#!/bin/bash

# Common functionality for Claude Code hook scripts

# Read and parse hook input
read_hook_input() {
    local input=$(cat)
    if ! echo "$input" | jq empty 2>/dev/null; then
        echo "Error: Invalid JSON input" >&2
        exit 1
    fi
    echo "$input"
}

# Extract tool information from hook input
extract_tool_info() {
    local input="$1"
    local tool_name=$(echo "$input" | jq -r '.tool_name // empty')
    # Keep tool_input as JSON object, not stringified
    local tool_input=$(echo "$input" | jq -c '.tool_input // empty')
    echo "$tool_name|$tool_input"
}

# Get workspace root with fallback
get_workspace_root() {
    local fallback="${1:-}"
    if [ -n "$fallback" ]; then
        git rev-parse --show-toplevel 2>/dev/null || echo "$fallback"
    else
        git rev-parse --show-toplevel 2>/dev/null
    fi
}

# Build settings file paths array
get_settings_files() {
    local workspace_root="$1"
    if [ -n "$workspace_root" ]; then
        echo "$workspace_root/.claude/settings.local.json"
        echo "$workspace_root/.claude/settings.json"
    fi
    echo "$HOME/.claude/settings.json"
}

# Extract allow/deny lists from settings files
extract_permission_list() {
    local list_type="$1"  # "allow" or "deny"
    shift
    local settings_files=("$@")
    
    local result=""
    for settings_file in "${settings_files[@]}"; do
        if [ -f "$settings_file" ]; then
            local current_list=$(jq -r ".permissions.${list_type}[]?" "$settings_file" 2>/dev/null || echo "")
            if [ -n "$current_list" ]; then
                if [ -z "$result" ]; then
                    result="$current_list"
                else
                    result="$result"$'\n'"$current_list"
                fi
            fi
        fi
    done
    echo "$result"
}

# Extract file paths from various tool inputs
extract_file_paths() {
    local tool_input="$1"
    echo "$tool_input" | jq -r '
        if .file_path then .file_path
        elif .edits then .file_path
        elif .notebook_path then .notebook_path
        elif .path then .path
        elif .pattern then .pattern
        else empty
        end
    ' 2>/dev/null
}