#!/usr/bin/env bash
# agent-vm bootstrap: runs inside the per-repo OrbStack machine, from the staging generation.
# Contract with the host launcher (home/dot_local/bin/executable_agent-vm, maybe_bootstrap):
#   bootstrap.sh <contract version> <staging hash> <staging generation dir>
set -euo pipefail

readonly SUPPORTED_CONTRACT=1
# VM counterpart of the host's run_onchange_install-packages-1-linux, which the VM does not run (spec K17/K18).
# Constants on purpose: the VM controls both its environment and the staging copy.
readonly VM_APT_PKGS=(jq bat fd-find ripgrep shellcheck gh)
# Libraries the linux-arm64 headless shell loads, minus mesa (libgbm1 would pull mesa-libgallium and libllvm, ~178MB),
# plus two small fonts (Latin and Japanese). Measured at 35.1MB installed (research F11); the limit is 40MB (spec K5).
# Derived from `playwright install-deps --dry-run chromium-headless-shell` with the spec K5 exclusion regex.
readonly VM_BROWSER_APT_PKGS=(at-spi2-common libasound2-data libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64
  libatspi2.0-0t64 libavahi-client3 libavahi-common-data libavahi-common3 libcairo2 libcups2t64 libdatrie1
  libdrm-common libdrm2 libfreetype6 libgraphite2-3 libharfbuzz0b libice6 libnspr4 libnss3 libpango-1.0-0
  libpixman-1-0 libpng16-16t64 libsm6 libthai-data libthai0 libunwind8 libxaw7 libxcb-render0 libxcomposite1
  libxdamage1 libxfixes3 libxi6 libxkbcommon0 libxkbfile1 libxmu6 libxpm4 libxrandr2 libxrender1 libxres1
  libxt6t64 x11-common fonts-liberation fonts-ipafont-gothic)
# agent-vm machines are arm64 (OrbStack on Apple Silicon, spec R4); the libgbm1 deb keeps its library here.
readonly GBM_DEB_LIBDIR=usr/lib/aarch64-linux-gnu
# A fresh machine can still hold the dpkg lock (cloud-init, unattended-upgrades); wait for it instead of failing,
# and bound every download so a stalled network fails the bootstrap (retried next launch) instead of hanging it.
readonly APT_OPTS=(-o DPkg::Lock::Timeout=120 -o Acquire::Retries=3)
# The MCP servers the VM keeps (spec K4). Claude also keeps the browser servers, configured by vm-claude-browser.jq;
# Codex does not (its playwright entry is an unpinned @latest).
readonly VM_CLAUDE_MCP_KEEP="readability context7 excalidraw playwright chrome-devtools"
readonly VM_CODEX_MCP_KEEP="readability context7 excalidraw"
readonly VM_BROWSER_MCP="playwright chrome-devtools"
# Codex only. The name is the contract with vm-codex-config.tmpl, which reads it with `env`.
readonly VM_MCP_KEEP=$VM_CODEX_MCP_KEEP
export VM_MCP_KEEP
readonly CURL_OPTS=(-fsSL --proto "=https" --tlsv1.2 --retry 3 --retry-connrefused --connect-timeout 15 --max-time 300)
MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
OUTBOX_ROOT="${AGENT_VM_OUTBOX_ROOT:-/opt/agent-vm/outbox}"
SECRETS_DIR="${AGENT_VM_SECRETS_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}}"
# The launcher mounts browsers/<machine> here and publishes current -> gen-*; the store puts the shell at
# bin/headless_shell (agent-vm fetch-browsers / ensure_browsers, spec K2/K3).
BROWSERS_ROOT="${AGENT_VM_BROWSERS_ROOT:-/opt/agent-vm/browsers}"
GBM_DIR="$HOME/.local/lib/agent-vm-browser"

fail() { printf 'agent-vm bootstrap: %s\n' "$1" >&2; exit "${2:-1}"; }
warn() { printf 'agent-vm bootstrap: warning: %s\n' "$1" >&2; }

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
install_browser_deps() { # spec K5; never fails the bootstrap: the browser is optional, everything else is not
  local pkg missing=() candidate tmp
  [[ -d "$BROWSERS_ROOT" ]] || return 0
  for pkg in "${VM_BROWSER_APT_PKGS[@]}"; do dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg"); done
  # Refresh the lists here rather than rely on install_vm_tools, which skips `update` when its own packages are
  # present: a fresh machine can have empty lists, and the libgbm candidate below must come from current lists.
  sudo apt-get "${APT_OPTS[@]}" update >/dev/null 2>&1 || warn "apt-get update failed; browser libraries may be stale or missing"
  if [[ ${#missing[@]} -gt 0 ]]; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "${missing[@]}" ||
      warn "could not install the browser libraries; browser MCP servers will fail to start"
  fi
  candidate=$(apt-cache policy libgbm1 2>/dev/null) || candidate=""
  candidate=$(printf '%s\n' "$candidate" | sed -n 's/^ *Candidate: *//p')
  if [[ -z "$candidate" || "$candidate" == "(none)" ]]; then warn "no libgbm1 candidate in the apt lists"; return 0; fi
  if [[ -e "$GBM_DIR/libgbm.so.1" && "$(cat "$GBM_DIR/.version" 2>/dev/null || true)" == "$candidate" ]]; then return 0; fi
  tmp=$(mktemp -d) || { warn "no temp dir for libgbm"; return 0; }
  # .version goes with the old files, so a copy that fails half way is retried on the next bootstrap.
  if (cd "$tmp" && apt-get download libgbm1 >/dev/null && dpkg-deb -x libgbm1_*.deb x) &&
     mkdir -p "$GBM_DIR" && rm -f "$GBM_DIR"/libgbm.so.1* "$GBM_DIR/.version" &&
     cp -P "$tmp/x/$GBM_DEB_LIBDIR"/libgbm.so.1* "$GBM_DIR/"; then
    printf '%s\n' "$candidate" >"$GBM_DIR/.version"
  else
    warn "could not fetch libgbm (apt-get download libgbm1); the headless shell will not start until the next bootstrap"
  fi
  rm -rf "$tmp"
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
filter_codex_config() { # codex config path: filter_vm_config appends the target as an argument; the template reads stdin
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  chezmoi execute-template --with-stdin --file "$here/vm-codex-config.tmpl" <"$1"
}
claude_keep() { # the Claude allowlist for this machine: without the browser mount the browser servers are dropped
  local name keep=""
  for name in $VM_CLAUDE_MCP_KEEP; do
    if [[ ! -d "$BROWSERS_ROOT" && " $VM_BROWSER_MCP " == *" $name "* ]]; then continue; fi
    keep="$keep${keep:+ }$name"
  done
  printf '%s\n' "$keep"
}
filter_vm_configs() { # every bootstrap, after apply (spec K19)
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  filter_vm_config "$HOME/.claude/settings.json" jq -f "$here/vm-settings.jq"
  filter_vm_config "$HOME/.claude.json" jq --arg keep "$(claude_keep)" -f "$here/vm-claude-json.jq"
  # Runs after the allowlist filter above: on a machine without the mount the browser entries are already gone,
  # so this changes nothing there.
  filter_vm_config "$HOME/.claude.json" jq --arg exe "$BROWSERS_ROOT/current/bin/headless_shell" \
    --arg lib "$HOME/.local/lib/agent-vm-browser" -f "$here/vm-claude-browser.jq"
  filter_vm_config "$HOME/.codex/config.toml" filter_codex_config
}
verify_vm_config() { # deliberately looser than the filters, and fail-closed: a filter that removed nothing must stop here
  local verdict
  # A mismatch here repeats on every launch until the dotfiles or the filters change; say how to get unstuck.
  local recover="fix the filter in agent-vm/ (or the template that changed), then run: agent-vm rm (the next launch recreates the machine)"
  if [[ -f "$HOME/.claude/settings.json" ]] && grep -q 'speak-notification' "$HOME/.claude/settings.json"; then
    fail "the audio notification hook is still registered after post-processing; $recover"
  fi
  if [[ -f "$HOME/.claude.json" ]]; then
    verdict=$(jq --arg keep "$(claude_keep)" '(.mcpServers // {}) | keys - ($keep | split(" ")) | length == 0' "$HOME/.claude.json") || verdict=""
    [[ "$verdict" == true ]] || fail "MCP servers outside the VM allowlist remain in ~/.claude.json; $recover"
    verdict=$(jq --arg exe "$BROWSERS_ROOT/current/bin/headless_shell" '[(.mcpServers // {}) | to_entries[]
      | select(.key == "playwright" or .key == "chrome-devtools")
      | select((.value.args | type) != "array" or (.value.args | index("--headless")) == null
               or (.value.args | index($exe)) == null or (.value.env.LD_LIBRARY_PATH // "") == "")]
      | length == 0' "$HOME/.claude.json") || verdict=""
    [[ "$verdict" == true ]] || fail "a browser MCP entry in ~/.claude.json is not configured for the VM headless shell; $recover"
  fi
  if [[ -f "$HOME/.codex/config.toml" ]]; then
    # Parsed, not grepped: every mcp_servers table at any depth (the filter only handles the top level) must name
    # kept servers only, and one that is not a table counts as a violation. A parse failure leaves jq without
    # input, so the verdict is never "true". Inline template on purpose: the filter's own template is not reused.
    verdict=$(chezmoi execute-template --with-stdin '{{ .chezmoi.stdin | fromToml | toJson }}' <"$HOME/.codex/config.toml" |
      jq --arg keep "$VM_MCP_KEEP" '[.. | objects | select(has("mcp_servers")) | .mcp_servers
        | if type == "object" then keys[] else "(mcp_servers is not a table)" end] - ($keep | split(" ")) | length == 0') || verdict=""
    [[ "$verdict" == true ]] || fail "MCP servers outside the VM allowlist remain in ~/.codex/config.toml (or it cannot be parsed); $recover"
  fi
}

safe_word() { # text from the VM-writable mount (ldd output, .meta) is shown only if it is a plain token
  if [[ "$1" =~ ^[0-9A-Za-z._+-]{1,64}$ ]]; then printf '%s' "$1"; else printf '(unreadable)'; fi
}
missing_libs() { # binary -> space-separated sonames ldd cannot resolve; captured first so pipefail cannot flip the test
  local out name rest list=""
  # ldd may run code from the binary; acceptable here: the binary sits in this VM's own copy, inside the VM boundary.
  out=$(LD_LIBRARY_PATH="$GBM_DIR" ldd "$1" 2>/dev/null) || true
  while read -r name _ rest; do
    [[ "$rest" == *"not found"* ]] && list="$list${list:+ }$(safe_word "$name")"
  done <<<"$out"
  printf '%s\n' "$list"
}
report_browser_state() { # spec K6: advisory only; .meta lives in a VM-writable mount, so it never drives a decision
  local exe="$BROWSERS_ROOT/current/bin/headless_shell" lib want have missing
  if [[ ! -d "$BROWSERS_ROOT" ]]; then
    warn "this machine has no browser mount (created before VM browser support); browser MCP servers are off."
    warn "to enable them: agent-vm rm, then launch again. you lose the VM-side logins (Claude, Codex) and tools installed inside the VM; the repo, session logs and env files stay."
    return 0
  fi
  if [[ ! -x "$exe" ]]; then
    warn "no headless shell at $exe; recover: agent-vm fetch-browsers on the host, then launch again"
    return 0
  fi
  for lib in "$exe" "$GBM_DIR/libgbm.so.1"; do
    [[ -e "$lib" ]] || continue
    missing=$(missing_libs "$lib")
    if [[ -n "$missing" ]]; then warn "$(basename "$lib") is missing libraries: $missing"; fi
  done
  want=$(jq -r '.mcpServers.playwright.args[0] // "" | sub("^@playwright/mcp@"; "")' "$HOME/.claude.json" 2>/dev/null) || want=""
  have=$(sed -n 's/^mcp_version=//p' "$BROWSERS_ROOT/current/.meta" 2>/dev/null | head -1) || have=""
  if [[ -n "$want" && -n "$have" && "$want" != "$have" ]]; then
    warn "playwright MCP is $(safe_word "$want") but the mounted browser is for $(safe_word "$have"); recover: chezmoi apply, agent-vm fetch-browsers"
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
install_browser_deps

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
chezmoi init --force --no-tty -W "$cz" --apply ||
  fail "chezmoi apply failed; if the error names ~/.codex/config.toml, that file cannot be parsed: fix it or run agent-vm rm (the next launch recreates the machine)"

# Every bootstrap, after apply: update-settings-json rewrites hooks wholesale, update-claude-json merges MCP
# servers additively and the codex config is regenerated from its template, so anything removed here comes
# back whenever those scripts re-run (spec K19). Nothing records applied-hash unless both succeed.
filter_vm_configs
verify_vm_config
report_browser_state

mkdir -p "$HOME/.local/state/agent-vm"
printf '%s\n' "$hash" >"$HOME/.local/state/agent-vm/applied-hash"
