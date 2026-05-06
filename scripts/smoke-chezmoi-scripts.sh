#!/usr/bin/env bash
# shellcheck shell=bash
# Smoke test runner for chezmoi script templates.
#
# Layout convention:
#   tests/smoke/<script-name>/<scenario>/setup.sh
#
# <script-name> matches the basename of a template under
# home/.chezmoiscripts/<script-name>.sh.tmpl. For each scenario:
#   1. Allocate an isolated HOME directory (mktemp -d).
#   2. Run setup.sh with HOME pointed at the tempdir to construct the
#      scenario state (e.g. write a dummy ~/.apm/apm.lock.yaml).
#   3. chezmoi execute-template the target script.
#   4. Execute the rendered script under the same isolated HOME.
#   5. Pass if exit code is 0; fail with a stderr dump of the rendered
#      script otherwise.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHEZMOI_SOURCE_PATH="${REPO_ROOT}/home"
SMOKE_ROOT="${REPO_ROOT}/tests/smoke"

if [[ ! -d "$SMOKE_ROOT" ]]; then
  echo -e "${YELLOW}No smoke fixtures found at ${SMOKE_ROOT}${NC}"
  exit 0
fi

if ! command -v chezmoi >/dev/null 2>&1; then
  echo -e "${RED}chezmoi is required but not found${NC}"
  exit 1
fi

# Single tmp parent dir cleaned up on exit, regardless of which iteration
# the script dies in.
SMOKE_TMP_ROOT=$(mktemp -d -t chezmoi-smoke-XXXXXX)
trap 'rm -rf "${SMOKE_TMP_ROOT}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

shopt -s nullglob

for script_dir in "${SMOKE_ROOT}"/*/; do
  script_name="$(basename "$script_dir")"
  template_path="${CHEZMOI_SOURCE_PATH}/.chezmoiscripts/${script_name}.sh.tmpl"

  if [[ ! -f "$template_path" ]]; then
    echo -e "${RED}Target template not found for fixture group '${script_name}': ${template_path}${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  for scenario_dir in "${script_dir}"*/; do
    scenario_name="$(basename "$scenario_dir")"
    setup_script="${scenario_dir}setup.sh"

    if [[ ! -f "$setup_script" ]]; then
      echo -e "${YELLOW}No setup.sh in ${scenario_dir}, skipping${NC}"
      continue
    fi

    echo "═══════════════════════════════════════════════"
    echo "Smoke: ${script_name} / ${scenario_name}"
    echo "═══════════════════════════════════════════════"

    smoke_home="${SMOKE_TMP_ROOT}/${script_name}__${scenario_name}"
    mkdir -p "$smoke_home"
    rendered="${smoke_home}/__rendered.sh"

    if ! HOME="$smoke_home" bash "$setup_script"; then
      echo -e "${RED}✗ setup.sh failed${NC}"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      continue
    fi

    if ! chezmoi execute-template --source "$CHEZMOI_SOURCE_PATH" < "$template_path" > "$rendered"; then
      echo -e "${RED}✗ template render failed${NC}"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      continue
    fi

    if HOME="$smoke_home" bash "$rendered"; then
      echo -e "${GREEN}✓ PASS${NC}"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      exit_code=$?
      echo -e "${RED}✗ FAIL (rendered script exited with ${exit_code})${NC}"
      {
        echo "--- rendered script (${template_path}) ---"
        cat "$rendered"
        echo "--- end rendered ---"
      } >&2
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  done
done

echo ""
echo "Smoke summary: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
