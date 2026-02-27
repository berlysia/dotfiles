setopt PROMPT_SUBST

autoload -Uz add-zsh-hook

# Load shared helpers
[ -f "$HOME/.shell_common/prompt/git_info.sh" ] && . "$HOME/.shell_common/prompt/git_info.sh"
[ -f "$HOME/.shell_common/prompt/cmd_duration.sh" ] && . "$HOME/.shell_common/prompt/cmd_duration.sh"

# --- Command duration: preexec starts timer ---
add-zsh-hook preexec __prompt_cmd_timer_start

# --- Single precmd to capture $? before any other processing ---
__prompt_precmd() {
  local exit_code=$?

  # Stop timer and compute duration
  __prompt_cmd_timer_stop

  # Gather git info
  __prompt_git_info

  # Build prompt
  __prompt_render "$exit_code"
}

add-zsh-hook precmd __prompt_precmd

# --- Prompt renderer ---
__prompt_render() {
  local exit_code=$1

  # Line 1: directory user@host status [duration]
  local dir='%F{green}%B%~%b%f'
  local user
  if [ $UID -eq 0 ]; then
    user='%F{red}%B%n%b%f'
  else
    user='%F{cyan}%B%n%b%f'
  fi
  local host='%F{blue}%B%m%b%f'
  local status_icon
  if [ "$exit_code" -eq 0 ]; then
    status_icon=$'\u2705'
  else
    status_icon=$'\u274c'" %F{red}${exit_code}%f"
  fi
  local current_time
  current_time=$(date '+%Y-%m-%d %H:%M:%S')
  local timestamp="%F{blue}at ${current_time}%f"

  local duration=""
  if [ -n "$PROMPT_CMD_DURATION" ]; then
    duration=" %F{yellow}took ${PROMPT_CMD_DURATION}%f"
  fi

  local line1="${dir} ${user}%F{yellow}@%f${host} ${status_icon} ${timestamp}${duration}"

  # Line 2: git info (only in git repos)
  local line2=""
  if [ "$PROMPT_GIT_ACTIVE" = "1" ]; then
    local git_parts="%F{cyan}%B${PROMPT_GIT_BRANCH}%b%f"
    if [ -n "$PROMPT_GIT_REMOTE" ]; then
      git_parts="${git_parts} %F{blue}→ ${PROMPT_GIT_REMOTE}%f"
    fi

    if [ -n "$PROMPT_GIT_STATE" ]; then
      git_parts="${git_parts} %F{red}%B(${PROMPT_GIT_STATE})%b%f"
    fi

    local ab=""
    if [ -n "$PROMPT_GIT_AHEAD" ] && [ -n "$PROMPT_GIT_BEHIND" ]; then
      ab="⇕⇡${PROMPT_GIT_AHEAD}⇣${PROMPT_GIT_BEHIND}"
    elif [ -n "$PROMPT_GIT_AHEAD" ]; then
      ab="⇡${PROMPT_GIT_AHEAD}"
    elif [ -n "$PROMPT_GIT_BEHIND" ]; then
      ab="⇣${PROMPT_GIT_BEHIND}"
    fi
    if [ -n "$ab" ]; then
      git_parts="${git_parts} %F{cyan}[${ab}]%f"
    fi

    if [ "$PROMPT_GIT_STAGED" -eq 0 ] && [ "$PROMPT_GIT_MODIFIED" -eq 0 ] && \
       [ "$PROMPT_GIT_UNTRACKED" -eq 0 ] && [ "$PROMPT_GIT_DELETED" -eq 0 ]; then
      git_parts="${git_parts} ✨"
    fi

    if [ "$PROMPT_GIT_STAGED" -gt 0 ]; then
      git_parts="${git_parts} %F{green}+${PROMPT_GIT_STAGED} staged%f"
    fi
    if [ "$PROMPT_GIT_MODIFIED" -gt 0 ]; then
      git_parts="${git_parts} %F{yellow}!${PROMPT_GIT_MODIFIED} modified%f"
    fi
    if [ "$PROMPT_GIT_DELETED" -gt 0 ]; then
      git_parts="${git_parts} %F{red}✘${PROMPT_GIT_DELETED} deleted%f"
    fi
    if [ "$PROMPT_GIT_UNTRACKED" -gt 0 ]; then
      git_parts="${git_parts} %F{red}?${PROMPT_GIT_UNTRACKED} untracked%f"
    fi

    line2=$'\n'"${git_parts}"
  fi

  # Line 3: prompt character
  local mark
  if [ "$exit_code" -eq 0 ]; then
    mark="%F{green}%B>%b%f "
  else
    mark="%F{red}%B>%b%f "
  fi

  PROMPT="${line1}${line2}"$'\n'"${mark}"
}

# Add newline before prompt (except first prompt)
__prompt_newline_precmd() {
  if [ -z "$_PROMPT_FIRST" ]; then
    _PROMPT_FIRST=1
  else
    print
  fi
}
add-zsh-hook precmd __prompt_newline_precmd
