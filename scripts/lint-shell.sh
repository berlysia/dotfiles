#!/usr/bin/env bash
# shellcheck shell=bash
# Wrapper script for shellcheck to match CI behavior
# Mimics: .github/workflows/ci-shellcheck.yml

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Running shellcheck with CI-equivalent settings..."

# Directories to ignore (same as CI)
IGNORE_PATHS=(
  "node_modules"
  ".git"
  ".tmp"
)

# Build find command to exclude ignored paths
FIND_ARGS=()
for ignore in "${IGNORE_PATHS[@]}"; do
  FIND_ARGS+=(-not -path "*/${ignore}/*")
done

# Find all .sh files (same as CI scandir: '.')
mapfile -t SHELL_FILES < <(find . -type f -name "*.sh" "${FIND_ARGS[@]}" | sort)

if [[ ${#SHELL_FILES[@]} -eq 0 ]]; then
  echo -e "${YELLOW}No shell files found to check${NC}"
  exit 0
fi

echo "Found ${#SHELL_FILES[@]} shell script(s) to check"
echo ""

# Run shellcheck with CI settings (severity: warning)
# Note: .shellcheckrc will be automatically loaded
FAILED=0
for file in "${SHELL_FILES[@]}"; do
  echo "Checking: $file"
  if ! shellcheck --severity=warning "$file"; then
    FAILED=1
  fi
done

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}✓ All shell scripts passed shellcheck${NC}"
  exit 0
else
  echo -e "${RED}✗ Some shell scripts failed shellcheck${NC}"
  exit 1
fi
