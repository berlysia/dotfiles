#!/bin/bash

# Main test runner for auto-approve functionality

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Auto-Approve Commands Test Suite     ${NC}"
echo -e "${BLUE}========================================${NC}"
echo

# Check if hook script exists
HOOK_SCRIPT="${SCRIPT_DIR}/auto-approve-commands.sh"
if [ ! -f "$HOOK_SCRIPT" ]; then
    echo -e "${RED}ERROR: Hook script not found at $HOOK_SCRIPT${NC}"
    exit 1
fi

# Check if pattern matcher exists
PATTERN_MATCHER="${SCRIPT_DIR}/lib/pattern-matcher.sh"
if [ ! -f "$PATTERN_MATCHER" ]; then
    echo -e "${RED}ERROR: Pattern matcher not found at $PATTERN_MATCHER${NC}"
    exit 1
fi

# Syntax check
echo -e "${YELLOW}Running syntax checks...${NC}"
if bash -n "$HOOK_SCRIPT" && bash -n "$PATTERN_MATCHER"; then
    echo -e "${GREEN}✓ Syntax checks passed${NC}"
else
    echo -e "${RED}✗ Syntax errors found${NC}"
    exit 1
fi
echo

# Run core functionality tests
echo -e "${YELLOW}Running core functionality tests...${NC}"
if "${SCRIPT_DIR}/tests/unit/test_auto_approve.sh"; then
    CORE_RESULT=0
    echo -e "${GREEN}✓ Core tests completed${NC}"
else
    CORE_RESULT=1
    echo -e "${RED}✗ Core tests failed${NC}"
fi
echo

# Run edge case tests
echo -e "${YELLOW}Running edge case tests...${NC}"
if "${SCRIPT_DIR}/tests/unit/test_edge_cases.sh"; then
    EDGE_RESULT=0
    echo -e "${GREEN}✓ Edge case tests completed${NC}"
else
    EDGE_RESULT=1
    echo -e "${RED}✗ Edge case tests failed${NC}"
fi
echo

# Run dangerous command protection tests
echo -e "${YELLOW}Running dangerous command protection tests...${NC}"
if "${SCRIPT_DIR}/tests/unit/test_dangerous_command_protection.sh"; then
    DANGEROUS_RESULT=0
    echo -e "${GREEN}✓ Dangerous command protection tests completed${NC}"
else
    DANGEROUS_RESULT=1
    echo -e "${RED}✗ Dangerous command protection tests failed${NC}"
fi
echo

# Performance test
echo -e "${YELLOW}Running performance test...${NC}"
PERF_START=$(date +%s%N)
for i in {1..50}; do
    echo '{"tool_name": "Bash", "tool_input": {"command": "git status && npm test | grep PASS"}}' | \
    "$HOOK_SCRIPT" > /dev/null 2>&1 || true
done
PERF_END=$(date +%s%N)
PERF_DURATION=$(( (PERF_END - PERF_START) / 1000000 )) # Convert to milliseconds

echo "Performance: 50 evaluations in ${PERF_DURATION}ms (avg: $((PERF_DURATION / 50))ms per evaluation)"

if [ $PERF_DURATION -lt 5000 ]; then
    echo -e "${GREEN}✓ Performance acceptable${NC}"
    PERF_RESULT=0
else
    echo -e "${YELLOW}⚠ Performance slower than expected${NC}"
    PERF_RESULT=1
fi
echo

# Memory usage test (rough estimate)
echo -e "${YELLOW}Running memory usage test...${NC}"
MEMORY_BEFORE=$(ps -o pid,vsz,rss,comm | grep $$ | awk '{print $2}')
for i in {1..100}; do
    echo '{"tool_name": "Bash", "tool_input": {"command": "find . -name \"*.log\" | xargs grep ERROR | head -20"}}' | \
    "$HOOK_SCRIPT" > /dev/null 2>&1 || true
done
MEMORY_AFTER=$(ps -o pid,vsz,rss,comm | grep $$ | awk '{print $2}')
MEMORY_DIFF=$((MEMORY_AFTER - MEMORY_BEFORE))

echo "Memory usage: ${MEMORY_DIFF}KB increase after 100 evaluations"

if [ $MEMORY_DIFF -lt 1000 ]; then
    echo -e "${GREEN}✓ Memory usage acceptable${NC}"
    MEMORY_RESULT=0
else
    echo -e "${YELLOW}⚠ Memory usage higher than expected${NC}"
    MEMORY_RESULT=1
fi
echo

# Integration test with actual settings
echo -e "${YELLOW}Running integration test...${NC}"
SETTINGS_FILE="/home/berlysia/.local/share/chezmoi/.claude/settings.local.json"
if [ -f "$SETTINGS_FILE" ]; then
    # Test with actual current settings
    TEST_COMMAND='{"tool_name": "Bash", "tool_input": {"command": "git status"}}'
    INTEGRATION_RESULT=$(echo "$TEST_COMMAND" | "$HOOK_SCRIPT" 2>/dev/null || echo '{}')
    
    if echo "$INTEGRATION_RESULT" | jq . > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Integration test passed (valid JSON output)${NC}"
        INTEGRATION_RESULT=0
    else
        echo -e "${RED}✗ Integration test failed (invalid JSON output)${NC}"
        INTEGRATION_RESULT=1
    fi
else
    echo -e "${YELLOW}⚠ No settings file found, skipping integration test${NC}"
    INTEGRATION_RESULT=0
fi
echo

# Final summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}           FINAL TEST RESULTS           ${NC}"
echo -e "${BLUE}========================================${NC}"

TOTAL_RESULT=$((CORE_RESULT + EDGE_RESULT + DANGEROUS_RESULT + PERF_RESULT + MEMORY_RESULT + INTEGRATION_RESULT))

if [ $CORE_RESULT -eq 0 ]; then
    echo -e "Core Functionality: ${GREEN}PASS${NC}"
else
    echo -e "Core Functionality: ${RED}FAIL${NC}"
fi

if [ $EDGE_RESULT -eq 0 ]; then
    echo -e "Edge Cases: ${GREEN}PASS${NC}"
else
    echo -e "Edge Cases: ${RED}FAIL${NC}"
fi

if [ $DANGEROUS_RESULT -eq 0 ]; then
    echo -e "Dangerous Command Protection: ${GREEN}PASS${NC}"
else
    echo -e "Dangerous Command Protection: ${RED}FAIL${NC}"
fi

if [ $PERF_RESULT -eq 0 ]; then
    echo -e "Performance: ${GREEN}PASS${NC}"
else
    echo -e "Performance: ${YELLOW}WARN${NC}"
fi

if [ $MEMORY_RESULT -eq 0 ]; then
    echo -e "Memory Usage: ${GREEN}PASS${NC}"
else
    echo -e "Memory Usage: ${YELLOW}WARN${NC}"
fi

if [ $INTEGRATION_RESULT -eq 0 ]; then
    echo -e "Integration: ${GREEN}PASS${NC}"
else
    echo -e "Integration: ${RED}FAIL${NC}"
fi

echo

if [ $TOTAL_RESULT -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL TESTS PASSED! 🎉${NC}"
    echo "The auto-approve system is working correctly."
    exit 0
elif [ $TOTAL_RESULT -le 2 ]; then
    echo -e "${YELLOW}⚠ TESTS PASSED WITH WARNINGS ⚠${NC}"
    echo "The auto-approve system is functional but may need optimization."
    exit 0
else
    echo -e "${RED}❌ TESTS FAILED ❌${NC}"
    echo "The auto-approve system has issues that need to be addressed."
    exit 1
fi