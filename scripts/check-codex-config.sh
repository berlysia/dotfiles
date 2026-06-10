#!/usr/bin/env bash
# Check if codex config TOML files are properly formatted
# Usage: ./scripts/check-codex-config.sh
#   - CODEX_CONFIG_FILE set: check that single file only (test/CI override)
#   - unset: check home/dot_codex/.config.toml and every host overlay
#     home/dot_codex/.config.<hostname>.toml that exists
# Exit code 0: properly formatted
# Exit code 1: formatting needed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OXFMT_BIN="${OXFMT_BIN:-${PROJECT_ROOT}/node_modules/.bin/oxfmt}"

# Dependency check
if ! command -v dasel &>/dev/null; then
    echo "❌ Error: dasel is not properly installed" >&2
    echo "   Install: mise install dasel -f" >&2
    exit 1
fi

if ! command -v jq &>/dev/null; then
    echo "❌ Error: jq is not installed" >&2
    echo "   Install: sudo apt-get install jq" >&2
    exit 1
fi

if ! command -v oxfmt &>/dev/null && [[ ! -x "${OXFMT_BIN}" ]]; then
    echo "❌ Error: oxfmt is not properly installed" >&2
    echo "   Install: pnpm install" >&2
    exit 1
fi

run_oxfmt() {
    if command -v oxfmt &>/dev/null; then
        oxfmt "$@"
    else
        "${OXFMT_BIN}" "$@"
    fi
}

check_file() {
    local config_file="$1"
    local temp_json temp_file temp_formatted
    temp_json=$(mktemp)
    temp_file=$(mktemp)
    temp_formatted=$(mktemp)
    # shellcheck disable=SC2064 # expand temp paths now, they are loop-local
    trap "rm -f '$temp_json' '$temp_file' '$temp_formatted'" RETURN

    echo "🔍 Checking ${config_file} formatting..."

    if [[ ! -s "${config_file}" ]]; then
        echo "❌ Error: Config file is empty" >&2
        return 1
    fi

    if ! dasel query --root -i toml -o json < "${config_file}" > "${temp_json}"; then
        echo "❌ Error: Failed to parse TOML" >&2
        return 1
    fi

    local json_content
    json_content=$(<"${temp_json}")
    if [[ "${json_content}" == "{}" ]] || [[ "${json_content}" == "null" ]] || [[ -z "${json_content}" ]]; then
        echo "❌ Error: TOML parsing produced empty result (possibly invalid syntax)" >&2
        return 1
    fi

    if ! jq -S < "${temp_json}" | dasel query --root -i json -o toml > "${temp_file}"; then
        echo "❌ Error: Failed to parse config" >&2
        return 1
    fi

    if ! run_oxfmt --stdin-filepath config.toml < "${temp_file}" > "${temp_formatted}"; then
        echo "❌ Error: Failed to format config with oxfmt" >&2
        return 1
    fi

    if diff -u "${config_file}" "${temp_formatted}" > /dev/null 2>&1; then
        echo "✅ Config is properly formatted"
        return 0
    fi

    echo "❌ Config formatting is incorrect: ${config_file}" >&2
    echo "" >&2
    echo "Expected format:" >&2
    diff -u "${config_file}" "${temp_formatted}" | head -30 >&2
    echo "" >&2
    echo "To fix, run: CODEX_CONFIG_FILE='${config_file}' ./scripts/format-codex-config.sh" >&2
    return 1
}

FILES=()
if [[ -n "${CODEX_CONFIG_FILE:-}" ]]; then
    if [[ ! -f "${CODEX_CONFIG_FILE}" ]]; then
        # When running locally without CI context, skip if file doesn't exist
        # CI uses path filters to only run when the file is present
        echo "⏭️ Skipping: ${CODEX_CONFIG_FILE} not found (this is normal for template-based configs)"
        exit 0
    fi
    FILES+=("${CODEX_CONFIG_FILE}")
else
    BASE_FILE="${PROJECT_ROOT}/home/dot_codex/.config.toml"
    if [[ -f "${BASE_FILE}" ]]; then
        FILES+=("${BASE_FILE}")
    fi
    for overlay in "${PROJECT_ROOT}"/home/dot_codex/.config.*.toml; do
        [[ -f "${overlay}" ]] || continue
        FILES+=("${overlay}")
    done
    if [[ ${#FILES[@]} -eq 0 ]]; then
        echo "⏭️ Skipping: no codex config files found (this is normal for template-based configs)"
        exit 0
    fi
fi

FAILED=0
for f in "${FILES[@]}"; do
    check_file "${f}" || FAILED=1
done

if [[ ${FAILED} -ne 0 ]]; then
    exit 1
fi
exit 0
