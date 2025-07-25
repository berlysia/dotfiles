#!/bin/bash

# Comprehensive test suite for auto-approve-commands.sh

set -uo pipefail

SCRIPT_DIR="$(dirname "$0")"
HOOK_SCRIPT="${SCRIPT_DIR}/auto-approve-commands.sh"
SETTINGS_FILE="/home/berlysia/.local/share/chezmoi/.claude/settings.local.json"

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

# Setup test environment
setup_test_permissions() {
    local allow_patterns="$1"
    local deny_patterns="$2"
    
    # Backup current settings
    cp "$SETTINGS_FILE" "${SETTINGS_FILE}.test_backup"
    
    # Create test settings
    cat > "$SETTINGS_FILE" << EOF
{
  "permissions": {
    "allow": [$allow_patterns],
    "deny": [$deny_patterns]
  }
}
EOF
}

restore_permissions() {
    if [ -f "${SETTINGS_FILE}.test_backup" ]; then
        mv "${SETTINGS_FILE}.test_backup" "$SETTINGS_FILE"
    fi
}

# Test runner function
run_test() {
    local description="$1"
    local command="$2"
    local expected_decision="$3"
    local allow_patterns="$4"
    local deny_patterns="${5:-}"
    
    log_test "$description"
    
    setup_test_permissions "$allow_patterns" "$deny_patterns"
    
    local test_input="{\"tool_name\": \"Bash\", \"tool_input\": {\"command\": \"$command\"}}"
    local result
    result=$(echo "$test_input" | "$HOOK_SCRIPT" 2>/dev/null || echo '{}')
    
    local decision
    decision=$(echo "$result" | jq -r '.decision // "no_match"' 2>/dev/null || echo "no_match")
    
    restore_permissions
    
    if [ "$decision" = "$expected_decision" ]; then
        log_pass "$description"
    else
        log_fail "$description (expected: $expected_decision, got: $decision)"
    fi
}

echo "Starting comprehensive auto-approve tests..."
echo

# Test 1: Basic allow patterns
run_test \
    "Single command with allow pattern" \
    "git status" \
    "approve" \
    "\"Bash(git:*)\""

# Test 2: Basic deny patterns
run_test \
    "Single command with deny pattern" \
    "rm -rf /" \
    "block" \
    "\"Bash(git:*)\"" \
    "\"Bash(rm:*)\""

# Test 3: No patterns match
run_test \
    "Command with no matching patterns" \
    "unknown_command" \
    "no_match" \
    "\"Bash(git:*)\""

# Test 4: Compound commands - all allowed
run_test \
    "Compound command with all parts allowed" \
    "git status && git add ." \
    "approve" \
    "\"Bash(git:*)\""

# Test 5: Compound commands - one denied
run_test \
    "Compound command with one part denied" \
    "git status && rm -rf /" \
    "block" \
    "\"Bash(git:*)\"" \
    "\"Bash(rm:*)\""

# Test 6: Compound commands - not all allowed
run_test \
    "Compound command with unmatched parts" \
    "git status && unknown_command" \
    "no_match" \
    "\"Bash(git:*)\""

# Test 7: Pipe commands - all allowed
run_test \
    "Pipe command with all parts allowed" \
    "cat file.txt | grep pattern | sort" \
    "approve" \
    "\"Bash(cat:*)\", \"Bash(grep:*)\", \"Bash(sort:*)\""

# Test 8: Pipe commands - one denied
run_test \
    "Pipe command with one part denied" \
    "cat file.txt | grep pattern | rm -rf /" \
    "block" \
    "\"Bash(cat:*)\", \"Bash(grep:*)\"" \
    "\"Bash(rm:*)\""

# Test 9: Wrapper commands - timeout with allowed child
run_test \
    "Timeout command with allowed child" \
    "timeout 15 git status" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(git:*)\""

# Test 10: Wrapper commands - timeout with denied child
run_test \
    "Timeout command with denied child" \
    "timeout 15 pnpm test:e2e" \
    "block" \
    "\"Bash(timeout:*)\"" \
    "\"Bash(pnpm:*)\""

# Test 11: Complex pipe with redirections
run_test \
    "Complex command with pipes and redirections" \
    "timeout 15 npm test 2>&1 | grep ERROR | head -5" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(npm:*)\", \"Bash(grep:*)\", \"Bash(head:*)\""

# Test 12: Wrapper commands - npx
run_test \
    "NPX command with allowed child" \
    "npx create-react-app myapp" \
    "approve" \
    "\"Bash(npx:*)\", \"Bash(create-react-app:*)\""

# Test 13: Wrapper commands - find -exec
run_test \
    "Find with exec and allowed child" \
    "find . -name '*.js' -exec eslint {} \\;" \
    "approve" \
    "\"Bash(find:*)\", \"Bash(eslint:*)\""

# Test 14: Wrapper commands - xargs
run_test \
    "Xargs command with allowed child" \
    "echo 'file1 file2' | xargs rm -f" \
    "approve" \
    "\"Bash(echo:*)\", \"Bash(xargs:*)\", \"Bash(rm:*)\""

# Test 15: Mixed wrapper and compound
run_test \
    "Mixed wrapper and compound commands" \
    "timeout 30 git status && echo done" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(git:*)\", \"Bash(echo:*)\""

# Test 16: Quoted strings with special characters
run_test \
    "Command with quoted strings containing pipes" \
    "grep -E '(error|warning)' file.log | head -10" \
    "approve" \
    "\"Bash(grep:*)\", \"Bash(head:*)\""

# Test 17: Multiple denies
run_test \
    "Command matching multiple deny patterns" \
    "rm -rf / && rm -f *" \
    "block" \
    "\"Bash(git:*)\"" \
    "\"Bash(rm:*)\""

# Test 18: Partial wrapper command matching
run_test \
    "Timeout with partial matching" \
    "timeout 15 unknown_command" \
    "no_match" \
    "\"Bash(timeout:*)\""

# Test 19: Empty command
run_test \
    "Empty command" \
    "" \
    "no_match" \
    "\"Bash(git:*)\""

# Test 20: Complex real-world example
run_test \
    "Complex real-world test command" \
    "timeout 120 pnpm test:e2e 2>&1 | grep -E '(PASS|FAIL|ERROR)' | tee test-results.log" \
    "block" \
    "\"Bash(timeout:*)\", \"Bash(grep:*)\", \"Bash(tee:*)\"" \
    "\"Bash(pnpm:*)\""

echo
log_summary