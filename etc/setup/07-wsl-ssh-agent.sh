#!/bin/bash
set -eu

# https://github.com/mame/wsl2-ssh-agent
if [ -n "$(which wslpath)" ]; then
  if ! type wsl2-ssh-agent; then
    curl -L https://github.com/mame/wsl2-ssh-agent/releases/latest/download/wsl2-ssh-agent -o $HOME/.local/bin/wsl2-ssh-agent
    chmod 755 $HOME/.local/bin/wsl2-ssh-agent
    echo "see: https://github.com/mame/wsl2-ssh-agent"
  fi
fi
