#!/bin/sh
# validator.sh
# Result validation and analysis utilities

# Validate shell test result
validate_shell_result() {
    local result="$1"
    case "$result" in
        SUCCESS)
            return 0
            ;;
        FAILED|MISSING_*)
            return 1
            ;;
        *)
            return 2  # Unknown result
            ;;
    esac
}

# Validate file path result
validate_file_path() {
    local path="$1"
    local required="$2"  # true/false
    
    if [ -f "$path" ]; then
        return 0  # File exists
    else
        if [ "$required" = "true" ]; then
            return 1  # Required file missing
        else
            return 2  # Optional file missing
        fi
    fi
}

# Validate directory path result
validate_directory_path() {
    local path="$1"
    local required="$2"  # true/false
    
    if [ -d "$path" ]; then
        return 0  # Directory exists
    else
        if [ "$required" = "true" ]; then
            return 1  # Required directory missing
        else
            return 2  # Optional directory missing
        fi
    fi
}

# Validate command availability
validate_command() {
    local command="$1"
    local required="$2"  # true/false
    
    if command -v "$command" >/dev/null 2>&1; then
        return 0  # Command available
    else
        if [ "$required" = "true" ]; then
            return 1  # Required command missing
        else
            return 2  # Optional command missing
        fi
    fi
}

# Validate test results and determine readiness
validate_readiness_for_apply() {
    local results="$1"
    local critical_failures=0
    local warnings=0
    
    # Parse results and count critical issues
    echo "$results" | while IFS='|' read -r category name result_status details; do
        case "$result_status" in
            FAIL)
                case "$category" in
                    core)
                        critical_failures=$((critical_failures + 1))
                        ;;
                    shell|config)
                        case "$name" in
                            *"bashrc"*|*"zshrc"*|*"Shell common"*)
                                critical_failures=$((critical_failures + 1))
                                ;;
                            *)
                                warnings=$((warnings + 1))
                                ;;
                        esac
                        ;;
                    *)
                        warnings=$((warnings + 1))
                        ;;
                esac
                ;;
        esac
    done
    
    if [ $critical_failures -gt 0 ]; then
        echo "NOT_READY"
        return 1
    elif [ $warnings -gt 0 ]; then
        echo "READY_WITH_WARNINGS"
        return 0
    else
        echo "READY"
        return 0
    fi
}

# Validate system health after apply
validate_system_health() {
    local results="$1"
    local total_tests="$2"
    local passed_tests="$3"
    local failed_tests="$4"
    
    # Calculate health percentage
    local health_percentage=0
    local counted_tests=$((total_tests - skipped_tests))
    
    if [ $counted_tests -gt 0 ]; then
        health_percentage=$((passed_tests * 100 / counted_tests))
    fi
    
    if [ $health_percentage -ge 90 ]; then
        echo "EXCELLENT"
        return 0
    elif [ $health_percentage -ge 70 ]; then
        echo "GOOD"
        return 0
    elif [ $health_percentage -ge 50 ]; then
        echo "FAIR"
        return 1
    else
        echo "POOR"
        return 2
    fi
}

# Check for specific configuration issues
check_configuration_issues() {
    local adapter="$1"
    local issues=""
    
    # Check shell common directory
    local shell_common_dir=$(${adapter}_get_shell_common_dir)
    if ! ${adapter}_dir_exists "$shell_common_dir"; then
        issues="${issues}MISSING_SHELL_COMMON "
    fi
    
    # Check essential files
    local functions_path=$(${adapter}_get_functions_path)
    if ! ${adapter}_file_exists "$functions_path"; then
        issues="${issues}MISSING_FUNCTIONS "
    fi
    
    local aliases_path=$(${adapter}_get_aliases_path)
    if ! ${adapter}_file_exists "$aliases_path"; then
        issues="${issues}MISSING_ALIASES "
    fi
    
    # Check shell configurations
    local bashrc_path=$(${adapter}_get_bashrc_path)
    if ! ${adapter}_file_exists "$bashrc_path"; then
        issues="${issues}MISSING_BASHRC "
    fi
    
    local zshrc_path=$(${adapter}_get_zshrc_path)
    if ! ${adapter}_file_exists "$zshrc_path"; then
        issues="${issues}MISSING_ZSHRC "
    fi
    
    echo "${issues% }"  # Remove trailing space
}

# Analyze test patterns for common problems
analyze_test_patterns() {
    local results="$1"
    local patterns=""
    
    # Count failures by category
    local core_failures=0
    local shell_failures=0
    local config_failures=0
    local integration_failures=0
    
    echo "$results" | while IFS='|' read -r category name result_status details; do
        if [ "$result_status" = "FAIL" ]; then
            case "$category" in
                core) core_failures=$((core_failures + 1)) ;;
                shell) shell_failures=$((shell_failures + 1)) ;;
                config) config_failures=$((config_failures + 1)) ;;
                integration) integration_failures=$((integration_failures + 1)) ;;
            esac
        fi
    done
    
    # Identify patterns
    if [ $core_failures -gt 0 ]; then
        patterns="${patterns}MISSING_CORE_TOOLS "
    fi
    
    if [ $shell_failures -gt 1 ]; then
        patterns="${patterns}SHELL_COMPATIBILITY_ISSUES "
    fi
    
    if [ $config_failures -gt 2 ]; then
        patterns="${patterns}CONFIGURATION_INCOMPLETE "
    fi
    
    if [ $integration_failures -gt 0 ] && [ $config_failures -eq 0 ]; then
        patterns="${patterns}INTEGRATION_ONLY_ISSUES "
    fi
    
    echo "${patterns% }"  # Remove trailing space
}

# Generate validation summary
generate_validation_summary() {
    local adapter="$1"
    local results="$2"
    local total="$3"
    local passed="$4"
    local failed="$5"
    local skipped="$6"
    
    local readiness=""
    local health=""
    local issues=""
    local patterns=""
    
    case "$adapter" in
        pre_apply)
            readiness=$(validate_readiness_for_apply "$results")
            ;;
        post_apply)
            health=$(validate_system_health "$results" "$total" "$passed" "$failed")
            ;;
    esac
    
    issues=$(check_configuration_issues "$adapter")
    patterns=$(analyze_test_patterns "$results")
    
    cat << EOF
Validation Summary:
  Readiness: ${readiness:-"N/A"}
  Health: ${health:-"N/A"}
  Issues: ${issues:-"None"}
  Patterns: ${patterns:-"None"}
EOF
}