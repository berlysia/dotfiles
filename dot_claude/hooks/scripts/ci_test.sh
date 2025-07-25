#!/bin/bash

# CI/CD test script for auto-approve functionality
# Can be used in GitHub Actions, Jenkins, etc.

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}     CI/CD Auto-Approve Tests           ${NC}"
echo -e "${BLUE}========================================${NC}"

# Get script directory
SCRIPT_DIR="$(dirname "$0")"
TEST_RUNNER="${SCRIPT_DIR}/run_all_tests.sh"

# Check if test runner exists
if [ ! -f "$TEST_RUNNER" ]; then
    echo -e "${RED}❌ Test runner not found at $TEST_RUNNER${NC}"
    exit 1
fi

# Set CI mode environment variable
export CI_MODE=1

# Run tests with verbose output
echo -e "${BLUE}Running comprehensive test suite...${NC}"
echo

# Capture start time
START_TIME=$(date +%s)

# Run the tests
if "$TEST_RUNNER"; then
    EXIT_CODE=0
    RESULT_COLOR="${GREEN}"
    RESULT_TEXT="✅ PASSED"
else
    EXIT_CODE=1
    RESULT_COLOR="${RED}"
    RESULT_TEXT="❌ FAILED"
fi

# Capture end time
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}           CI/CD TEST RESULTS           ${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "Status: ${RESULT_COLOR}${RESULT_TEXT}${NC}"
echo -e "Duration: ${DURATION}s"
echo -e "Timestamp: $(date)"
echo

# Exit with appropriate code
exit $EXIT_CODE