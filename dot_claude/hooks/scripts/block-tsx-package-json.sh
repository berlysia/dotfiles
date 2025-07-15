#!/bin/bash

# Hook script to block tsx/ts-node usage in package.json edits

check_package_json_edit() {
    local tool_name="$1"
    local file_path="$2"
    local new_content="$3"
    
    # Only check package.json files
    if [[ ! $file_path =~ package\.json$ ]]; then
        return 0
    fi
    
    # Check if the content is valid JSON
    if ! echo "$new_content" | jq . >/dev/null 2>&1; then
        # If not valid JSON, fall back to grep
        if echo "$new_content" | grep -q '"scripts"' && echo "$new_content" | grep -E '"[^"]*"[[:space:]]*:[[:space:]]*"[^"]*(^|[[:space:]])(tsx|ts-node)([[:space:]]|$)[^"]*"'; then
            echo "Adding tsx/ts-node to package.json scripts is prohibited. Use the existing TypeScript toolchain in the project." >&2
            exit 2
        fi
        if echo "$new_content" | grep -E '"(dependencies|devDependencies)"' && echo "$new_content" | grep -E '"(tsx|ts-node)"[[:space:]]*:[[:space:]]*"[^"]*"'; then
            echo "Adding tsx/ts-node to package.json dependencies is prohibited. Use the existing TypeScript toolchain in the project." >&2
            exit 2
        fi
        return 0
    fi
    
    # Check for tsx/ts-node in scripts using jq
    if echo "$new_content" | jq -e '.scripts // empty' >/dev/null 2>&1; then
        # Check each script value for tsx/ts-node usage as commands
        while IFS= read -r script_value; do
            [[ -z "$script_value" ]] && continue
            
            # Check for tsx/ts-node usage patterns that indicate command execution
            
            # Pattern 1: Direct command usage (tsx, ts-node at start or after separators)
            if echo "$script_value" | grep -E '(^|[[:space:]]|[|&;])[[:space:]]*(tsx|ts-node)([[:space:]]|$)' >/dev/null; then
                # Check if it's in a context where tsx/ts-node is used as a command
                
                # Allow common cases where tsx is file extension or safe option value
                if echo "$script_value" | grep -E -- '--[a-zA-Z-]*[[:space:]]+(tsx|ts-node)' >/dev/null; then
                    continue  # --ext tsx, --extension tsx (file extension/option value)
                fi
                
                if echo "$script_value" | grep -E 'webpack[^|&;]*\.(tsx|ts)([[:space:]]|$)' >/dev/null; then
                    continue  # webpack src/App.tsx (file path)
                fi
                
                # Block command execution patterns
                if echo "$script_value" | grep -E '(^|[[:space:]]|[|&;])[[:space:]]*(tsx|ts-node)([[:space:]].*\.(ts|tsx|js|mjs)([[:space:]]|$)|[[:space:]]|$)' >/dev/null; then
                    echo "Adding tsx/ts-node to package.json scripts is prohibited. Use the existing TypeScript toolchain in the project." >&2
                    exit 2
                fi
                
                # Block loader patterns
                if echo "$script_value" | grep -E 'node[^|&;]*--[a-zA-Z-]*(loader|require)[^|&;]*(tsx|ts-node)' >/dev/null; then
                    echo "Adding tsx/ts-node to package.json scripts is prohibited. Use the existing TypeScript toolchain in the project." >&2
                    exit 2
                fi
            fi
        done < <(echo "$new_content" | jq -r '.scripts // {} | to_entries[] | .value')
    fi
    
    # Check for tsx/ts-node in dependencies using jq
    if echo "$new_content" | jq -e '.dependencies // .devDependencies // empty' >/dev/null 2>&1; then
        if echo "$new_content" | jq -r '.dependencies // {}, .devDependencies // {} | keys[]' | grep -E '^(tsx|ts-node)$' >/dev/null; then
            echo "Adding tsx/ts-node to package.json dependencies is prohibited. Use the existing TypeScript toolchain in the project." >&2
            exit 2
        fi
    fi
}

# Read JSON input from stdin
input=$(cat)

# Extract tool_name using jq
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# Only process Edit, MultiEdit, and Write commands
if [[ $tool_name != "Edit" && $tool_name != "MultiEdit" && $tool_name != "Write" ]]; then
    exit 0
fi

# Extract file_path
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# For MultiEdit, check all edits
if [[ $tool_name == "MultiEdit" ]]; then
    # Extract all new_string values from edits array and check them
    while IFS= read -r new_content; do
        [[ -n "$new_content" ]] && check_package_json_edit "$tool_name" "$file_path" "$new_content"
    done < <(echo "$input" | jq -r '.tool_input.edits[]?.new_string // empty')
else
    # For Edit and Write, check the content
    if [[ $tool_name == "Edit" ]]; then
        new_content=$(echo "$input" | jq -r '.tool_input.new_string // empty')
    elif [[ $tool_name == "Write" ]]; then
        new_content=$(echo "$input" | jq -r '.tool_input.content // empty')
    fi
    
    [[ -n "$new_content" ]] && check_package_json_edit "$tool_name" "$file_path" "$new_content"
fi

# Allow the operation to proceed
exit 0