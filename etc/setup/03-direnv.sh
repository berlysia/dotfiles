#!/bin/bash
set -eu

if type direnv; then
  exit
fi

curl -sfL https://direnv.net/install.sh | bash
