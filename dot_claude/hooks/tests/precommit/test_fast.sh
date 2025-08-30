#!/bin/bash

# Fast test suite for pre-commit hooks - optimized for speed

set -uo pipefail

SCRIPT_DIR="$(dirname "$0")"
HOOK_SCRIPT="${SCRIPT_DIR}/auto-approve-commands.sh"

# Test configuration
TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0

# Colors for output (simplified)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Fast test runner with minimal overhead
run_fast_test() {
    local description="$1"
    local command="$2"
    local expected_decision="$3"
    
    ((TEST_COUNT++))
    
    # Set test environment variables to bypass file operations
    export CLAUDE_TEST_MODE=1
    export CLAUDE_TEST_ALLOW='["Bash(git add:*)","Bash(git status:*)","Bash(cat:*)","Bash(grep:*)","Bash(timeout:*)","Bash(echo:*)"]'
    export CLAUDE_TEST_DENY='["Bash(rm -rf:*)"]'
    
    local test_input="{\"tool_name\": \"Bash\", \"tool_input\": {\"command\": \"$command\"}}"
    local result
    result=$(echo "$test_input" | "$HOOK_SCRIPT" 2>/dev/null || echo '{}')
    
    local decision
    case "$result" in
        *'"decision": "approve"'*) decision="approve" ;;
        *'"decision": "block"'*) decision="block" ;;
        *) decision="no_match" ;;
    esac
    
    if [ "$decision" = "$expected_decision" ]; then
        ((PASS_COUNT++))
        [ "${VERBOSE:-}" = "1" ] && echo -e "${GREEN}✓${NC} $description"
    else
        ((FAIL_COUNT++))
        echo -e "${RED}✗${NC} $description (expected: $expected_decision, got: $decision)"
    fi
    
    # Clean up test environment
    unset CLAUDE_TEST_MODE CLAUDE_TEST_ALLOW CLAUDE_TEST_DENY
}

# Critical tests only - focus on core functionality
echo "Fast pre-commit tests..."

# Test 1: Basic allow
run_fast_test "Basic allow pattern" "git status" "approve"

# Test 2: Basic deny  
run_fast_test "Basic deny pattern" "rm -rf /" "block"

# Test 3: Compound command
run_fast_test "Compound command" "git status && echo done" "approve"

# Test 4: Pipe command
run_fast_test "Pipe command" "cat file | grep test" "approve"

# Test 5: Wrapper command with subcommand detection
run_fast_test "Timeout wrapper" "timeout 15 git status" "approve"

# Test 6: Mixed approval (should be no_match)
run_fast_test "Mixed approval" "git status && unknown_cmd" "no_match"

# Test 7: Syntax check (empty command)
run_fast_test "Empty command" "" "no_match"

# Summary
echo
if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ Fast tests passed ($PASS_COUNT/$TEST_COUNT)${NC}"
    exit 0
else
    echo -e "${RED}❌ Fast tests failed ($FAIL_COUNT/$TEST_COUNT failed)${NC}"
    exit 1
fi