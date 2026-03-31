#!/usr/bin/env bash
# Format home/dot_codex/.config.toml with normalized TOML structure
# Usage: ./scripts/format-codex-config.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${CODEX_CONFIG_FILE:-${PROJECT_ROOT}/home/dot_codex/.config.toml}"
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

# Check if config file exists
if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo "❌ Error: ${CONFIG_FILE} not found" >&2
    exit 1
fi

# Format: TOML -> JSON -> sorted JSON -> TOML
echo "📝 Formatting ${CONFIG_FILE}..."
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
    echo "❌ Error: Failed to format config" >&2
    exit 1
fi

if ! run_oxfmt --stdin-filepath config.toml < "${TEMP_FILE}" > "${TEMP_FORMATTED}"; then
    echo "❌ Error: Failed to format config with oxfmt" >&2
    exit 1
fi

mv "${TEMP_FORMATTED}" "${TEMP_FILE}"

# Replace original file
mv "${TEMP_FILE}" "${CONFIG_FILE}"
echo "✅ Formatted successfully"
