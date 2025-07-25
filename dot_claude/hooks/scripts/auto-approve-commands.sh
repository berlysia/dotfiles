#!/bin/bash

# Auto-approve commands based on permissions.allow/deny lists
# Unified script that handles both allow and deny patterns

# Source common libraries
SCRIPT_DIR="$(dirname "$0")"
source "${SCRIPT_DIR}/lib/hook-common.sh"
source "${SCRIPT_DIR}/lib/pattern-matcher.sh"

# Log file for auto-approved commands
LOG_FILE="${HOME}/.claude/auto_approve_commands.log"


# Read and validate input
TOOL_DATA=$(read_hook_input)
TOOL_INFO=$(extract_tool_info "$TOOL_DATA")
TOOL_NAME=$(echo "$TOOL_INFO" | cut -d'|' -f1)
TOOL_INPUT=$(echo "$TOOL_INFO" | cut -d'|' -f2-)

# Exit if no tool name
[ -z "$TOOL_NAME" ] && exit 0

# Get settings files
WORKSPACE_ROOT=$(get_workspace_root)
readarray -t SETTINGS_FILES < <(get_settings_files "$WORKSPACE_ROOT")

# Extract permission lists
ALLOW_LIST=$(extract_permission_list "allow" "${SETTINGS_FILES[@]}")
DENY_LIST=$(extract_permission_list "deny" "${SETTINGS_FILES[@]}")

# Handle no-list case - exit silently
if [ -z "$ALLOW_LIST" ] && [ -z "$DENY_LIST" ]; then
    exit 0
fi

# Check deny patterns first
if [ -n "$DENY_LIST" ]; then
    while IFS= read -r pattern; do
        if [ -n "$pattern" ] && check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
            echo '{"decision": "block"}'
            exit 0
        fi
    done <<< "$DENY_LIST"
fi

# Check allow patterns
if [ -n "$ALLOW_LIST" ]; then
    while IFS= read -r pattern; do
        if [ -n "$pattern" ] && check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
            # Log the approved command
            {
                echo "[$(date '+%Y-%m-%d %H:%M:%S')]"
                echo "Tool: $TOOL_NAME"
                echo "Pattern: $pattern"
                if [ "$TOOL_NAME" = "Bash" ]; then
                    # For Bash tool, extract the actual command from tool_input JSON
                    bash_command=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
                    echo "Command: $bash_command"
                else
                    # For other tools, show the tool input JSON
                    echo "Input: $TOOL_INPUT"
                fi
                echo "---"
            } >> "$LOG_FILE"
            
            echo '{"decision": "approve"}'
            exit 0
        fi
    done <<< "$ALLOW_LIST"
fi

# Handle no-match case - output empty object
echo '{}'