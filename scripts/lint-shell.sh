#!/usr/bin/env bash
# shellcheck shell=bash
# Single source of truth for shellcheck target discovery.
# Both local development and CI should invoke this script directly.

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "Running shellcheck with CI-equivalent settings..."

# Directories to ignore during target discovery
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

# Find all .sh files to check
# Use while-read loop instead of mapfile for macOS compatibility (Bash 3.2)
SHELL_FILES=()
while IFS= read -r file; do
  SHELL_FILES+=("$file")
done < <(find . -type f -name "*.sh" "${FIND_ARGS[@]}" | sort)

# Find all .sh.tmpl files (chezmoi templates that contain shell scripts)
TEMPLATE_FILES=()
while IFS= read -r file; do
  TEMPLATE_FILES+=("$file")
done < <(find . -type f -name "*.sh.tmpl" "${FIND_ARGS[@]}" | sort)

TOTAL=$((${#SHELL_FILES[@]} + ${#TEMPLATE_FILES[@]}))
if [[ ${TOTAL} -eq 0 ]]; then
  echo -e "${YELLOW}No shell files found to check${NC}"
  exit 0
fi

echo "Found ${#SHELL_FILES[@]} .sh and ${#TEMPLATE_FILES[@]} .sh.tmpl file(s) to check"
echo ""

# Run shellcheck with repository-standard settings
# Note: .shellcheckrc will be automatically loaded
FAILED=0

for file in "${SHELL_FILES[@]}"; do
  echo "Checking: $file"
  if ! shellcheck --severity=warning "$file"; then
    FAILED=1
  fi
done

# .sh.tmpl: render via chezmoi execute-template, then shellcheck the rendered output.
# Output paths are rewritten back to the original .sh.tmpl path so users can
# navigate to the source location.
if [[ ${#TEMPLATE_FILES[@]} -gt 0 ]]; then
  if ! command -v chezmoi >/dev/null 2>&1; then
    echo -e "${RED}chezmoi is required to lint .sh.tmpl files but was not found${NC}"
    echo "Install chezmoi (https://www.chezmoi.io/install/) and re-run."
    exit 1
  fi

  # Source path for chezmoi execute-template. This repo follows the convention
  # of placing source state under ./home (see .chezmoiroot at the repo root).
  CHEZMOI_SOURCE_PATH="${PWD}/home"

  TMPDIR_RENDER=$(mktemp -d)
  trap 'rm -rf "${TMPDIR_RENDER}"' EXIT

  # Make .shellcheckrc directives (e.g., disable=SC1090) reachable from the
  # rendered file's directory, since the linter walks up from each file's dir
  # to find the rc file.
  if [[ -f "${PWD}/.shellcheckrc" ]]; then
    cp "${PWD}/.shellcheckrc" "${TMPDIR_RENDER}/.shellcheckrc"
  fi

  for file in "${TEMPLATE_FILES[@]}"; do
    # Use a deterministic, collision-free name for the rendered file so the
    # linter diagnostics carry a recognisable suffix.
    rendered_name=$(echo "${file#./}" | tr '/' '_')
    rendered="${TMPDIR_RENDER}/${rendered_name%.tmpl}"

    if ! chezmoi execute-template --source "${CHEZMOI_SOURCE_PATH}" < "$file" > "$rendered" 2>"${TMPDIR_RENDER}/render.err"; then
      echo -e "${RED}Template render failed: $file${NC}"
      cat "${TMPDIR_RENDER}/render.err" >&2
      FAILED=1
      continue
    fi

    # Skip empty renders: when a template is OS-gated (e.g., darwin-only on
    # Linux), the rendered output may be empty or whitespace-only. There is
    # nothing meaningful to lint in that case.
    if ! grep -qv '^[[:space:]]*\(#.*\)\?$' "$rendered" 2>/dev/null; then
      echo "Skipping (empty render on this OS): $file"
      continue
    fi

    echo "Checking (rendered): $file"
    # --shell=bash forces shell detection for templates that may render
    # without a shebang on certain OS branches.
    if ! shellcheck --shell=bash --severity=warning "$rendered" 2>&1 | sed "s|${rendered}|${file} (rendered)|g"; then
      FAILED=1
    fi
  done
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}✓ All shell scripts passed shellcheck${NC}"
  exit 0
else
  echo -e "${RED}✗ Some shell scripts failed shellcheck${NC}"
  exit 1
fi
