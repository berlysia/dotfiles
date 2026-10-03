# Common shell initialization script for both zsh and bash

# Detect current shell
# shellcheck disable=SC2206
if [ -n "$ZSH_VERSION" ]; then
  CURRENT_SHELL="zsh"
elif [ -n "$BASH_VERSION" ]; then
  CURRENT_SHELL="bash"
else
  CURRENT_SHELL="sh" # Fallback
fi

# Not exported: lets .bashrc tell whether init.sh ran in this very process
_SHELL_COMMON_INIT_PID=$$

# Set common directory path
if [ -z "$SHELL_COMMON" ]; then
  # Default path for deployed files
  SHELL_COMMON="$HOME/.shell_common"
fi

# shellcheck source=/dev/null
[ -f "$SHELL_COMMON/is_human.sh" ] && . "$SHELL_COMMON/is_human.sh"

# A human shell may have inherited AI values from an AI-judged parent; env.sh below re-sets EDITOR.
command -v is_human >/dev/null 2>&1 && is_human && clear_inherited_ai_env

# Load common environment variables
# shellcheck source=/dev/null # env.sh is rendered from env.sh.tmpl by chezmoi apply
[ -f "$SHELL_COMMON/env.sh" ] && . "$SHELL_COMMON/env.sh"

# AI-only environment; must come after env.sh to override it. Missing is_human falls to human.
if command -v is_human >/dev/null 2>&1 && ! is_human && [ -f "$SHELL_COMMON/ai.env.sh" ]; then
  # shellcheck source=/dev/null
  . "$SHELL_COMMON/ai.env.sh"
fi

# Load common path settings
if [ -f "$SHELL_COMMON/path.sh" ]; then
  . "$SHELL_COMMON/path.sh"

  # Apply paths based on shell type
  # Note: COMMON_PATHS array is bash/zsh specific, but this code only runs in those shells
  # shellcheck disable=SC3054
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    # zsh-specific path handling
    # shellcheck disable=SC2154
    for p in "${COMMON_PATHS[@]}"; do
      # shellcheck disable=SC2128,SC2034,SC3030
      path=($p $path)
    done
  else
    # bash-specific path handling
    # shellcheck disable=SC2154
    for p in "${COMMON_PATHS[@]}"; do
      add_to_path "$p"
    done
    export PATH
  fi
fi

# Load common functions
[ -f "$SHELL_COMMON/functions.sh" ] && . "$SHELL_COMMON/functions.sh"

# Load OS-specific common settings
case "$(uname -s)" in
  Darwin*)
    # macOS
    [ -f "$SHELL_COMMON/darwin.sh" ] && . "$SHELL_COMMON/darwin.sh"
    ;;
  Linux*)
    # Linux
    [ -f "$SHELL_COMMON/linux.sh" ] && . "$SHELL_COMMON/linux.sh"
    # WSL detection
    # shellcheck disable=SC2263 # plain grep is wanted; color aliases live in the human layer and are not defined here
    if grep -q microsoft /proc/version 2>/dev/null; then
      if [ -x "$HOME/.local/bin/wsl2-ssh-agent" ] && [ -f "$SHELL_COMMON/wsl_ssh_agent.sh" ]; then
        . "$SHELL_COMMON/wsl_ssh_agent.sh"
        initialize_wsl_ssh_agent "$HOME/.local/bin/wsl2-ssh-agent"
      fi
      export BROWSER=wslview
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    # Windows
    [ -f "$SHELL_COMMON/windows.sh" ] && . "$SHELL_COMMON/windows.sh"
    ;;
esac

# Load common tool integrations
[ -f "$SHELL_COMMON/tools.sh" ] && . "$SHELL_COMMON/tools.sh"

# Aikido Safe Chain: wrap package managers with malware scanning, in every shell (AI included).
# Loaded before mise activate: its init script runs `cd`, which would otherwise fire mise's
# chpwd hook and re-run `mise hook-env` (~70ms per shell). It appends to PATH, so the order
# does not change PATH precedence. The script appends its bin dir unconditionally, so keep
# the previous PATH when a parent shell already added it (nested shells would duplicate it).
if [ -f "$HOME/.safe-chain/scripts/init-posix.sh" ]; then
  _sc_prev_path=$PATH
  # shellcheck source=/dev/null
  . "$HOME/.safe-chain/scripts/init-posix.sh"
  case ":$_sc_prev_path:" in
    *":$HOME/.safe-chain/bin:"*) PATH=$_sc_prev_path ;;
  esac
  unset _sc_prev_path
fi

# Shell-specific tool activations
# shellcheck disable=SC2154
if [ "$HAS_MISE" = "1" ] && [ -f "$HOME/.local/bin/mise" ]; then
  if [ "$CURRENT_SHELL" = "zsh" ]; then
    eval "$("$HOME"/.local/bin/mise activate zsh)"
    eval "$("$HOME"/.local/bin/mise hook-env -s zsh)"
  else
    eval "$("$HOME"/.local/bin/mise activate bash)"
    eval "$("$HOME"/.local/bin/mise hook-env -s bash)"
  fi
fi

# Load Rust/Cargo environment
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null # installed by rustup, outside this repository
  . "$HOME/.cargo/env"
fi

# shellcheck disable=SC2154
if [ "$HAS_OPAM" = "1" ] && type opam >/dev/null 2>&1; then
  eval "$(opam env)"
fi
