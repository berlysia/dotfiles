#!/bin/sh
# Common Windows-specific configuration for all shells (MSYS/MINGW/Cygwin/WSL)

# Windows specific aliases
alias explorer='explorer.exe'
alias notepad='notepad.exe'
alias cmd='cmd.exe /c'
alias pwsh='powershell.exe -Command'

# SSH agent workaround for Windows
if [ -z "$SSH_AUTH_SOCK" ]; then
  # For SSH agent forwarding in WSL
  if [ -f "/proc/version" ] && grep -q "Microsoft" /proc/version; then
    # WSL-specific SSH agent handling
    if [ -f "$HOME/.local/bin/wsl2-ssh-agent" ]; then
      eval "$($HOME/.local/bin/wsl2-ssh-agent)"
    fi
  else
    # MSYS/MINGW/Cygwin SSH agent handling
    alias ssh='MSYS=winsymlinks:nativestrict ssh'
    alias ssh-add='MSYS=winsymlinks:nativestrict ssh-add'
  fi
fi
