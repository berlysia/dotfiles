#!/usr/bin/env bash
# Smoke fixture: empty HOME. No ~/.claude, ~/.apm or private-skills.
# The settings step must still exit 0 and create ~/.claude/settings.json.
# The runner already provides the isolated HOME; absence of state is the fixture.
set -euo pipefail
:
