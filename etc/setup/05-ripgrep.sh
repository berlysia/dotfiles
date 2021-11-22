#!/bin/bash
set -eu

if ! type rg; then

if type brew > /dev/null 2>&1; then
  echo "install ripgrep via brew"
  brew install ripgrep
elif type apt > /dev/null 2>&1; then
  echo "install ripgrep via apt"
  sudo apt install ripgrep
else
  echo "ripgrep installation skipped... see https://github.com/BurntSushi/ripgrep"
fi

fi

