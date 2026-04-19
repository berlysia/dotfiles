#!/usr/bin/env bash
# Verify prerequisites for claude-action-bootstrap skill.
# Run from the target repository root. Exits 0 only when all checks pass.

set -uo pipefail

PASS="\033[32m[✓]\033[0m"
FAIL="\033[31m[✗]\033[0m"
FAILED=0

report_pass() { printf "%b %s\n" "${PASS}" "$1"; }
report_fail() {
  printf "%b %s\n" "${FAIL}" "$1"
  [[ -n "${2:-}" ]] && printf "    → %s\n" "$2"
  FAILED=$((FAILED + 1))
}

echo "== Claude Action Bootstrap Prerequisites =="
echo

# 1. gh CLI installed
if command -v gh >/dev/null 2>&1; then
  GH_VERSION=$(gh --version 2>&1 | head -n1)
  report_pass "gh CLI: ${GH_VERSION}"
else
  report_fail "gh CLI: not installed" "https://cli.github.com/ or mise use -g gh@latest"
fi

# 2. gh CLI authenticated
if [[ "${FAILED}" -eq 0 ]] && gh auth status >/dev/null 2>&1; then
  GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
  report_pass "gh auth: authenticated as ${GH_USER}"
else
  report_fail "gh auth: not authenticated" "gh auth login"
fi

# 3. Target repository context (must be run from inside a git repo)
REPO_SLUG=""
if git rev-parse --show-toplevel >/dev/null 2>&1; then
  if REPO_SLUG=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null); then
    report_pass "repository: ${REPO_SLUG}"
  else
    report_fail "repository: cannot resolve via gh repo view" "Ensure the current directory is a GitHub-hosted repo with an 'origin' remote"
    REPO_SLUG=""
  fi
else
  report_fail "repository: not inside a git working tree" "cd into the target repository first"
fi

# 4. Admin permission on the target repo
if [[ -n "${REPO_SLUG}" ]]; then
  ADMIN=$(gh api "repos/${REPO_SLUG}" --jq '.permissions.admin' 2>/dev/null || echo "false")
  if [[ "${ADMIN}" = "true" ]]; then
    report_pass "admin access: ${REPO_SLUG}"
  else
    report_fail "admin access: insufficient on ${REPO_SLUG}" "Request admin or use a different repository"
  fi
fi

# 5. actionlint
if command -v actionlint >/dev/null 2>&1; then
  ACTIONLINT_VERSION=$(actionlint -version 2>&1 | head -n1)
  report_pass "actionlint: ${ACTIONLINT_VERSION}"
else
  report_fail "actionlint: not installed" "mise use -g actionlint@latest"
fi

# 6. zizmor
if command -v zizmor >/dev/null 2>&1; then
  ZIZMOR_VERSION=$(zizmor --version 2>&1 | head -n1)
  report_pass "zizmor: ${ZIZMOR_VERSION}"
else
  report_fail "zizmor: not installed" "mise use -g zizmor@latest (or cargo install zizmor)"
fi

# 7. Informational: auto-merge state (NOT a hard prerequisite)
if [[ -n "${REPO_SLUG}" ]]; then
  AUTO_MERGE=$(gh api "repos/${REPO_SLUG}" --jq '.allow_auto_merge' 2>/dev/null || echo "unknown")
  echo
  echo "-- Informational --"
  echo "allow_auto_merge: ${AUTO_MERGE} (Step 5 enables this if auto-fix workflow is installed)"
fi

echo
if [[ "${FAILED}" -eq 0 ]]; then
  echo "All prerequisites satisfied. Proceed to Step 1."
  exit 0
else
  echo "${FAILED} check(s) failed. Resolve the items above before proceeding."
  exit 1
fi
