#!/bin/sh
set -eu

if type nodebrew; then
  exit
fi

# https://github.com/hokaccha/nodebrew
curl -L git.io/nodebrew | perl - setup
