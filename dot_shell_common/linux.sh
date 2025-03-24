#!/bin/sh
# Common Linux-specific configuration for all shells

# Linux specific aliases
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias fgrep='fgrep --color=auto'
alias egrep='egrep --color=auto'

# If snap is available
if type snap &>/dev/null; then
  # Add snap bin to PATH if not already there
  add_to_path "/snap/bin"
fi
