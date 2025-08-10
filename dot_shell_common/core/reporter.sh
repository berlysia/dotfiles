#!/bin/sh
# reporter.sh
# Test result reporting and formatting

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Icons for status
ICON_PASS="✅"
ICON_FAIL="❌"
ICON_SKIP="⏭️ "
ICON_INFO="ℹ️ "

# Report verbosity levels
REPORT_QUIET=0
REPORT_NORMAL=1
REPORT_VERBOSE=2

# Default report level
REPORT_LEVEL=$REPORT_NORMAL

# Set report verbosity
set_report_level() {
    local level="$1"
    case "$level" in
        quiet|0)
            REPORT_LEVEL=$REPORT_QUIET
            ;;
        normal|1)
            REPORT_LEVEL=$REPORT_NORMAL
            ;;
        verbose|2)
            REPORT_LEVEL=$REPORT_VERBOSE
            ;;
        *)
            echo "Warning: Unknown report level '$level', using normal" >&2
            REPORT_LEVEL=$REPORT_NORMAL
            ;;
    esac
}

# Print colored status message
print_status() {
    local status="$1"
    local message="$2"
    local details="$3"
    local min_level="${4:-$REPORT_NORMAL}"
    
    # Check if we should print based on verbosity level
    [ $REPORT_LEVEL -lt $min_level ] && return
    
    case "$status" in
        PASS)
            [ $REPORT_LEVEL -ge $REPORT_NORMAL ] && printf "${GREEN}${ICON_PASS}${NC} %s\n" "$message"
            [ $REPORT_LEVEL -ge $REPORT_VERBOSE ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        FAIL)
            printf "${RED}${ICON_FAIL}${NC} %s\n" "$message"
            [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        SKIP)
            [ $REPORT_LEVEL -ge $REPORT_VERBOSE ] && printf "${GRAY}${ICON_SKIP} %s${NC}\n" "$message"
            [ $REPORT_LEVEL -ge $REPORT_VERBOSE ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        INFO)
            [ $REPORT_LEVEL -ge $REPORT_NORMAL ] && printf "${BLUE}${ICON_INFO}${NC} %s\n" "$message"
            [ $REPORT_LEVEL -ge $REPORT_VERBOSE ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        HEADER)
            [ $REPORT_LEVEL -ge $REPORT_NORMAL ] && printf "\n${BOLD}%s${NC}\n" "$message"
            ;;
    esac
}

# Generate test report header
print_report_header() {
    local adapter="$1"
    local mode_display=""
    
    case "$adapter" in
        pre_apply)
            mode_display="Pre-Apply Mode (Chezmoi Source Directory)"
            ;;
        post_apply)
            mode_display="Post-Apply Mode (Installed Environment)"
            ;;
        *)
            mode_display="Unknown Mode ($adapter)"
            ;;
    esac
    
    if [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "${BOLD}Dotfiles Test Suite Report${NC}\n"
        printf "${GRAY}%s${NC}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
        printf "${GRAY}Mode: %s${NC}\n" "$mode_display"
    fi
}

# Print configuration summary (uses adapter)
print_config_summary() {
    local adapter="$1"
    
    if [ $REPORT_LEVEL -ge $REPORT_VERBOSE ]; then
        print_status "HEADER" "Environment Configuration"
        ${adapter}_get_config_summary | while IFS= read -r line; do
            print_status "INFO" "$line" "" $REPORT_VERBOSE
        done
    fi
}

# Print detailed test results
print_test_results() {
    local results="$1"
    local current_category=""
    
    # Parse and display results by category
    echo "$results" | while IFS='|' read -r category name status details; do
        if [ "$category" != "$current_category" ]; then
            case "$category" in
                core)
                    print_status "HEADER" "Core Requirements"
                    ;;
                shell)
                    print_status "HEADER" "Shell Compatibility"
                    ;;
                config)
                    print_status "HEADER" "Configuration Files"
                    ;;
                integration)
                    print_status "HEADER" "Integration Tests"
                    ;;
            esac
            current_category="$category"
        fi
        
        print_status "$status" "$name" "$details"
    done
}

# Calculate and print health score
print_health_score() {
    local total="$1"
    local passed="$2"
    local failed="$3"
    local skipped="$4"
    
    # Calculate score (skip tests don't count against score)
    local counted_tests=$((total - skipped))
    local health_score=0
    
    if [ $counted_tests -gt 0 ]; then
        health_score=$((passed * 100 / counted_tests))
    fi
    
    if [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "\n${BOLD}Health Score${NC}\n"
        printf "${GRAY}────────────────────────────────────────${NC}\n"
        
        if [ $health_score -ge 90 ]; then
            printf "${GREEN}${BOLD}%d%%${NC} - Excellent! Your configuration is working perfectly.${NC}\n" "$health_score"
        elif [ $health_score -ge 70 ]; then
            printf "${GREEN}%d%%${NC} - Good. Most components are working correctly.\n" "$health_score"
        elif [ $health_score -ge 50 ]; then
            printf "${YELLOW}%d%%${NC} - Fair. Some issues need attention.\n" "$health_score"
        else
            printf "${RED}%d%%${NC} - Poor. Significant issues detected.\n" "$health_score"
        fi
    fi
    
    return $health_score
}

# Print summary statistics
print_test_summary() {
    local total="$1"
    local passed="$2"
    local failed="$3"
    local skipped="$4"
    
    if [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "\n${BOLD}Test Summary${NC}\n"
        printf "${GRAY}────────────────────────────────────────${NC}\n"
        printf "Total Tests:     %d\n" "$total"
        printf "${GREEN}Passed:          %d${NC}\n" "$passed"
        
        if [ $failed -gt 0 ]; then
            printf "${RED}Failed:          %d${NC}\n" "$failed"
        fi
        
        if [ $skipped -gt 0 ] && [ $REPORT_LEVEL -ge $REPORT_VERBOSE ]; then
            printf "${GRAY}Skipped:         %d${NC}\n" "$skipped"
        fi
    fi
}

# Print actionable recommendations
print_recommendations() {
    local failed="$1"
    local adapter="$2"
    
    if [ $failed -gt 0 ] && [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "\n${BOLD}Recommendations${NC}\n"
        printf "${GRAY}────────────────────────────────────────${NC}\n"
        
        case "$adapter" in
            pre_apply)
                printf "${YELLOW}Before running 'chezmoi apply':${NC}\n"
                printf "  • Ensure all configuration files are present\n"
                printf "  • Verify shell compatibility\n"
                printf "  • Run tests with -v for more details\n"
                ;;
            post_apply)
                printf "${YELLOW}To fix configuration issues:${NC}\n"
                printf "  • Run 'chezmoi apply' to update configuration\n"
                printf "  • Check shell configuration files\n"
                printf "  • Verify environment variables\n"
                printf "  • Restart shell sessions after changes\n"
                ;;
        esac
    fi
}

# Generate complete report
generate_report() {
    local adapter="$1"
    local results="$2"
    local total="$3"
    local passed="$4"
    local failed="$5"
    local skipped="$6"
    
    print_report_header "$adapter"
    print_config_summary "$adapter"
    print_test_results "$results"
    print_test_summary "$total" "$passed" "$failed" "$skipped"
    print_health_score "$total" "$passed" "$failed" "$skipped"
    local score=$?
    print_recommendations "$failed" "$adapter"
    
    # Return exit code based on results
    if [ $failed -gt 0 ]; then
        if [ $score -lt 50 ]; then
            return 2  # Critical failures
        else
            return 1  # Some failures
        fi
    else
        return 0  # All tests passed or skipped
    fi
}