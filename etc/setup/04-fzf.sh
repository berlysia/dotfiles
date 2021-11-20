#!/bin/bash
set -eu

if ! type fzf; then

git clone --depth 1 https://github.com/junegunn/fzf.git ~/.fzf
~/.fzf/install --completion --key-bindings --no-fish

fi
