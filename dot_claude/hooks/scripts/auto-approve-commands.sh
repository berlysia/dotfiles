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

# Analyze patterns with individual command validation
DENY_MATCHES=()
ALLOW_MATCHES=()
ALL_PATTERNS_CHECKED=()
INDIVIDUAL_COMMAND_RESULTS=()

# For Bash tool, extract and validate individual commands
if [ "$TOOL_NAME" = "Bash" ]; then
    bash_command=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
    extracted_commands=()
    _extract_commands_from_compound "$bash_command" extracted_commands
    
    # Check each individual command
    for cmd in "${extracted_commands[@]}"; do
        cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        if [ -n "$cmd" ]; then
            # Check deny patterns for this command
            if [ -n "$DENY_LIST" ]; then
                matched_deny_pattern=""
                if _check_individual_command_deny_with_pattern "$cmd" "$DENY_LIST" matched_deny_pattern; then
                    INDIVIDUAL_COMMAND_RESULTS+=("DENY: '$cmd' (matched: $matched_deny_pattern)")
                    DENY_MATCHES+=("Individual command blocked: $cmd")
                    continue
                fi
            fi
            
            # Check allow patterns for this command
            if [ -n "$ALLOW_LIST" ]; then
                matched_allow_pattern=""
                if _check_individual_command_with_pattern "$cmd" "$ALLOW_LIST" matched_allow_pattern; then
                    INDIVIDUAL_COMMAND_RESULTS+=("ALLOW: '$cmd' (matched: $matched_allow_pattern)")
                else
                    INDIVIDUAL_COMMAND_RESULTS+=("NO_MATCH: '$cmd' (no allow pattern matched)")
                fi
            else
                INDIVIDUAL_COMMAND_RESULTS+=("NO_MATCH: '$cmd' (no allow patterns defined)")
            fi
        fi
    done
    
    # Determine decision based on individual command results
    DECISION=""
    DECISION_REASON=""
    
    # If any command is denied, block the entire operation
    if [ ${#DENY_MATCHES[@]} -gt 0 ]; then
        DECISION="block"
        DECISION_REASON="One or more commands blocked: ${DENY_MATCHES[*]}"
    else
        # Check if ALL commands are explicitly allowed
        all_allowed=true
        for result in "${INDIVIDUAL_COMMAND_RESULTS[@]}"; do
            if [[ "$result" != ALLOW:* ]]; then
                all_allowed=false
                break
            fi
        done
        
        if [ "$all_allowed" = true ] && [ ${#INDIVIDUAL_COMMAND_RESULTS[@]} -gt 0 ]; then
            DECISION="approve"
            DECISION_REASON="All individual commands explicitly allowed"
        else
            DECISION="no_match"
            DECISION_REASON="Not all commands explicitly allowed"
        fi
    fi
else
    # For non-Bash tools, use original logic
    # Check deny patterns first
    if [ -n "$DENY_LIST" ]; then
        while IFS= read -r pattern; do
            if [ -n "$pattern" ]; then
                ALL_PATTERNS_CHECKED+=("DENY: $pattern")
                if check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
                    DENY_MATCHES+=("$pattern")
                fi
            fi
        done <<< "$DENY_LIST"
    fi

    # Check allow patterns
    if [ -n "$ALLOW_LIST" ]; then
        while IFS= read -r pattern; do
            if [ -n "$pattern" ]; then
                ALL_PATTERNS_CHECKED+=("ALLOW: $pattern")
                if check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
                    ALLOW_MATCHES+=("$pattern")
                fi
            fi
        done <<< "$ALLOW_LIST"
    fi

    # Determine final decision
    DECISION=""
    DECISION_REASON=""

    if [ ${#DENY_MATCHES[@]} -gt 0 ]; then
        DECISION="block"
        DECISION_REASON="Matched deny patterns: ${DENY_MATCHES[*]}"
    elif [ ${#ALLOW_MATCHES[@]} -gt 0 ]; then
        DECISION="approve"
        DECISION_REASON="Matched allow patterns: ${ALLOW_MATCHES[*]}"
    else
        DECISION="no_match"
        DECISION_REASON="No patterns matched"
    fi
fi

# Log comprehensive analysis
{
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] PATTERN ANALYSIS"
    echo "Tool: $TOOL_NAME"
    
    if [ "$TOOL_NAME" = "Bash" ]; then
        bash_command=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
        echo "Command: $bash_command"
        
        # Show individual command analysis
        echo "Individual command analysis:"
        for result in "${INDIVIDUAL_COMMAND_RESULTS[@]}"; do
            echo "  $result"
        done
        
        if [ ${#INDIVIDUAL_COMMAND_RESULTS[@]} -eq 0 ]; then
            echo "  No commands extracted"
        fi
    else
        echo "Input: $TOOL_INPUT"
    fi
    
    echo "Decision: $DECISION"
    echo "Reason: $DECISION_REASON"
    
    if [ ${#DENY_MATCHES[@]} -gt 0 ]; then
        echo "Deny matches:"
        for match in "${DENY_MATCHES[@]}"; do
            echo "  - $match"
        done
    fi
    
    if [ ${#ALLOW_MATCHES[@]} -gt 0 ]; then
        echo "Allow matches:"
        for match in "${ALLOW_MATCHES[@]}"; do
            echo "  - $match"
        done
    fi
    
    echo "---"
} >> "$LOG_FILE"

# Output decision
case "$DECISION" in
    "block")
        echo '{"decision": "block"}'
        ;;
    "approve")
        echo '{"decision": "approve"}'
        ;;
    *)
        echo '{}'
        ;;
esac
# test change for pre-commit hook - should trigger tests
