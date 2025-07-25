#!/bin/bash

# Test script for block-tsx-tsnode.sh

script_path="$(dirname "$0")/block-tsx-tsnode.sh"
test_count=0
pass_count=0

run_test() {
    local test_name="$1"
    local command="$2"
    local expected_exit_code="$3"
    local expected_output="$4"
    
    ((test_count++))
    
    # Create test JSON input
    local json_input="{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$command\"}}"
    
    # Run the script
    local output
    local exit_code
    output=$(echo "$json_input" | bash "$script_path" 2>&1)
    exit_code=$?
    
    # Check result
    if [[ $exit_code -eq $expected_exit_code ]]; then
        if [[ -z "$expected_output" ]] || echo "$output" | grep -q "$expected_output"; then
            echo "✅ PASS: $test_name"
            ((pass_count++))
        else
            echo "❌ FAIL: $test_name (output mismatch)"
            echo "   Expected: $expected_output"
            echo "   Got: $output"
        fi
    else
        echo "❌ FAIL: $test_name (exit code mismatch)"
        echo "   Expected exit code: $expected_exit_code"
        echo "   Got exit code: $exit_code"
        echo "   Output: $output"
    fi
}

echo "Testing block-tsx-tsnode.sh"
echo "=========================="

# Test 1: Package installation - should block
run_test "Block npm install tsx" "npm install tsx" 2 "Installation of tsx is prohibited"

# Test 2: Package installation - should block
run_test "Block yarn add ts-node" "yarn add ts-node" 2 "Installation of ts-node is prohibited"

# Test 3: Package installation with version - should block
run_test "Block npm install tsx@latest" "npm install tsx@latest" 2 "Installation of tsx is prohibited"

# Test 4: Package installation with flags - should block
run_test "Block npm install -D tsx" "npm install -D tsx" 2 "Installation of tsx is prohibited"

# Test 5: Package installation of similar packages - should allow
run_test "Allow npm install tsx-loader" "npm install tsx-loader" 0 ""

# Test 6: npx usage - should block
run_test "Block npx tsx script.ts" "npx tsx script.ts" 2 "Running tsx/ts-node via npx is prohibited"

# Test 7: npx usage - should block
run_test "Block npx ts-node index.ts" "npx ts-node index.ts" 2 "Running tsx/ts-node via npx is prohibited"

# Test 8: Node loader usage - should block
run_test "Block node --loader tsx" "node --loader tsx app.js" 2 "Using tsx/ts-node as a loader is prohibited"

# Test 9: Node loader usage - should block
run_test "Block node --require ts-node" "node --require ts-node/register app.js" 2 "Using tsx/ts-node as a loader is prohibited"

# Test 10: Direct execution - should block
run_test "Block tsx script.ts" "tsx script.ts" 2 "Direct execution of TypeScript files with tsx/ts-node is prohibited"

# Test 11: Direct execution - should block
run_test "Block ts-node app.ts" "ts-node app.ts" 2 "Direct execution of TypeScript files with tsx/ts-node is prohibited"

# Test 12: Regular commands - should allow
run_test "Allow npm install react" "npm install react" 0 ""

# Test 13: Regular commands - should allow
run_test "Allow node app.js" "node app.js" 0 ""

# Test 14: Regular commands - should allow
run_test "Allow tsc --build" "tsc --build" 0 ""

# Test 15: Non-Bash tool - should allow
run_test "Allow non-Bash tool" "" 0 ""

# Test 16: Edge case - tsx in file path but not command
run_test "Allow cat tsx-file.js" "cat tsx-file.js" 0 ""

echo
echo "=========================="
echo "Tests completed: $test_count"
echo "Passed: $pass_count"
echo "Failed: $((test_count - pass_count))"

if [[ $pass_count -eq $test_count ]]; then
    echo "🎉 All tests passed!"
    exit 0
else
    echo "💥 Some tests failed!"
    exit 1
fi