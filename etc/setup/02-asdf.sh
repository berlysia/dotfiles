#!/bin/bash
set -eu

if ! type asdf; then

# https://asdf-vm.com/
git clone https://github.com/asdf-vm/asdf.git ~/.asdf
cd ~/.asdf
git checkout "$(git describe --abbrev=0 --tags)"

fi
