#!/usr/bin/env bash
# Format dot_codex/config.toml with normalized TOML structure
# Usage: ./scripts/format-codex-config.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${CODEX_CONFIG_FILE:-${PROJECT_ROOT}/dot_codex/config.toml}"

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

# Check if config file exists
if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo "❌ Error: ${CONFIG_FILE} not found" >&2
    exit 1
fi

# Format: TOML -> JSON -> sorted JSON -> TOML
echo "📝 Formatting ${CONFIG_FILE}..."
TEMP_FILE=$(mktemp)
TEMP_JSON=$(mktemp)
trap 'rm -f "$TEMP_FILE" "$TEMP_JSON"' EXIT

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

# Replace original file
mv "${TEMP_FILE}" "${CONFIG_FILE}"
echo "✅ Formatted successfully"
