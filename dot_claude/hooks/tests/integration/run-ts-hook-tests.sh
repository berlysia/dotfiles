#!/bin/bash

# TypeScript Hook Integration Test Suite
# Tests all converted TypeScript hooks with structured test data

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
TEST_DATA_DIR="${SCRIPT_DIR}/test-data"
HOOKS_DIR="$(dirname "$SCRIPT_DIR")/../implementations"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

echo "🧪 TypeScript Hook Integration Test Suite"
echo "==========================================="

# Function to run test and check result
run_test() {
    local test_name="$1"
    local script="$2"
    local input_file="$3"
    local expected_exit_code="$4"
    local description="$5"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -n "Testing: $description... "
    
    # Capture both output and exit code
    if cat "$input_file" | $script >/dev/null 2>&1; then
        local actual_exit_code=0
    else
        local actual_exit_code=$?
    fi
    
    if [[ $actual_exit_code -eq $expected_exit_code ]]; then
        echo -e "${GREEN}PASS${NC}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}FAIL${NC} (expected exit code $expected_exit_code, got $actual_exit_code)"
        FAILED_TESTS=$((FAILED_TESTS + 1))
    fi
}

echo ""
echo "✅ Testing auto-approve.ts..."
run_test "auto-approve-allow" \
    "bun ${HOOKS_DIR}/auto-approve.ts" \
    "${TEST_DATA_DIR}/auto-approve-allow.json" \
    0 \
    "Auto-approve safe command"

echo ""
echo "📦 Testing block-package-json-tsx.ts..."
run_test "block-tsx-package-json-deny" \
    "bun ${HOOKS_DIR}/block-package-json-tsx.ts" \
    "${TEST_DATA_DIR}/block-tsx-package-json-deny.json" \
    2 \
    "Block tsx in package.json (should deny)"

run_test "block-tsx-package-json-allow" \
    "bun ${HOOKS_DIR}/block-package-json-tsx.ts" \
    "${TEST_DATA_DIR}/block-tsx-package-json-allow.json" \
    0 \
    "Allow safe tsx usage in package.json"

echo ""
echo "🚫 Testing block-tsx.ts..."
run_test "block-tsx-tsnode-deny" \
    "bun ${HOOKS_DIR}/block-tsx.ts" \
    "${TEST_DATA_DIR}/block-tsx-tsnode-deny.json" \
    2 \
    "Block npx tsx command (should deny)"

run_test "block-tsx-tsnode-allow" \
    "bun ${HOOKS_DIR}/block-tsx.ts" \
    "${TEST_DATA_DIR}/block-tsx-tsnode-allow.json" \
    0 \
    "Allow safe bun command"

echo ""
echo "🔒 Testing deny-node-modules.ts..."
run_test "deny-node-modules-deny" \
    "bun ${HOOKS_DIR}/deny-node-modules.ts" \
    "${TEST_DATA_DIR}/deny-node-modules-deny.json" \
    1 \
    "Deny node_modules write (should deny)"

run_test "deny-node-modules-allow" \
    "bun ${HOOKS_DIR}/deny-node-modules.ts" \
    "${TEST_DATA_DIR}/deny-node-modules-allow.json" \
    0 \
    "Allow safe file write"

echo ""
echo "==========================================="
echo "📊 Test Results Summary:"
echo -e "   Total Tests: ${YELLOW}$TOTAL_TESTS${NC}"
echo -e "   Passed: ${GREEN}$PASSED_TESTS${NC}"
echo -e "   Failed: ${RED}$FAILED_TESTS${NC}"

if [[ $FAILED_TESTS -eq 0 ]]; then
    echo -e "   ${GREEN}All tests passed! ✅${NC}"
    exit 0
else
    echo -e "   ${RED}Some tests failed! ❌${NC}"
    exit 1
fi