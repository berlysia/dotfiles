#!/bin/sh
# Common Windows-specific configuration for all shells (MSYS/MINGW/Cygwin/WSL)

# SSH agent workaround for Windows
if [ -z "$SSH_AUTH_SOCK" ]; then
  # For SSH agent forwarding in WSL
  if [ -f "/proc/version" ] && grep -q "Microsoft" /proc/version; then
    # WSL-specific SSH agent handling
    if [ -x "$HOME/.local/bin/wsl2-ssh-agent" ] && [ -f "${SHELL_COMMON:-$HOME/.shell_common}/wsl_ssh_agent.sh" ]; then
      . "${SHELL_COMMON:-$HOME/.shell_common}/wsl_ssh_agent.sh"
      initialize_wsl_ssh_agent "$HOME/.local/bin/wsl2-ssh-agent"
    fi
  else
    # MSYS/MINGW/Cygwin SSH agent handling
    # Functions, not aliases: this is an env-layer workaround that must also apply to AI shells
    ssh() { MSYS=winsymlinks:nativestrict command ssh "$@"; }
    # shellcheck disable=SC3033 # hyphenated function name is accepted by bash/zsh
    ssh-add() { MSYS=winsymlinks:nativestrict command ssh-add "$@"; }
  fi
fi
