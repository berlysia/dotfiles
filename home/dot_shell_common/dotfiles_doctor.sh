#!/bin/sh
# dotfiles_doctor.sh - DEPRECATED - Legacy wrapper for test_suite.sh
# This file is maintained for backward compatibility only
# Please use test_suite.sh directly for all new features
#
# Migration Notice:
#   Old: dotfiles_doctor.sh [options]
#   New: test_suite.sh [options]
#
# The new test_suite.sh includes all functionality plus:
# - Weighted scoring system
# - Enhanced environment detection
# - Actionable recommendations
# - Cross-platform support

# Color codes for output - always use colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Icons for status
ICON_SUCCESS="✅"
ICON_WARNING="⚠️ "
ICON_ERROR="❌"
ICON_INFO="ℹ️ "
ICON_SKIP="⏭️ "

# Default options
VERBOSE=0
QUIET=0

# Counters for summary
TOTAL_CHECKS=0
PASSED_CHECKS=0
WARNED_CHECKS=0
FAILED_CHECKS=0
SKIPPED_CHECKS=0

# Weight for scoring
WEIGHT_REQUIRED=10
WEIGHT_RECOMMENDED=5
WEIGHT_OPTIONAL=1
TOTAL_WEIGHT=0
ACHIEVED_WEIGHT=0

# OS detection
OS_TYPE=""
case "$(uname -s)" in
    Linux*)     OS_TYPE="linux";;
    Darwin*)    OS_TYPE="darwin";;
    CYGWIN*|MINGW*|MSYS*) OS_TYPE="windows";;
    *)          OS_TYPE="unknown";;
esac

# Function to print colored messages
print_status() {
    local msg_status="$1"
    local message="$2"
    local details="$3"
    
    TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
    
    case "$msg_status" in
        "success")
            PASSED_CHECKS=$((PASSED_CHECKS + 1))
            [ $QUIET -eq 0 ] && printf "${GREEN}${ICON_SUCCESS}${NC} %s\n" "$message"
            [ $VERBOSE -eq 1 ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        "warning")
            WARNED_CHECKS=$((WARNED_CHECKS + 1))
            printf "${YELLOW}${ICON_WARNING}${NC} %s\n" "$message"
            [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        "error")
            FAILED_CHECKS=$((FAILED_CHECKS + 1))
            printf "${RED}${ICON_ERROR}${NC} %s\n" "$message"
            [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        "info")
            [ $QUIET -eq 0 ] && printf "${BLUE}${ICON_INFO}${NC} %s\n" "$message"
            [ $VERBOSE -eq 1 ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        "skip")
            SKIPPED_CHECKS=$((SKIPPED_CHECKS + 1))
            [ $VERBOSE -eq 1 ] && printf "${GRAY}${ICON_SKIP} %s${NC}\n" "$message"
            ;;
        "header")
            [ $QUIET -eq 0 ] && printf "\n${BOLD}%s${NC}\n" "$message"
            ;;
    esac
}

# Function to add weight for scoring
add_weight() {
    local weight="$1"
    local achieved="$2"
    
    TOTAL_WEIGHT=$((TOTAL_WEIGHT + weight))
    if [ "$achieved" = "1" ]; then
        ACHIEVED_WEIGHT=$((ACHIEVED_WEIGHT + weight))
    fi
}

# Function to check if a command exists with dependency check
check_command_with_deps() {
    local cmd="$1"
    local priority="$2"  # "required", "recommended", or "optional"
    local description="$3"
    local install_hint="$4"
    local depends_on="$5"  # Optional dependency
    
    # Check dependency first
    if [ -n "$depends_on" ] && ! command -v "$depends_on" >/dev/null 2>&1; then
        [ $VERBOSE -eq 1 ] && print_status "skip" "$cmd - $description (skipped: $depends_on not found)"
        return
    fi
    
    # Set weight based on priority
    local weight=$WEIGHT_OPTIONAL
    case "$priority" in
        "required") weight=$WEIGHT_REQUIRED;;
        "recommended") weight=$WEIGHT_RECOMMENDED;;
    esac
    
    if command -v "$cmd" >/dev/null 2>&1; then
        local version=""
        case "$cmd" in
            git)
                version=$(git --version 2>/dev/null | head -1)
                ;;
            node|npm|pnpm|bun|deno)
                # Check if managed by mise
                if command -v mise >/dev/null 2>&1 && mise ls 2>/dev/null | grep -q "$cmd"; then
                    local mise_version
                    mise_version=$(mise current $cmd 2>/dev/null)
                    if [ -n "$mise_version" ]; then
                        version="mise: $mise_version"
                    else
                        case "$cmd" in
                            node) version=$(node --version 2>/dev/null);;
                            npm) version=$(npm --version 2>/dev/null);;
                            pnpm) version=$(pnpm --version 2>/dev/null);;
                            bun) version=$(bun --version 2>/dev/null);;
                            deno) version=$(deno --version 2>/dev/null | head -1);;
                        esac
                    fi
                else
                    case "$cmd" in
                        node) version=$(node --version 2>/dev/null);;
                        npm) version=$(npm --version 2>/dev/null);;
                        pnpm) version=$(pnpm --version 2>/dev/null);;
                        bun) version=$(bun --version 2>/dev/null);;
                        deno) version=$(deno --version 2>/dev/null | head -1);;
                    esac
                fi
                ;;
            go)
                if command -v mise >/dev/null 2>&1 && mise ls 2>/dev/null | grep -q "go"; then
                    local mise_version
                    mise_version=$(mise current go 2>/dev/null)
                    if [ -n "$mise_version" ]; then
                        version="mise: $mise_version"
                    else
                        version=$(go version 2>/dev/null)
                    fi
                else
                    version=$(go version 2>/dev/null)
                fi
                ;;
            rustc|cargo)
                if command -v mise >/dev/null 2>&1 && mise ls 2>/dev/null | grep -q "rust"; then
                    local mise_version
                    mise_version=$(mise current rust 2>/dev/null)
                    if [ -n "$mise_version" ]; then
                        version="mise: $mise_version"
                    else
                        case "$cmd" in
                            rustc) version=$(rustc --version 2>/dev/null);;
                            cargo) version=$(cargo --version 2>/dev/null);;
                        esac
                    fi
                else
                    case "$cmd" in
                        rustc) version=$(rustc --version 2>/dev/null);;
                        cargo) version=$(cargo --version 2>/dev/null);;
                    esac
                fi
                ;;
            mise)
                version=$(mise --version 2>/dev/null)
                ;;
            starship)
                version=$(starship --version 2>/dev/null | head -1)
                ;;
            chezmoi)
                version=$(chezmoi --version 2>/dev/null | head -1)
                ;;
            *)
                version="installed"
                ;;
        esac
        print_status "success" "$cmd - $description" "$version"
        add_weight $weight 1
    else
        if [ "$priority" = "required" ]; then
            print_status "error" "$cmd - $description (NOT FOUND)" "$install_hint"
            add_weight $weight 0
        else
            print_status "warning" "$cmd - $description ($priority, not installed)" "$install_hint"
            add_weight $weight 0
        fi
    fi
}

# Simplified wrapper for backward compatibility
check_command() {
    check_command_with_deps "$1" "$2" "$3" "$4" ""
}

# Function to check file or directory existence
check_path() {
    local path="$1"
    local description="$2"
    local type="$3"  # "file" or "directory"
    local priority="$4"  # "required", "recommended", or "optional"
    
    local weight=$WEIGHT_OPTIONAL
    case "$priority" in
        "required") weight=$WEIGHT_REQUIRED;;
        "recommended") weight=$WEIGHT_RECOMMENDED;;
    esac
    
    if [ "$type" = "file" ]; then
        if [ -f "$path" ]; then
            print_status "success" "$description" "$path exists"
            add_weight $weight 1
        else
            if [ "$priority" = "required" ]; then
                print_status "error" "$description" "$path not found"
            else
                print_status "warning" "$description" "$path not found"
            fi
            add_weight $weight 0
        fi
    elif [ "$type" = "directory" ]; then
        if [ -d "$path" ]; then
            print_status "success" "$description" "$path exists"
            add_weight $weight 1
        else
            if [ "$priority" = "required" ]; then
                print_status "error" "$description" "$path not found"
            else
                print_status "warning" "$description" "$path not found"
            fi
            add_weight $weight 0
        fi
    fi
}

# Function to check environment variable
check_env() {
    local var="$1"
    local description="$2"
    local priority="$3"
    
    local weight=$WEIGHT_OPTIONAL
    case "$priority" in
        "required") weight=$WEIGHT_REQUIRED;;
        "recommended") weight=$WEIGHT_RECOMMENDED;;
    esac
    
    eval "value=\$$var"
    if [ -n "$value" ]; then
        if [ $VERBOSE -eq 1 ]; then
            # Truncate long values for readability
            if [ ${#value} -gt 50 ]; then
                value="$(printf '%.47s...' "$value")"
            fi
            print_status "success" "$var - $description" "$value"
        else
            print_status "success" "$var - $description" "set"
        fi
        add_weight $weight 1
    else
        if [ "$priority" = "required" ]; then
            print_status "error" "$var - $description" "not set"
        else
            print_status "warning" "$var - $description ($priority)" "not set"
        fi
        add_weight $weight 0
    fi
}

# Function to check shell functions
check_function() {
    local func="$1"
    local description="$2"
    local shell="$3"
    
    # Try to check if function exists in the shell config
    local shell_rc
    shell_rc=$(get_shell_config_path "$shell")
    
    if [ -n "$shell_rc" ] && [ -f "$shell_rc" ]; then
        # Check if function is defined in shell config or common files
        # Allow both "func()" and "func ()" formats
        local functions_file="$HOME/.shell_common/functions.sh"
        if [ -n "$SHELL_COMMON" ]; then
            functions_file="$SHELL_COMMON/functions.sh"
        fi
        
        if grep -q "^${func}[[:space:]]*(" "$shell_rc" 2>/dev/null || \
           grep -q "^${func}[[:space:]]*(" "$functions_file" 2>/dev/null; then
            print_status "success" "Function: $func - $description" "defined"
            add_weight $WEIGHT_OPTIONAL 1
        else
            [ $VERBOSE -eq 1 ] && print_status "warning" "Function: $func - $description" "not found"
            add_weight $WEIGHT_OPTIONAL 0
        fi
    fi
}

# Function to check aliases
check_alias() {
    local alias_name="$1"
    local description="$2"
    
    # Check if alias is defined in common aliases file
    local aliases_file="$HOME/.shell_common/aliases.sh"
    if [ -n "$SHELL_COMMON" ]; then
        aliases_file="$SHELL_COMMON/aliases.sh"
    fi
    
    if [ -f "$aliases_file" ]; then
        if grep -q "^alias $alias_name=" "$aliases_file" 2>/dev/null; then
            print_status "success" "Alias: $alias_name - $description" "defined"
            add_weight $WEIGHT_OPTIONAL 1
        else
            [ $VERBOSE -eq 1 ] && print_status "warning" "Alias: $alias_name - $description" "not found"
            add_weight $WEIGHT_OPTIONAL 0
        fi
    fi
}

# Function to get shell configuration file path (respects environment variables)
get_shell_config_path() {
    local shell_name="$1"
    
    case "$shell_name" in
        bash)
            printf "%s" "$HOME/.bashrc"
            ;;
        zsh)
            printf "%s" "${ZDOTDIR:-$HOME}/.zshrc"
            ;;
        fish)
            printf "%s" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
            ;;
        *)
            printf "%s" "$HOME/.${shell_name}rc"
            ;;
    esac
}

# Function to format shell display name with environment variable notes
format_shell_display_name() {
    local shell_name="$1"
    local config_path="$2"
    
    case "$shell_name" in
        zsh)
            if [ -n "$ZDOTDIR" ]; then
                printf "%s (ZDOTDIR)" "$shell_name"
            else
                printf "%s" "$shell_name"
            fi
            ;;
        fish)
            if [ -n "$XDG_CONFIG_HOME" ]; then
                printf "%s (XDG_CONFIG_HOME)" "$shell_name"
            else
                printf "%s" "$shell_name"
            fi
            ;;
        *)
            printf "%s" "$shell_name"
            ;;
    esac
}

# Function to check shell configuration
check_shell_config() {
    local shell_name="$1"
    local priority="$2"  # "required", "recommended", or "optional"
    
    # Get configuration file path and display name
    local config_file
    config_file=$(get_shell_config_path "$shell_name")
    local display_name
    display_name=$(format_shell_display_name "$shell_name" "$config_file")
    
    # Determine weight based on priority
    local weight=$WEIGHT_OPTIONAL
    case "$priority" in
        "required") weight=$WEIGHT_REQUIRED;;
        "recommended") weight=$WEIGHT_RECOMMENDED;;
    esac
    
    if [ -f "$config_file" ]; then
        # Check if shell common is sourced
        if grep -q "SHELL_COMMON" "$config_file" 2>/dev/null; then
            print_status "success" "$display_name configuration" "$config_file properly configured"
            add_weight $weight 1
        else
            print_status "warning" "$display_name configuration" "$config_file exists but may not source common settings"
            add_weight $weight 0
        fi
    else
        if [ "$priority" = "required" ]; then
            print_status "error" "$display_name configuration" "$config_file not found"
            add_weight $weight 0
        else
            print_status "skip" "$display_name configuration" "$config_file not found"
            add_weight $weight 0
        fi
    fi
}

# Function to check Git configuration
check_git_config() {
    if command -v git >/dev/null 2>&1; then
        local user_name
        user_name=$(git config --global user.name 2>/dev/null)
        local user_email
        user_email=$(git config --global user.email 2>/dev/null)
        
        if [ -n "$user_name" ] && [ -n "$user_email" ]; then
            print_status "success" "Git user configuration" "$user_name <$user_email>"
            add_weight $WEIGHT_REQUIRED 1
        else
            print_status "error" "Git user configuration" "user.name or user.email not set"
            add_weight $WEIGHT_REQUIRED 0
        fi
        
        # Check for GPG signing
        local gpg_sign
        gpg_sign=$(git config --global commit.gpgsign 2>/dev/null)
        if [ "$gpg_sign" = "true" ]; then
            local signing_key
            signing_key=$(git config --global user.signingkey 2>/dev/null)
            if [ -n "$signing_key" ]; then
                print_status "success" "Git GPG signing" "enabled with key"
                add_weight $WEIGHT_RECOMMENDED 1
            else
                print_status "warning" "Git GPG signing" "enabled but no signing key configured"
                add_weight $WEIGHT_RECOMMENDED 0
            fi
        else
            [ $VERBOSE -eq 1 ] && print_status "info" "Git GPG signing" "not enabled"
        fi
    fi
}

# Function to check chezmoi status
check_chezmoi() {
    if command -v chezmoi >/dev/null 2>&1; then
        local source_dir
        source_dir=$(chezmoi source-path 2>/dev/null)
        if [ -n "$source_dir" ] && [ -d "$source_dir" ]; then
            print_status "success" "Chezmoi source directory" "$source_dir"
            add_weight $WEIGHT_REQUIRED 1
            
            # Check for uncommitted changes
            if git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
                local git_status
                git_status=$(cd "$source_dir" && git status --porcelain 2>/dev/null)
                if [ -z "$git_status" ]; then
                    print_status "success" "Chezmoi repository" "clean"
                    add_weight $WEIGHT_RECOMMENDED 1
                else
                    local changed_count
                    changed_count=$(echo "$git_status" | wc -l)
                    print_status "warning" "Chezmoi repository" "$changed_count uncommitted changes"
                    add_weight $WEIGHT_RECOMMENDED 0
                fi
            fi
        else
            print_status "error" "Chezmoi" "not initialized"
            add_weight $WEIGHT_REQUIRED 0
        fi
    fi
}

# Function to check OS-specific packages
check_os_packages() {
    case "$OS_TYPE" in
        linux)
            print_status "header" "Package Manager (Linux)"
            check_command "apt" "recommended" "APT package manager" "System package manager"
            check_command "notify-send" "optional" "Desktop notifications" "apt install libnotify-bin"
            check_command "paplay" "optional" "Audio playback" "apt install pulseaudio-utils"
            ;;
        darwin)
            print_status "header" "Package Manager (macOS)"
            check_command "brew" "recommended" "Homebrew package manager" "https://brew.sh"
            check_command "terminal-notifier" "optional" "Desktop notifications" "brew install terminal-notifier"
            ;;
        windows)
            print_status "header" "Package Manager (Windows)"
            check_command "winget" "recommended" "Windows Package Manager" "Microsoft Store: App Installer"
            check_command "pwsh" "recommended" "PowerShell Core" "winget install Microsoft.PowerShell"
            ;;
    esac
}

# Function to show help
show_help() {
    cat << EOF
doctor - System health check for development environment

Usage: doctor [options]

Options:
    -v, --verbose    Show detailed output for all checks
    -q, --quiet      Only show errors and warnings
    -h, --help       Show this help message

This script checks:
    - Core requirements (shell, git, chezmoi)
    - Shell environment and configuration
    - Version managers (mise)
    - Programming languages and runtimes
    - Development tools and CLI utilities
    - Text editors and IDE configuration
    - Security and authentication tools
    - Directory structure
    - Environment variables
    - Shell functions and aliases

Exit codes:
    0 - All checks passed or only warnings
    1 - Some required checks failed
    2 - Critical errors found
EOF
}

# Parse command line arguments
while [ $# -gt 0 ]; do
    case "$1" in
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -q|--quiet)
            QUIET=1
            shift
            ;;
        -h|--help)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Main checks
[ $QUIET -eq 0 ] && printf "${BOLD}System Health Check${NC}\n"
[ $QUIET -eq 0 ] && printf "${GRAY}%s${NC}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
[ $QUIET -eq 0 ] && printf "${GRAY}OS: %s${NC}\n\n" "$OS_TYPE"

# Core Requirements
print_status "header" "Core Requirements"
check_command "sh" "required" "POSIX shell" "Should be pre-installed"
check_command "bash" "required" "Bash shell" "apt install bash / brew install bash"
check_command "git" "required" "Version control" "apt install git / brew install git"
check_command "curl" "required" "HTTP client" "apt install curl / brew install curl"
check_command "chezmoi" "required" "Dotfiles manager" "sh -c \"\$(curl -fsLS get.chezmoi.io)\""

# Shell Environment
print_status "header" "Shell Environment"

# Detect current shell
CURRENT_SHELL=$(basename "$SHELL")
[ $VERBOSE -eq 1 ] && print_status "info" "Current shell: $CURRENT_SHELL"

# Check shells and their configurations
if [ "$CURRENT_SHELL" = "zsh" ]; then
    check_command "zsh" "required" "Z shell (current)" "apt install zsh / brew install zsh"
    check_shell_config "zsh" "required"
    check_command "bash" "optional" "Bash shell" "apt install bash / brew install bash"
    [ $VERBOSE -eq 1 ] && check_shell_config "bash" "optional"
else
    # Default to bash or other shells
    check_command "bash" "required" "Bash shell (current)" "apt install bash / brew install bash"  
    check_shell_config "bash" "required"
    check_command "zsh" "optional" "Z shell" "apt install zsh / brew install zsh"
    [ $VERBOSE -eq 1 ] && check_shell_config "zsh" "optional"
fi

# Version Management
print_status "header" "Version Management"
check_command "mise" "recommended" "Version manager" "curl https://mise.run | sh"

# Languages & Runtimes (managed by mise)
print_status "header" "Languages & Runtimes"
check_command_with_deps "node" "recommended" "Node.js runtime" "mise use node@latest" ""
check_command_with_deps "pnpm" "optional" "Fast package manager" "mise use pnpm@latest" ""
check_command_with_deps "bun" "optional" "JavaScript runtime" "mise use bun@latest" ""
check_command_with_deps "deno" "optional" "Secure JS/TS runtime" "mise use deno@latest" ""
check_command_with_deps "go" "optional" "Go programming language" "mise use go@latest" ""
check_command_with_deps "rustc" "optional" "Rust compiler" "mise use rust@latest" ""
check_command_with_deps "direnv" "optional" "Environment switcher" "mise use direnv@latest" ""

# Package Managers
print_status "header" "Package Managers"
check_command_with_deps "npm" "optional" "Node package manager" "Comes with Node.js" "node"
check_command_with_deps "cargo" "optional" "Rust package manager" "Comes with Rust" "rustc"

# Development Tools
print_status "header" "Development Tools"
check_command "starship" "recommended" "Cross-shell prompt" "curl -sS https://starship.rs/install.sh | sh"
check_command "gh" "optional" "GitHub CLI" "apt install gh / brew install gh"
check_command "rg" "recommended" "Ripgrep search" "apt install ripgrep / brew install ripgrep"
check_command "fd" "optional" "Find alternative" "apt install fd-find / brew install fd"
check_command "fzf" "optional" "Fuzzy finder" "apt install fzf / brew install fzf"
check_command "bat" "optional" "Cat with wings" "apt install bat / brew install bat"
check_command "jq" "optional" "JSON processor" "apt install jq / brew install jq"
check_command "age" "optional" "Encryption tool" "apt install age / brew install age"
check_command_with_deps "similarity-ts" "optional" "Code similarity detector" "cargo install similarity-ts" "cargo"
check_command_with_deps "git-sequential-stage" "optional" "Git staging helper" "go install github.com/syou6162/git-sequential-stage@latest" "go"

# Text Editors
print_status "header" "Text Editors"
check_command "vim" "optional" "Vi improved" "apt install vim / brew install vim"
check_command "code" "recommended" "VS Code" "https://code.visualstudio.com"

# Security & Authentication
print_status "header" "Security & Authentication"
check_command "op" "optional" "1Password CLI" "https://1password.com/downloads/command-line"

# OS-specific packages
check_os_packages

# Directory Structure
print_status "header" "Directory Structure"
check_path "$HOME/.local/bin" "User binaries directory" "directory" "recommended"
check_path "$HOME/.local/share/zsh-completions" "Zsh completions" "directory" "optional"
check_path "$HOME/.local/share/zsh-functions" "Zsh functions" "directory" "optional"
check_path "$HOME/.config" "User configuration directory" "directory" "recommended"
check_path "$HOME/.claude" "Claude configuration directory" "directory" "optional"

# Check language-specific tools (actual commands rather than directories)
print_status "header" "Language-specific Tools"
# Go tools
if command -v go >/dev/null 2>&1; then
    check_command "gofmt" "optional" "Go formatter" "Comes with Go installation"
    check_command "go" "optional" "Go compiler" "Already checked above"
fi

# Rust tools  
if command -v rustc >/dev/null 2>&1; then
    check_command "rustfmt" "optional" "Rust formatter" "Comes with Rust installation"
    check_command "clippy-driver" "optional" "Rust linter" "rustup component add clippy"
fi

# Node.js tools
if command -v node >/dev/null 2>&1; then
    check_command "pnpx" "optional" "Node package executor" "Comes with pnpm"
fi

# Environment Variables
print_status "header" "Environment Variables"
check_env "EDITOR" "Default editor" "recommended"
check_env "GOPATH" "Go workspace" "optional"
check_env "FZF_DEFAULT_OPTS" "FZF configuration" "optional"

# Shell Functions & Aliases
if [ $VERBOSE -eq 1 ]; then
    print_status "header" "Shell Functions"
    check_function "extract" "Extract archives" "$CURRENT_SHELL"
    check_function "opr" "1Password run" "$CURRENT_SHELL"
    check_function "opl" "1Password load" "$CURRENT_SHELL"
    
    print_status "header" "Shell Aliases"
    check_alias "claude" "Claude CLI"
fi

# Configuration Files
print_status "header" "Configuration Files"
check_git_config
check_path "$HOME/.config/starship.toml" "Starship configuration" "file" "optional"
check_path "$HOME/.claude/CLAUDE.md" "Claude configuration" "file" "optional"

# Chezmoi Status
print_status "header" "Chezmoi Status"
check_chezmoi

# Calculate health score
HEALTH_SCORE=0
if [ $TOTAL_WEIGHT -gt 0 ]; then
    HEALTH_SCORE=$((ACHIEVED_WEIGHT * 100 / TOTAL_WEIGHT))
fi

# Summary
[ $QUIET -eq 0 ] && printf "\n"
printf "${BOLD}Summary${NC}\n"
printf "${GRAY}────────────────────────────────────────${NC}\n"
printf "Total checks:    %d\n" "$TOTAL_CHECKS"
printf "${GREEN}Passed:          %d${NC}\n" "$PASSED_CHECKS"
[ $WARNED_CHECKS -gt 0 ] && printf "${YELLOW}Warnings:        %d${NC}\n" "$WARNED_CHECKS"
[ $FAILED_CHECKS -gt 0 ] && printf "${RED}Failed:          %d${NC}\n" "$FAILED_CHECKS"
[ $VERBOSE -eq 1 ] && [ $SKIPPED_CHECKS -gt 0 ] && printf "${GRAY}Skipped:         %d${NC}\n" "$SKIPPED_CHECKS"

# Health Score
printf "\n${BOLD}Health Score${NC}\n"
printf "${GRAY}────────────────────────────────────────${NC}\n"
if [ $HEALTH_SCORE -ge 90 ]; then
    printf "${GREEN}${BOLD}%d%%${NC} - Excellent! Your environment is fully configured.${NC}\n" "$HEALTH_SCORE"
elif [ $HEALTH_SCORE -ge 70 ]; then
    printf "${GREEN}%d%%${NC} - Good. Most tools are properly configured.\n" "$HEALTH_SCORE"
elif [ $HEALTH_SCORE -ge 50 ]; then
    printf "${YELLOW}%d%%${NC} - Fair. Some recommended tools are missing.\n" "$HEALTH_SCORE"
else
    printf "${RED}%d%%${NC} - Poor. Many required tools are missing.\n" "$HEALTH_SCORE"
fi

# Exit with appropriate code
if [ $FAILED_CHECKS -gt 0 ]; then
    # Check if any required checks failed
    if [ $HEALTH_SCORE -lt 50 ]; then
        printf "\n${RED}Critical: Required components are missing. Please install them first.${NC}\n"
        exit 2
    else
        printf "\n${YELLOW}Some checks failed but system is functional.${NC}\n"
        exit 1
    fi
elif [ $WARNED_CHECKS -gt 0 ]; then
    printf "\n${YELLOW}System is functional but some optional components are missing.${NC}\n"
    exit 0
else
    printf "\n${GREEN}All checks passed! Your system is perfectly configured.${NC}\n"
    exit 0
fi
