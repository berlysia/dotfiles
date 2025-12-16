#!/bin/bash
# Shows missing plugins and manual install instructions
# Usage: ~/.claude/scripts/show-missing-plugins.sh
#
# Compares .settings.plugins.json with installed_plugins.json
# and displays commands to run manually in Claude Code.
# Note: /plugin commands only work in interactive Claude Code sessions (IDE),
#       not via CLI (-p mode).

set -euo pipefail

CHEZMOI_SOURCE_DIR="${CHEZMOI_SOURCE_DIR:-$(chezmoi source-path 2>/dev/null || echo "$HOME/.local/share/chezmoi")}"
PLUGINS_FILE="${CHEZMOI_SOURCE_DIR}/dot_claude/.settings.plugins.json"
INSTALLED_FILE="$HOME/.claude/plugins/installed_plugins.json"
KNOWN_MARKETPLACES_FILE="$HOME/.claude/plugins/known_marketplaces.json"

# Check if plugins file exists
if [[ ! -f "$PLUGINS_FILE" ]]; then
    echo "❌ .settings.plugins.json not found at $PLUGINS_FILE"
    exit 1
fi

# Get required plugin keys from .settings.plugins.json
# Format: "plugin-name@marketplace"
REQUIRED_PLUGINS=$(jq -r 'keys[]' "$PLUGINS_FILE")

# Get installed plugin keys from installed_plugins.json
if [[ -f "$INSTALLED_FILE" ]]; then
    INSTALLED_PLUGINS=$(jq -r '.plugins // {} | keys[]' "$INSTALLED_FILE")
else
    INSTALLED_PLUGINS=""
fi

# Find missing plugins
MISSING=()
while IFS= read -r plugin; do
    [[ -z "$plugin" ]] && continue
    if ! echo "$INSTALLED_PLUGINS" | grep -qxF "$plugin"; then
        MISSING+=("$plugin")
    fi
done <<< "$REQUIRED_PLUGINS"

# Output results
if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo "✅ All required plugins are installed!"
    exit 0
fi

# Get registered marketplaces from known_marketplaces.json
REGISTERED_MARKETPLACES=""
if [[ -f "$KNOWN_MARKETPLACES_FILE" ]]; then
    REGISTERED_MARKETPLACES=$(jq -r 'keys[]' "$KNOWN_MARKETPLACES_FILE" 2>/dev/null || echo "")
fi

# Collect unique marketplaces needed for missing plugins (using regular array)
MARKETPLACES=()
for plugin in "${MISSING[@]}"; do
    marketplace="${plugin##*@}"
    # Only add if not already registered and not already in list
    if ! echo "$REGISTERED_MARKETPLACES" | grep -qxF "$marketplace"; then
        # Check if already in MARKETPLACES array
        already_added=false
        for m in "${MARKETPLACES[@]+"${MARKETPLACES[@]}"}"; do
            if [[ "$m" == "$marketplace" ]]; then
                already_added=true
                break
            fi
        done
        if [[ "$already_added" == "false" ]]; then
            MARKETPLACES+=("$marketplace")
        fi
    fi
done

echo "📦 Missing plugins (${#MISSING[@]}):"
for plugin in "${MISSING[@]}"; do
    name="${plugin%@*}"
    marketplace="${plugin##*@}"
    echo "   - $name ($marketplace)"
done
echo ""

# Helper function to get repo name from marketplace
get_repo_name() {
    local marketplace="$1"
    if [[ "$marketplace" == "claude-code-plugins" ]]; then
        echo "anthropics/claude-code"
    else
        echo "$marketplace"
    fi
}

# Show marketplace registration commands if needed
if [[ ${#MARKETPLACES[@]} -gt 0 ]]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📋 Step 1: Register marketplaces (run in Claude Code):"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    for marketplace in "${MARKETPLACES[@]}"; do
        echo "    /plugin marketplace add $(get_repo_name "$marketplace")"
    done
    echo ""
fi

# Show plugin install commands
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ ${#MARKETPLACES[@]} -gt 0 ]]; then
    echo "📋 Step 2: Install plugins (run in Claude Code):"
else
    echo "📋 Install plugins (run in Claude Code):"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
for plugin in "${MISSING[@]}"; do
    name="${plugin%@*}"
    marketplace="${plugin##*@}"
    if [[ "$marketplace" == "claude-code-plugins" ]]; then
        echo "    /plugin install ${name}@anthropics/claude-code"
    else
        echo "    /plugin install $plugin"
    fi
done
echo ""
