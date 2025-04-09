#!/bin/sh
# Common environment variables for all shells

# Default editor
if type code &>/dev/null; then
  export EDITOR="code --wait"
elif type emacs &>/dev/null; then
  export EDITOR=emacs
fi

# FZF configuration
export FZF_DEFAULT_OPTS="--height=50% --layout=reverse --info=inline --border --padding=1"

# Locale settings
export LANG=C.UTF-8
