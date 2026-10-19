#!/usr/bin/env bash
# Checks for the apm-overlap fixture (see setup.sh).
#
# The runner does not keep the script's output, but it leaves the rendered
# script at $HOME/__rendered.sh, so run it once more here and read its output.

set -euo pipefail

out="$(bash "$HOME/__rendered.sh" 2>&1)"

warnings="$(printf '%s\n' "$out" | grep -c "koncise.*recover: apm uninstall -g example-owner/koncise-upstream/skills/koncise" || true)"
if [[ "$warnings" != 1 ]]; then
  echo "expected exactly 1 warning line with the name and recover:, got $warnings" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
if [[ -e "$HOME/.claude/skills/koncise" || -e "$HOME/.codex/skills/koncise" ]]; then
  echo "koncise was synced although the apm lock owns it" >&2
  exit 1
fi
