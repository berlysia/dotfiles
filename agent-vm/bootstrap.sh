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
