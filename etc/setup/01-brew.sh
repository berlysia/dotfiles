#!/bin/bash
set -eu

if ! type brew; then

if [ "`uname`" = "Darwin" ]; then
  echo "install Homebrew..."

  # https://brew.sh/index_ja.html
  /usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"

  # https://github.com/rcmdnk/homebrew-file
  brew install rcmdnk/file/brew-file || :
  brew file install
else
  echo "Homebrew install -> skip"
fi

fi
