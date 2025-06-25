# Common shell initialization script for both zsh and bash

# Detect current shell
if [ -n "$ZSH_VERSION" ]; then
  CURRENT_SHELL="zsh"
elif [ -n "$BASH_VERSION" ]; then
  CURRENT_SHELL="bash"
else
  CURRENT_SHELL="sh"  # Fallback
fi

# Set common directory path
if [ -z "$SHELL_COMMON" ]; then
  # Default path for deployed files
  SHELL_COMMON="$HOME/.shell_common"
fi

# Load common environment variables
[ -f "$SHELL_COMMON/env.sh" ] && . "$SHELL_COMMON/env.sh"


# Load common path settings
if [ -f "$SHELL_COMMON/path.sh" ]; then
  source "$SHELL_COMMON/path.sh"

  # Apply paths based on shell type
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    # zsh-specific path handling
    for p in "${COMMON_PATHS[@]}"; do
      path=($p $path)
    done
  else
    # bash-specific path handling
    for p in "${COMMON_PATHS[@]}"; do
      add_to_path "$p"
    done
    export PATH
  fi
fi

# Load common aliases
[ -f "$SHELL_COMMON/aliases.sh" ] && source "$SHELL_COMMON/aliases.sh"

# Load common functions
[ -f "$SHELL_COMMON/functions.sh" ] && source "$SHELL_COMMON/functions.sh"

# Load OS-specific common settings
case "$(uname -s)" in
  Darwin*)
    # macOS
    [ -f "$SHELL_COMMON/darwin.sh" ] && source "$SHELL_COMMON/darwin.sh"
    ;;
  Linux*)
    # Linux
    [ -f "$SHELL_COMMON/linux.sh" ] && source "$SHELL_COMMON/linux.sh"
    # WSL detection
    if grep -q microsoft /proc/version 2>/dev/null; then
      if [ -f "$HOME/.local/bin/wsl2-ssh-agent" ]; then
        eval "$($HOME/.local/bin/wsl2-ssh-agent)"
      fi
      export BROWSER=wslview
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows
    [ -f "$SHELL_COMMON/windows.sh" ] && source "$SHELL_COMMON/windows.sh"
    ;;
esac

# Load common tool integrations
[ -f "$SHELL_COMMON/tools.sh" ] && source "$SHELL_COMMON/tools.sh"

# Shell-specific tool activations
if [ "$HAS_MISE" = "1" ] && [ -f "$HOME/.local/bin/mise" ]; then
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    eval "$($HOME/.local/bin/mise activate zsh)"
  else
    eval "$($HOME/.local/bin/mise activate bash)"
  fi
fi

if [ "$HAS_OPAM" = "1" ] && type opam &>/dev/null; then
  eval "$(opam env)"
fi
