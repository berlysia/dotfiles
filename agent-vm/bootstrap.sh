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
readonly CURL_OPTS=(-fsSL --proto "=https" --tlsv1.2 --retry 3 --retry-connrefused --connect-timeout 15 --max-time 300)
MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
OUTBOX_ROOT="${AGENT_VM_OUTBOX_ROOT:-/opt/agent-vm/outbox}"
SECRETS_DIR="${AGENT_VM_SECRETS_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}}"

fail() { printf 'agent-vm bootstrap: %s\n' "$1" >&2; exit "${2:-1}"; }

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
chezmoi init --force --no-tty -W "$cz" --apply

mkdir -p "$HOME/.local/state/agent-vm"
printf '%s\n' "$hash" >"$HOME/.local/state/agent-vm/applied-hash"
