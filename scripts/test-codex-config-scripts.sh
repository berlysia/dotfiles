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

# ─────────────────────────────────────────────
# merge-config.ts tests (M1-M6)
# ─────────────────────────────────────────────

MERGE_SCRIPT="${PROJECT_ROOT}/home/dot_codex/private_dot_merge-config.ts"
FIXTURE_DIR="${PROJECT_ROOT}/scripts/fixtures/codex-merge"

run_merge() {
    bun run "$MERGE_SCRIPT" "$@"
}

toml_to_json() {
    mise x -- dasel query --root -i toml -o json
}

# Test M1: three-layer composition (base + overlay + user-preserve)
test_start "M1: overlay deep-merges into base, user keys preserved, arrays overlay-win"
setup_test
cat > "$TEST_DIR/target.toml" << 'EOF'
user_key = 'keep'
EOF
cat > "$TEST_DIR/base.toml" << 'EOF'
[mcp_servers]
list_key = ['a']

[mcp_servers.playwright]
args = ['base-arg']
command = 'npx'
EOF
cat > "$TEST_DIR/overlay.toml" << 'EOF'
[mcp_servers]
list_key = ['b']

[mcp_servers.playwright]
[mcp_servers.playwright.tools]
[mcp_servers.playwright.tools.browser_navigate]
approval_mode = 'approve'
EOF

M1_JSON=$(run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" "$TEST_DIR/overlay.toml" 2>/dev/null | toml_to_json || true)
if [[ "$(printf '%s' "$M1_JSON" | jq -r '.mcp_servers.playwright.args[0]')" == "base-arg" ]] \
    && [[ "$(printf '%s' "$M1_JSON" | jq -r '.mcp_servers.playwright.tools.browser_navigate.approval_mode')" == "approve" ]] \
    && [[ "$(printf '%s' "$M1_JSON" | jq -r '.user_key')" == "keep" ]] \
    && [[ "$(printf '%s' "$M1_JSON" | jq -c '.mcp_servers.list_key')" == '["b"]' ]]; then
    test_pass
else
    test_fail "Three-layer composition produced unexpected output: $M1_JSON"
fi
cleanup_test

# Test M2: backward compatibility against committed golden (2-arg invocation)
test_start "M2: two-arg output is byte-identical to committed golden fixture"
setup_test
M2_OUT="$TEST_DIR/m2-output.toml"
if run_merge "$FIXTURE_DIR/target.toml" "$FIXTURE_DIR/base.toml" > "$M2_OUT" 2>/dev/null \
    && diff -q "$M2_OUT" "$FIXTURE_DIR/golden.toml" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Two-arg output differs from committed golden"
    diff -u "$FIXTURE_DIR/golden.toml" "$M2_OUT" | head -20 || true
fi
cleanup_test

# Test M3: absent target composes base + overlay with exit 0
test_start "M3: absent target -> exit 0 with base + overlay composition"
setup_test
cat > "$TEST_DIR/base.toml" << 'EOF'
[mcp_servers]
[mcp_servers.playwright]
args = ['base-arg']
command = 'npx'
EOF
cat > "$TEST_DIR/overlay.toml" << 'EOF'
[mcp_servers]
[mcp_servers.playwright]
[mcp_servers.playwright.tools]
[mcp_servers.playwright.tools.browser_navigate]
approval_mode = 'approve'
EOF

if M3_OUT=$(run_merge "$TEST_DIR/does-not-exist.toml" "$TEST_DIR/base.toml" "$TEST_DIR/overlay.toml" 2>/dev/null) \
    && printf '%s' "$M3_OUT" | grep -q "approval_mode = 'approve'"; then
    test_pass
else
    test_fail "Absent target did not produce composed output with exit 0"
fi
cleanup_test

# Test M4a: invalid overlay TOML is fatal
test_start "M4a: invalid overlay TOML -> non-zero exit"
setup_test
cat > "$TEST_DIR/target.toml" << 'EOF'
user_key = 'keep'
EOF
cat > "$TEST_DIR/base.toml" << 'EOF'
network_access = true
EOF
cat > "$TEST_DIR/overlay.toml" << 'EOF'
[unclosed
EOF

if ! run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" "$TEST_DIR/overlay.toml" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Invalid overlay TOML was not fatal"
fi
cleanup_test

# Test M4b: invalid template TOML is fatal (closes the FORCED-wipe path)
test_start "M4b: invalid template TOML -> non-zero exit"
setup_test
cat > "$TEST_DIR/target.toml" << 'EOF'
user_key = 'keep'
EOF
cat > "$TEST_DIR/base.toml" << 'EOF'
[unclosed
EOF

if ! run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Invalid template TOML was not fatal"
fi
cleanup_test

# Test M5: corrupt target keeps existing silent-{} behavior (template adopted, exit 0)
test_start "M5: corrupt target -> exit 0 with template adopted (intentional silent fallback)"
setup_test
cat > "$TEST_DIR/target.toml" << 'EOF'
this is not valid toml at all
[unclosed section
EOF
cat > "$TEST_DIR/base.toml" << 'EOF'
network_access = true
EOF

if M5_OUT=$(run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" 2>/dev/null) \
    && printf '%s' "$M5_OUT" | grep -q 'network_access = true'; then
    test_pass
else
    test_fail "Corrupt target did not fall back to template with exit 0"
fi
cleanup_test

# Test M6: overlay with non-FORCED top-level key is fatal
test_start "M6: overlay with non-FORCED top-level keys -> non-zero exit"
setup_test
cat > "$TEST_DIR/target.toml" << 'EOF'
user_key = 'keep'
EOF
cat > "$TEST_DIR/base.toml" << 'EOF'
network_access = true
EOF
cat > "$TEST_DIR/overlay-verbatim.toml" << 'EOF'
[projects."/tmp/x"]
trust_level = 'trusted'
EOF
cat > "$TEST_DIR/overlay-user.toml" << 'EOF'
user_key = 'oops'
EOF

if ! run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" "$TEST_DIR/overlay-verbatim.toml" >/dev/null 2>&1 \
    && ! run_merge "$TEST_DIR/target.toml" "$TEST_DIR/base.toml" "$TEST_DIR/overlay-user.toml" >/dev/null 2>&1; then
    test_pass
else
    test_fail "Overlay with non-FORCED top-level key was not rejected"
fi
cleanup_test

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
approval_mode = "approve"
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
