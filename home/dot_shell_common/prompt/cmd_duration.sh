#!/bin/sh
# Command duration measurement helper for shell prompts
# POSIX sh compatible - shared between zsh and bash
#
# Usage:
#   zsh:  add-zsh-hook preexec __prompt_cmd_timer_start
#         add-zsh-hook precmd __prompt_cmd_timer_stop
#   bash: trap '__prompt_cmd_timer_start' DEBUG (if no existing DEBUG trap)
#         call __prompt_cmd_timer_stop in PROMPT_COMMAND

__prompt_cmd_timer_start() {
  PROMPT_CMD_TIMER_START="${PROMPT_CMD_TIMER_START:-$SECONDS}"
}

__prompt_cmd_timer_stop() {
  PROMPT_CMD_DURATION=""
  if [ -n "$PROMPT_CMD_TIMER_START" ]; then
    local elapsed=$((SECONDS - PROMPT_CMD_TIMER_START))
    if [ "$elapsed" -ge 1 ]; then
      if [ "$elapsed" -ge 60 ]; then
        local minutes=$((elapsed / 60))
        local secs=$((elapsed % 60))
        PROMPT_CMD_DURATION="${minutes}m${secs}s"
      else
        PROMPT_CMD_DURATION="${elapsed}s"
      fi
    fi
    unset PROMPT_CMD_TIMER_START
  fi
}
