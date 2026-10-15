#!/usr/bin/env bash
# Smoke fixture: an existing skills root with a mode no umask produces, and
# stale copies whose executable bit disagrees with git.
#
# State setup:
#   $HOME/.claude/skills/                                          : mode 700
#   .../claude-action-bootstrap/scripts/verify-secrets.sh          : mode 644 (100755 in git)
#   .../claude-action-bootstrap/SKILL.md                           : mode 755 (100644 in git)
#
# chezmoi manages ~/.claude/skills (parent of its externals) and records its
# mode; the sync must leave that mode alone or the next apply stops with
# "has changed since chezmoi last wrote it?". 700 survives only if the rsync
# does not copy .skills/'s directory mode onto the root. The two stale copies
# check that the executable bit still follows git in both directions. rsync
# updates attributes even when it skips the content, so the stub contents do
# not matter.

set -euo pipefail

skill_dir="$HOME/.claude/skills/claude-action-bootstrap"
mkdir -p "$skill_dir/scripts"
chmod 700 "$HOME/.claude/skills"
: > "$skill_dir/scripts/verify-secrets.sh"
chmod 644 "$skill_dir/scripts/verify-secrets.sh"
: > "$skill_dir/SKILL.md"
chmod 755 "$skill_dir/SKILL.md"
