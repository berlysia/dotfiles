#!/usr/bin/env bash
# Verify environment-scoped secrets for claude-action-bootstrap skill.
# Run from the target repository root AFTER Step 5 (env creation + secret registration).
# Env overrides:
#   MANUAL_ENV   (default: claude-manual)
#   AUTOFIX_ENV  (default: claude-autofix; set empty to skip autofix check)
#   SECRET_NAME  (default: CLAUDE_CODE_OAUTH_TOKEN)

set -uo pipefail

PASS="\033[32m[✓]\033[0m"
FAIL="\033[31m[✗]\033[0m"
WARN="\033[33m[!]\033[0m"
FAILED=0

report_pass() { printf "%b %s\n" "${PASS}" "$1"; }
report_fail() {
  printf "%b %s\n" "${FAIL}" "$1"
  [[ -n "${2:-}" ]] && printf "    → %s\n" "$2"
  FAILED=$((FAILED + 1))
}
report_warn() {
  printf "%b %s\n" "${WARN}" "$1"
  [[ -n "${2:-}" ]] && printf "    → %s\n" "$2"
}

MANUAL_ENV="${MANUAL_ENV:-claude-manual}"
AUTOFIX_ENV="${AUTOFIX_ENV-claude-autofix}"
SECRET_NAME="${SECRET_NAME:-CLAUDE_CODE_OAUTH_TOKEN}"

echo "== Claude Action Bootstrap Secrets Verification =="
echo
echo "MANUAL_ENV=${MANUAL_ENV}"
echo "AUTOFIX_ENV=${AUTOFIX_ENV:-<skipped>}"
echo "SECRET_NAME=${SECRET_NAME}"
echo

if ! REPO_SLUG=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null); then
  report_fail "repository: cannot resolve via gh repo view" "cd into the target repository"
  exit 1
fi
report_pass "repository: ${REPO_SLUG}"

check_env() {
  local env_name="$1"
  local label="$2"

  if ! gh api "repos/${REPO_SLUG}/environments/${env_name}" >/dev/null 2>&1; then
    report_fail "${label} environment: ${env_name} not found" \
      "gh api -X PUT repos/${REPO_SLUG}/environments/${env_name}"
    return
  fi
  report_pass "${label} environment: ${env_name} exists"

  local secrets
  if ! secrets=$(gh api "repos/${REPO_SLUG}/environments/${env_name}/secrets" --jq '.secrets[].name' 2>/dev/null); then
    report_fail "${label} secret: cannot list secrets for ${env_name}" \
      "Check gh token scopes (needs repo admin)"
    return
  fi

  if grep -qx "${SECRET_NAME}" <<<"${secrets}"; then
    report_pass "${label} secret: ${SECRET_NAME} set in ${env_name}"
  else
    report_fail "${label} secret: ${SECRET_NAME} not set in ${env_name}" \
      "gh secret set ${SECRET_NAME} --env ${env_name}"
  fi
}

check_env "${MANUAL_ENV}" "manual"
if [[ -n "${AUTOFIX_ENV}" ]]; then
  check_env "${AUTOFIX_ENV}" "autofix"
fi

# Repo-level 誤登録検知（env secret が優先されるが、不要な repo secret は削除推奨）
if repo_secrets=$(gh api "repos/${REPO_SLUG}/actions/secrets" --jq '.secrets[].name' 2>/dev/null); then
  if grep -qx "${SECRET_NAME}" <<<"${repo_secrets}"; then
    report_warn "repository-level: ${SECRET_NAME} is also set at repo level" \
      "Env-scoped secret takes precedence for jobs with 'environment:', but repo-level is unnecessary. Consider: gh secret delete ${SECRET_NAME}"
  fi
fi

echo
if [[ "${FAILED}" -eq 0 ]]; then
  echo "All secrets verified. Proceed to Step 6."
  exit 0
else
  echo "${FAILED} check(s) failed. Resolve the items above before proceeding to Step 6."
  exit 1
fi
