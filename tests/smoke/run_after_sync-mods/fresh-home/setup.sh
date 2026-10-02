#!/usr/bin/env bash
# Smoke fixture: fresh HOME — not even ~/.claude exists.
#
# State setup:
#   $HOME/.claude/   : ABSENT
#
# The target script must create ~/.claude/mods itself and rsync every mod under the repo's mods/.
# The script verifies plugin.json and hooks.json at the destination and exits non-zero otherwise;
# the smoke harness only reads that exit code.

set -euo pipefail

# Absence of state IS the fixture; the runner already provides an isolated HOME.
:
