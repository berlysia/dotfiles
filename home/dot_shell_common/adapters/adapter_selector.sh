#!/bin/sh
# adapter_selector.sh
# Automatically selects the appropriate adapter based on environment

# Resolve .chezmoiroot redirect for a given directory
# If .chezmoiroot exists, returns dir/chezmoiroot_value; otherwise returns dir unchanged
resolve_chezmoiroot() {
    local dir="$1"
    if [ -f "$dir/.chezmoiroot" ]; then
        local root_subdir
        root_subdir=$(head -1 "$dir/.chezmoiroot" | tr -d '[:space:]')
        if [ -n "$root_subdir" ] && [ -d "$dir/$root_subdir" ]; then
            echo "$dir/$root_subdir"
            return
        fi
    fi
    echo "$dir"
}

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

# Advanced CI environment detection
is_ci_mode() {
    [ -n "$GITHUB_WORKSPACE" ] || [ -n "$CI" ] || [ -n "$GITHUB_ACTIONS" ] || \
    [ -n "$GITLAB_CI" ] || [ -n "$CIRCLECI" ] || [ -n "$TRAVIS" ] || \
    [ -n "$JENKINS_URL" ] || [ -n "$BUILDKITE" ] || [ -n "$AZURE_DEVOPS" ]
}

# Detect specific CI platform
get_ci_platform() {
    if [ -n "$GITHUB_ACTIONS" ]; then
        echo "github-actions"
    elif [ -n "$GITLAB_CI" ]; then
        echo "gitlab-ci"
    elif [ -n "$CIRCLECI" ]; then
        echo "circleci"
    elif [ -n "$TRAVIS" ]; then
        echo "travis-ci"
    elif [ -n "$JENKINS_URL" ]; then
        echo "jenkins"
    elif [ -n "$BUILDKITE" ]; then
        echo "buildkite"
    elif [ -n "$AZURE_DEVOPS" ] || [ -n "$BUILD_BUILDNUMBER" ]; then
        echo "azure-devops"
    elif [ -n "$CI" ]; then
        echo "generic-ci"
    else
        echo "none"
    fi
}

# Container environment detection
is_container_mode() {
    # Check for container indicators
    [ -f "/.dockerenv" ] || \
    [ -n "$CONTAINER" ] || \
    [ -n "$DOCKER_CONTAINER" ] || \
    grep -q "container=docker" /proc/1/environ 2>/dev/null || \
    grep -q "docker" /proc/1/cgroup 2>/dev/null
}

# Remote development environment support
is_remote_dev_mode() {
    # GitHub Codespaces
    [ -n "$CODESPACES" ] || [ -n "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" ] || \
    # VS Code Remote Containers
    [ -n "$VSCODE_REMOTE_CONTAINERS_SESSION" ] || [ -n "$REMOTE_CONTAINERS" ] || \
    # GitPod
    [ -n "$GITPOD_WORKSPACE_ID" ] || \
    # DevPod
    [ -n "$DEVPOD" ] || \
    # General remote development
    [ -n "$SSH_CONNECTION" ] || [ -n "$SSH_CLIENT" ]
}

# Get remote development platform
get_remote_dev_platform() {
    if [ -n "$CODESPACES" ]; then
        echo "github-codespaces"
    elif [ -n "$VSCODE_REMOTE_CONTAINERS_SESSION" ]; then
        echo "vscode-remote-containers"
    elif [ -n "$GITPOD_WORKSPACE_ID" ]; then
        echo "gitpod"
    elif [ -n "$DEVPOD" ]; then
        echo "devpod"
    elif [ -n "$SSH_CONNECTION" ]; then
        echo "ssh-remote"
    else
        echo "none"
    fi
}

# Enhanced path resolution with XDG and platform support
get_config_directory() {
    local config_type="$1"  # bashrc, zshrc, shell_common
    
    case "$config_type" in
        "config_home")
            # XDG_CONFIG_HOME support
            echo "${XDG_CONFIG_HOME:-$HOME/.config}"
            ;;
        "zsh_dir")
            # ZDOTDIR-aware zsh configuration detection
            if [ -n "$ZDOTDIR" ]; then
                echo "$ZDOTDIR"
            elif [ -d "$HOME/.config/zsh" ]; then
                echo "$HOME/.config/zsh"
            else
                echo "$HOME"
            fi
            ;;
        "shell_common")
            if is_pre_apply_mode; then
                get_base_directory
            else
                echo "$HOME/.shell_common"
            fi
            ;;
        *)
            echo "$HOME"
            ;;
    esac
}

# Platform-specific profile paths
get_platform_profile_paths() {
    local os_name
    os_name=$(uname -s 2>/dev/null)
    
    case "$os_name" in
        "Darwin")
            # macOS-specific paths
            echo "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin"
            ;;
        "Linux")
            # Linux standard paths
            echo "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin"
            ;;
        CYGWIN*|MINGW*|MSYS*)
            # Windows PowerShell profile support
            local ps_profile_dir="${USERPROFILE:-$HOME}/Documents/PowerShell"
            if [ -d "$ps_profile_dir" ]; then
                echo "$ps_profile_dir"
            else
                echo "$HOME"
            fi
            ;;
        *)
            echo "/usr/local/bin:/usr/bin:/bin"
            ;;
    esac
}

# Enhanced tool detection with platform awareness
get_platform_tool_paths() {
    local os_name
    os_name=$(uname -s 2>/dev/null)
    local arch_name
    arch_name=$(uname -m 2>/dev/null)
    
    case "$os_name" in
        "Darwin")
            # macOS-specific tool locations
            if [ "$arch_name" = "arm64" ]; then
                echo "/opt/homebrew/bin:/opt/homebrew/sbin"
            else
                echo "/usr/local/bin"
            fi
            ;;
        "Linux")
            # Linux distribution variations
            if [ -d "/snap/bin" ]; then
                echo "/snap/bin"  # Ubuntu snap
            elif [ -d "/usr/local/bin" ]; then
                echo "/usr/local/bin"
            fi
            ;;
        CYGWIN*|MINGW*|MSYS*)
            # Windows tool paths
            echo "/mingw64/bin:/usr/bin"
            ;;
        *)
            echo "/usr/local/bin"
            ;;
    esac
}

# Get the base directory based on mode (enhanced)
get_base_directory() {
    if is_ci_mode && [ -n "$GITHUB_WORKSPACE" ]; then
        resolve_chezmoiroot "$GITHUB_WORKSPACE"
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
    local adapter_name
    adapter_name=$(select_adapter)
    local script_dir
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    local adapter_file
    adapter_file="$script_dir/${adapter_name}_adapter.sh"
    
    if [ -f "$adapter_file" ]; then
        . "$adapter_file"
        echo "$adapter_name"
    else
        echo "ERROR: Adapter file not found: $adapter_file" >&2
        return 1
    fi
}

# Cross-platform adapter selection with enhanced detection
select_enhanced_adapter() {
    local base_adapter
    base_adapter=$(select_adapter)
    local platform_suffix=""
    local env_suffix=""
    
    # Add platform suffix
    local os_name
    os_name=$(uname -s 2>/dev/null)
    case "$os_name" in
        "Darwin") platform_suffix="_macos" ;;
        "Linux") platform_suffix="_linux" ;;
        CYGWIN*|MINGW*|MSYS*) platform_suffix="_windows" ;;
        *) platform_suffix="" ;;
    esac
    
    # Add environment suffix
    if is_ci_mode; then
        env_suffix="_ci"
    elif is_container_mode; then
        env_suffix="_container"
    elif is_remote_dev_mode; then
        env_suffix="_remote"
    fi
    
    echo "${base_adapter}${platform_suffix}${env_suffix}"
}

# Windows PowerShell compatibility detection
is_powershell_available() {
    command -v pwsh >/dev/null 2>&1 || command -v powershell.exe >/dev/null 2>&1
}

# macOS architecture detection
get_macos_architecture() {
    local arch_name
    arch_name=$(uname -m 2>/dev/null)
    case "$arch_name" in
        "arm64") echo "apple-silicon" ;;
        "x86_64") echo "intel" ;;
        *) echo "unknown" ;;
    esac
}

# Linux distribution detection
get_linux_distribution() {
    if [ -f /etc/os-release ]; then
        grep '^ID=' /etc/os-release | cut -d'=' -f2 | tr -d '"'
    elif [ -f /etc/lsb-release ]; then
        grep '^DISTRIB_ID=' /etc/lsb-release | cut -d'=' -f2 | tr -d '"'
    elif command -v lsb_release >/dev/null 2>&1; then
        lsb_release -si | tr '[:upper:]' '[:lower:]'
    else
        echo "unknown"
    fi
}

# Get comprehensive environment info for debugging
get_environment_info() {
    local adapter
    adapter=$(select_adapter)
    local enhanced_adapter
    enhanced_adapter=$(select_enhanced_adapter)
    local base_dir
    base_dir=$(get_base_directory)
    local os_name
    os_name=$(uname -s 2>/dev/null)
    local arch_name
    arch_name=$(uname -m 2>/dev/null)
    
    # Environment flags
    local flags=""
    if is_ci_mode; then
        flags="$flags CI($(get_ci_platform))"
    fi
    if is_container_mode; then
        flags="$flags Container"
    fi
    if is_remote_dev_mode; then
        flags="$flags Remote($(get_remote_dev_platform))"
    fi
    
    # Platform-specific details
    local platform_info=""
    case "$os_name" in
        "Darwin")
            platform_info="macOS $(get_macos_architecture)"
            ;;
        "Linux")
            platform_info="Linux $(get_linux_distribution)"
            if grep -qi microsoft /proc/version 2>/dev/null; then
                platform_info="$platform_info (WSL)"
            fi
            ;;
        CYGWIN*|MINGW*|MSYS*)
            platform_info="Windows ($os_name)"
            if is_powershell_available; then
                platform_info="$platform_info + PowerShell"
            fi
            ;;
        *)
            platform_info="$os_name ($arch_name)"
            ;;
    esac
    
    cat << EOF
Enhanced Environment Detection:
  Basic Mode: $adapter
  Enhanced Mode: $enhanced_adapter
  Platform: $platform_info
  Environment Flags: ${flags:-"None"}
  Base Directory: $base_dir
  Config Directory: $(get_config_directory config_home)
  Zsh Directory: $(get_config_directory zsh_dir)
  Platform Tool Paths: $(get_platform_tool_paths)
  Working Directory: $PWD
EOF
}
