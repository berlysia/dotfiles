#!/bin/bash

# TypeScript Hook Test Suite with Type Checking
# Combines type checking and functional testing

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
HOOKS_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

echo -e "${BLUE}🧪 TypeScript Hook Test Suite with Type Checking${NC}"
echo "=================================================="

# Function to run type check
run_type_check() {
    local file="$1"
    local description="$2"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -n "Type checking: $description... "
    
    if npx tsgo --noEmit --target esnext --module esnext "$file" >/dev/null 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}FAIL${NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${YELLOW}Type errors in $file:${NC}"
        npx tsgo --noEmit --target esnext --module esnext "$file" 2>&1 | head -5
        return 1
    fi
}

# Function to run functional test
run_functional_test() {
    local test_name="$1"
    local script="$2" 
    local test_data="$3"
    local expected_exit_code="$4"
    local description="$5"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -n "Functional test: $description... "
    
    # Create test input if provided as string
    if [[ "$test_data" == "{"* ]]; then
        local temp_file=$(mktemp)
        echo "$test_data" > "$temp_file"
        test_data="$temp_file"
    fi
    
    # Capture both output and exit code
    if cat "$test_data" | $script >/dev/null 2>&1; then
        local actual_exit_code=0
    else
        local actual_exit_code=$?
    fi
    
    # Clean up temp file if created
    if [[ "$test_data" == /tmp/tmp* ]]; then
        rm -f "$test_data"
    fi
    
    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        echo -e "${GREEN}PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${RED}FAIL${NC} (expected exit code $expected_exit_code, got $actual_exit_code)"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

echo ""
echo -e "${YELLOW}🔍 Phase 1: Type Checking${NC}"
echo "=========================="

# Type check all TypeScript files
run_type_check "types/hooks-types.ts" "Hook type definitions"
run_type_check "lib/hook-common.ts" "Common hook utilities" 
run_type_check "command-logger.ts" "Command logger script"
run_type_check "auto-approve-commands.ts" "Auto-approve commands script"
run_type_check "block-tsx-package-json.ts" "Block tsx package.json script"
run_type_check "block-tsx-tsnode.ts" "Block tsx/tsnode script"
run_type_check "deny-node-modules-write.ts" "Deny node modules write script"
run_type_check "deny-repository-outside-access.ts" "Deny outside access script"

echo ""
echo -e "${YELLOW}🚀 Phase 2: Functional Testing${NC}"
echo "==============================="

# Test command-logger with different hook types
run_functional_test "command-logger-stop" \
    "bun ${HOOKS_DIR}/command-logger.ts Stop" \
    '{"session_id": "test123", "transcript_path": "/tmp/test.jsonl", "hook_event_name": "Stop", "stop_hook_active": false}' \
    0 \
    "Command logger Stop hook"

run_functional_test "command-logger-pretooluse" \
    "bun ${HOOKS_DIR}/command-logger.ts PreToolUse" \
    '{"tool_name": "Bash", "tool_input": {"command": "echo test", "description": "Test command"}, "session_id": "test123"}' \
    0 \
    "Command logger PreToolUse hook"

run_functional_test "command-logger-posttooluse" \
    "bun ${HOOKS_DIR}/command-logger.ts PostToolUse" \
    '{"tool_name": "Bash", "tool_input": {"command": "echo test", "description": "Test command"}, "session_id": "test123"}' \
    0 \
    "Command logger PostToolUse hook"

# Test basic functionality of other hooks
run_functional_test "auto-approve-safe" \
    "bun ${HOOKS_DIR}/auto-approve-commands.ts" \
    '{"tool_name": "Bash", "tool_input": {"command": "git status"}, "session_id": "test123"}' \
    0 \
    "Auto-approve safe git command"

echo ""
echo "=================================================="
echo -e "${BLUE}📊 Test Results Summary:${NC}"
echo -e "   Total Tests: ${YELLOW}$TOTAL_TESTS${NC}"
echo -e "   Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "   Failed: ${RED}$FAILED_TESTS${NC}"

if [[ $FAILED_TESTS -eq 0 ]]; then
    echo -e "   ${GREEN}All tests passed! ✅${NC}"
    echo ""
    echo -e "${GREEN}🎉 TypeScript hooks are ready for production use!${NC}"
    exit 0
else
    echo -e "   ${RED}Some tests failed! ❌${NC}"
    echo ""
    echo -e "${RED}🔧 Please fix the issues above before deploying.${NC}"
    exit 1
fi