#!/usr/bin/env bash
# agent-vm bootstrap: runs inside the per-repo OrbStack machine, from the staging generation.
# Contract with the host launcher (home/dot_local/bin/executable_agent-vm, maybe_bootstrap):
#   bootstrap.sh <contract version> <staging hash> <staging generation dir>
set -euo pipefail

readonly SUPPORTED_CONTRACT=1
MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
OUTBOX_ROOT="${AGENT_VM_OUTBOX_ROOT:-/opt/agent-vm/outbox}"
SECRETS_DIR="${AGENT_VM_SECRETS_DIR:-${XDG_RUNTIME_DIR:-/dev/shm}}"

fail() { printf 'agent-vm bootstrap: %s\n' "$1" >&2; exit "${2:-1}"; }

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
