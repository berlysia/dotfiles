#!/bin/sh
# Common shell initialization script for both zsh and bash interactive sessions

# Load common aliases
[ -f "$SHELL_COMMON/aliases.sh" ] && source "$SHELL_COMMON/aliases.sh"

# FZF integration based on shell type
if type fzf &>/dev/null; then
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    # zsh-specific FZF integration
    source <(fzf --zsh)
  else
    # bash-specific FZF integration
    if [ -f ~/.fzf.bash ]; then
      source ~/.fzf.bash
    elif [ -f /usr/share/doc/fzf/examples/key-bindings.bash ]; then
      source /usr/share/doc/fzf/examples/key-bindings.bash
    fi
  fi
fi

# chezmoi更新チェック
[ -f "$SHELL_COMMON/chezmoi_check.sh" ] && source "$SHELL_COMMON/chezmoi_check.sh"

# mise更新チェック
[ -f "$SHELL_COMMON/mise_check.sh" ] && source "$SHELL_COMMON/mise_check.sh"
