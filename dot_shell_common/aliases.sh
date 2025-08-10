#!/bin/sh
# Common aliases for all shells

# Navigation
alias ..='cd ..'
alias ...='cd ../..'

# Claude command
if [ -x "$HOME/.claude/local/claude" ]; then
    alias claude='$HOME/.claude/local/claude'
fi
