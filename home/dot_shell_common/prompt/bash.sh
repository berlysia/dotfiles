#!/bin/bash
# Bash-specific prompt implementation

# Variables PROMPT_GIT_* and PROMPT_CMD_DURATION are set by sourced helpers
# shellcheck disable=SC2154

# shellcheck source=git_info.sh
[ -f "$HOME/.shell_common/prompt/git_info.sh" ] && . "$HOME/.shell_common/prompt/git_info.sh"
# shellcheck source=cmd_duration.sh
[ -f "$HOME/.shell_common/prompt/cmd_duration.sh" ] && . "$HOME/.shell_common/prompt/cmd_duration.sh"

# --- Command duration via DEBUG trap ---
# Only set if no existing DEBUG trap to avoid conflicts
if [ -z "$(trap -p DEBUG)" ]; then
  trap '__prompt_cmd_timer_start' DEBUG
  _PROMPT_HAS_DURATION=1
fi

# --- Color helpers for bash (non-printing escape wrappers) ---
_c_reset='\[\033[0m\]'
_c_bold='\[\033[1m\]'
_c_green='\[\033[32m\]'
_c_red='\[\033[31m\]'
_c_cyan='\[\033[36m\]'
_c_blue='\[\033[34m\]'
_c_yellow='\[\033[33m\]'
_c_bold_green='\[\033[1;32m\]'
_c_bold_red='\[\033[1;31m\]'
_c_bold_cyan='\[\033[1;36m\]'
_c_bold_blue='\[\033[1;34m\]'

# --- Main prompt builder ---
__prompt_bash_build() {
  local exit_code=$?

  # Run shared helpers
  __prompt_git_info
  if [ "$_PROMPT_HAS_DURATION" = "1" ]; then
    __prompt_cmd_timer_stop
  fi

  # Line 1: directory user@host status [duration]
  local dir="${_c_bold_green}\w${_c_reset}"
  local user
  if [ "$(id -u)" -eq 0 ]; then
    user="${_c_bold_red}\u${_c_reset}"
  else
    user="${_c_bold_cyan}\u${_c_reset}"
  fi
  local host="${_c_bold_blue}\h${_c_reset}"

  local status_icon
  if [ "$exit_code" -eq 0 ]; then
    status_icon='✅'
  else
    status_icon='❌'" ${_c_red}${exit_code}${_c_reset}"
  fi

  local duration=""
  if [ -n "$PROMPT_CMD_DURATION" ]; then
    duration=" ${_c_yellow}took ${PROMPT_CMD_DURATION}${_c_reset}"
  fi

  local line1="${dir} ${user}${_c_yellow}@${_c_reset}${host} ${status_icon}${duration}"

  # Line 2: git info (only in git repos)
  local line2=""
  if [ "$PROMPT_GIT_ACTIVE" = "1" ]; then
    local git_parts="${_c_bold_cyan}${PROMPT_GIT_BRANCH}${_c_reset}"
    if [ -n "$PROMPT_GIT_REMOTE" ]; then
      git_parts="${git_parts} ${_c_blue}→ ${PROMPT_GIT_REMOTE}${_c_reset}"
    fi

    # State (merge, rebase, etc.)
    if [ -n "$PROMPT_GIT_STATE" ]; then
      git_parts="${git_parts} ${_c_bold_red}(${PROMPT_GIT_STATE})${_c_reset}"
    fi

    # Ahead/behind
    local ab=""
    if [ -n "$PROMPT_GIT_AHEAD" ] && [ -n "$PROMPT_GIT_BEHIND" ]; then
      ab="⇕⇡${PROMPT_GIT_AHEAD}⇣${PROMPT_GIT_BEHIND}"
    elif [ -n "$PROMPT_GIT_AHEAD" ]; then
      ab="⇡${PROMPT_GIT_AHEAD}"
    elif [ -n "$PROMPT_GIT_BEHIND" ]; then
      ab="⇣${PROMPT_GIT_BEHIND}"
    fi
    if [ -n "$ab" ]; then
      git_parts="${git_parts} ${_c_cyan}[${ab}]${_c_reset}"
    fi

    # Clean indicator
    if [ "$PROMPT_GIT_STAGED" -eq 0 ] && [ "$PROMPT_GIT_MODIFIED" -eq 0 ] && \
       [ "$PROMPT_GIT_UNTRACKED" -eq 0 ] && [ "$PROMPT_GIT_DELETED" -eq 0 ]; then
      git_parts="${git_parts} ✨"
    fi

    # File status counts
    if [ "$PROMPT_GIT_STAGED" -gt 0 ]; then
      git_parts="${git_parts} ${_c_green}+${PROMPT_GIT_STAGED} staged${_c_reset}"
    fi
    if [ "$PROMPT_GIT_MODIFIED" -gt 0 ]; then
      git_parts="${git_parts} ${_c_yellow}!${PROMPT_GIT_MODIFIED} modified${_c_reset}"
    fi
    if [ "$PROMPT_GIT_DELETED" -gt 0 ]; then
      git_parts="${git_parts} ${_c_red}✘${PROMPT_GIT_DELETED} deleted${_c_reset}"
    fi
    if [ "$PROMPT_GIT_UNTRACKED" -gt 0 ]; then
      git_parts="${git_parts} ${_c_red}?${PROMPT_GIT_UNTRACKED} untracked${_c_reset}"
    fi

    line2=$'\n'"${git_parts}"
  fi

  # Line 3: prompt character
  local mark
  if [ "$exit_code" -eq 0 ]; then
    mark="${_c_bold_green}>${_c_reset} "
  else
    mark="${_c_bold_red}>${_c_reset} "
  fi

  # Add newline before prompt (except first prompt)
  local newline=""
  if [ -z "$_PROMPT_FIRST" ]; then
    _PROMPT_FIRST=1
  else
    newline=$'\n'
  fi

  PS1="${newline}${line1}${line2}"$'\n'"${mark}"
}

# Append to PROMPT_COMMAND without overwriting existing entries
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__prompt_bash_build;${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="__prompt_bash_build"
fi
