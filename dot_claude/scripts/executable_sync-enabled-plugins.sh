#!/bin/bash
# Syncs enabledPlugins from ~/.claude/settings.json to chezmoi source
# Usage: bun ~/.claude/scripts/sync-enabled-plugins.sh
#
# This exports the current enabledPlugins state to dotfiles, allowing you to
# commit plugin enable/disable changes made via Claude Code.

set -euo pipefail

SETTINGS_FILE="$HOME/.claude/settings.json"
CHEZMOI_SOURCE_DIR="${CHEZMOI_SOURCE_DIR:-$(chezmoi source-path)}"
TARGET_FILE="${CHEZMOI_SOURCE_DIR}/dot_claude/.settings.plugins.json"

# Check if settings file exists
if [[ ! -f "$SETTINGS_FILE" ]]; then
    echo "❌ ~/.claude/settings.json not found"
    exit 1
fi

# Extract enabledPlugins
ENABLED_PLUGINS=$(jq '.enabledPlugins // {}' "$SETTINGS_FILE")

# Validate JSON
if ! echo "$ENABLED_PLUGINS" | jq empty 2>/dev/null; then
    echo "❌ Failed to extract enabledPlugins"
    exit 1
fi

# Check if there are changes
if [[ -f "$TARGET_FILE" ]]; then
    CURRENT=$(cat "$TARGET_FILE")
    if [[ "$CURRENT" == "$ENABLED_PLUGINS" ]]; then
        echo "✅ No changes to sync"
        exit 0
    fi
fi

# Write to target
echo "$ENABLED_PLUGINS" | jq '.' > "$TARGET_FILE"

# Show result
PLUGIN_COUNT=$(echo "$ENABLED_PLUGINS" | jq 'length')
echo "✅ Synced $PLUGIN_COUNT plugins to .settings.plugins.json"
echo ""
echo "Changes:"
git -C "$CHEZMOI_SOURCE_DIR" diff --color dot_claude/.settings.plugins.json 2>/dev/null || cat "$TARGET_FILE"
echo ""
echo "To commit: cd $CHEZMOI_SOURCE_DIR && git add dot_claude/.settings.plugins.json && git commit -m 'chore: sync enabledPlugins'"
