#!/bin/sh
set -eu

case ${OSTYPE} in
  darwin*)
  echo "[start] install Homebrew"

  # https://brew.sh/index_ja.html
  /usr/bin/ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"

  # https://github.com/rcmdnk/homebrew-file
  brew install rcmdnk/file/brew-file || :
  brew file install
  ;;

  *)

  echo "[skip] install Homebrew"
esac
