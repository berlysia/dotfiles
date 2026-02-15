#!/bin/bash
# Reverse sync: generate YAML from installed plugins and compare with current YAML
# Usage: ~/.claude/scripts/sync-enabled-plugins.sh

set -euo pipefail

# Check dependencies
if ! command -v claude &> /dev/null; then
    echo "claude CLI not found"
    exit 1
fi
if ! command -v jq &> /dev/null; then
    echo "jq not found"
    exit 1
fi

CHEZMOI_SOURCE_DIR="${CHEZMOI_SOURCE_DIR:-$(chezmoi source-path 2>/dev/null || echo "$HOME/.local/share/chezmoi/home")}"
YAML_FILE="${CHEZMOI_SOURCE_DIR}/../home/.chezmoidata/claude_plugins.yaml"

# Normalize path (resolve ../home when source-path already points to home/)
if [ ! -f "$YAML_FILE" ]; then
    YAML_FILE="${CHEZMOI_SOURCE_DIR%/home}/.chezmoidata/claude_plugins.yaml"
fi
if [ ! -f "$YAML_FILE" ]; then
    # Try working tree path
    WORKING_TREE=$(chezmoi data --format json 2>/dev/null | jq -r '.chezmoi.workingTree // empty')
    if [ -n "$WORKING_TREE" ]; then
        YAML_FILE="${WORKING_TREE}/home/.chezmoidata/claude_plugins.yaml"
    fi
fi

# Get actual state from claude CLI
ACTUAL_MARKETPLACES=$(CLAUDECODE='' claude plugin marketplace list --json 2>/dev/null || echo '[]')
ACTUAL_PLUGINS=$(CLAUDECODE='' claude plugin list --json 2>/dev/null || echo '[]')

# Generate YAML output
echo "claude_plugins:"
echo "    marketplaces:"
echo "$ACTUAL_MARKETPLACES" | jq -r '.[] | "        - name: \(.name)\n          repo: \(.repo)"'
echo "    plugins:"
echo "$ACTUAL_PLUGINS" | jq -r '.[].id' | while IFS= read -r id; do
    echo "        - $id"
done

# Show diff with current YAML if it exists
if [ -f "$YAML_FILE" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Diff with current YAML ($YAML_FILE):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Generate YAML to temp file for comparison
    TEMP_YAML=$(mktemp)
    {
        echo "claude_plugins:"
        echo "    marketplaces:"
        echo "$ACTUAL_MARKETPLACES" | jq -r '.[] | "        - name: \(.name)\n          repo: \(.repo)"'
        echo "    plugins:"
        echo "$ACTUAL_PLUGINS" | jq -r '.[].id' | while IFS= read -r id; do
            echo "        - $id"
        done
    } > "$TEMP_YAML"

    diff --color "$YAML_FILE" "$TEMP_YAML" || true
    rm "$TEMP_YAML"

    echo ""
    echo "To update: copy the YAML output above to $YAML_FILE"
else
    echo ""
    echo "YAML file not found at: $YAML_FILE"
    echo "Copy the output above to home/.chezmoidata/claude_plugins.yaml"
fi
