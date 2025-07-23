#!/bin/bash

# Source common libraries
SCRIPT_DIR="$(dirname "$0")"
source "${SCRIPT_DIR}/lib/hook-common.sh"

# Read and parse hook input
TOOL_DATA=$(read_hook_input)
TOOL_INFO=$(extract_tool_info "$TOOL_DATA")
TOOL_INPUT_DATA=$(echo "$TOOL_INFO" | cut -d'|' -f2-)

# Extract file paths from tool input
FILES=$(extract_file_paths "$TOOL_INPUT_DATA")

# Also extract command for bash tool analysis
COMMAND=$(echo "$TOOL_INPUT_DATA" | jq -r '.command // empty' 2>/dev/null)

# Exit if no files to check
if [ -z "$FILES" ]; then
  exit 0
fi

# Get repository root
REPO_ROOT=$(get_workspace_root)
if [ -z "$REPO_ROOT" ]; then
  # Not in a git repository, allow access
  exit 0
fi

# Resolve absolute paths
resolve_path() {
  local path="$1"
  if [[ "$path" =~ ^/ ]]; then
    echo "$path"
  else
    echo "$(pwd)/$path"
  fi
}

# Check if path is outside repository root
is_outside_repo() {
  local path="$1"
  local abs_path=$(resolve_path "$path")
  
  # Check if path starts with repository root
  if [[ "$abs_path" == "$REPO_ROOT"* ]]; then
    return 1  # Inside repository
  fi
  
  # Check if path is in ~/.claude directory (allowed exception)
  if [[ "$abs_path" == "$HOME/.claude"* ]]; then
    return 1  # Allowed exception
  fi
  
  return 0  # Outside repository
}

# Check for bash commands that might access files outside repo
if [ -n "$COMMAND" ]; then
  
  # Check for dangerous patterns in bash commands
  if echo "$COMMAND" | grep -qE "(cd\s+/|cd\s+\.\./|cd\s+~(?!/\.claude)|cp\s+[^[:space:]]*\s+/|mv\s+[^[:space:]]*\s+/|rm\s+[^[:space:]]*\s+/|touch\s+/|mkdir\s+/|ln\s+[^[:space:]]*\s+/)"; then
    # Extract potential paths from command
    POTENTIAL_PATHS=$(echo "$COMMAND" | grep -oE '(/[^[:space:]]+|\.\.+/[^[:space:]]*|~[^[:space:]]*)')
    
    while IFS= read -r path; do
      if [ -n "$path" ] && is_outside_repo "$path"; then
        echo "ERROR: Access to files outside repository root is prohibited: $path"
        echo "Only ~/.claude directory is allowed as exception."
        exit 1
      fi
    done <<< "$POTENTIAL_PATHS"
  fi
fi

# Check file paths directly
while IFS= read -r file; do
  if [ -n "$file" ] && is_outside_repo "$file"; then
    echo "ERROR: Access to files outside repository root is prohibited: $file"
    echo "Only ~/.claude directory is allowed as exception."
    exit 1
  fi
done <<< "$FILES"

exit 0