#!/usr/bin/env bash
# shellcheck shell=bash
# Wrapper script for zizmor to match CI behavior
# Mimics: .github/workflows/lint-actions.yml (zizmor job)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Running zizmor on GitHub Actions workflows..."

# Check if zizmor is installed
if ! command -v zizmor &> /dev/null; then
  echo -e "${RED}Error: zizmor is not installed${NC}"
  echo "Install with: mise install cargo-zizmor"
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

# Run zizmor (mimics zizmor-action behavior)
# The action runs: zizmor --format sarif .github/workflows > results.sarif
# For local use, we'll use human-readable format
if zizmor .github/workflows; then
  echo ""
  echo -e "${GREEN}✓ All GitHub Actions workflows passed zizmor checks${NC}"
  exit 0
else
  echo ""
  echo -e "${RED}✗ Some workflows have security or best practice issues${NC}"
  exit 1
fi
