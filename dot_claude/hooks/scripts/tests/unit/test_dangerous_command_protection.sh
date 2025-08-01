#!/bin/bash

# Test suite for dangerous command protection features
# Tests git push force protection, rm force protection, and .git directory protection

set -uo pipefail

SCRIPT_DIR="$(dirname "$0")"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source test utilities
cd "$ROOT_DIR"
source "${ROOT_DIR}/lib/hook-common.sh"
source "${ROOT_DIR}/lib/pattern-matcher.sh"

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
    echo "  Expected: $2"
    echo "  Got: $3"
    ((FAIL_COUNT++))
}

# Function to test a command
test_command() {
    local test_name="$1"
    local cmd="$2"
    local expected_decision="$3"
    local allow_list="${4:-}"
    local deny_list="${5:-}"
    
    log_test "$test_name"
    
    # Create test input
    local test_input=$(jq -n --arg cmd "$cmd" '{
        "tool_name": "Bash",
        "tool_input": {
            "command": $cmd
        }
    }')
    
    # Run the hook script in test mode
    export CLAUDE_TEST_MODE=1
    export CLAUDE_TEST_ALLOW="$allow_list"
    export CLAUDE_TEST_DENY="$deny_list"
    
    result=$(echo "$test_input" | ./auto-approve-commands.sh 2>&1)
    decision=$(echo "$result" | grep -o '"decision":[[:space:]]*"[^"]*"' | sed 's/.*"decision":[[:space:]]*"\([^"]*\)".*/\1/')
    
    # Clean up environment
    unset CLAUDE_TEST_MODE
    unset CLAUDE_TEST_ALLOW
    unset CLAUDE_TEST_DENY
    
    if [ "$decision" = "$expected_decision" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "$expected_decision" "$decision"
    fi
}

echo "=== Testing Dangerous Command Protection ==="
echo

# Test git push force protection
echo "--- Git Push Force Protection ---"
test_command "Normal git push should be approved" \
    "git push origin main" \
    "approve" \
    '["Bash(git push:*)"]' \
    '[]'

test_command "Git push with -f should be blocked" \
    "git push -f origin main" \
    "block" \
    '["Bash(git push:*)"]' \
    '[]'

test_command "Git push with --force should be blocked" \
    "git push --force origin main" \
    "block" \
    '["Bash(git push:*)"]' \
    '[]'

test_command "Git push with --force-with-lease should be blocked" \
    "git push --force-with-lease origin main" \
    "block" \
    '["Bash(git push:*)"]' \
    '[]'

test_command "Git push with -f at end should be blocked" \
    "git push origin main -f" \
    "block" \
    '["Bash(git push:*)"]' \
    '[]'

test_command "Git push with -u should be approved" \
    "git push -u origin main" \
    "approve" \
    '["Bash(git push:*)"]' \
    '[]'

echo

# Test rm force protection
echo "--- RM Force Protection ---"
test_command "Normal rm should be approved" \
    "rm file.txt" \
    "approve" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with -f should be blocked" \
    "rm -f file.txt" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with --force should be blocked" \
    "rm --force file.txt" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm -rf should be blocked" \
    "rm -rf directory" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm -r (without -f) should be approved" \
    "rm -r directory" \
    "approve" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm -fr should be blocked" \
    "rm -fr directory" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm -i should be approved" \
    "rm -i file.txt" \
    "approve" \
    '["Bash(rm:*)"]' \
    '[]'

echo

# Test .git directory protection
echo "--- .git Directory Protection ---"
test_command "rm .git should be blocked" \
    "rm .git" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm -r .git should be blocked" \
    "rm -r .git" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm .git/config should be blocked" \
    "rm .git/config" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm .git/HEAD should be blocked" \
    "rm .git/HEAD" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm .git/objects should be blocked" \
    "rm -r .git/objects" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "mv .git should be blocked" \
    "mv .git .git-backup" \
    "block" \
    '["Bash(mv:*)"]' \
    '[]'

test_command "mv .git/config should be blocked" \
    "mv .git/config .git/config.bak" \
    "block" \
    '["Bash(mv:*)"]' \
    '[]'

test_command "rmdir .git should be blocked" \
    "rmdir .git" \
    "block" \
    '["Bash(rmdir:*)"]' \
    '[]'

test_command "rm .gitignore should be approved" \
    "rm .gitignore" \
    "approve" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm project.git should be approved (not .git)" \
    "rm project.git" \
    "approve" \
    '["Bash(rm:*)"]' \
    '[]'

echo

# Test edge cases
echo "--- Edge Cases ---"
test_command "rm with quoted .git path should be blocked" \
    "rm '.git/config'" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with double-quoted .git path should be blocked" \
    "rm \".git/HEAD\"" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with absolute .git path should be blocked" \
    "rm /path/to/repo/.git/config" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with home .git path should be blocked" \
    "rm ~/project/.git/HEAD" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm with relative .git path should be blocked" \
    "rm ../../../.git/refs" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm .git with wildcard should be blocked" \
    "rm .git/*" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "rm multiple args including .git should be blocked" \
    "rm file1.txt .git/config file2.txt" \
    "block" \
    '["Bash(rm:*)"]' \
    '[]'

test_command "compound command with .git should be blocked" \
    "mv .git/HEAD /tmp/ && echo done" \
    "block" \
    '["Bash(mv:*)", "Bash(echo:*)"]' \
    '[]'

echo

# Summary
echo "=== Test Summary ==="
echo "Total tests: $TEST_COUNT"
echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "${RED}Failed: $FAIL_COUNT${NC}"

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi