#!/usr/bin/env bash
# Test suite for format-codex-config.sh and check-codex-config.sh
# Usage: ./scripts/test-codex-config-scripts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

TESTS_PASSED=0
TESTS_FAILED=0

# Test helper functions
test_start() {
    echo -e "\n${YELLOW}Test: $1${NC}"
}

test_pass() {
    echo -e "${GREEN}✅ PASS${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

test_fail() {
    echo -e "${RED}❌ FAIL: $1${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

# Setup test environment
setup_test() {
    TEST_DIR=$(mktemp -d)
    export CODEX_CONFIG_FILE="$TEST_DIR/config.toml"
    echo "Test directory: $TEST_DIR"
}

cleanup_test() {
    if [[ -n "${TEST_DIR:-}" ]] && [[ -d "${TEST_DIR:-}" ]]; then
        rm -rf "$TEST_DIR"
    fi
    TEST_DIR=""
    CODEX_CONFIG_FILE=""
}

# Cleanup on script exit
trap 'cleanup_test' EXIT

# Test 1: Check script accepts properly formatted config
test_start "Check script accepts properly formatted config"
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
hide_agent_reasoning = true
model_reasoning_effort = 'high'
network_access = true

[features]
web_search_request = true

[mcp_servers]
[mcp_servers.context7]
args = ['@upstash/context7-mcp@latest']
command = 'pnpx'

[mcp_servers.playwright]
args = ['@playwright/mcp@latest']
command = 'pnpx'

[mcp_servers.readability]
args = ['@mizchi/readability@latest', '--mcp']
command = 'pnpx'
EOF

if "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Check script rejected properly formatted config"
fi

# Test 2: Check script rejects improperly formatted config
test_start "Check script rejects improperly formatted config"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
model_reasoning_effort = "high"
network_access = true
hide_agent_reasoning = true

[features]
web_search_request = true

[mcp_servers.context7]
command = "pnpx"
args = ["@upstash/context7-mcp@latest"]
EOF

if ! "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Check script accepted improperly formatted config"
fi

# Test 3: Format script fixes improperly formatted config
test_start "Format script fixes improperly formatted config"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
model_reasoning_effort = "high"
network_access = true
hide_agent_reasoning = true

[features]
web_search_request = true

[mcp_servers.context7]
command = "pnpx"
args = ["@upstash/context7-mcp@latest"]

[mcp_servers.readability]
command = "pnpx"
args = ["@mizchi/readability@latest", "--mcp"]
EOF

if "$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1; then
    if "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
        test_pass
    else
        test_fail "Format script did not produce properly formatted config"
    fi
else
    test_fail "Format script failed to run"
fi

# Test 4: Format script is idempotent
test_start "Format script is idempotent (running twice produces same result)"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
hide_agent_reasoning = true
model_reasoning_effort = 'high'
network_access = true

[features]
web_search_request = true

[mcp_servers]
[mcp_servers.context7]
args = ['@upstash/context7-mcp@latest']
command = 'pnpx'
EOF

HASH1=$(sha256sum "$CODEX_CONFIG_FILE" | cut -d' ' -f1)
"$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1
HASH2=$(sha256sum "$CODEX_CONFIG_FILE" | cut -d' ' -f1)
"$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1
HASH3=$(sha256sum "$CODEX_CONFIG_FILE" | cut -d' ' -f1)

if [[ "$HASH2" == "$HASH3" ]]; then
    test_pass
else
    test_fail "Format script is not idempotent"
fi

# Test 5: Scripts handle minimal configs
test_start "Scripts handle minimal configs"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
hide_agent_reasoning = true
EOF

if "$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1; then
    if "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
        test_pass
    else
        test_fail "Check script rejected formatted minimal config"
    fi
else
    test_fail "Format script failed on minimal config"
fi

# Test 7: Scripts reject invalid TOML
test_start "Scripts reject invalid TOML (dasel returns empty)"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
this is not valid toml at all
[unclosed section
EOF

if ! "$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1; then
    if ! "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
        test_pass
    else
        test_fail "Check script accepted invalid TOML"
    fi
else
    test_fail "Format script did not reject invalid TOML"
fi

# Test 8: Scripts reject empty files
test_start "Scripts reject empty files"
cleanup_test
setup_test
touch "$CODEX_CONFIG_FILE"  # Create empty file

if ! "$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1; then
    if ! "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
        test_pass
    else
        test_fail "Check script accepted empty file"
    fi
else
    test_fail "Format script did not reject empty file"
fi

# Test 6: Format script preserves semantic content
test_start "Format script preserves semantic content (keys and values)"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
network_access = true
model_reasoning_effort = "high"
hide_agent_reasoning = true

[mcp_servers.context7]
args = ["@upstash/context7-mcp@latest"]
command = "pnpx"

[features]
web_search_request = true
EOF

# Extract semantic content before formatting
BEFORE_JSON=$(cat "$CODEX_CONFIG_FILE" | mise x -- dasel query --root -i toml -o json | jq -S)

"$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1

# Extract semantic content after formatting
AFTER_JSON=$(cat "$CODEX_CONFIG_FILE" | mise x -- dasel query --root -i toml -o json | jq -S)

if [[ "$BEFORE_JSON" == "$AFTER_JSON" ]]; then
    test_pass
else
    test_fail "Format script changed semantic content"
    echo "Before: $BEFORE_JSON"
    echo "After: $AFTER_JSON"
fi

# Summary
echo -e "\n${YELLOW}═══════════════════════════════════════${NC}"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
if [[ $TESTS_FAILED -gt 0 ]]; then
    echo -e "${RED}Failed: $TESTS_FAILED${NC}"
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
    exit 1
else
    echo -e "${YELLOW}═══════════════════════════════════════${NC}"
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
