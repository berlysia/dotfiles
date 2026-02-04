#!/usr/bin/env bash
# CI Test Coverage Check using Claude Code headless mode
#
# Usage:
#   Copy this template to your project and adapt the configuration.
#   Requires ANTHROPIC_API_KEY in CI environment secrets.
#
# Example GitHub Actions step:
#   - name: Check test coverage for changed files
#     env:
#       ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
#     run: bash scripts/ci-test-coverage-check.sh

set -euo pipefail

# Configuration - adapt to your project
DIFF_TARGET="${1:-origin/main}"
ALLOWED_TOOLS="Bash,Read,Grep,Glob"
MAX_TURNS="${MAX_TURNS:-10}"

# Get changed files
DIFF=$(git diff "$DIFF_TARGET" --name-only -- '*.ts' '*.tsx' '*.js' '*.jsx' | head -50)

if [ -z "$DIFF" ]; then
  echo "No source files changed, skipping coverage check."
  exit 0
fi

echo "Checking test coverage for changed files:"
echo "$DIFF"
echo "---"

claude -p "$(cat <<EOF
Review the following changed files and check if all changed functions have corresponding test coverage.

Changed files:
$DIFF

Steps:
1. Read each changed file and identify exported functions/classes
2. Search for existing test files that cover these functions
3. Report which functions lack test coverage

Output format:
- List each function with its coverage status (covered/missing)
- For missing coverage, suggest what tests should be added
- Exit with a summary: "X of Y functions have test coverage"
EOF
)" --allowedTools "$ALLOWED_TOOLS" --max-turns "$MAX_TURNS"
