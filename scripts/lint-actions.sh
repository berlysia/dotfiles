#!/usr/bin/env bash
# shellcheck shell=bash
# Local counterpart of .github/workflows/lint-actions.yml (jactionlint job)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Running jactionlint on GitHub Actions workflows..."

# jactionlint comes from PATH (the mise global config pins it), like CI's pinned install.
if ! command -v jactionlint &> /dev/null; then
  echo -e "${RED}Error: jactionlint is not installed${NC}"
  echo "Install with: mise install"
  exit 1
fi

# Check if workflows directory exists
if [[ ! -d .github/workflows ]]; then
  echo -e "${YELLOW}No .github/workflows directory found${NC}"
  exit 0
fi

# Count workflow files
WORKFLOW_COUNT=$(find .github/workflows -type f \( -name "*.yml" -o -name "*.yaml" \) | wc -l)

if [[ $WORKFLOW_COUNT -eq 0 ]]; then
  echo -e "${YELLOW}No workflow files found in .github/workflows${NC}"
  exit 0
fi

echo "Found $WORKFLOW_COUNT workflow file(s) to check"
echo ""

# --config-file is explicit because worktrees live under the main checkout's
# .git/, and config discovery can pick up the main checkout's
# .github/jactionlint.yaml instead of this worktree's. Output stays in the
# human-readable text format; CI uses --format github.
if jactionlint --config-file .github/jactionlint.yaml; then
  echo ""
  echo -e "${GREEN}✓ All GitHub Actions workflows passed jactionlint checks${NC}"
  exit 0
else
  echo ""
  echo -e "${RED}✗ Some workflows have security or best practice issues${NC}"
  exit 1
fi
