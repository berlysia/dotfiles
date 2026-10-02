# shellcheck shell=sh
# is_human: true only for an interactive terminal not driven by an AI agent.
# This is a UX switch, not a security boundary. Function definitions only (no top-level
# assignments) so re-sourcing from init.sh, .zshrc and .bashrc never clears the cache.
# The cache is trusted only when _IS_HUMAN_PID matches this process, so a value inherited
# from a parent environment is ignored.
is_human() {
  if [ "${_IS_HUMAN_PID:-}" != "$$" ]; then
    if [ -t 0 ] && [ -t 1 ] &&
      [ -z "${CLAUDECODE:-}${CODEX_SANDBOX:-}${GEMINI_CLI:-}${CURSOR_AGENT:-}${AI_AGENT:-}" ]; then
      _IS_HUMAN=1
    else
      _IS_HUMAN=0
    fi
    _IS_HUMAN_PID=$$
  fi
  [ "$_IS_HUMAN" = 1 ]
}
