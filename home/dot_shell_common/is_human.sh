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

# Unset ai-env values a human shell inherited from an AI-judged parent (e.g. VSCode's
# environment resolution runs a TTY-less login shell). Only exact AI values are cleared,
# so values a human set (PAGER=less) survive; a human's own PAGER=cat is cleared too (accepted).
clear_inherited_ai_env() {
  [ "${EDITOR:-}" = true ] && unset EDITOR
  [ "${VISUAL:-}" = true ] && unset VISUAL
  [ "${GIT_EDITOR:-}" = true ] && unset GIT_EDITOR
  [ "${GIT_SEQUENCE_EDITOR:-}" = true ] && unset GIT_SEQUENCE_EDITOR
  [ "${PAGER:-}" = cat ] && unset PAGER
  [ "${GIT_PAGER:-}" = cat ] && unset GIT_PAGER
  [ "${MANPAGER:-}" = cat ] && unset MANPAGER
  [ "${GIT_TERMINAL_PROMPT:-}" = 0 ] && unset GIT_TERMINAL_PROMPT
  return 0
}
