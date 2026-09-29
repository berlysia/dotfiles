#!/usr/bin/env bash
# agent-vm bootstrap: runs inside the per-repo OrbStack machine, from the staging generation.
# Contract with the host launcher (home/dot_local/bin/executable_agent-vm, maybe_bootstrap):
#   bootstrap.sh <contract version> <staging hash> <staging generation dir>
set -euo pipefail

readonly SUPPORTED_CONTRACT=1
# VM counterpart of the host's run_onchange_install-packages-1-linux, which the VM does not run (spec K17/K18).
# Constants on purpose: the VM controls both its environment and the staging copy.
readonly VM_APT_PKGS=(jq bat fd-find ripgrep shellcheck)
# A fresh machine can still hold the dpkg lock (cloud-init, unattended-upgrades); wait for it instead of failing,
# and bound every download so a stalled network fails the bootstrap (retried next launch) instead of hanging it.
readonly APT_OPTS=(-o DPkg::Lock::Timeout=120 -o Acquire::Retries=3)
# The one list of MCP servers the VM keeps; the jq filter, the awk filter and the self-check all take it from here.
readonly VM_MCP_KEEP="readability context7 excalidraw"
readonly CURL_OPTS=(-fsSL --proto "=https" --tlsv1.2 --retry 3 --retry-connrefused --connect-timeout 15 --max-time 300)
MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
OUTBOX_ROOT="${AGENT_VM_OUTBOX_ROOT:-/opt/agent-vm/outbox}"
SECRETS_DIR="${AGENT_VM_SECRETS_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}}"

fail() { printf 'agent-vm bootstrap: %s\n' "$1" >&2; exit "${2:-1}"; }
prepare_source_tools() { # chezmoi source dir
  # home/dot_codex/private_config.toml.tmpl merges through home/dot_codex/private_dot_merge-config.ts on every
  # apply after the first, from the working tree, so mise must resolve dasel from the source's own .mise.toml
  # there, as on the host (spec K18). Installing dasel into mise's install dir alone is not enough: the merge
  # script finds the mise shim first, and the shim refuses an untrusted .mise.toml. The trusted file is this VM's
  # own copy of the source. Only dasel is installed. Runs on every bootstrap (idempotent) so re-applies never
  # meet a missing dasel.
  "$HOME/.local/bin/mise" trust "$1/.mise.toml"
  (cd "$1" && "$HOME/.local/bin/mise" install dasel)
}

# bootstrap.sh owns no global EXIT trap: run_installer and filter_vm_config each set one for their own temp file
# and clear it on success. A future global cleanup must be folded into those, not added as a separate trap.
run_installer() { # url, installer args...: download first so a truncated fetch is never executed
  local url=$1 script
  shift
  script=$(mktemp)
  # shellcheck disable=SC2064 # expand now: remove this call's file even when fail() exits the script
  trap "rm -f '$script'" EXIT
  curl "${CURL_OPTS[@]}" -o "$script" "$url" || fail "could not download $url"
  # The installer downloads its own binary with its own curl; bound the whole run so a stall cannot hang bootstrap.
  timeout 600 sh "$script" "$@" || fail "installer from $url failed or timed out"
  rm -f "$script"
  trap - EXIT
}
link_debian_name() { # debian_command usual_name: Ubuntu ships bat / fd as batcat / fdfind
  local src
  command -v "$2" >/dev/null 2>&1 && return 0
  src=$(command -v "$1") || fail "$1 is missing after the apt install"
  ln -sfn "$src" "$HOME/.local/bin/$2" # -f replaces a dangling link left by an earlier failed run
}
install_vm_tools() { # only what the VM needs, before apply: 00-install-mise-tools needs mise, the plugin and
  # update-*-json scripts need jq. tests/agent-vm/run-bootstrap.sh checks the list stays a subset of the host's.
  local pkg missing=()
  for pkg in "${VM_APT_PKGS[@]}"; do
    dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    # sudo resets the environment, so DEBIAN_FRONTEND goes after it; no recommends keeps MTAs (postfix) out.
    sudo apt-get "${APT_OPTS[@]}" update
    sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${missing[@]}"
  fi
  mkdir -p "$HOME/.local/bin"
  # `--version` rather than -x: a zero-byte file from an interrupted install must not count as installed.
  if ! "$HOME/.local/bin/mise" --version >/dev/null 2>&1; then
    run_installer https://mise.run
  fi
  if ! starship --version >/dev/null 2>&1; then
    run_installer https://starship.rs/install.sh --yes --bin-dir "$HOME/.local/bin"
  fi
  link_debian_name batcat bat
  link_debian_name fdfind fd
}
filter_vm_config() { # target file, command... (the target is appended last): rewrite through a same-directory temp
  local target=$1 tmp
  shift
  [[ -f "$target" ]] || return 0
  tmp=$(mktemp "$target.XXXXXX") || fail "cannot create a temp file next to $target"
  # shellcheck disable=SC2064 # expand now: remove this call's file even when fail() exits the script
  trap "rm -f '$tmp'" EXIT
  "$@" "$target" >"$tmp" || fail "could not post-process $target for the VM"
  # An empty result is never a valid config; refuse it rather than wipe the file (and, for .claude.json, the login).
  [[ -s "$tmp" ]] || fail "post-processing $target produced nothing"
  chmod --reference="$target" "$tmp"
  mv "$tmp" "$target"
  trap - EXIT
}
filter_vm_configs() { # every bootstrap, after apply (spec K19)
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  filter_vm_config "$HOME/.claude/settings.json" jq -f "$here/vm-settings.jq"
  filter_vm_config "$HOME/.claude.json" jq --arg keep "$VM_MCP_KEEP" -f "$here/vm-claude-json.jq"
  filter_vm_config "$HOME/.codex/config.toml" awk -v keep_list="$VM_MCP_KEEP" -f "$here/vm-codex-config.awk"
}
verify_vm_config() { # deliberately looser than the filters, and fail-closed: a filter that removed nothing must stop here
  local keep_alt bad verdict
  # A mismatch here repeats on every launch until the dotfiles or the filters change; say how to get unstuck.
  local recover="fix the filter in agent-vm/ (or the template that changed), then run: agent-vm rm (the next launch recreates the machine)"
  keep_alt=${VM_MCP_KEEP// /|}
  if [[ -f "$HOME/.claude/settings.json" ]] && grep -q 'speak-notification' "$HOME/.claude/settings.json"; then
    fail "the audio notification hook is still registered after post-processing; $recover"
  fi
  if [[ -f "$HOME/.claude.json" ]]; then
    verdict=$(jq --arg keep "$VM_MCP_KEEP" '(.mcpServers // {}) | keys - ($keep | split(" ")) | length == 0' "$HOME/.claude.json") || verdict=""
    [[ "$verdict" == true ]] || fail "MCP servers outside the VM allowlist remain in ~/.claude.json; $recover"
  fi
  if [[ -f "$HOME/.codex/config.toml" ]]; then
    # Any line starting with mcp_servers (table header, dotted key or inline table) must name a kept server right
    # after `mcp_servers.`; the bare [mcp_servers] parent header is the only exception.
    bad=$(grep -E '^[[:space:]]*\[*[[:space:]]*mcp_servers' "$HOME/.codex/config.toml" |
      grep -vE '^[[:space:]]*\[[[:space:]]*mcp_servers[[:space:]]*\][[:space:]]*$' |
      grep -vE "^[[:space:]]*\[*[[:space:]]*mcp_servers\.\"?(${keep_alt})\"?([].[:space:]=]|$)") || true
    [[ -z "$bad" ]] || fail "MCP servers outside the VM allowlist remain in ~/.codex/config.toml: $bad; $recover"
  fi
}

contract=${1:-}
hash=${2:-}
src=${3:-}
if [[ "$contract" != "$SUPPORTED_CONTRACT" ]]; then
  fail "launcher and bootstrap contract versions differ (got '$contract', need '$SUPPORTED_CONTRACT'); run chezmoi apply on the host to update the launcher" 3
fi
[[ -n "$hash" && -d "$src" ]] || fail "usage: bootstrap.sh <contract> <hash> <src dir>"
[[ -f "$MARKER" ]] || fail "not an agent-vm machine ($MARKER missing)"
# Secrets are handed over as files here (spec K6); they must never land on a persistent disk.
[[ "$(stat -f -c %T "$SECRETS_DIR" 2>/dev/null)" == tmpfs ]] || fail "$SECRETS_DIR is not tmpfs; refusing to continue"

# This shell is non-interactive and reads no profile: add the installers' target dirs so the claude check
# below and later chezmoi scripts (mise, and what mise installs) see what earlier runs installed.
# Appended, not prepended: files a session planted in ~/.local/bin cannot shadow system commands
# (curl, bash, rsync, git, chezmoi) that bootstrap itself runs. User-only tools (mise, claude) can still be
# replaced from inside the VM, exactly as for the next interactive session; that stays within the VM boundary.
export PATH="$PATH:$HOME/.local/bin:$HOME/.local/share/mise/shims"
install_vm_tools

# Claude Code is not managed by chezmoi on any host; the VM installs it the same way as the host (spec K16).
# Under pipefail a failed download aborts here, before applied-hash is written, so the next launch retries.
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi

link_outbox() { # outbox subdir, target path (bootstrap owns these VM-only symlinks; chezmoi does not manage them)
  local out="$OUTBOX_ROOT/$1" target=$2
  mkdir -p "$out" "$(dirname "$target")"
  if [[ -d "$target" && ! -L "$target" ]]; then
    cp -a "$target/." "$out/"
    rm -rf "$target"
  fi
  ln -sfn "$out" "$target"
}
link_outbox claude-projects "$HOME/.claude/projects"
link_outbox codex-sessions "$HOME/.codex/sessions"

cz="$HOME/.local/share/chezmoi"
mkdir -p "$cz"
# .git is excluded so the empty repository chezmoi init creates in a .git-less source survives resyncs.
rsync -a --delete --exclude node_modules --exclude .git "$src/" "$cz/"
prepare_source_tools "$cz"
chezmoi init --force --no-tty -W "$cz" --apply

# Every bootstrap, after apply: update-settings-json rewrites hooks wholesale, update-claude-json merges MCP
# servers additively and the codex config is regenerated from its template, so anything removed here comes
# back whenever those scripts re-run (spec K19). Nothing records applied-hash unless both succeed.
filter_vm_configs
verify_vm_config

mkdir -p "$HOME/.local/state/agent-vm"
printf '%s\n' "$hash" >"$HOME/.local/state/agent-vm/applied-hash"
