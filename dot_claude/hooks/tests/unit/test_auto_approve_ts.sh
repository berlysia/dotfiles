#!/bin/bash

# Test suite for TypeScript auto-approve-commands
# Modified version to test the TypeScript implementation

set -uo pipefail

SCRIPT_DIR="$(dirname "$0")"
# Point to TypeScript version instead of shell version
HOOK_SCRIPT="${SCRIPT_DIR}/../../dist/auto-approve-commands.sh"
SETTINGS_FILE="/tmp/claude_test_settings.json"

# Test configuration
TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test helper functions
log_test() {
    echo -e "${YELLOW}[TEST $((++TEST_COUNT))]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASS_COUNT++))
}

log_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAIL_COUNT++))
}

log_summary() {
    echo
    echo "=== TEST SUMMARY ==="
    echo "Total: $TEST_COUNT"
    echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
    echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
    
    if [ $FAIL_COUNT -eq 0 ]; then
        echo -e "${GREEN}All tests passed!${NC}"
        return 0
    else
        echo -e "${RED}Some tests failed!${NC}"
        return 1
    fi
}

# Test runner function using environment variables (matches TypeScript implementation)
run_test() {
    local description="$1"
    local command="$2"
    local expected_decision="$3"
    local allow_patterns="$4"
    local deny_patterns="${5:-}"
    
    log_test "$description"
    
    # Set test environment variables
    export CLAUDE_TEST_MODE=1
    export CLAUDE_TEST_ALLOW="$allow_patterns"
    export CLAUDE_TEST_DENY="$deny_patterns"
    
    local test_input="{\"tool_name\": \"Bash\", \"tool_input\": {\"command\": \"$command\"}}"
    local result
    result=$(echo "$test_input" | "$HOOK_SCRIPT" 2>/dev/null || echo '{}')
    
    local decision
    decision=$(echo "$result" | jq -r '.hookSpecificOutput.permissionDecision // "no_match"' 2>/dev/null || echo "no_match")
    
    # Map expected decisions
    case "$expected_decision" in
        "approve") expected_decision="allow" ;;
        "block") expected_decision="deny" ;;
    esac
    
    if [ "$decision" = "$expected_decision" ]; then
        log_pass "$description"
    else
        log_fail "$description (expected: $expected_decision, got: $decision)"
        echo "  Command: $command"
        echo "  Input: $test_input"
        echo "  Result: $result"
    fi
    
    # Clean up environment
    unset CLAUDE_TEST_MODE CLAUDE_TEST_ALLOW CLAUDE_TEST_DENY
}

# Basic tests
echo "Starting TypeScript implementation tests..."

run_test "Single command with allow pattern" \
    "echo hello" \
    "approve" \
    "[\"Bash(echo:*)\"]"

run_test "Single command with deny pattern" \
    "rm dangerous.txt" \
    "block" \
    "[]" \
    "[\"Bash(rm:*)\"]"

run_test "Command with no matching patterns" \
    "unknown_command" \
    "ask" \
    "[]"

run_test "Compound command with all parts allowed" \
    "echo hello && echo world" \
    "approve" \
    "[\"Bash(echo:*)\"]"

run_test "Compound command with one part denied" \
    "echo hello && rm file.txt" \
    "block" \
    "[\"Bash(echo:*)\"]" \
    "[\"Bash(rm:*)\"]"

# Clean up and show results
log_summary