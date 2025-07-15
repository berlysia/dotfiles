#!/bin/bash

# Hook script to block tsx and ts-node usage in various forms.
# Blocks installation, npx usage, loader usage, and direct execution.

check_bash_command() {
    local command="$1"
    
    # Pattern 1: Package installation (npm/yarn/pnpm/bun)
    if [[ $command =~ ^[[:space:]]*(npm|yarn|pnpm|bun)[[:space:]]+(install|add|i)[[:space:]]+(.+)$ ]]; then
        local packages="${BASH_REMATCH[3]}"
        
        # Check if tsx or ts-node is being installed as a standalone package
        for pkg in $packages; do
            # Skip flags
            [[ $pkg =~ ^- ]] && continue
            
            # Remove version specifier if present (e.g., tsx@latest)
            local pkg_name="${pkg%%@*}"
            
            if [[ $pkg_name == "tsx" || $pkg_name == "ts-node" ]]; then
                echo "Installation of $pkg_name is prohibited. Use the existing TypeScript toolchain in the project." >&2
                exit 2
            fi
        done
    fi
    
    # Pattern 2: Node.js loader usage
    if [[ $command =~ (--loader|--require|--experimental-loader)[[:space:]]+(tsx|ts-node) ]]; then
        echo "Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project." >&2
        exit 2
    fi
    
    # Pattern 3: npx usage
    if [[ $command =~ ^[[:space:]]*npx[[:space:]]+(tsx|ts-node)[[:space:]]+ ]]; then
        echo "Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project." >&2
        exit 2
    fi
    
    # Pattern 4: Direct execution
    if [[ $command =~ ^[[:space:]]*(tsx|ts-node)[[:space:]]+[^-].*\.ts[[:space:]]*$ ]]; then
        echo "Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project." >&2
        exit 2
    fi
}

# Read JSON input from stdin
input=$(cat)

# Extract tool_name and command using jq
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# Only process Bash commands
[[ $tool_name != "Bash" ]] && exit 0

# Extract command
command=$(echo "$input" | jq -r '.command // empty')

[[ -z $command ]] && exit 0

# Check if the command should be blocked
check_bash_command "$command"

# Allow the command to proceed
exit 0