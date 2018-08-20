#!/bin/sh
set -eu

cd `dirname $0`

for file in `ls ./setup`
do
  sh ./setup/$file
done
