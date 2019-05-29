#!/bin/sh
set -eu

if type nodenv; then
  exit
fi

brew install nodenv node-build
