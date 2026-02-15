#!/bin/bash
# Audit tool: compare declared plugins (YAML) vs actual state (claude CLI)
# Usage: ~/.claude/scripts/show-missing-plugins.sh

set -euo pipefail

# Check dependencies
if ! command -v chezmoi &> /dev/null; then
    echo "chezmoi not found"
    exit 1
fi
if ! command -v claude &> /dev/null; then
    echo "claude CLI not found"
    exit 1
fi
if ! command -v jq &> /dev/null; then
    echo "jq not found"
    exit 1
fi

# Get declared state from chezmoi data
DECLARED=$(chezmoi data --format json | jq '.claude_plugins // empty')
if [ -z "$DECLARED" ]; then
    echo "No claude_plugins found in chezmoi data"
    exit 1
fi

# Get actual state from claude CLI
ACTUAL_MARKETPLACES=$(CLAUDECODE='' claude plugin marketplace list --json 2>/dev/null || echo '[]')
ACTUAL_PLUGINS=$(CLAUDECODE='' claude plugin list --json 2>/dev/null || echo '[]')

# ─── Check marketplaces ───

MISSING_MARKETPLACES=()
while IFS= read -r name; do
    [ -z "$name" ] && continue
    if ! echo "$ACTUAL_MARKETPLACES" | jq -e ".[] | select(.name == \"$name\")" >/dev/null 2>&1; then
        MISSING_MARKETPLACES+=("$name")
    fi
done < <(echo "$DECLARED" | jq -r '.marketplaces[].name')

# ─── Check plugins ───

MISSING_PLUGINS=()
while IFS= read -r id; do
    [ -z "$id" ] && continue
    if ! echo "$ACTUAL_PLUGINS" | jq -e ".[] | select(.id == \"$id\")" >/dev/null 2>&1; then
        MISSING_PLUGINS+=("$id")
    fi
done < <(echo "$DECLARED" | jq -r '.plugins[]')

# ─── Check extra plugins (installed but not declared) ───

DECLARED_PLUGIN_LIST=$(echo "$DECLARED" | jq -r '.plugins[]')
EXTRA_PLUGINS=()
while IFS= read -r id; do
    [ -z "$id" ] && continue
    if ! echo "$DECLARED_PLUGIN_LIST" | grep -qxF "$id"; then
        EXTRA_PLUGINS+=("$id")
    fi
done < <(echo "$ACTUAL_PLUGINS" | jq -r '.[].id')

# ─── Output results ───

ALL_OK=true

if [ ${#MISSING_MARKETPLACES[@]} -gt 0 ]; then
    ALL_OK=false
    echo "Missing marketplaces (${#MISSING_MARKETPLACES[@]}):"
    for m in "${MISSING_MARKETPLACES[@]}"; do
        echo "  - $m"
    done
    echo ""
fi

if [ ${#MISSING_PLUGINS[@]} -gt 0 ]; then
    ALL_OK=false
    echo "Missing plugins (${#MISSING_PLUGINS[@]}):"
    for p in "${MISSING_PLUGINS[@]}"; do
        echo "  - $p"
    done
    echo ""
    echo "Run 'chezmoi apply' to install missing plugins."
    echo ""
fi

if [ ${#EXTRA_PLUGINS[@]} -gt 0 ]; then
    ALL_OK=false
    echo "Extra plugins not in YAML (${#EXTRA_PLUGINS[@]}):"
    for p in "${EXTRA_PLUGINS[@]}"; do
        echo "  - $p"
    done
    echo ""
    echo "To track these, add them to home/.chezmoidata/claude_plugins.yaml"
    echo "Or run ~/.claude/scripts/sync-enabled-plugins.sh to generate YAML."
    echo ""
fi

if $ALL_OK; then
    echo "All declared plugins are installed. No extra plugins found."
fi
