#!/bin/bash
set -eu

if ! type bat; then

if type brew > /dev/null 2>&1; then
  echo "install bat via brew"
  brew install bat
elif type apt > /dev/null 2>&1; then
  echo "install bat via apt"
  sudo apt install bat
  ln -s /usr/bin/batcat ~/.bin/bat
else
  echo "bat installation skipped... see https://github.com/sharkdp/bat"
fi

fi

