#!/usr/bin/env bash
# Smoke fixture: apm.lock.yaml present, private-skills absent.
#
# State setup:
#   $HOME/.apm/apm.lock.yaml             : present (one synthetic skill entry)
#   $HOME/.local/share/private-skills/   : ABSENT
#
# With apm present and private-skills absent, EXCLUDE_ARGS gets one element
# while PRIVATE_EXCLUDE_ARGS stays empty. This independently verifies the
# PRIVATE_EXCLUDE_ARGS guard: removing only the PRIVATE_EXCLUDE_ARGS guard
# from the rsync line would still pass empty-env (both empty masks the
# distinction) but would fail this fixture under bash < 5.2.

set -euo pipefail

mkdir -p "$HOME/.apm"
cat > "$HOME/.apm/apm.lock.yaml" <<'EOF'
# Synthetic apm.lock.yaml for smoke testing.
# The target script greps for lines matching '^  - \.claude/skills/'.
artifacts:
  - .claude/skills/synthetic-skill-for-smoke
EOF
