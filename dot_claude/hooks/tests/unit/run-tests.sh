#!/bin/bash

# Unit test runner for hook implementations
# Uses node:test to run all test files

set -e

SCRIPT_DIR="$(dirname "$0")"
TEST_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     Hook Implementations Unit Test Runner       ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo

# Find all test files
TEST_FILES=$(find "$TEST_DIR" -name "*.test.ts" -type f | sort)

if [ -z "$TEST_FILES" ]; then
    echo -e "${YELLOW}⚠ No test files found in $TEST_DIR${NC}"
    exit 1
fi

echo -e "${BLUE}Found test files:${NC}"
echo "$TEST_FILES" | while read -r file; do
    echo "  • $(basename "$file")"
done
echo

# Track overall results
TOTAL_TESTS=0
TOTAL_PASSED=0
TOTAL_FAILED=0
FAILED_FILES=""

# Run each test file
echo -e "${BLUE}Running tests...${NC}"
echo "─────────────────────────────────────────────────"

for TEST_FILE in $TEST_FILES; do
    TEST_NAME=$(basename "$TEST_FILE" .test.ts)
    echo -e "\n${YELLOW}Testing: $TEST_NAME${NC}"
    
    # Run the test and capture output
    if OUTPUT=$(npx tsx --test "$TEST_FILE" 2>&1); then
        echo -e "${GREEN}✓ All tests passed${NC}"
        
        # Parse test counts from output if available
        if echo "$OUTPUT" | grep -q "tests"; then
            echo "$OUTPUT" | grep -E "(tests|pass|fail)" | tail -5
        fi
        
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
        echo -e "${RED}✗ Tests failed${NC}"
        echo "$OUTPUT" | tail -20
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
        FAILED_FILES="$FAILED_FILES\n  • $TEST_NAME"
    fi
done

echo
echo "─────────────────────────────────────────────────"
echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                TEST SUMMARY                     ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"

TOTAL_FILES=$((TOTAL_PASSED + TOTAL_FAILED))
echo -e "Files tested: ${BLUE}$TOTAL_FILES${NC}"
echo -e "Passed: ${GREEN}$TOTAL_PASSED${NC}"
echo -e "Failed: ${RED}$TOTAL_FAILED${NC}"

if [ $TOTAL_FAILED -eq 0 ]; then
    echo
    echo -e "${GREEN}🎉 All tests passed successfully!${NC}"
    exit 0
else
    echo
    echo -e "${RED}Failed test files:${NC}"
    echo -e "$FAILED_FILES"
    echo
    echo -e "${RED}❌ Some tests failed. Please fix the failing tests.${NC}"
    exit 1
fi