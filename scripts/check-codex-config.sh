#!/usr/bin/env bash
# Check if home/dot_codex/.config.toml is properly formatted
# Usage: ./scripts/check-codex-config.sh
# Exit code 0: properly formatted
# Exit code 1: formatting needed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${CODEX_CONFIG_FILE:-${PROJECT_ROOT}/home/dot_codex/.config.toml}"
OXFMT_BIN="${OXFMT_BIN:-${PROJECT_ROOT}/node_modules/.bin/oxfmt}"

# Check if config file exists
if [[ ! -f "${CONFIG_FILE}" ]]; then
    # When running locally without CI context, skip if file doesn't exist
    # CI uses path filters to only run when the file is present
    echo "⏭️ Skipping: ${CONFIG_FILE} not found (this is normal for template-based configs)"
    exit 0
fi

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

# Generate formatted version
echo "🔍 Checking ${CONFIG_FILE} formatting..."
TEMP_FILE=$(mktemp)
TEMP_JSON=$(mktemp)
TEMP_FORMATTED=$(mktemp)
trap 'rm -f "$TEMP_FILE" "$TEMP_JSON" "$TEMP_FORMATTED"' EXIT

run_oxfmt() {
    if command -v oxfmt &>/dev/null; then
        oxfmt "$@"
    else
        "${OXFMT_BIN}" "$@"
    fi
}

# Check if file has content
if [[ ! -s "${CONFIG_FILE}" ]]; then
    echo "❌ Error: Config file is empty" >&2
    exit 1
fi

# Parse TOML to JSON
if ! dasel query --root -i toml -o json < "${CONFIG_FILE}" > "${TEMP_JSON}"; then
    echo "❌ Error: Failed to parse TOML" >&2
    exit 1
fi

# Check if parsing resulted in empty output
JSON_CONTENT=$(<"${TEMP_JSON}")
if [[ "${JSON_CONTENT}" == "{}" ]] || [[ "${JSON_CONTENT}" == "null" ]] || [[ -z "${JSON_CONTENT}" ]]; then
    echo "❌ Error: TOML parsing produced empty result (possibly invalid syntax)" >&2
    exit 1
fi

# Sort and convert back to TOML
if ! jq -S < "${TEMP_JSON}" | dasel query --root -i json -o toml > "${TEMP_FILE}"; then
    echo "❌ Error: Failed to parse config" >&2
    exit 1
fi

if ! run_oxfmt --stdin-filepath config.toml < "${TEMP_FILE}" > "${TEMP_FORMATTED}"; then
    echo "❌ Error: Failed to format config with oxfmt" >&2
    exit 1
fi

mv "${TEMP_FORMATTED}" "${TEMP_FILE}"

# Compare with original
if diff -u "${CONFIG_FILE}" "${TEMP_FILE}" > /dev/null 2>&1; then
    echo "✅ Config is properly formatted"
    exit 0
else
    echo "❌ Config formatting is incorrect" >&2
    echo "" >&2
    echo "Expected format:" >&2
    diff -u "${CONFIG_FILE}" "${TEMP_FILE}" | head -30 >&2
    echo "" >&2
    echo "To fix, run: ./scripts/format-codex-config.sh" >&2
    exit 1
fi
