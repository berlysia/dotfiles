#!/bin/sh
# Common aliases for all shells

# Navigation
alias ..='cd ..'
alias ...='cd ../..'
alias ll='ls -la'

# Git shortcuts
alias gs='git status'
alias ga='git add'
alias gc='git commit'
alias gp='git push'

# Other useful aliases
alias h='history'
alias c='clear'

# Claude command
if [ -x "$HOME/.claude/local/claude" ]; then
    alias claude='$HOME/.claude/local/claude'
else
    # Use claude from PATH if local version not available
    alias claude='claude'
fi
