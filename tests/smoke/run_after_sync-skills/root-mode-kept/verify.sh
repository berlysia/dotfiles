#!/usr/bin/env bash
# Checks for the root-mode-kept fixture (see setup.sh).

set -euo pipefail

root="$HOME/.claude/skills"
skill_dir="$root/claude-action-bootstrap"

if [[ "$(uname)" == Linux ]]; then
  root_mode="$(stat -c %a "$root")"
else
  root_mode="$(stat -f %Lp "$root")"
fi

if [[ ! "$root_mode" =~ ^[0-7]{3,4}$ ]]; then
  echo "could not read the mode of $root (got '$root_mode')" >&2
  exit 1
fi
if [[ "$root_mode" != 700 ]]; then
  echo "$root is $root_mode after the sync, expected 700: the rsync copied .skills/'s directory mode onto the root" >&2
  exit 1
fi
if [[ ! -x "$skill_dir/scripts/verify-secrets.sh" ]]; then
  echo "verify-secrets.sh is not executable: the executable bit did not follow git" >&2
  exit 1
fi
if [[ -x "$skill_dir/SKILL.md" ]]; then
  echo "SKILL.md is executable: the cleared executable bit did not follow git" >&2
  exit 1
fi
