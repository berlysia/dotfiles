#!/bin/bash

# Test script for pattern-matcher.sh

# Source the library
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/pattern-matcher.sh"

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Test counters
PASSED=0
FAILED=0

# Test function
test_pattern() {
    local test_name="$1"
    local pattern="$2"
    local tool_name="$3"
    local tool_input="$4"
    local expected="$5"
    
    if check_pattern "$pattern" "$tool_name" "$tool_input"; then
        local result=0
    else
        local result=1
    fi
    
    if [[ "$result" -eq "$expected" ]]; then
        echo -e "${GREEN}✓${NC} $test_name"
        ((PASSED++))
    else
        echo -e "${RED}✗${NC} $test_name"
        echo "  Pattern: $pattern"
        echo "  Tool: $tool_name"
        echo "  Input: $tool_input"
        echo "  Expected: $expected, Got: $result"
        ((FAILED++))
    fi
}

echo "Testing pattern-matcher.sh"
echo "========================="

# Test Bash command patterns
echo -e "\nBash command patterns:"
test_pattern "Bash(echo:*) matches echo command" \
    'Bash(echo:*)' "Bash" '{"command": "echo hello world"}' 0

test_pattern "Bash(echo:*) does not match ls command" \
    'Bash(echo:*)' "Bash" '{"command": "ls -la"}' 1

test_pattern "Bash(rm -f:*) matches rm -f command" \
    'Bash(rm -f:*)' "Bash" '{"command": "rm -f /tmp/test.txt"}' 0

test_pattern "Bash(rm -f:*) does not match rm -rf command" \
    'Bash(rm -f:*)' "Bash" '{"command": "rm -rf /tmp/test"}' 1

test_pattern "Bash(cd:*) matches cd in compound command" \
    'Bash(cd:*)' "Bash" '{"command": "cd /tmp && ls"}' 0

test_pattern "Bash(ls:*) matches ls in compound command" \
    'Bash(ls:*)' "Bash" '{"command": "cd /tmp && ls -la"}' 0

test_pattern "Exact match Bash(echo hello)" \
    'Bash(echo hello)' "Bash" '{"command": "echo hello"}' 0

test_pattern "Exact match fails with different command" \
    'Bash(echo hello)' "Bash" '{"command": "echo world"}' 1

# Test file path patterns
echo -e "\nFile path patterns:"
test_pattern "Read(**) matches any file" \
    'Read(**)' "Read" '{"file_path": "/path/to/file.txt"}' 0

test_pattern "Read(*.js) matches JavaScript file" \
    'Read(*.js)' "Read" '{"file_path": "script.js"}' 0

test_pattern "Read(*.js) does not match Python file" \
    'Read(*.js)' "Read" '{"file_path": "script.py"}' 1

test_pattern "Read(/src/**) matches files in /src" \
    'Read(/src/**)' "Read" '{"file_path": "/src/components/Button.js"}' 0

test_pattern "Read(!*.test.js) matches non-test files" \
    'Read(!*.test.js)' "Read" '{"file_path": "app.js"}' 0

test_pattern "Read(!*.test.js) does not match test files" \
    'Read(!*.test.js)' "Read" '{"file_path": "app.test.js"}' 1

# Test tool name only patterns
echo -e "\nTool name only patterns:"
test_pattern "Bash matches any Bash command" \
    'Bash' "Bash" '{"command": "any command"}' 0

test_pattern "Read matches any Read operation" \
    'Read' "Read" '{"file_path": "/any/file"}' 0

test_pattern "Write does not match Read" \
    'Write' "Read" '{"file_path": "/any/file"}' 1

# Test edge cases
echo -e "\nEdge cases:"
test_pattern "Command with special characters" \
    'Bash(git commit:*)' "Bash" '{"command": "git commit -m \"test message\""}' 0

test_pattern "Multiple separators in compound command" \
    'Bash(npm:*)' "Bash" '{"command": "cd /app && npm install && npm test"}' 0

# Summary
echo -e "\n========================="
echo "Test Results:"
echo -e "${GREEN}Passed: $PASSED${NC}"
if [[ $FAILED -gt 0 ]]; then
    echo -e "${RED}Failed: $FAILED${NC}"
    exit 1
else
    echo -e "All tests passed!"
    exit 0
fi