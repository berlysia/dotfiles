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
    [ "$REPORT_LEVEL" -lt "$min_level" ] && return
    
    case "$print_status_arg" in
        PASS)
            [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ] && printf "${GREEN}${ICON_PASS}${NC} %s\n" "$message"
            [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        FAIL)
            printf "${RED}${ICON_FAIL}${NC} %s\n" "$message"
            [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        SKIP)
            [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ] && printf "${GRAY}${ICON_SKIP} %s${NC}\n" "$message"
            [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        INFO)
            [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ] && printf "${BLUE}${ICON_INFO}${NC} %s\n" "$message"
            [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ] && [ -n "$details" ] && printf "   ${GRAY}%s${NC}\n" "$details"
            ;;
        HEADER)
            [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ] && printf "\n${BOLD}%s${NC}\n" "$message"
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
    
    if [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ]; then
        printf "%bDotfiles Test Suite Report%b\n" "$BOLD" "$NC"
        printf "${GRAY}%s${NC}\n" "$(date '+%Y-%m-%d %H:%M:%S')"
        printf "${GRAY}Mode: %s${NC}\n" "$mode_display"
    fi
}

# Print configuration summary (uses adapter)
print_config_summary() {
    local adapter="$1"
    
    if [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ]; then
        print_status "HEADER" "Environment Configuration"
        "${adapter}_get_config_summary" | while IFS= read -r line; do
            print_status "INFO" "$line" "" "$REPORT_VERBOSE"
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
    
    if [ "$counted_tests" -gt 0 ]; then
        health_score=$((passed * 100 / counted_tests))
    fi
    
    if [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ]; then
        printf "\n%bHealth Score%b\n" "$BOLD" "$NC"
        printf "%b────────────────────────────────────────%b\n" "$GRAY" "$NC"
        
        if [ "$health_score" -ge 90 ]; then
            printf "${GREEN}${BOLD}%d%%${NC} - Excellent! Your configuration is working perfectly.${NC}\n" "$health_score"
        elif [ "$health_score" -ge 70 ]; then
            printf "${GREEN}%d%%${NC} - Good. Most components are working correctly.\n" "$health_score"
        elif [ "$health_score" -ge 50 ]; then
            printf "${YELLOW}%d%%${NC} - Fair. Some issues need attention.\n" "$health_score"
        else
            printf "${RED}%d%%${NC} - Poor. Significant issues detected.\n" "$health_score"
        fi
    fi
    
    return "$health_score"
}

# Print summary statistics
print_test_summary() {
    local total="$1"
    local passed="$2"
    local failed="$3"
    local skipped="$4"
    
    if [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ]; then
        printf "\n%bTest Summary%b\n" "$BOLD" "$NC"
        printf "%b────────────────────────────────────────%b\n" "$GRAY" "$NC"
        printf "Total Tests:     %d\n" "$total"
        printf "${GREEN}Passed:          %d${NC}\n" "$passed"
        
        if [ "$failed" -gt 0 ]; then
            printf "${RED}Failed:          %d${NC}\n" "$failed"
        fi
        
        if [ "$skipped" -gt 0 ] && [ "$REPORT_LEVEL" -ge "$REPORT_VERBOSE" ]; then
            printf "${GRAY}Skipped:         %d${NC}\n" "$skipped"
        fi
    fi
}

# Print actionable recommendations based on missing components
print_recommendations() {
    local failed="$1"
    local adapter="$2"
    
    if [ "$failed" -gt 0 ] && [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ]; then
        printf "\n%bActionable Recommendations%b\n" "$BOLD" "$NC"
        printf "%b────────────────────────────────────────%b\n" "$GRAY" "$NC"
        
        # Parse failed tests to provide specific recommendations
        generate_specific_recommendations "$adapter"
        
        # General recommendations based on adapter mode
        case "$adapter" in
            pre_apply)
                printf "\n%bBefore running 'chezmoi apply':%b\n" "$YELLOW" "$NC"
                printf "  • Review specific recommendations above\n"
                printf "  • Install missing required components (priority: required > recommended > optional)\n"
                printf "  • Run tests with -v for detailed installation hints\n"
                printf "  • Focus on fixing 'required' failures first\n"
                ;;
            post_apply)
                printf "\n%bTo fix configuration issues:%b\n" "$YELLOW" "$NC"
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
    printf "%b%b%b Specific Issues Found:\n" "$BLUE" "$ICON_INFO" "$NC"
    
    # Parse TEST_RESULTS for failed tests with install hints
    local old_ifs="$IFS"
    IFS='
'
    for result_line in $TEST_RESULTS; do
        IFS='|'
        # shellcheck disable=SC2086 # split result_line into fields
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
        printf "     %bTip: Configure git globally with user.name and user.email%b\n" "$GRAY" "$NC"
    fi
    
    if [ -n "$shell_issues" ]; then
        printf "\n${BLUE}🐚 Shell Configuration Issues:${NC}\n%s\n" "$shell_issues"
        printf "     %bTip: Source shell files after installation or restart terminal%b\n" "$GRAY" "$NC"
    fi
}

# Print chezmoi apply readiness status
print_chezmoi_readiness_status() {
    local adapter="$1"
    local failed="$2" 
    local score="$3"
    
    if [ "$REPORT_LEVEL" -ge "$REPORT_NORMAL" ]; then
        printf "\n%bChezmoi Apply Readiness%b\n" "$BOLD" "$NC"
        printf "%b────────────────────────────────────────%b\n" "$GRAY" "$NC"
        
        # Analyze critical failures (required priority)
        local critical_failures=0
        local blocking_issues=""
        
        # Parse TEST_RESULTS for required failures
        local old_ifs="$IFS"
        IFS='
'
        for result_line in $TEST_RESULTS; do
            IFS='|'
            # shellcheck disable=SC2086 # split result_line into fields
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
                if [ "$critical_failures" -eq 0 ] && [ "$score" -ge 70 ]; then
                    printf "%b✅ READY%b - Safe to run 'chezmoi apply'\n" "$GREEN" "$NC"
                    printf "   ${GRAY}All critical requirements met (Health: ${score}%%)${NC}\n"
                    
                    if [ "$failed" -gt 0 ]; then
                        printf "\n%b⚠️  NON-BLOCKING ISSUES:%b\n" "$YELLOW" "$NC"
                        printf "   %bSome optional/recommended components missing%b\n" "$GRAY" "$NC"
                        printf "   %bYou can proceed but consider installing them later%b\n" "$GRAY" "$NC"
                    fi
                    
                elif [ "$critical_failures" -eq 0 ] && [ "$score" -ge 50 ]; then
                    printf "%b⚠️  READY WITH WARNINGS%b - Can proceed with caution\n" "$YELLOW" "$NC"
                    printf "   ${GRAY}No critical failures but health is moderate (${score}%%)${NC}\n"
                    printf "   %bConsider fixing recommended issues first%b\n" "$GRAY" "$NC"
                    
                else
                    printf "%b🚫 NOT READY%b - Do not run 'chezmoi apply' yet\n" "$RED" "$NC"
                    printf "   %bCritical failures must be resolved first%b\n" "$GRAY" "$NC"
                    
                    if [ -n "$blocking_issues" ]; then
                        printf "\n${RED}🚨 BLOCKING ISSUES:${NC}%s\n" "$blocking_issues"
                    fi
                    
                    printf "\n%bNEXT STEPS:%b\n" "$YELLOW" "$NC"
                    printf "   1. Fix all critical (required) failures above\n" 
                    printf "   2. Re-run test suite to verify fixes\n"
                    printf "   3. Proceed with 'chezmoi apply' once ready\n"
                fi
                ;;
                
            post_apply)
                if [ "$critical_failures" -eq 0 ] && [ "$score" -ge 80 ]; then
                    printf "%b✅ OPTIMAL%b - Configuration is working well\n" "$GREEN" "$NC"
                    printf "   ${GRAY}Environment is properly configured (Health: ${score}%%)${NC}\n"
                    
                elif [ "$critical_failures" -eq 0 ] && [ "$score" -ge 60 ]; then
                    printf "%b⚠️  FUNCTIONAL%b - Basic functionality working\n" "$YELLOW" "$NC"
                    printf "   ${GRAY}Core features available but some enhancements missing (${score}%%)${NC}\n"
                    
                else
                    printf "%b🚫 NEEDS ATTENTION%b - Configuration issues detected\n" "$RED" "$NC"
                    printf "   %bCritical components missing or misconfigured%b\n" "$GRAY" "$NC"
                    
                    if [ -n "$blocking_issues" ]; then
                        printf "\n${RED}🚨 CRITICAL ISSUES:${NC}%s\n" "$blocking_issues"
                    fi
                    
                    printf "\n%bNEXT STEPS:%b\n" "$YELLOW" "$NC"
                    printf "   1. Install missing critical components\n"
                    printf "   2. Run 'chezmoi apply' to refresh configuration\n" 
                    printf "   3. Restart shell sessions after fixes\n"
                fi
                ;;
        esac
        
        # Additional context based on score
        if [ "$score" -lt 30 ]; then
            printf "\n%b💥 SEVERE ISSUES%b: Multiple critical components missing\n" "$RED" "$NC"
        elif [ "$score" -lt 60 ]; then
            printf "\n%b⚠️  MODERATE ISSUES%b: Several components need attention\n" "$YELLOW" "$NC"
        elif [ "$score" -lt 90 ]; then
            printf "\n%bℹ️  MINOR ISSUES%b: Mostly good with some enhancements possible\n" "$BLUE" "$NC"
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
    if [ "$critical_count" -gt 0 ]; then
        if [ "$score" -lt 50 ]; then
            return 2  # Critical failures with low score
        else
            return 1  # Some critical failures
        fi
    else
        return 0  # No critical failures (warnings are acceptable)
    fi
}