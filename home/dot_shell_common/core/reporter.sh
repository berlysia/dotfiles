#!/bin/sh
# reporter.sh
# Test result reporting and formatting
# shellcheck disable=SC1083,SC2154

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
    local print_status_arg="$1"
    local message="$2"
    local details="$3"
    local min_level="${4:-$REPORT_NORMAL}"
    
    # Check if we should print based on verbosity level
    [ $REPORT_LEVEL -lt $min_level ] && return
    
    case "$print_status_arg" in
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
    echo "$results" | while IFS='|' read -r category name test_status details; do
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
        
        print_status "$test_status" "$name" "$details"
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

# Print actionable recommendations based on missing components
print_recommendations() {
    local failed="$1"
    local adapter="$2"
    
    if [ $failed -gt 0 ] && [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "\n${BOLD}Actionable Recommendations${NC}\n"
        printf "${GRAY}────────────────────────────────────────${NC}\n"
        
        # Parse failed tests to provide specific recommendations
        generate_specific_recommendations "$adapter"
        
        # General recommendations based on adapter mode
        case "$adapter" in
            pre_apply)
                printf "\n${YELLOW}Before running 'chezmoi apply':${NC}\n"
                printf "  • Review specific recommendations above\n"
                printf "  • Install missing required components (priority: required > recommended > optional)\n"
                printf "  • Run tests with -v for detailed installation hints\n"
                printf "  • Focus on fixing 'required' failures first\n"
                ;;
            post_apply)
                printf "\n${YELLOW}To fix configuration issues:${NC}\n"
                printf "  • Install missing components using provided commands\n"
                printf "  • Run 'chezmoi apply' to update configuration after installations\n"
                printf "  • Check shell configuration files and restart shell sessions\n"
                printf "  • Verify environment variables are properly set\n"
                ;;
        esac
    fi
}

# Generate specific recommendations based on failed test analysis
generate_specific_recommendations() {
    local adapter="$1"
    local critical_missing=""
    local recommended_missing=""
    local git_issues=""
    local shell_issues=""
    
    # Analyze test results to identify specific issues
    printf "${BLUE}${ICON_INFO}${NC} Specific Issues Found:\n"
    
    # Parse TEST_RESULTS for failed tests with install hints
    local old_ifs="$IFS"
    IFS='
'
    for result_line in $TEST_RESULTS; do
        IFS='|'
        set -- $result_line
        local category="$1"
        local name="$2"
        local test_status="$3"
        local details="$4"
        local priority="$5"
        local install_hint="$6"
        IFS="$old_ifs"
        
        if [ "$test_status" = "FAIL" ] && [ -n "$install_hint" ]; then
            case "$priority" in
                "required")
                    printf "  ${RED}🔴 CRITICAL${NC}: %s\n" "$name"
                    printf "     ${GRAY}Fix: %s${NC}\n" "$install_hint"
                    critical_missing="${critical_missing}\n    - $name: $install_hint"
                    ;;
                "recommended")
                    printf "  ${YELLOW}🟡 RECOMMENDED${NC}: %s\n" "$name"
                    printf "     ${GRAY}Install: %s${NC}\n" "$install_hint"
                    recommended_missing="${recommended_missing}\n    - $name: $install_hint"
                    ;;
                "optional")
                    printf "  ${BLUE}🔵 OPTIONAL${NC}: %s (can skip)\n" "$name"
                    ;;
            esac
            
            # Categorize issues for specific advice
            case "$category" in
                "config")
                    if echo "$name" | grep -qi "git"; then
                        git_issues="$git_issues\n    - $name: $install_hint"
                    fi
                    ;;
                "shell"|"integration")
                    shell_issues="$shell_issues\n    - $name: $install_hint"
                    ;;
            esac
        fi
    done
    IFS="$old_ifs"
    
    # Priority-based recommendations
    if [ -n "$critical_missing" ]; then
        printf "\n${RED}🚨 CRITICAL ACTIONS REQUIRED:${NC}\n%s\n" "$critical_missing"
    fi
    
    if [ -n "$recommended_missing" ]; then
        printf "\n${YELLOW}📋 RECOMMENDED INSTALLATIONS:${NC}\n%s\n" "$recommended_missing"
    fi
    
    # Category-specific advice
    if [ -n "$git_issues" ]; then
        printf "\n${BLUE}🔧 Git Configuration Issues:${NC}\n%s\n" "$git_issues"
        printf "     ${GRAY}Tip: Configure git globally with user.name and user.email${NC}\n"
    fi
    
    if [ -n "$shell_issues" ]; then
        printf "\n${BLUE}🐚 Shell Configuration Issues:${NC}\n%s\n" "$shell_issues"
        printf "     ${GRAY}Tip: Source shell files after installation or restart terminal${NC}\n"
    fi
}

# Print chezmoi apply readiness status
print_chezmoi_readiness_status() {
    local adapter="$1"
    local failed="$2" 
    local score="$3"
    
    if [ $REPORT_LEVEL -ge $REPORT_NORMAL ]; then
        printf "\n${BOLD}Chezmoi Apply Readiness${NC}\n"
        printf "${GRAY}────────────────────────────────────────${NC}\n"
        
        # Analyze critical failures (required priority)
        local critical_failures=0
        local blocking_issues=""
        
        # Parse TEST_RESULTS for required failures
        local old_ifs="$IFS"
        IFS='
'
        for result_line in $TEST_RESULTS; do
            IFS='|'
            set -- $result_line
            local category="$1"
            local name="$2"
            local test_status="$3"
            local details="$4"
            local priority="$5"
            local install_hint="$6"
            IFS="$old_ifs"
            
            if [ "$test_status" = "FAIL" ] && [ "$priority" = "required" ]; then
                critical_failures=$((critical_failures + 1))
                blocking_issues="$blocking_issues\n    🚫 $name ($category)"
            fi
        done
        IFS="$old_ifs"
        
        # Determine readiness status
        case "$adapter" in
            pre_apply)
                if [ $critical_failures -eq 0 ] && [ $score -ge 70 ]; then
                    printf "${GREEN}✅ READY${NC} - Safe to run 'chezmoi apply'\n"
                    printf "   ${GRAY}All critical requirements met (Health: ${score}%%)${NC}\n"
                    
                    if [ $failed -gt 0 ]; then
                        printf "\n${YELLOW}⚠️  NON-BLOCKING ISSUES:${NC}\n"
                        printf "   ${GRAY}Some optional/recommended components missing${NC}\n"
                        printf "   ${GRAY}You can proceed but consider installing them later${NC}\n"
                    fi
                    
                elif [ $critical_failures -eq 0 ] && [ $score -ge 50 ]; then
                    printf "${YELLOW}⚠️  READY WITH WARNINGS${NC} - Can proceed with caution\n"
                    printf "   ${GRAY}No critical failures but health is moderate (${score}%%)${NC}\n"
                    printf "   ${GRAY}Consider fixing recommended issues first${NC}\n"
                    
                else
                    printf "${RED}🚫 NOT READY${NC} - Do not run 'chezmoi apply' yet\n"
                    printf "   ${GRAY}Critical failures must be resolved first${NC}\n"
                    
                    if [ -n "$blocking_issues" ]; then
                        printf "\n${RED}🚨 BLOCKING ISSUES:${NC}%s\n" "$blocking_issues"
                    fi
                    
                    printf "\n${YELLOW}NEXT STEPS:${NC}\n"
                    printf "   1. Fix all critical (required) failures above\n" 
                    printf "   2. Re-run test suite to verify fixes\n"
                    printf "   3. Proceed with 'chezmoi apply' once ready\n"
                fi
                ;;
                
            post_apply)
                if [ $critical_failures -eq 0 ] && [ $score -ge 80 ]; then
                    printf "${GREEN}✅ OPTIMAL${NC} - Configuration is working well\n"
                    printf "   ${GRAY}Environment is properly configured (Health: ${score}%%)${NC}\n"
                    
                elif [ $critical_failures -eq 0 ] && [ $score -ge 60 ]; then
                    printf "${YELLOW}⚠️  FUNCTIONAL${NC} - Basic functionality working\n"
                    printf "   ${GRAY}Core features available but some enhancements missing (${score}%%)${NC}\n"
                    
                else
                    printf "${RED}🚫 NEEDS ATTENTION${NC} - Configuration issues detected\n"
                    printf "   ${GRAY}Critical components missing or misconfigured${NC}\n"
                    
                    if [ -n "$blocking_issues" ]; then
                        printf "\n${RED}🚨 CRITICAL ISSUES:${NC}%s\n" "$blocking_issues"
                    fi
                    
                    printf "\n${YELLOW}NEXT STEPS:${NC}\n"
                    printf "   1. Install missing critical components\n"
                    printf "   2. Run 'chezmoi apply' to refresh configuration\n" 
                    printf "   3. Restart shell sessions after fixes\n"
                fi
                ;;
        esac
        
        # Additional context based on score
        if [ $score -lt 30 ]; then
            printf "\n${RED}💥 SEVERE ISSUES${NC}: Multiple critical components missing\n"
        elif [ $score -lt 60 ]; then
            printf "\n${YELLOW}⚠️  MODERATE ISSUES${NC}: Several components need attention\n"
        elif [ $score -lt 90 ]; then
            printf "\n${BLUE}ℹ️  MINOR ISSUES${NC}: Mostly good with some enhancements possible\n"
        fi
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
    print_chezmoi_readiness_status "$adapter" "$failed" "$score"
    print_recommendations "$failed" "$adapter"

    # Return exit code based on critical failures only (using validator logic)
    # Count critical failures by parsing results
    local critical_count=0
    while IFS='|' read -r category name result_status details; do
        if [ "$result_status" = "FAIL" ]; then
            case "$category" in
                core)
                    critical_count=$((critical_count + 1))
                    ;;
                shell|config)
                    case "$name" in
                        *"bashrc"*|*"zshrc"*|*"Shell common"*)
                            critical_count=$((critical_count + 1))
                            ;;
                    esac
                    ;;
            esac
        fi
    done <<EOF
$results
EOF

    # Return exit code aligned with readiness status
    if [ $critical_count -gt 0 ]; then
        if [ $score -lt 50 ]; then
            return 2  # Critical failures with low score
        else
            return 1  # Some critical failures
        fi
    else
        return 0  # No critical failures (warnings are acceptable)
    fi
}