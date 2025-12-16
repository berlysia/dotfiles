#!/bin/bash
# Install git hooks for this repository
# Called by: pnpm install (via prepare script)

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "Not a git repository, skipping hook installation"
    exit 0
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_SRC="${SCRIPT_DIR}/hooks"
HOOKS_DEST="${REPO_ROOT}/.git/hooks"

# Install hooks by copying from source
for hook in pre-commit pre-push; do
    if [ -f "${HOOKS_SRC}/${hook}" ]; then
        cp "${HOOKS_SRC}/${hook}" "${HOOKS_DEST}/${hook}"
        chmod +x "${HOOKS_DEST}/${hook}"
        echo "✓ Installed ${hook} hook"
    fi
done

echo "Git hooks installed successfully!"
