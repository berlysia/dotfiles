#!/usr/bin/env bash
# Test suite for format-codex-config.sh and check-codex-config.sh
# Usage: ./scripts/test-codex-config-scripts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OXFMT_BIN="${PROJECT_ROOT}/node_modules/.bin/oxfmt"

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
    export OXFMT_BIN
    echo "Test directory: $TEST_DIR"
}

cleanup_test() {
    if [[ -n "${TEST_DIR:-}" ]] && [[ -d "${TEST_DIR:-}" ]]; then
        rm -rf "$TEST_DIR"
    fi
    TEST_DIR=""
    CODEX_CONFIG_FILE=""
}

toml_to_json() { chezmoi execute-template --with-stdin '{{ .chezmoi.stdin | fromToml | toJson }}' | jq -S .; }

# Cleanup on script exit
trap 'cleanup_test' EXIT

# Test 0: Default path resolves to chezmoi source-state location
test_start "Default path resolves home/dot_codex/.config.toml in repo layout"
setup_test
TEMP_REPO="$TEST_DIR/repo"
mkdir -p "$TEMP_REPO/scripts" "$TEMP_REPO/home/dot_codex"
cp "$SCRIPT_DIR/check-codex-config.sh" "$TEMP_REPO/scripts/check-codex-config.sh"
cp "$SCRIPT_DIR/format-codex-config.sh" "$TEMP_REPO/scripts/format-codex-config.sh"
chmod +x "$TEMP_REPO/scripts/check-codex-config.sh" "$TEMP_REPO/scripts/format-codex-config.sh"
unset CODEX_CONFIG_FILE
cat > "$TEMP_REPO/home/dot_codex/.config.toml" << 'EOF'
hide_agent_reasoning = true
model_reasoning_effort = 'high'
network_access = true
EOF

DEFAULT_PATH_OUTPUT=$("$TEMP_REPO/scripts/check-codex-config.sh" 2>&1 || true)
if printf '%s' "$DEFAULT_PATH_OUTPUT" | grep -q "Config is properly formatted"; then
    test_pass
else
    test_fail "Check script did not read default home/dot_codex/.config.toml"
fi

cleanup_test

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
hide_agent_reasoning=true
[mcp_servers.context7]
  command =   'pnpx'
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
hide_agent_reasoning=true
[mcp_servers.context7]
  command =   'pnpx'
EOF
EXPECTED_FORMATTED=$'hide_agent_reasoning = true\n[mcp_servers.context7]\ncommand = \'pnpx\'\n'

if "$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1; then
    if "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then
        if [[ "$(cat "$CODEX_CONFIG_FILE")" == "${EXPECTED_FORMATTED%$'\n'}" ]]; then
            test_pass
        else
            test_fail "Formatted content differs from expected: $(cat "$CODEX_CONFIG_FILE")"
        fi
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
test_start "Scripts reject invalid TOML"
cleanup_test
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
this is not valid toml at all
[unclosed section
EOF

if FORMAT_ERR=$("$SCRIPT_DIR/format-codex-config.sh" 2>&1 >/dev/null); then
    test_fail "Format script did not reject invalid TOML"
elif CHECK_ERR=$("$SCRIPT_DIR/check-codex-config.sh" 2>&1 >/dev/null); then
    test_fail "Check script accepted invalid TOML"
elif [[ "$FORMAT_ERR" != *"Failed to parse TOML"* ]] || [[ "$CHECK_ERR" != *"Failed to parse TOML"* ]]; then
    test_fail "Parse failure was not reported: format=[$FORMAT_ERR] check=[$CHECK_ERR]"
else
    test_pass
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
BEFORE_JSON=$(toml_to_json < "$CODEX_CONFIG_FILE")

"$SCRIPT_DIR/format-codex-config.sh" >/dev/null 2>&1

# Extract semantic content after formatting
AFTER_JSON=$(toml_to_json < "$CODEX_CONFIG_FILE")

if [[ "$BEFORE_JSON" == "$AFTER_JSON" ]]; then
    test_pass
else
    test_fail "Format script changed semantic content"
    echo "Before: $BEFORE_JSON"
    echo "After: $AFTER_JSON"
fi

test_start "Check script does not require sorted keys or single quotes (spec R6)"
setup_test
cat > "$CODEX_CONFIG_FILE" << 'EOF'
network_access = true
hide_agent_reasoning = "yes"
EOF
if "$SCRIPT_DIR/check-codex-config.sh" >/dev/null 2>&1; then test_pass; else test_fail "Check script rejected unsorted keys"; fi
cleanup_test

# Needs a chezmoi outside /usr/bin and /bin (the macOS host and CI install it under ~/.local/bin). Where it
# lives there, PATH cannot hide it, so the case is reported as skipped and counted neither way.
CHEZMOI_PATH=$(command -v chezmoi || true)
if [[ "$CHEZMOI_PATH" == /usr/bin/* || "$CHEZMOI_PATH" == /bin/* ]]; then
    echo -e "${YELLOW}⏭️ Skipped: chezmoi is in ${CHEZMOI_PATH%/*}, which PATH cannot hide${NC}"
else
    test_start "Scripts stop with install guidance when chezmoi is missing"
    setup_test
    printf 'network_access = true\n' > "$CODEX_CONFIG_FILE"
    MISSING_OK=1
    for script in check-codex-config.sh format-codex-config.sh; do
        if ERR=$(PATH=/usr/bin:/bin "$SCRIPT_DIR/$script" 2>&1 >/dev/null); then
            MISSING_OK=0; echo "$script ran without chezmoi"
        elif [[ "$ERR" != *chezmoi* ]]; then
            MISSING_OK=0; echo "$script error does not name chezmoi: $ERR"
        fi
    done
    if [[ "$MISSING_OK" == 1 ]]; then test_pass; else test_fail "Missing chezmoi was not reported by both scripts"; fi
    cleanup_test
fi

# Test C1: check script default mode validates base + all overlays
test_start "C1: default mode checks every .config.*.toml overlay alongside base"
setup_test
TEMP_REPO="$TEST_DIR/repo"
mkdir -p "$TEMP_REPO/scripts" "$TEMP_REPO/home/dot_codex"
cp "$SCRIPT_DIR/check-codex-config.sh" "$TEMP_REPO/scripts/check-codex-config.sh"
cp "$SCRIPT_DIR/format-codex-config.sh" "$TEMP_REPO/scripts/format-codex-config.sh"
chmod +x "$TEMP_REPO/scripts/check-codex-config.sh" "$TEMP_REPO/scripts/format-codex-config.sh"
unset CODEX_CONFIG_FILE
cat > "$TEMP_REPO/home/dot_codex/.config.toml" << 'EOF'
hide_agent_reasoning = true
network_access = true
EOF
cat > "$TEMP_REPO/home/dot_codex/.config.TESTHOST.toml" << 'EOF'
[mcp_servers.playwright.tools.browser_navigate]
approval_mode="approve"
EOF

if ! "$TEMP_REPO/scripts/check-codex-config.sh" >/dev/null 2>&1; then
    CODEX_CONFIG_FILE="$TEMP_REPO/home/dot_codex/.config.TESTHOST.toml" "$TEMP_REPO/scripts/format-codex-config.sh" >/dev/null 2>&1
    if "$TEMP_REPO/scripts/check-codex-config.sh" >/dev/null 2>&1; then
        test_pass
    else
        test_fail "Check script still failing after overlay was canonicalized"
    fi
else
    test_fail "Check script default mode did not detect non-canonical overlay"
fi
cleanup_test

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
