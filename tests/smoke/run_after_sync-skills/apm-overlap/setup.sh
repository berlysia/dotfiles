#!/usr/bin/env bash
# Smoke fixture: a skill name present in both the apm lock and .skills.
#
# State setup:
#   $HOME/.apm/apm.lock.yaml : lists `koncise` (a real .skills dir) as an
#                              apm-deployed skill with a virtual_path
#
# The sync excludes apm-owned names, so `koncise` must not be deployed, and
# the script must warn about it with a `recover:` field. verify.sh checks both.

set -euo pipefail

mkdir -p "$HOME/.apm"
cat > "$HOME/.apm/apm.lock.yaml" <<'LOCK'
lockfile_version: '1'
dependencies:
- repo_url: example-owner/koncise-upstream
  name: koncise
  virtual_path: skills/koncise
  is_virtual: true
  package_type: claude_skill
  deployed_files:
  - .agents/skills/koncise
  - .claude/skills/koncise
  - .claude/skills/koncise/SKILL.md
  - .claude/skills/koncise/references
LOCK
