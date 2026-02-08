#!/bin/sh
# post_apply_adapter.sh
# Adapter for testing in installed environment (after chezmoi apply)

# Path resolution functions for installed structure
post_apply_get_bashrc_path() {
    echo "$HOME/.bashrc"
}

post_apply_get_zshrc_path() {
    echo "${ZDOTDIR:-$HOME}/.zshrc"
}

post_apply_get_shell_common_dir() {
    # Use SHELL_COMMON if set, otherwise default location
    echo "${SHELL_COMMON:-$HOME/.shell_common}"
}

post_apply_get_functions_path() {
    local shell_common_dir
    shell_common_dir=$(post_apply_get_shell_common_dir)
    echo "$shell_common_dir/functions.sh"
}

post_apply_get_aliases_path() {
    local shell_common_dir
    shell_common_dir=$(post_apply_get_shell_common_dir)
    echo "$shell_common_dir/aliases.sh"
}

post_apply_get_init_path() {
    local shell_common_dir
    shell_common_dir=$(post_apply_get_shell_common_dir)
    echo "$shell_common_dir/init.sh"
}

# File existence checks
post_apply_file_exists() {
    local file_path="$1"
    [ -f "$file_path" ]
}

post_apply_dir_exists() {
    local dir_path="$1"
    [ -d "$dir_path" ]
}

# Shell execution functions for testing installed configuration
post_apply_test_bash_loading() {
    local bashrc_path
    bashrc_path=$(post_apply_get_bashrc_path)
    
    if [ -f "$bashrc_path" ]; then
        # Test by sourcing bashrc which should set up SHELL_COMMON
        bash -c "source '$bashrc_path' && [ -n \"\$SHELL_COMMON\" ] && echo 'SUCCESS' || echo 'FAILED'"
    else
        echo "MISSING_BASHRC"
    fi
}

post_apply_test_zsh_loading() {
    local zshrc_path
    zshrc_path=$(post_apply_get_zshrc_path)
    
    if [ -f "$zshrc_path" ]; then
        # Test by sourcing zshrc which should set up SHELL_COMMON
        zsh -c "source '$zshrc_path' && [ -n \"\$SHELL_COMMON\" ] && echo 'SUCCESS' || echo 'FAILED'"
    else
        echo "MISSING_ZSHRC"
    fi
}

# Test PATH configuration
post_apply_test_path_setup() {
    local shell="$1"
    local config_path=""
    
    case "$shell" in
        bash)
            config_path=$(post_apply_get_bashrc_path)
            ;;
        zsh)
            config_path=$(post_apply_get_zshrc_path)
            ;;
        *)
            return 1
            ;;
    esac
    
    if [ -f "$config_path" ]; then
        "$shell" -c "source '$config_path' && echo \$PATH" | grep -q "\.local/bin"
        return $?
    else
        return 1
    fi
}

# Test function availability in current environment
post_apply_test_function_exists() {
    local function_name="$1"
    local shell="$2"
    
    # Test by loading the user's shell configuration
    case "$shell" in
        bash)
            local config_path
            config_path=$(post_apply_get_bashrc_path)
            if [ -f "$config_path" ]; then
                bash -c "source '$config_path' && type $function_name >/dev/null 2>&1"
                return $?
            fi
            ;;
        zsh)
            local config_path
            config_path=$(post_apply_get_zshrc_path)
            if [ -f "$config_path" ]; then
                zsh -c "source '$config_path' && type $function_name >/dev/null 2>&1"
                return $?
            fi
            ;;
    esac
    
    return 1
}

# Test alias availability in current environment
post_apply_test_alias_exists() {
    local alias_name="$1"
    local aliases_path
    aliases_path=$(post_apply_get_aliases_path)
    
    if [ -f "$aliases_path" ]; then
        grep -q "^alias $alias_name=" "$aliases_path"
        return $?
    else
        return 1
    fi
}

# Test if chezmoi is properly configured
post_apply_test_chezmoi_status() {
    if command -v chezmoi >/dev/null 2>&1; then
        local source_dir
        source_dir=$(chezmoi source-path 2>/dev/null)
        if [ -n "$source_dir" ] && [ -d "$source_dir" ]; then
            echo "CONFIGURED"
            return 0
        else
            echo "NOT_INITIALIZED"
            return 1
        fi
    else
        echo "NOT_INSTALLED"
        return 1
    fi
}

# Test git configuration
post_apply_test_git_config() {
    if command -v git >/dev/null 2>&1; then
        local user_name
        user_name=$(git config --global user.name 2>/dev/null)
        local user_email
        user_email=$(git config --global user.email 2>/dev/null)
        
        if [ -n "$user_name" ] && [ -n "$user_email" ]; then
            echo "CONFIGURED"
            return 0
        else
            echo "INCOMPLETE"
            return 1
        fi
    else
        echo "NOT_INSTALLED"
        return 1
    fi
}

# Test environment variables
post_apply_test_env_var() {
    local var_name="$1"
    local config_path=""
    
    # Try to load environment from shell configuration
    if [ "$SHELL" = "/bin/zsh" ] || [ "$SHELL" = "/usr/bin/zsh" ]; then
        config_path=$(post_apply_get_zshrc_path)
    else
        config_path=$(post_apply_get_bashrc_path)
    fi
    
    if [ -f "$config_path" ]; then
        local shell_name
        shell_name=$(basename "$SHELL")
        "$shell_name" -c "source '$config_path' && eval echo \\\$$var_name" 2>/dev/null
    else
        eval echo \$$var_name
    fi
}

# Get configuration summary for this adapter
post_apply_get_config_summary() {
    local bashrc_path
    bashrc_path=$(post_apply_get_bashrc_path)
    local zshrc_path
    zshrc_path=$(post_apply_get_zshrc_path)
    local shell_common_dir
    shell_common_dir=$(post_apply_get_shell_common_dir)
    
    cat << EOF
Post-Apply Configuration:
  Home Directory: $HOME
  Bashrc: $([ -f "$bashrc_path" ] && echo "Found" || echo "Missing") ($bashrc_path)
  Zshrc: $([ -f "$zshrc_path" ] && echo "Found" || echo "Missing") ($zshrc_path)
  Shell Common: $([ -d "$shell_common_dir" ] && echo "Found" || echo "Missing") ($shell_common_dir)
  Current Shell: ${SHELL:-"not set"}
  ZDOTDIR: ${ZDOTDIR:-"not set"}
EOF
}
