#!/usr/bin/env bash
# Format home/dot_codex/.config.toml with normalized TOML structure
# Usage: ./scripts/format-codex-config.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${CODEX_CONFIG_FILE:-${PROJECT_ROOT}/home/dot_codex/.config.toml}"
OXFMT_BIN="${OXFMT_BIN:-${PROJECT_ROOT}/node_modules/.bin/oxfmt}"

# Dependency check
if ! command -v chezmoi &>/dev/null; then
    echo "❌ Error: chezmoi is not installed (it parses the TOML)" >&2
    echo "   Install: sh -c \"\$(curl -fsLS get.chezmoi.io)\" -- -b \"\$HOME/.local/bin\"" >&2
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

# Format: oxfmt normalizes whitespace only (spec R6: key order and quote style are left as written)
echo "📝 Formatting ${CONFIG_FILE}..."
TEMP_FORMATTED=$(mktemp)
trap 'rm -f "$TEMP_FORMATTED"' EXIT

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

# Parse only to prove the file is TOML with at least one key
if ! KEY_COUNT=$(chezmoi execute-template --with-stdin '{{ .chezmoi.stdin | fromToml | len }}' < "${CONFIG_FILE}" 2>/dev/null); then
    echo "❌ Error: Failed to parse TOML" >&2
    exit 1
fi
if [[ "${KEY_COUNT}" == 0 ]]; then
    echo "❌ Error: TOML parsing produced empty result (possibly invalid syntax)" >&2
    exit 1
fi

if ! run_oxfmt --stdin-filepath config.toml < "${CONFIG_FILE}" > "${TEMP_FORMATTED}"; then
    echo "❌ Error: Failed to format config with oxfmt" >&2
    exit 1
fi

# Replace original file
mv "${TEMP_FORMATTED}" "${CONFIG_FILE}"
echo "✅ Formatted successfully"
