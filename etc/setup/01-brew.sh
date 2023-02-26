#!/bin/bash
set -eu

if ! type brew; then

if [ "`uname`" = "Darwin" ]; then
  echo "install Homebrew..."

  # https://brew.sh/index_ja.html
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"

  # https://github.com/rcmdnk/homebrew-file
  brew install rcmdnk/file/brew-file || :
  brew file install
else
  echo "homebrew installation skipped..."
fi

fi
