#!/bin/bash

# Auto-approve commands that are in permissions.allow list
# This script checks if the current tool use matches any pattern in the allow list

# Get the tool use data from stdin
TOOL_DATA=$(cat)

# Parse tool name and input
TOOL_NAME=$(echo "$TOOL_DATA" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$TOOL_DATA" | jq -r '.tool_input // empty')

# Exit if no tool name
if [ -z "$TOOL_NAME" ]; then
    exit 0
fi

# Get workspace root for project-specific settings
WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"

# Get all possible settings file paths (in priority order)
SETTINGS_FILES=(
    "$HOME/.claude/settings.json"  # User global (lowest priority)
)

# Add project-specific settings if in a git repository
if [ -n "$WORKSPACE_ROOT" ]; then
    SETTINGS_FILES=(
        "$WORKSPACE_ROOT/.claude/settings.local.json"  # Project-local (highest priority)
        "$WORKSPACE_ROOT/.claude/settings.json"        # Project-shared
        "$HOME/.claude/settings.json"                  # User global (lowest priority)
    )
fi

# Function to extract allow list from a settings file
extract_allow_list() {
    local file="$1"
    if [ -f "$file" ]; then
        jq -r '.permissions.allow[]?' "$file" 2>/dev/null || echo ""
    fi
}

# Function to extract deny list from a settings file
extract_deny_list() {
    local file="$1"
    if [ -f "$file" ]; then
        jq -r '.permissions.deny[]?' "$file" 2>/dev/null || echo ""
    fi
}

# Merge allow lists from all settings files
ALLOW_LIST=""
for settings_file in "${SETTINGS_FILES[@]}"; do
    current_list=$(extract_allow_list "$settings_file")
    if [ -n "$current_list" ]; then
        if [ -z "$ALLOW_LIST" ]; then
            ALLOW_LIST="$current_list"
        else
            ALLOW_LIST="$ALLOW_LIST"$'\n'"$current_list"
        fi
    fi
done

# Merge deny lists from all settings files
DENY_LIST=""
for settings_file in "${SETTINGS_FILES[@]}"; do
    current_list=$(extract_deny_list "$settings_file")
    if [ -n "$current_list" ]; then
        if [ -z "$DENY_LIST" ]; then
            DENY_LIST="$current_list"
        else
            DENY_LIST="$DENY_LIST"$'\n'"$current_list"
        fi
    fi
done

# If no allow or deny list, exit without decision
if [ -z "$ALLOW_LIST" ] && [ -z "$DENY_LIST" ]; then
    exit 0
fi

# Function to check if a pattern matches the tool usage
check_pattern() {
    local pattern="$1"
    local tool_name="$2"
    local tool_input="$3"
    
    # Handle Bash tool specifically
    if [[ "$pattern" == Bash\(* ]]; then
        if [ "$tool_name" != "Bash" ]; then
            return 1
        fi
        
        # Extract the command pattern from Bash(command:*)
        local cmd_pattern
        cmd_pattern=$(echo "$pattern" | sed 's/Bash(\(.*\))/\1/')
        
        # Get the actual command
        local actual_command
        actual_command=$(echo "$tool_input" | jq -r '.command // empty')
        
        # Check if command matches the pattern
        if [[ "$cmd_pattern" == *:* ]]; then
            local cmd_prefix
            cmd_prefix=$(echo "$cmd_pattern" | cut -d':' -f1)
            if [[ "$actual_command" == "$cmd_prefix"* ]]; then
                return 0
            fi
        elif [[ "$actual_command" == "$cmd_pattern" ]]; then
            return 0
        fi
        
        return 1
    fi
    
    # Handle other tools with file path patterns
    if [[ "$pattern" == "$tool_name"* ]]; then
        # Extract the path pattern
        local path_pattern
        if [[ "$pattern" == *\(* ]]; then
            path_pattern=$(echo "$pattern" | sed "s/${tool_name}(\(.*\))/\1/")
            
            # Get the file path from tool input
            local file_path
            file_path=$(echo "$tool_input" | jq -r '.file_path // .path // .pattern // empty')
            
            # Simple glob pattern matching
            if [[ "$path_pattern" == "**" || "$path_pattern" == "*" ]]; then
                return 0
            elif [[ "$path_pattern" == \!* ]]; then
                # Negation pattern - should not match
                local neg_pattern
                neg_pattern=$(echo "$path_pattern" | sed 's/^!//')
                if [[ "$file_path" == $neg_pattern ]]; then
                    return 1
                fi
                return 0
            elif [[ "$file_path" == $path_pattern ]]; then
                return 0
            fi
        elif [[ "$pattern" == "$tool_name" ]]; then
            return 0
        fi
    fi
    
    return 1
}

# First, check if the current tool usage matches any deny pattern
if [ -n "$DENY_LIST" ]; then
    while IFS= read -r pattern; do
        if [ -n "$pattern" ] && check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
            # Match found in deny list - explicitly block
            echo '{"decision": "block"}'
            exit 0
        fi
    done <<< "$DENY_LIST"
fi

# Then, check if the current tool usage matches any allow pattern
if [ -n "$ALLOW_LIST" ]; then
    while IFS= read -r pattern; do
        if [ -n "$pattern" ] && check_pattern "$pattern" "$TOOL_NAME" "$TOOL_INPUT"; then
            # Match found in allow list - approve automatically
            echo '{"decision": "approve"}'
            exit 0
        fi
    done <<< "$ALLOW_LIST"
fi

# No match found in either list - let other hooks handle it
exit 0