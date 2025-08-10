#!/bin/sh
# pre_apply_adapter.sh
# Adapter for testing in chezmoi source directory (before apply)

# Get base directory for pre-apply mode
pre_apply_get_base_dir() {
    if [ -n "$GITHUB_WORKSPACE" ]; then
        echo "$GITHUB_WORKSPACE"
    else
        # Find the chezmoi source root directory
        local check_dir="$PWD"
        while [ "$check_dir" != "/" ]; do
            if [ -f "$check_dir/dot_bashrc" ] || [ -d "$check_dir/dot_shell_common" ]; then
                echo "$check_dir"
                return
            fi
            check_dir="$(dirname "$check_dir")"
        done
        # Fallback to parent if we're inside dot_shell_common
        if [ "$(basename "$PWD")" = "dot_shell_common" ]; then
            echo "$(dirname "$PWD")"
        else
            echo "$PWD"
        fi
    fi
}

# Path resolution functions for chezmoi source structure
pre_apply_get_bashrc_path() {
    local base_dir=$(pre_apply_get_base_dir)
    echo "$base_dir/dot_bashrc"
}

pre_apply_get_zshrc_path() {
    local base_dir=$(pre_apply_get_base_dir)
    echo "$base_dir/dot_zsh/dot_zshrc"
}

pre_apply_get_shell_common_dir() {
    local base_dir=$(pre_apply_get_base_dir)
    echo "$base_dir/dot_shell_common"
}

pre_apply_get_functions_path() {
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    echo "$shell_common_dir/functions.sh"
}

pre_apply_get_aliases_path() {
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    echo "$shell_common_dir/aliases.sh"
}

pre_apply_get_init_path() {
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    echo "$shell_common_dir/init.sh"
}

# File existence checks
pre_apply_file_exists() {
    local file_path="$1"
    [ -f "$file_path" ]
}

pre_apply_dir_exists() {
    local dir_path="$1"
    [ -d "$dir_path" ]
}

# Shell execution functions for testing configuration loading
pre_apply_test_bash_loading() {
    local bashrc_path=$(pre_apply_get_bashrc_path)
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    
    if [ -f "$bashrc_path" ]; then
        # Test by sourcing bashrc and checking SHELL_COMMON
        bash -c "source '$bashrc_path' && [ -n \"\$SHELL_COMMON\" ] && echo 'SUCCESS' || echo 'FAILED'" 2>/dev/null
    else
        # Direct test by setting up SHELL_COMMON and sourcing init
        local init_path=$(pre_apply_get_init_path)
        if [ -f "$init_path" ]; then
            bash -c "export SHELL_COMMON='$shell_common_dir' && source '$init_path' && echo 'SUCCESS' || echo 'FAILED'"
        else
            echo "MISSING_INIT"
        fi
    fi
}

pre_apply_test_zsh_loading() {
    local zshrc_path=$(pre_apply_get_zshrc_path)
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    
    if [ -f "$zshrc_path" ]; then
        # For CI environment, set ZDOTDIR
        if [ -n "$GITHUB_WORKSPACE" ]; then
            local zdotdir="$GITHUB_WORKSPACE/dot_zsh"
            zsh -c "export ZDOTDIR='$zdotdir' && source '$zshrc_path' && [ -n \"\$SHELL_COMMON\" ] && echo 'SUCCESS' || echo 'FAILED'" 2>/dev/null
        else
            # Local environment
            zsh -c "source '$zshrc_path' && [ -n \"\$SHELL_COMMON\" ] && echo 'SUCCESS' || echo 'FAILED'" 2>/dev/null
        fi
    else
        # Direct test by setting up SHELL_COMMON and sourcing init
        local init_path=$(pre_apply_get_init_path)
        if [ -f "$init_path" ]; then
            zsh -c "export SHELL_COMMON='$shell_common_dir' && source '$init_path' && echo 'SUCCESS' || echo 'FAILED'"
        else
            echo "MISSING_INIT"
        fi
    fi
}

# Test PATH configuration
pre_apply_test_path_setup() {
    local shell="$1"
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    local init_path=$(pre_apply_get_init_path)
    
    if [ -f "$init_path" ]; then
        "$shell" -c "export SHELL_COMMON='$shell_common_dir' && source '$init_path' && echo \$PATH" | grep -q "\.local/bin"
        return $?
    else
        return 1
    fi
}

# Test function availability
pre_apply_test_function_exists() {
    local function_name="$1"
    local shell="$2"
    local functions_path=$(pre_apply_get_functions_path)
    
    if [ -f "$functions_path" ]; then
        "$shell" -c "source '$functions_path' && type $function_name >/dev/null 2>&1"
        return $?
    else
        return 1
    fi
}

# Test alias availability
pre_apply_test_alias_exists() {
    local alias_name="$1"
    local aliases_path=$(pre_apply_get_aliases_path)
    
    if [ -f "$aliases_path" ]; then
        grep -q "^alias $alias_name=" "$aliases_path"
        return $?
    else
        return 1
    fi
}

# Get configuration summary for this adapter
pre_apply_get_config_summary() {
    local base_dir=$(pre_apply_get_base_dir)
    local bashrc_path=$(pre_apply_get_bashrc_path)
    local zshrc_path=$(pre_apply_get_zshrc_path)
    local shell_common_dir=$(pre_apply_get_shell_common_dir)
    
    cat << EOF
Pre-Apply Configuration:
  Base Directory: $base_dir
  Bashrc: $([ -f "$bashrc_path" ] && echo "Found" || echo "Missing") ($bashrc_path)
  Zshrc: $([ -f "$zshrc_path" ] && echo "Found" || echo "Missing") ($zshrc_path)
  Shell Common: $([ -d "$shell_common_dir" ] && echo "Found" || echo "Missing") ($shell_common_dir)
EOF
}