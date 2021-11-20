#!/bin/bash
set -eu

if ! type direnv; then

asdf plugin-add direnv
asdf install direnv latest
asdf global  direnv $(asdf list-all direnv | tail -n 1)

fi
