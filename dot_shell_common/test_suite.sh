#!/bin/sh
# test_suite.sh
# Unified dotfiles test suite with adapter pattern

# Script directory detection
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load core modules
. "$SCRIPT_DIR/adapters/adapter_selector.sh"
. "$SCRIPT_DIR/core/test_engine.sh"
. "$SCRIPT_DIR/core/reporter.sh"
. "$SCRIPT_DIR/core/validator.sh"

# Default options
VERBOSE=0
QUIET=0
FORCE_MODE=""
CATEGORIES=""
SHOW_HELP=0
SHOW_CONFIG=0

# Help text
show_help() {
    cat << EOF
Dotfiles Test Suite - Unified testing for pre/post chezmoi apply

Usage: $(basename "$0") [OPTIONS]

Options:
    --pre-apply      Force pre-apply mode (test chezmoi source files)
    --post-apply     Force post-apply mode (test installed configuration)
    --categories=X   Run specific test categories (comma-separated)
                     Available: core,shell,config,integration
    --config         Show environment configuration and exit
    -v, --verbose    Show detailed output for all tests
    -q, --quiet      Only show errors and final summary
    -h, --help       Show this help message

Examples:
    $(basename "$0")                      # Auto-detect mode and run all tests
    $(basename "$0") --pre-apply          # Test before chezmoi apply
    $(basename "$0") --post-apply -v      # Test after apply with verbose output
    $(basename "$0") --categories=core,shell # Run only core and shell tests
    $(basename "$0") --config             # Show configuration info

Test Categories:
    core         - Essential commands (git, curl, chezmoi, shells)
    shell        - Shell compatibility (bash/zsh loading)
    config       - Configuration files (bashrc, zshrc, shell_common)
    tools        - Development tools (rg, fzf, bat, jq, etc.)
    languages    - Programming languages and runtimes
    development  - Development environment (starship, gh, vim, vscode)
    security     - Security tools (age, 1password-cli, etc.)
    integration  - Functions, aliases, and advanced features

Exit Codes:
    0 - All tests passed or only warnings
    1 - Some tests failed but system is functional
    2 - Critical failures detected
EOF
}

# Parse command line arguments
parse_arguments() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --pre-apply)
                FORCE_MODE="pre_apply"
                shift
                ;;
            --post-apply)
                FORCE_MODE="post_apply"
                shift
                ;;
            --categories=*)
                CATEGORIES=$(echo "$1" | cut -d'=' -f2)
                shift
                ;;
            --config)
                SHOW_CONFIG=1
                shift
                ;;
            -v|--verbose)
                VERBOSE=1
                shift
                ;;
            -q|--quiet)
                QUIET=1
                shift
                ;;
            -h|--help)
                SHOW_HELP=1
                shift
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Use --help for usage information." >&2
                exit 1
                ;;
        esac
    done
    
    # Set report level based on verbosity flags
    if [ $QUIET -eq 1 ]; then
        set_report_level quiet
    elif [ $VERBOSE -eq 1 ]; then
        set_report_level verbose
    else
        set_report_level normal
    fi
}

# Show configuration information
show_configuration() {
    local adapter
    
    if [ -n "$FORCE_MODE" ]; then
        adapter="$FORCE_MODE"
    else
        adapter=$(select_adapter)
    fi
    
    # Load the adapter
    . "$SCRIPT_DIR/adapters/${adapter}_adapter.sh"
    
    printf "${BOLD}Dotfiles Test Suite Configuration${NC}\n"
    printf "${GRAY}%s${NC}\n\n" "$(date '+%Y-%m-%d %H:%M:%S')"
    
    # Environment detection info
    get_environment_info
    printf "\n"
    
    # Adapter configuration
    ${adapter}_get_config_summary
}

# Convert comma-separated categories to space-separated
parse_categories() {
    local cats="$1"
    if [ -n "$cats" ]; then
        # Replace commas with spaces
        echo "$cats" | tr ',' ' '
    fi
}

# Validate categories
validate_categories() {
    local categories="$1"
    local valid_categories="core shell config tools languages development security integration"
    
    if [ -z "$categories" ]; then
        return 0  # Empty is valid (means all)
    fi
    
    for cat in $categories; do
        case " $valid_categories " in
            *" $cat "*)
                # Valid category found
                ;;
            *)
                echo "Error: Invalid category '$cat'" >&2
                echo "Valid categories: $valid_categories" >&2
                return 1
                ;;
        esac
    done
    return 0
}

# Main test execution
main() {
    # Parse arguments
    parse_arguments "$@"
    
    # Show help if requested
    if [ $SHOW_HELP -eq 1 ]; then
        show_help
        exit 0
    fi
    
    # Show configuration if requested
    if [ $SHOW_CONFIG -eq 1 ]; then
        show_configuration
        exit 0
    fi
    
    # Determine adapter to use
    local adapter
    if [ -n "$FORCE_MODE" ]; then
        adapter="$FORCE_MODE"
    else
        adapter=$(select_adapter)
        if [ $? -ne 0 ]; then
            echo "Error: Failed to select adapter" >&2
            exit 1
        fi
    fi
    
    # Load the specific adapter
    local adapter_file="$SCRIPT_DIR/adapters/${adapter}_adapter.sh"
    if [ ! -f "$adapter_file" ]; then
        echo "Error: Adapter file not found: $adapter_file" >&2
        exit 1
    fi
    if ! . "$adapter_file"; then
        echo "Error: Failed to load adapter: $adapter" >&2
        exit 1
    fi
    
    # Parse and validate test categories
    local test_categories=""
    if [ -n "$CATEGORIES" ]; then
        test_categories=$(parse_categories "$CATEGORIES")
        if ! validate_categories "$test_categories"; then
            exit 1
        fi
    fi
    # Note: if test_categories is empty, run_all_tests will use default categories
    
    # Run the test suite
    run_all_tests "$adapter" "$test_categories"
    
    # Get results
    local test_results
    test_results=$(get_test_results)
    local total_tests=$TOTAL_TESTS
    local passed_tests=$PASSED_TESTS
    local failed_tests=$FAILED_TESTS
    local skipped_tests=$SKIPPED_TESTS
    
    # Generate and display report
    generate_report "$adapter" "$test_results" "$total_tests" "$passed_tests" "$failed_tests" "$skipped_tests"
    local exit_code=$?
    
    # Show validation summary in verbose mode
    if [ $VERBOSE -eq 1 ]; then
        printf "\n"
        generate_validation_summary "$adapter" "$test_results" "$total_tests" "$passed_tests" "$failed_tests" "$skipped_tests"
    fi
    
    exit $exit_code
}

# Execute main function with all arguments
main "$@"
