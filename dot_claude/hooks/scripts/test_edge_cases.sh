#!/bin/bash

# Edge cases and stress tests for auto-approve-commands.sh

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
source "${SCRIPT_DIR}/test_auto_approve.sh"

echo "Starting edge case tests..."
echo

# Reset counters for edge case tests
TEST_COUNT=0
PASS_COUNT=0  
FAIL_COUNT=0

# Test 21: Nested wrapper commands
run_test \
    "Nested wrapper commands" \
    "timeout 30 time npm install" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(time:*)\", \"Bash(npm:*)\""

# Test 22: Wrapper with denied nested command
run_test \
    "Wrapper with denied nested command" \
    "timeout 30 time pnpm install" \
    "block" \
    "\"Bash(timeout:*)\", \"Bash(time:*)\"" \
    "\"Bash(pnpm:*)\""

# Test 23: Long command with many pipes
run_test \
    "Long pipe chain" \
    "cat large.log | grep ERROR | sort | uniq | head -20 | tail -10" \
    "approve" \
    "\"Bash(cat:*)\", \"Bash(grep:*)\", \"Bash(sort:*)\", \"Bash(uniq:*)\", \"Bash(head:*)\", \"Bash(tail:*)\""

# Test 24: Commands with special characters in arguments
run_test \
    "Command with special characters" \
    "grep -E '\\[(ERROR|WARN)\\]' app.log" \
    "approve" \
    "\"Bash(grep:*)\""

# Test 25: Very long command line
run_test \
    "Very long command line" \
    "find /very/long/path/to/search -type f -name '*.log' -exec grep -l 'ERROR' {} \\; | head -100" \
    "approve" \
    "\"Bash(find:*)\", \"Bash(grep:*)\", \"Bash(head:*)\""

# Test 26: Multiple xargs in sequence
run_test \
    "Multiple xargs in sequence" \
    "find . -name '*.tmp' | xargs rm -f && find . -name '*.bak' | xargs rm -f" \
    "approve" \
    "\"Bash(find:*)\", \"Bash(xargs:*)\", \"Bash(rm:*)\""

# Test 27: Wrapper command with complex arguments
run_test \
    "Timeout with complex npm script" \
    "timeout 300 npm run test:integration:full -- --verbose --coverage" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(npm:*)\""

# Test 28: Find with multiple exec commands
run_test \
    "Find with multiple exec patterns" \
    "find . -name '*.js' -exec eslint {} \\; -exec prettier --check {} \\;" \
    "approve" \
    "\"Bash(find:*)\", \"Bash(eslint:*)\", \"Bash(prettier:*)\""

# Test 29: Bunx with scoped package
run_test \
    "Bunx with scoped package" \
    "bunx @playwright/test" \
    "approve" \
    "\"Bash(bunx:*)\", \"Bash(@playwright/test:*)\""

# Test 30: Pnpx with version specification
run_test \
    "Pnpx with version specification" \
    "pnpx create-next-app@latest myapp" \
    "approve" \
    "\"Bash(pnpx:*)\", \"Bash(create-next-app:*)\""

# Test 31: Command with semicolon separator
run_test \
    "Commands separated by semicolon" \
    "cd /tmp; ls -la; pwd" \
    "approve" \
    "\"Bash(cd:*)\", \"Bash(ls:*)\", \"Bash(pwd:*)\""

# Test 32: OR operator with mixed results
run_test \
    "OR operator with mixed allow/deny" \
    "git status || rm -rf /" \
    "block" \
    "\"Bash(git:*)\"" \
    "\"Bash(rm:*)\""

# Test 33: Background process
run_test \
    "Background process with &" \
    "npm start & sleep 5 && curl localhost:3000" \
    "approve" \
    "\"Bash(npm:*)\", \"Bash(sleep:*)\", \"Bash(curl:*)\""

# Test 34: Command substitution in arguments
run_test \
    "Command with command substitution" \
    "cd \"\\$(git rev-parse --show-toplevel)\" && pwd" \
    "approve" \
    "\"Bash(cd:*)\", \"Bash(pwd:*)\""

# Test 35: Multiple redirections
run_test \
    "Command with multiple redirections" \
    "npm test > test.log 2>&1 && cat test.log" \
    "approve" \
    "\"Bash(npm:*)\", \"Bash(cat:*)\""

# Test 36: Xargs with find and complex options
run_test \
    "Complex find with xargs" \
    "find . -type f -name '*.log' -mtime +7 | xargs -I {} mv {} archive/" \
    "approve" \
    "\"Bash(find:*)\", \"Bash(xargs:*)\", \"Bash(mv:*)\""

# Test 37: Time command with complex nested command
run_test \
    "Time with nested pipe command" \
    "time (cat large.txt | grep pattern | wc -l)" \
    "approve" \
    "\"Bash(time:*)\", \"Bash(cat:*)\", \"Bash(grep:*)\", \"Bash(wc:*)\""

# Test 38: Timeout with zero duration
run_test \
    "Timeout with zero duration" \
    "timeout 0 echo 'test'" \
    "approve" \
    "\"Bash(timeout:*)\", \"Bash(echo:*)\""

# Test 39: Empty deny list with allow patterns
run_test \
    "Command with empty deny list" \
    "git status" \
    "approve" \
    "\"Bash(git:*)\"" \
    ""

# Test 40: Unicode characters in command
run_test \
    "Command with unicode characters" \
    "echo 'Hello 世界 🌍'" \
    "approve" \
    "\"Bash(echo:*)\""

echo
echo "=== EDGE CASE TEST SUMMARY ==="
log_summary