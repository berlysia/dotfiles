#!/bin/sh
# Common Linux-specific configuration for all shells

# Linux specific aliases
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# If snap is available
if type snap >/dev/null 2>&1; then
  # Add snap bin to PATH if not already there
  add_to_path "/snap/bin"
fi

# WSL-specific: notify-send using wsl-notify-send.exe for Windows toast notifications
if [ -n "$WSL_DISTRO_NAME" ]; then
  WSL_NOTIFY_SEND_PATH="/mnt/c/Users/$USER/.local/bin/wsl-notify-send.exe"
  if [ -f "$WSL_NOTIFY_SEND_PATH" ]; then
    notify-send() {
      # Use nohup and background to prevent process suspension issues
      # wsl-notify-send.exe can cause parent process suspension in interactive shells
      nohup "$WSL_NOTIFY_SEND_PATH" --category "$WSL_DISTRO_NAME" "$@" </dev/null >/dev/null 2>&1 &
    }
  fi
fi
