#!/bin/bash
set -eu

if ! type fzf; then

if type brew > /dev/null 2>&1; then
  echo "install fzf via brew"
  brew install fzf
  $(brew --prefix)/opt/fzf/install
elif type apt > /dev/null 2>&1; then
  echo "install fzf via apt"
  sudo apt install fzf
else
  # git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
  # ~/.fzf/install
  echo "fzf installation skipped... see https://github.com/junegunn/fzf"
fi

fi
