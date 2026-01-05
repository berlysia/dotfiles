#!/bin/sh
# Common shell initialization script for both zsh and bash interactive sessions

# Load common aliases
# shellcheck disable=SC2154
[ -f "$SHELL_COMMON/aliases.sh" ] && . "$SHELL_COMMON/aliases.sh"

# FZF integration based on shell type
if type fzf >/dev/null 2>&1; then
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    # zsh-specific FZF integration (uses process substitution, zsh-only)
    # shellcheck disable=SC3001
    . <(fzf --zsh)
  else
    # bash-specific FZF integration
    if [ -f ~/.fzf.bash ]; then
      . ~/.fzf.bash
    elif [ -f /usr/share/doc/fzf/examples/key-bindings.bash ]; then
      . /usr/share/doc/fzf/examples/key-bindings.bash
    fi
  fi
fi

# Update checkers (tools and dotfiles)
[ -f "$SHELL_COMMON/updates/chezmoi.sh" ] && . "$SHELL_COMMON/updates/chezmoi.sh"
[ -f "$SHELL_COMMON/updates/mise.sh" ] && . "$SHELL_COMMON/updates/mise.sh"
[ -f "$SHELL_COMMON/updates/dotfiles.sh" ] && . "$SHELL_COMMON/updates/dotfiles.sh"
