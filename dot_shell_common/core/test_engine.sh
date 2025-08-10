#!/bin/sh
# test_engine.sh
# Environment-independent test execution engine

# Test execution context
TEST_RESULTS=""
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Test categories
TEST_CATEGORY_CORE="core"
TEST_CATEGORY_SHELL="shell"
TEST_CATEGORY_CONFIG="config"
TEST_CATEGORY_INTEGRATION="integration"

# Initialize test engine
init_test_engine() {
    TEST_RESULTS=""
    TOTAL_TESTS=0
    PASSED_TESTS=0
    FAILED_TESTS=0
    SKIPPED_TESTS=0
}

# Add test result
add_test_result() {
    local category="$1"
    local name="$2"
    local status="$3"  # PASS, FAIL, SKIP
    local details="$4"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    case "$status" in
        PASS)
            PASSED_TESTS=$((PASSED_TESTS + 1))
            ;;
        FAIL)
            FAILED_TESTS=$((FAILED_TESTS + 1))
            ;;
        SKIP)
            SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
            ;;
    esac
    
    # Store result for reporting
    local result_line="$category|$name|$status|$details"
    if [ -z "$TEST_RESULTS" ]; then
        TEST_RESULTS="$result_line"
    else
        TEST_RESULTS="$TEST_RESULTS
$result_line"
    fi
}

# Core requirement tests (environment-independent)
test_core_requirements() {
    local adapter="$1"
    
    # Test required commands
    for cmd in sh bash git curl; do
        if command -v "$cmd" >/dev/null 2>&1; then
            local version=$(command -v "$cmd" >/dev/null 2>&1 && "$cmd" --version 2>/dev/null | head -1 || echo "unknown")
            add_test_result "$TEST_CATEGORY_CORE" "Command: $cmd" "PASS" "$version"
        else
            add_test_result "$TEST_CATEGORY_CORE" "Command: $cmd" "FAIL" "Command not found"
        fi
    done
    
    # Test chezmoi
    if command -v chezmoi >/dev/null 2>&1; then
        local version=$(chezmoi --version 2>/dev/null | head -1)
        add_test_result "$TEST_CATEGORY_CORE" "Command: chezmoi" "PASS" "$version"
    else
        add_test_result "$TEST_CATEGORY_CORE" "Command: chezmoi" "FAIL" "Chezmoi not found"
    fi
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

# Run all tests with specified adapter
run_all_tests() {
    local adapter="$1"
    local categories="$2"  # Optional: specific categories to run
    
    if [ -z "$categories" ]; then
        categories="$TEST_CATEGORY_CORE $TEST_CATEGORY_SHELL $TEST_CATEGORY_CONFIG $TEST_CATEGORY_INTEGRATION"
    fi
    
    init_test_engine
    
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
                ;;
            "$TEST_CATEGORY_INTEGRATION")
                test_integration "$adapter"
                ;;
        esac
    done
}

# Get test results summary
get_test_summary() {
    cat << EOF
Test Summary:
  Total Tests: $TOTAL_TESTS
  Passed: $PASSED_TESTS
  Failed: $FAILED_TESTS
  Skipped: $SKIPPED_TESTS
EOF
}

# Get detailed test results
get_test_results() {
    echo "$TEST_RESULTS"
}