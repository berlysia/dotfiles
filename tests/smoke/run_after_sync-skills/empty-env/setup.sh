#!/usr/bin/env bash
# Smoke fixture: empty environment — the original bug's repro condition.
#
# State setup:
#   $HOME/.apm/apm.lock.yaml             : ABSENT
#   $HOME/.local/share/private-skills/   : ABSENT
#
# With both absent, the target script's EXCLUDE_ARGS and PRIVATE_EXCLUDE_ARGS
# arrays remain empty; the rsync line then expands "${arr[@]}" under set -u,
# which errors on bash < 5.2 (the originally-reported failure).
#
# repro_before:  986c2e8^   (parent of the fix commit)
# fixed_in:      986c2e8    (rsync expansion guarded with ${arr[@]+"${arr[@]}"})
# reproduces_on: bash < 5.2 (5.2+ silently tolerates empty-array expansion,
#                            so this fixture only catches regressions on CI
#                            runners pinned to ubuntu-22.04 / bash 5.1.16).

set -euo pipefail

# Absence of state IS the fixture; the runner already provides an isolated HOME.
:
