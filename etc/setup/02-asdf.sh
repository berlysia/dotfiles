#!/bin/bash
set -eu

if ! type asdf; then

if [ -e ~/.asdf ]; then
  echo "初期設定時の注意: シェルの再起動はしたか？"
fi

# https://asdf-vm.com/
git clone https://github.com/asdf-vm/asdf.git ~/.asdf
cd ~/.asdf
git checkout "$(git describe --abbrev=0 --tags)"

fi
