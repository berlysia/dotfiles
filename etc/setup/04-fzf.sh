#!/bin/bash
set -eu

if type fzf; then
  exit
fi

git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
~/.fzf/install --completion --key-bindings --no-fish
