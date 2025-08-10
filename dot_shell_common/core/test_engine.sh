#!/bin/sh
# test_engine.sh
# Environment-independent test execution engine

# Test execution context
TEST_RESULTS=""
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Weight system for scoring
WEIGHT_REQUIRED=10
WEIGHT_RECOMMENDED=5
WEIGHT_OPTIONAL=1
TOTAL_WEIGHT=0
ACHIEVED_WEIGHT=0

# Test categories
TEST_CATEGORY_CORE="core"
TEST_CATEGORY_SHELL="shell"
TEST_CATEGORY_CONFIG="config"
TEST_CATEGORY_INTEGRATION="integration"
TEST_CATEGORY_TOOLS="tools"
TEST_CATEGORY_LANGUAGES="languages"
TEST_CATEGORY_DEVELOPMENT="development"
TEST_CATEGORY_SECURITY="security"

# Initialize test engine
init_test_engine() {
    TEST_RESULTS=""
    TOTAL_TESTS=0
    PASSED_TESTS=0
    FAILED_TESTS=0
    SKIPPED_TESTS=0
    TOTAL_WEIGHT=0
    ACHIEVED_WEIGHT=0
}

# Add weight for scoring
add_weight() {
    local weight="$1"
    local achieved="$2"
    
    TOTAL_WEIGHT=$((TOTAL_WEIGHT + weight))
    if [ "$achieved" = "1" ]; then
        ACHIEVED_WEIGHT=$((ACHIEVED_WEIGHT + weight))
    fi
}

# Add test result with weight support
add_test_result() {
    local category="$1"
    local name="$2"
    local test_status="$3"  # PASS, FAIL, SKIP
    local details="$4"
    local priority="$5"  # required, recommended, optional (optional parameter)
    local install_hint="$6"  # install hint (optional parameter)
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    # Calculate weight if priority is provided
    local weight=0
    local achieved=0
    if [ -n "$priority" ]; then
        case "$priority" in
            "required") weight=$WEIGHT_REQUIRED;;
            "recommended") weight=$WEIGHT_RECOMMENDED;;
            "optional") weight=$WEIGHT_OPTIONAL;;
        esac
    fi
    
    case "$test_status" in
        PASS)
            PASSED_TESTS=$((PASSED_TESTS + 1))
            achieved=1
            ;;
        FAIL)
            FAILED_TESTS=$((FAILED_TESTS + 1))
            achieved=0
            ;;
        SKIP)
            SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
            # Don't add weight for skipped tests
            weight=0
            ;;
    esac
    
    # Add weight if applicable
    if [ $weight -gt 0 ]; then
        add_weight $weight $achieved
    fi
    
    # Store result for reporting (include priority and install hint if provided)
    local result_line="$category|$name|$test_status|$details"
    if [ -n "$priority" ]; then
        result_line="$result_line|$priority"
        if [ -n "$install_hint" ]; then
            result_line="$result_line|$install_hint"
        fi
    fi
    
    if [ -z "$TEST_RESULTS" ]; then
        TEST_RESULTS="$result_line"
    else
        TEST_RESULTS="$TEST_RESULTS
$result_line"
    fi
}

# Check command with dependency support
check_command_with_deps() {
    local cmd="$1"
    local priority="$2"  # "required", "recommended", or "optional"
    local description="$3"
    local install_hint="$4"
    local depends_on="$5"  # Optional dependency
    local category="$6"    # Test category (defaults to "tools")
    
    # Default category
    if [ -z "$category" ]; then
        category="tools"
    fi
    
    # Check dependency first
    if [ -n "$depends_on" ] && ! command -v "$depends_on" >/dev/null 2>&1; then
        add_test_result "$category" "Command: $cmd - $description" "SKIP" "Dependency $depends_on not found" "$priority" "$install_hint"
        return
    fi
    
    if command -v "$cmd" >/dev/null 2>&1; then
        local version=""
        case "$cmd" in
            git)
                version=$(git --version 2>/dev/null | head -1)
                ;;
            node|npm|pnpm|bun|deno)
                # Check if managed by mise
                if command -v mise >/dev/null 2>&1 && mise ls 2>/dev/null | grep -q "$cmd"; then
                    local mise_version=$(mise current $cmd 2>/dev/null)
                    if [ -n "$mise_version" ]; then
                        version="$cmd $mise_version (managed by mise)"
                    else
                        version=$($cmd --version 2>/dev/null | head -1)
                    fi
                else
                    version=$($cmd --version 2>/dev/null | head -1)
                fi
                ;;
            *)
                version=$($cmd --version 2>/dev/null | head -1 || echo "installed")
                ;;
        esac
        add_test_result "$category" "Command: $cmd - $description" "PASS" "$version" "$priority" "$install_hint"
    else
        add_test_result "$category" "Command: $cmd - $description" "FAIL" "Command not found" "$priority" "$install_hint"
    fi
}

# Check command (simplified version)
check_command() {
    check_command_with_deps "$1" "$2" "$3" "$4" "" "$5"
}

# Check path (file or directory)
check_path() {
    local path="$1"
    local description="$2"
    local type="$3"  # "file" or "directory"
    local priority="$4"  # "required", "recommended", or "optional"
    local category="$5"  # Test category (defaults to "config")
    
    # Default category
    if [ -z "$category" ]; then
        category="config"
    fi
    
    if [ "$type" = "file" ]; then
        if [ -f "$path" ]; then
            add_test_result "$category" "$description" "PASS" "$path exists" "$priority"
        else
            add_test_result "$category" "$description" "FAIL" "$path not found" "$priority"
        fi
    elif [ "$type" = "directory" ]; then
        if [ -d "$path" ]; then
            add_test_result "$category" "$description" "PASS" "$path exists" "$priority"
        else
            add_test_result "$category" "$description" "FAIL" "$path not found" "$priority"
        fi
    fi
}

# Core requirement tests (environment-independent)
test_core_requirements() {
    local adapter="$1"
    
    # Test required commands using the new check_command function
    check_command "sh" "required" "POSIX shell" "Should be pre-installed" "$TEST_CATEGORY_CORE"
    check_command "bash" "required" "Bash shell" "apt install bash / brew install bash" "$TEST_CATEGORY_CORE"
    check_command "git" "required" "Version control" "apt install git / brew install git" "$TEST_CATEGORY_CORE"
    check_command "curl" "required" "HTTP client" "apt install curl / brew install curl" "$TEST_CATEGORY_CORE"
    check_command "chezmoi" "required" "Dotfiles manager" "sh -c \"\$(curl -fsLS get.chezmoi.io)\"" "$TEST_CATEGORY_CORE"
}

# Shell compatibility tests (uses adapter)
test_shell_compatibility() {
    local adapter="$1"
    
    # Test bash loading
    if command -v bash >/dev/null 2>&1; then
        local bash_result=$(${adapter}_test_bash_loading)
        case "$bash_result" in
            SUCCESS)
                add_test_result "$TEST_CATEGORY_SHELL" "Bash loading" "PASS" "Configuration loaded successfully"
                ;;
            FAILED)
                add_test_result "$TEST_CATEGORY_SHELL" "Bash loading" "FAIL" "Failed to load configuration"
                ;;
            MISSING_*)
                add_test_result "$TEST_CATEGORY_SHELL" "Bash loading" "SKIP" "$bash_result"
                ;;
        esac
    else
        add_test_result "$TEST_CATEGORY_SHELL" "Bash loading" "SKIP" "Bash not available"
    fi
    
    # Test zsh loading
    if command -v zsh >/dev/null 2>&1; then
        local zsh_result=$(${adapter}_test_zsh_loading)
        case "$zsh_result" in
            SUCCESS)
                add_test_result "$TEST_CATEGORY_SHELL" "Zsh loading" "PASS" "Configuration loaded successfully"
                ;;
            FAILED)
                add_test_result "$TEST_CATEGORY_SHELL" "Zsh loading" "FAIL" "Failed to load configuration"
                ;;
            MISSING_*)
                add_test_result "$TEST_CATEGORY_SHELL" "Zsh loading" "SKIP" "$zsh_result"
                ;;
        esac
    else
        add_test_result "$TEST_CATEGORY_SHELL" "Zsh loading" "SKIP" "Zsh not available"
    fi
}

# Configuration file tests (uses adapter)
test_configuration_files() {
    local adapter="$1"
    
    # Test essential files
    local bashrc_path=$(${adapter}_get_bashrc_path)
    if ${adapter}_file_exists "$bashrc_path"; then
        add_test_result "$TEST_CATEGORY_CONFIG" "Bashrc file" "PASS" "$bashrc_path"
    else
        add_test_result "$TEST_CATEGORY_CONFIG" "Bashrc file" "FAIL" "Missing: $bashrc_path"
    fi
    
    local zshrc_path=$(${adapter}_get_zshrc_path)
    if ${adapter}_file_exists "$zshrc_path"; then
        add_test_result "$TEST_CATEGORY_CONFIG" "Zshrc file" "PASS" "$zshrc_path"
    else
        add_test_result "$TEST_CATEGORY_CONFIG" "Zshrc file" "FAIL" "Missing: $zshrc_path"
    fi
    
    local shell_common_dir=$(${adapter}_get_shell_common_dir)
    if ${adapter}_dir_exists "$shell_common_dir"; then
        add_test_result "$TEST_CATEGORY_CONFIG" "Shell common directory" "PASS" "$shell_common_dir"
        
        # Test individual files within shell_common
        local functions_path=$(${adapter}_get_functions_path)
        if ${adapter}_file_exists "$functions_path"; then
            add_test_result "$TEST_CATEGORY_CONFIG" "Functions file" "PASS" "$functions_path"
        else
            add_test_result "$TEST_CATEGORY_CONFIG" "Functions file" "FAIL" "Missing: $functions_path"
        fi
        
        local aliases_path=$(${adapter}_get_aliases_path)
        if ${adapter}_file_exists "$aliases_path"; then
            add_test_result "$TEST_CATEGORY_CONFIG" "Aliases file" "PASS" "$aliases_path"
        else
            add_test_result "$TEST_CATEGORY_CONFIG" "Aliases file" "FAIL" "Missing: $aliases_path"
        fi
    else
        add_test_result "$TEST_CATEGORY_CONFIG" "Shell common directory" "FAIL" "Missing: $shell_common_dir"
    fi
}

# PATH configuration tests (uses adapter)
test_path_configuration() {
    local adapter="$1"
    
    # Test PATH setup for different shells
    for shell in bash zsh; do
        if command -v "$shell" >/dev/null 2>&1; then
            if ${adapter}_test_path_setup "$shell"; then
                add_test_result "$TEST_CATEGORY_CONFIG" "PATH setup ($shell)" "PASS" ".local/bin found in PATH"
            else
                add_test_result "$TEST_CATEGORY_CONFIG" "PATH setup ($shell)" "FAIL" ".local/bin not found in PATH"
            fi
        else
            add_test_result "$TEST_CATEGORY_CONFIG" "PATH setup ($shell)" "SKIP" "$shell not available"
        fi
    done
}

# Integration tests (adapter-specific)
test_integration() {
    local adapter="$1"
    
    # Test function availability (if adapter supports it)
    if command -v "${adapter}_test_function_exists" >/dev/null 2>&1; then
        for func in extract; do  # Add more functions as needed
            for shell in bash zsh; do
                if command -v "$shell" >/dev/null 2>&1; then
                    if ${adapter}_test_function_exists "$func" "$shell"; then
                        add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: $func ($shell)" "PASS" "Function available"
                    else
                        add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: $func ($shell)" "FAIL" "Function not available"
                    fi
                fi
            done
        done
    fi
    
    # Test alias availability (only for post-apply mode)
    if [ "$adapter" = "post_apply" ] && command -v "${adapter}_test_alias_exists" >/dev/null 2>&1; then
        # Only test aliases that are actually defined in aliases.sh
        for alias_name in claude; do  # Only test existing aliases
            if ${adapter}_test_alias_exists "$alias_name"; then
                add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: $alias_name" "PASS" "Alias defined"
            else
                add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: $alias_name" "FAIL" "Alias not defined"
            fi
        done
    else
        echo "Skipping alias tests for $adapter"
    fi
}

# Version management and language tools tests
test_development_tools() {
    local adapter="$1"
    
    # Version Management
    check_command "mise" "recommended" "Version manager" "curl https://mise.run | sh" "$TEST_CATEGORY_TOOLS"
    
    # Development Tools
    check_command "starship" "recommended" "Cross-shell prompt" "curl -sS https://starship.rs/install.sh | sh" "$TEST_CATEGORY_DEVELOPMENT"
    check_command "gh" "optional" "GitHub CLI" "apt install gh / brew install gh" "$TEST_CATEGORY_DEVELOPMENT"
    check_command "ghq" "optional" "Git repository manager" "go install github.com/x-motemen/ghq@latest" "$TEST_CATEGORY_DEVELOPMENT"
    check_command "rg" "recommended" "Ripgrep search" "apt install ripgrep / brew install ripgrep" "$TEST_CATEGORY_TOOLS"
    check_command "fd" "optional" "Find alternative" "apt install fd-find / brew install fd" "$TEST_CATEGORY_TOOLS"
    check_command "fzf" "optional" "Fuzzy finder" "apt install fzf / brew install fzf" "$TEST_CATEGORY_TOOLS"
    check_command "bat" "optional" "Cat with wings" "apt install bat / brew install bat" "$TEST_CATEGORY_TOOLS"
    check_command "jq" "optional" "JSON processor" "apt install jq / brew install jq" "$TEST_CATEGORY_TOOLS"
    check_command "age" "optional" "Encryption tool" "apt install age / brew install age" "$TEST_CATEGORY_SECURITY"
    
    # Text Editors
    check_command "vim" "optional" "Vi improved" "apt install vim / brew install vim" "$TEST_CATEGORY_DEVELOPMENT"
    check_command "code" "recommended" "VS Code" "https://code.visualstudio.com" "$TEST_CATEGORY_DEVELOPMENT"
    
    # Security & Authentication
    check_command "op" "optional" "1Password CLI" "https://1password.com/downloads/command-line" "$TEST_CATEGORY_SECURITY"
}

# Languages and runtime tests
test_language_tools() {
    local adapter="$1"
    
    # Languages & Runtimes (managed by mise)
    check_command_with_deps "node" "recommended" "Node.js runtime" "mise use node@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "pnpm" "optional" "Fast package manager" "mise use pnpm@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "bun" "optional" "JavaScript runtime" "mise use bun@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "deno" "optional" "Secure JS/TS runtime" "mise use deno@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "go" "optional" "Go programming language" "mise use go@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "rustc" "optional" "Rust compiler" "mise use rust@latest" "" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "direnv" "optional" "Environment switcher" "mise use direnv@latest" "" "$TEST_CATEGORY_TOOLS"
    
    # Package Managers
    check_command_with_deps "npm" "optional" "Node package manager" "Comes with Node.js" "node" "$TEST_CATEGORY_LANGUAGES"
    check_command_with_deps "cargo" "optional" "Rust package manager" "Comes with Rust" "rustc" "$TEST_CATEGORY_LANGUAGES"
    
    # Specialized tools
    check_command_with_deps "similarity-ts" "optional" "Code similarity detector" "cargo install similarity-ts" "cargo" "$TEST_CATEGORY_DEVELOPMENT"
    check_command_with_deps "git-sequential-stage" "optional" "Git staging helper" "go install github.com/syou6162/git-sequential-stage@latest" "go" "$TEST_CATEGORY_DEVELOPMENT"
    
    # Language-specific tools (runtime dependent)
    if command -v go >/dev/null 2>&1; then
        check_command "gofmt" "optional" "Go formatter" "Comes with Go installation" "$TEST_CATEGORY_LANGUAGES"
    fi
    
    if command -v rustc >/dev/null 2>&1; then
        check_command "rustfmt" "optional" "Rust formatter" "Comes with Rust installation" "$TEST_CATEGORY_LANGUAGES"
        check_command "clippy-driver" "optional" "Rust linter" "rustup component add clippy" "$TEST_CATEGORY_LANGUAGES"
    fi
    
    if command -v node >/dev/null 2>&1; then
        check_command "npx" "optional" "Node package executor" "Comes with Node.js/npm" "$TEST_CATEGORY_LANGUAGES"
    fi
}

# Directory structure tests
test_directory_structure() {
    local adapter="$1"
    
    # Essential directories
    check_path "$HOME/.local/bin" "User binaries directory" "directory" "recommended" "$TEST_CATEGORY_CONFIG"
    check_path "$HOME/.local/share/zsh-completions" "Zsh completions" "directory" "optional" "$TEST_CATEGORY_CONFIG"
    check_path "$HOME/.local/share/zsh-functions" "Zsh functions" "directory" "optional" "$TEST_CATEGORY_CONFIG"
    check_path "$HOME/.config" "User configuration directory" "directory" "recommended" "$TEST_CATEGORY_CONFIG"
    check_path "$HOME/.claude" "Claude configuration directory" "directory" "optional" "$TEST_CATEGORY_CONFIG"
}

# OS-specific package manager tests
test_package_managers() {
    local adapter="$1"
    
    # Detect OS type
    local os_type="unknown"
    if [ "$(uname)" = "Linux" ]; then
        os_type="linux"
    elif [ "$(uname)" = "Darwin" ]; then
        os_type="darwin"
    elif uname -s | grep -qi "mingw\|msys\|cygwin"; then
        os_type="windows"
    fi
    
    case "$os_type" in
        linux)
            if command -v apt >/dev/null 2>&1; then
                check_command "apt" "APT package manager" "System package manager" "recommended" "$TEST_CATEGORY_TOOLS"
            elif command -v yum >/dev/null 2>&1; then
                check_command "yum" "YUM package manager" "System package manager" "recommended" "$TEST_CATEGORY_TOOLS"
            elif command -v pacman >/dev/null 2>&1; then
                check_command "pacman" "Pacman package manager" "System package manager" "recommended" "$TEST_CATEGORY_TOOLS"
            fi
            check_command "notify-send" "Desktop notifications" "apt install libnotify-bin" "optional" "$TEST_CATEGORY_TOOLS"
            check_command "paplay" "Audio playback" "apt install pulseaudio-utils" "optional" "$TEST_CATEGORY_TOOLS"
            ;;
        darwin)
            check_command "brew" "Homebrew package manager" "https://brew.sh" "recommended" "$TEST_CATEGORY_TOOLS"
            check_command "terminal-notifier" "Desktop notifications" "brew install terminal-notifier" "optional" "$TEST_CATEGORY_TOOLS"
            ;;
        windows)
            check_command "winget" "Windows Package Manager" "Microsoft Store: App Installer" "recommended" "$TEST_CATEGORY_TOOLS"
            check_command "pwsh" "PowerShell Core" "winget install Microsoft.PowerShell" "recommended" "$TEST_CATEGORY_TOOLS"
            ;;
    esac
}

# Git configuration tests
test_git_configuration() {
    local adapter="$1"
    
    if command -v git >/dev/null 2>&1; then
        # Check user configuration
        local user_name=$(git config --global user.name 2>/dev/null)
        local user_email=$(git config --global user.email 2>/dev/null)
        
        if [ -n "$user_name" ] && [ -n "$user_email" ]; then
            add_test_result "$TEST_CATEGORY_CONFIG" "Git user configuration" "PASS" "$user_name <$user_email>" "required" ""
        else
            add_test_result "$TEST_CATEGORY_CONFIG" "Git user configuration" "FAIL" "user.name or user.email not set" "required" "git config --global user.name 'Your Name' && git config --global user.email 'you@example.com'"
        fi
        
        # Check GPG signing configuration
        local gpg_sign=$(git config --global commit.gpgsign 2>/dev/null)
        if [ "$gpg_sign" = "true" ]; then
            local signing_key=$(git config --global user.signingkey 2>/dev/null)
            if [ -n "$signing_key" ]; then
                add_test_result "$TEST_CATEGORY_CONFIG" "Git GPG signing" "PASS" "enabled with key $signing_key" "recommended" ""
            else
                add_test_result "$TEST_CATEGORY_CONFIG" "Git GPG signing" "FAIL" "enabled but no signing key configured" "recommended" "git config --global user.signingkey <key-id>"
            fi
        else
            add_test_result "$TEST_CATEGORY_CONFIG" "Git GPG signing" "SKIP" "not enabled" "optional" "git config --global commit.gpgsign true"
        fi
        
        # Check for chezmoi repository health
        if command -v chezmoi >/dev/null 2>&1; then
            local chezmoi_source=$(chezmoi source-path 2>/dev/null)
            if [ -d "$chezmoi_source" ] && [ -d "$chezmoi_source/.git" ]; then
                # Check if repository is clean (save current directory)
                local current_dir="$PWD"
                cd "$chezmoi_source"
                if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
                    add_test_result "$TEST_CATEGORY_CONFIG" "Chezmoi repository status" "PASS" "clean working directory" "recommended" ""
                else
                    add_test_result "$TEST_CATEGORY_CONFIG" "Chezmoi repository status" "WARN" "uncommitted changes" "recommended" "cd $(chezmoi source-path) && git add -A && git commit -m 'Update dotfiles'"
                fi
                cd "$current_dir"
            else
                add_test_result "$TEST_CATEGORY_CONFIG" "Chezmoi repository status" "FAIL" "not initialized or not a git repository" "required" "chezmoi init --apply <your-dotfiles-repo>"
            fi
        fi
    else
        add_test_result "$TEST_CATEGORY_CONFIG" "Git configuration" "FAIL" "git command not found" "required" "apt install git / brew install git"
    fi
}

# Advanced shell configuration validation
test_shell_functions() {
    local adapter="$1"
    
    # Get shell common path using adapter
    local shell_common_dir
    if [ -n "$adapter" ]; then
        shell_common_dir=$("${adapter}_get_shell_common_dir")
    else
        shell_common_dir="$HOME/.shell_common"
    fi
    
    local functions_file="$shell_common_dir/functions.sh"
    
    if [ -f "$functions_file" ]; then
        # Check for key functions
        if grep -q "^extract[[:space:]]*(" "$functions_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: extract" "PASS" "archive extraction utility" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: extract" "FAIL" "not found" "optional" "Define extract function in $functions_file"
        fi
        
        if grep -q "^opr[[:space:]]*(" "$functions_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: opr" "PASS" "1Password run utility" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: opr" "SKIP" "not found" "optional" "Define opr function for 1Password CLI"
        fi
        
        if grep -q "^opl[[:space:]]*(" "$functions_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: opl" "PASS" "1Password load utility" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Function: opl" "SKIP" "not found" "optional" "Define opl function for 1Password CLI"
        fi
    else
        add_test_result "$TEST_CATEGORY_INTEGRATION" "Shell functions file" "FAIL" "functions.sh not found" "recommended" "Create $functions_file"
    fi
}

# Advanced alias validation
test_shell_aliases() {
    local adapter="$1"
    
    # Get shell common path using adapter
    local shell_common_dir
    if [ -n "$adapter" ]; then
        shell_common_dir=$("${adapter}_get_shell_common_dir")
    else
        shell_common_dir="$HOME/.shell_common"
    fi
    
    local aliases_file="$shell_common_dir/aliases.sh"
    
    if [ -f "$aliases_file" ]; then
        # Check for key aliases
        if grep -q "^alias claude=" "$aliases_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: claude" "PASS" "Claude CLI shortcut" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: claude" "SKIP" "not found" "optional" "Define claude alias in $aliases_file"
        fi
        
        # Check for common development aliases
        if grep -q "^alias ll=" "$aliases_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: ll" "PASS" "detailed listing" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: ll" "SKIP" "not found" "optional" "Define ll='ls -la' in $aliases_file"
        fi
        
        if grep -q "^alias la=" "$aliases_file" 2>/dev/null; then
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: la" "PASS" "show all files" "optional" ""
        else
            add_test_result "$TEST_CATEGORY_INTEGRATION" "Alias: la" "SKIP" "not found" "optional" "Define la='ls -A' in $aliases_file"
        fi
    else
        add_test_result "$TEST_CATEGORY_INTEGRATION" "Shell aliases file" "FAIL" "aliases.sh not found" "recommended" "Create $aliases_file"
    fi
}

# Run all tests with specified adapter
run_all_tests() {
    local adapter="$1"
    local categories="$2"  # Optional: specific categories to run
    
    if [ -z "$categories" ]; then
        categories="$TEST_CATEGORY_CORE $TEST_CATEGORY_SHELL $TEST_CATEGORY_CONFIG $TEST_CATEGORY_TOOLS $TEST_CATEGORY_LANGUAGES $TEST_CATEGORY_DEVELOPMENT $TEST_CATEGORY_SECURITY $TEST_CATEGORY_INTEGRATION"
    fi
    
    init_test_engine
    
    # POSIX-compatible category iteration with zsh compatibility
    if [ -n "$ZSH_VERSION" ]; then
        # Enable word splitting in zsh
        setopt SH_WORD_SPLIT 2>/dev/null || true
    fi
    
    for category in $categories; do
        case "$category" in
            "$TEST_CATEGORY_CORE")
                test_core_requirements "$adapter"
                ;;
            "$TEST_CATEGORY_SHELL")
                test_shell_compatibility "$adapter"
                ;;
            "$TEST_CATEGORY_CONFIG")
                test_configuration_files "$adapter"
                test_path_configuration "$adapter"
                test_directory_structure "$adapter"
                test_git_configuration "$adapter"
                ;;
            "$TEST_CATEGORY_TOOLS")
                test_development_tools "$adapter"
                test_package_managers "$adapter"
                ;;
            "$TEST_CATEGORY_DEVELOPMENT")
                test_development_tools "$adapter"
                ;;
            "$TEST_CATEGORY_SECURITY")
                test_development_tools "$adapter"
                ;;
            "$TEST_CATEGORY_LANGUAGES")
                test_language_tools "$adapter"
                ;;
            "$TEST_CATEGORY_INTEGRATION")
                test_integration "$adapter"
                test_shell_functions "$adapter"
                test_shell_aliases "$adapter"
                ;;
        esac
    done
}

# Get test results summary
get_test_summary() {
    local health_score=0
    if [ $TOTAL_WEIGHT -gt 0 ]; then
        health_score=$((ACHIEVED_WEIGHT * 100 / TOTAL_WEIGHT))
    fi
    
    cat << EOF
Test Summary:
  Total Tests: $TOTAL_TESTS
  Passed: $PASSED_TESTS
  Failed: $FAILED_TESTS
  Skipped: $SKIPPED_TESTS
  
Health Score: ${health_score}% (${ACHIEVED_WEIGHT}/${TOTAL_WEIGHT})
EOF
}

# Get detailed test results
get_test_results() {
    echo "$TEST_RESULTS"
}