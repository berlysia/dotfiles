#!/bin/sh
# adapter_selector.sh
# Automatically selects the appropriate adapter based on environment

# Detect if we're in pre-apply mode (chezmoi source directory)
is_pre_apply_mode() {
    # Check if we're in chezmoi source directory by looking for characteristic files
    # We need to check both current directory and parent directories
    local check_dir="$PWD"
    
    while [ "$check_dir" != "/" ]; do
        if [ -f "$check_dir/dot_bashrc" ] || [ -f "$check_dir/dot_zshrc" ] || [ -d "$check_dir/dot_zsh" ] || [ -d "$check_dir/dot_shell_common" ]; then
            return 0  # true - pre-apply mode
        fi
        check_dir="$(dirname "$check_dir")"
    done
    
    # Check if GITHUB_WORKSPACE is set (CI environment)
    if [ -n "$GITHUB_WORKSPACE" ]; then
        return 0  # true - CI pre-apply mode
    fi
    
    return 1  # false - post-apply mode
}

# Detect if we're in CI environment
is_ci_mode() {
    [ -n "$GITHUB_WORKSPACE" ] || [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ]
}

# Get the base directory based on mode
get_base_directory() {
    if is_ci_mode && [ -n "$GITHUB_WORKSPACE" ]; then
        echo "$GITHUB_WORKSPACE"
    elif is_pre_apply_mode; then
        # If we're in chezmoi source directory, find the root
        local check_dir="$PWD"
        while [ "$check_dir" != "/" ]; do
            if [ -f "$check_dir/dot_bashrc" ] || [ -d "$check_dir/dot_shell_common" ]; then
                echo "$check_dir"
                return
            fi
            check_dir="$(dirname "$check_dir")"
        done
        # Fallback to current directory
        echo "$PWD"
    else
        # Post-apply mode, use home directory
        echo "$HOME"
    fi
}

# Select and return the appropriate adapter name
select_adapter() {
    if is_pre_apply_mode; then
        echo "pre_apply"
    else
        echo "post_apply"
    fi
}

# Load the selected adapter functions
load_adapter() {
    local adapter_name=$(select_adapter)
    local script_dir="$(cd "$(dirname "$0")" && pwd)"
    local adapter_file="$script_dir/${adapter_name}_adapter.sh"
    
    if [ -f "$adapter_file" ]; then
        . "$adapter_file"
        echo "$adapter_name"
    else
        echo "ERROR: Adapter file not found: $adapter_file" >&2
        return 1
    fi
}

# Get environment info for debugging
get_environment_info() {
    local adapter=$(select_adapter)
    local base_dir=$(get_base_directory)
    local ci_flag=""
    
    if is_ci_mode; then
        ci_flag=" (CI)"
    fi
    
    cat << EOF
Environment Detection:
  Mode: ${adapter}${ci_flag}
  Base Directory: ${base_dir}
  Working Directory: ${PWD}
  GitHub Workspace: ${GITHUB_WORKSPACE:-"(not set)"}
EOF
}