#!/bin/bash

# Test script for block-tsx-package-json.sh

script_path="$(dirname "$0")/block-tsx-package-json.sh"
test_count=0
pass_count=0

run_test() {
    local test_name="$1"
    local tool_name="$2"
    local file_path="$3"
    local content="$4"
    local expected_exit_code="$5"
    local expected_output="$6"
    
    ((test_count++))
    
    # Create test JSON input
    local json_input
    if [[ $tool_name == "Write" ]]; then
        json_input="{\"tool_name\":\"$tool_name\",\"tool_input\":{\"file_path\":\"$file_path\",\"content\":\"$content\"}}"
    elif [[ $tool_name == "Edit" ]]; then
        json_input="{\"tool_name\":\"$tool_name\",\"tool_input\":{\"file_path\":\"$file_path\",\"new_string\":\"$content\"}}"
    elif [[ $tool_name == "MultiEdit" ]]; then
        json_input="{\"tool_name\":\"$tool_name\",\"tool_input\":{\"file_path\":\"$file_path\",\"edits\":[{\"new_string\":\"$content\"}]}}"
    fi
    
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

echo "Testing block-tsx-package-json.sh"
echo "================================="

# Test 1: Block tsx in scripts (Write)
run_test "Block tsx in scripts (Write)" "Write" "package.json" '{\"scripts\":{\"dev\":\"tsx src/index.ts\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

# Test 2: Block ts-node in scripts (Write)
run_test "Block ts-node in scripts (Write)" "Write" "package.json" '{\"scripts\":{\"start\":\"ts-node app.ts\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

# Test 3: Block tsx in dependencies (Write)
run_test "Block tsx in dependencies (Write)" "Write" "package.json" '{\"devDependencies\":{\"tsx\":\"^1.0.0\"}}' 2 "Adding tsx/ts-node to package.json dependencies is prohibited"

# Test 4: Block ts-node in dependencies (Write)
run_test "Block ts-node in dependencies (Write)" "Write" "package.json" '{\"dependencies\":{\"ts-node\":\"^10.0.0\"}}' 2 "Adding tsx/ts-node to package.json dependencies is prohibited"

# Test 5: Allow normal scripts (Write)
run_test "Allow normal scripts (Write)" "Write" "package.json" '{\"scripts\":{\"build\":\"tsc\",\"test\":\"vitest\"}}' 0 ""

# Test 6: Allow similar package names (Write)
run_test "Allow similar packages (Write)" "Write" "package.json" '{\"devDependencies\":{\"tsx-loader\":\"^1.0.0\"}}' 0 ""

# Test 7: Block tsx in scripts (Edit)
run_test "Block tsx in scripts (Edit)" "Edit" "package.json" '{\"scripts\":{\"dev\":\"tsx watch src/index.ts\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

# Test 8: Allow normal scripts (Edit)
run_test "Allow normal scripts (Edit)" "Edit" "package.json" '{\"scripts\":{\"dev\":\"next dev\"}}' 0 ""

# Test 9: Block tsx in scripts (MultiEdit)
run_test "Block tsx in scripts (MultiEdit)" "MultiEdit" "package.json" '{\"scripts\":{\"dev\":\"tsx src/main.ts\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

# Test 10: Allow normal scripts (MultiEdit)
run_test "Allow normal scripts (MultiEdit)" "MultiEdit" "package.json" '{\"scripts\":{\"build\":\"webpack\"}}' 0 ""

# Test 11: Non-package.json file should be allowed
run_test "Allow non-package.json (Write)" "Write" "src/config.json" '{\"command\":\"tsx build.ts\"}' 0 ""

# Test 12: Read operation should be allowed
run_test "Allow Read operation" "Read" "package.json" "" 0 ""

# Test 13: Allow .tsx files in scripts (should not trigger tsx command block)
run_test "Allow .tsx files in scripts" "Write" "package.json" '{\"scripts\":{\"build\":\"webpack src/App.tsx\"}}' 0 ""

# Test 14: Allow tsx in file paths but not as command
run_test "Allow tsx in file paths" "Write" "package.json" '{\"scripts\":{\"dev\":\"vite src/components/tsx-components/\"}}' 0 ""

# Test 15: Allow tsx in package name
run_test "Allow tsx in package name" "Write" "package.json" '{\"dependencies\":{\"@types/tsx-parser\":\"^1.0.0\"}}' 0 ""

# Test 16: Block xargs tsx (should be detected)
run_test "Block xargs tsx" "Write" "package.json" '{\"scripts\":{\"build\":\"find . -name \\\"*.ts\\\" | xargs tsx\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

# Test 17: Allow --ext tsx (should not be detected)
run_test "Allow --ext tsx" "Write" "package.json" '{\"scripts\":{\"lint\":\"eslint --ext tsx src/\"}}' 0 ""

# Test 18: Allow --extension tsx (should not be detected)
run_test "Allow --extension tsx" "Write" "package.json" '{\"scripts\":{\"check\":\"mycommand --extension tsx\"}}' 0 ""

# Test 19: Block pipe to tsx (should be detected)
run_test "Block pipe to tsx" "Write" "package.json" '{\"scripts\":{\"dev\":\"echo test | tsx script.ts\"}}' 2 "Adding tsx/ts-node to package.json scripts is prohibited"

echo
echo "================================="
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