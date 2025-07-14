#!/bin/bash

# Extract file paths from tool input
FILES=$(echo "$CLAUDE_TOOL_INPUT" | jq -r '
  if .file_path then
    .file_path
  elif .edits then
    .file_path
  elif .notebook_path then
    .notebook_path
  else
    empty
  end
' 2>/dev/null)

# Exit if no files to check
if [ -z "$FILES" ]; then
  exit 0
fi

# Function to check if path is in node_modules
is_in_node_modules() {
  local path="$1"
  
  # Resolve relative paths to absolute paths
  if [[ "$path" =~ ^/ ]]; then
    local abs_path="$path"
  else
    local abs_path="$(pwd)/$path"
  fi
  
  # Check if path contains node_modules
  if [[ "$abs_path" == *"/node_modules/"* ]]; then
    return 0  # In node_modules
  fi
  
  return 1  # Not in node_modules
}

# Check file paths
while IFS= read -r file; do
  if [ -n "$file" ] && is_in_node_modules "$file"; then
    echo "ERROR: Modification of files in node_modules is prohibited: $file"
    echo "Reading from node_modules is allowed, but writing/editing is not permitted."
    exit 1
  fi
done <<< "$FILES"

exit 0