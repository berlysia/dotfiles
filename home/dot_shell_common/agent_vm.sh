# shellcheck shell=sh
# claude / codex run inside this repository's OrbStack machine through agent-vm (docs/agent-vm.md).
# `AGENT_VM=off claude` runs the host binary for one command. Repositories that should always run on
# the host are listed in ~/.config/agent-vm/config (never in the repository, which the VM can write).
if command -v agent-vm >/dev/null 2>&1; then
  claude() {
    if [ "${AGENT_VM:-}" = off ]; then command claude "$@"; else agent-vm claude "$@"; fi
  }
  codex() {
    if [ "${AGENT_VM:-}" = off ]; then command codex "$@"; else agent-vm codex "$@"; fi
  }
fi
