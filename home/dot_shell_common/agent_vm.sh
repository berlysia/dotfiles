# shellcheck shell=sh
# claude / codex run on the host. vclaude / vcodex run them inside this repository's OrbStack machine
# through agent-vm (docs/agent-vm.md); the launcher decides VM or host and fails closed on anomalies.
# Repositories that should stay on the host even through vclaude / vcodex are listed in
# ~/.config/agent-vm/config (never in the repository, which the VM can write).
if command -v agent-vm >/dev/null 2>&1; then
  vclaude() { agent-vm claude "$@"; }
  vcodex() { agent-vm codex "$@"; }
fi
