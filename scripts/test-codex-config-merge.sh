#!/usr/bin/env bash
# Tests for home/dot_codex/modify_private_config.toml. Each case runs the modify template through the real chezmoi
# against a throwaway source and destination, so the merge rules are exercised exactly as `chezmoi apply` runs them.
# Usage: ./scripts/test-codex-config-merge.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$PROJECT_ROOT/home/dot_codex/modify_private_config.toml"
for tool in chezmoi jq; do
    command -v "$tool" >/dev/null 2>&1 || { echo "❌ $tool is required" >&2; exit 1; }
done
# The overlay is picked by the machine's hostname, so the cases name their overlay after this machine.
HOST_NAME=$(chezmoi execute-template '{{ .chezmoi.hostname }}')
PASSED=0
FAILED=0
CASE=""
trap '[[ -z "$CASE" ]] || rm -rf "$CASE"' EXIT

pass() { echo "✅ PASS: $1"; PASSED=$((PASSED + 1)); }
fail_case() { echo "❌ FAIL: $1" >&2; FAILED=$((FAILED + 1)); }
new_case() {
    [[ -z "$CASE" ]] || rm -rf "$CASE"
    CASE=$(mktemp -d)
    mkdir -p "$CASE/src/dot_codex" "$CASE/dst/.codex"
    : >"$CASE/chezmoi.toml"
    cp "$TEMPLATE" "$CASE/src/dot_codex/modify_private_config.toml"
}
cz() { chezmoi --source "$CASE/src" --destination "$CASE/dst" --config "$CASE/chezmoi.toml" --persistent-state "$CASE/state.boltdb" "$@"; }
base() { cat >"$CASE/src/dot_codex/.config.toml"; }
overlay() { cat >"$CASE/src/dot_codex/.config.$HOST_NAME.toml"; }
current() { cat >"$CASE/dst/.codex/config.toml"; }
merged() { cz cat "$CASE/dst/.codex/config.toml"; }
to_json() { chezmoi execute-template --with-stdin '{{ .chezmoi.stdin | fromToml | toJson }}'; }
expect() { # label, jq filter over the merged config that must print true
    local json
    json=$(merged | to_json) || json='{}'
    if [[ "$(jq "$2" <<<"$json")" == true ]]; then pass "$1"; else fail_case "$1 (got: $json)"; fi
}
expect_refusal() { # label, text the error must contain
    local err
    if err=$(merged 2>&1 >/dev/null); then fail_case "$1 (merge succeeded)"; return; fi
    if [[ "$err" == *"$2"* ]]; then pass "$1"; else fail_case "$1 (stderr: $err)"; fi
}

new_case
base <<'EOF'
approval_policy = 'on-request'
model_reasoning_effort = 'high'
network_access = false

[mcp_servers]
list_key = ['a']

[mcp_servers.playwright]
args = ['base-arg']
command = 'npx'
EOF
overlay <<'EOF'
network_access = true

[mcp_servers]
list_key = ['b']

[mcp_servers.playwright.tools.browser_navigate]
approval_mode = 'approve'
EOF
current <<'EOF'
model_reasoning_effort = 'low'
user_key = 'keep'
EOF
expect "M1: overlay deep-merges into base, arrays and scalars are overlay-wins, the current file wins for other keys" \
    '.mcp_servers.playwright.args == ["base-arg"] and .mcp_servers.playwright.tools.browser_navigate.approval_mode == "approve"
     and .mcp_servers.list_key == ["b"] and .network_access == true and .user_key == "keep" and .model_reasoning_effort == "low"
     and .approval_policy == "on-request"'

new_case
base <<'EOF'
network_access = true
sandbox_mode = 'workspace-write'

[mcp_servers.context7]
command = 'npx'
EOF
current <<'EOF'
allow_login_shell = true
approval_policy = 'never'
network_access = false
sandbox_mode = 'danger-full-access'

[features]
x = true

[mcp_servers.evil]
command = 'x'

[sandbox_workspace_write]
network_access = true

[shell_environment_policy]
inherit = 'all'
EOF
expect "M2: forced keys come only from the template; absent forced and deprecated keys are dropped" \
    '.sandbox_mode == "workspace-write" and .network_access == true and (has("approval_policy") | not)
     and (has("allow_login_shell") | not) and (has("sandbox_workspace_write") | not) and (has("shell_environment_policy") | not)
     and (.mcp_servers | keys) == ["context7"] and (has("features") | not)'

new_case
base <<'EOF'
sandbox_mode = 'workspace-write'
EOF
current <<'EOF'
big = 9007199254740993

[model_providers.azure]
env_http_headers = { "X-Foo" = "FOO" }
name = 'Azure'

[profiles.fast]
model = 'o4-mini'

[projects."/tmp/a.b"]
trust_level = 'trusted'
EOF
expect "M3: projects, model_providers and profiles survive as TOML values" \
    '.projects["/tmp/a.b"].trust_level == "trusted" and .model_providers.azure.env_http_headers["X-Foo"] == "FOO"
     and .model_providers.azure.name == "Azure" and .profiles.fast.model == "o4-mini"'
out=$(merged) # captured first: grep -q exiting early would make the pipeline fail under pipefail
if grep -qx 'big = 9007199254740993' <<<"$out"; then pass "M3b: a 64-bit integer keeps every digit"; else fail_case "M3b: a 64-bit integer keeps every digit"; fi

new_case
base <<'EOF'
sandbox_mode = 'workspace-write'

[sandbox_workspace_write]
writable_roots = ['__CHEZMOI_HOME__/.cache/mise']
EOF
overlay <<'EOF'
[mcp_servers.playwright.tools.browser_tabs]
approval_mode = 'approve'
EOF
rm -f "$CASE/dst/.codex/config.toml"
expect "M4: an absent current file composes base + overlay and replaces __CHEZMOI_HOME__" \
    ".mcp_servers.playwright.tools.browser_tabs.approval_mode == \"approve\" and .sandbox_workspace_write.writable_roots == [\"$HOME/.cache/mise\"]"
cz apply --force
if [[ "$(ls -l "$CASE/dst/.codex/config.toml" | cut -c1-10)" == "-rw-------" ]]; then pass "M4b: a created file is private (0600)"; else fail_case "M4b: a created file is private (0600)"; fi
chmod 644 "$CASE/dst/.codex/config.toml"
cz apply --force
if [[ "$(ls -l "$CASE/dst/.codex/config.toml" | cut -c1-10)" == "-rw-------" ]]; then pass "M4c: an existing 0644 file becomes private (0600)"; else fail_case "M4c: an existing 0644 file becomes private (0600)"; fi

new_case
base <<'EOF'
network_access = true
EOF
printf 'this is not toml\n[unclosed\n' | current
before=$(cat "$CASE/dst/.codex/config.toml")
expect_refusal "M5: an unreadable current file stops the merge" "toml:"
cz apply --force >/dev/null 2>&1 || true
if [[ "$(cat "$CASE/dst/.codex/config.toml")" == "$before" ]]; then pass "M5b: the unreadable file is left as it was"; else fail_case "M5b: the unreadable file is left as it was"; fi

new_case
printf '[unclosed\n' | base
expect_refusal "M6a: an unreadable base stops the merge" "toml:"
new_case
printf '# only a comment\n' | base
expect_refusal "M6b: a base with no keys stops the merge" "has no keys"
new_case
printf 'network_access = true\n' | base
printf '# only a comment\n' | overlay
expect_refusal "M6c: an overlay with no keys stops the merge" "has no keys"
new_case
printf 'network_access = true\n' | base
printf "user_key = 'oops'\n" | overlay
expect_refusal "M6d: an overlay with a non-forced key stops the merge and names it" "user_key"
new_case
printf 'network_access = true\n' | base
printf "[projects.\"/tmp/x\"]\ntrust_level = 'trusted'\n" | overlay
expect_refusal "M6e: an overlay cannot set projects" "projects"

new_case
base <<'EOF'
network_access = true

[mcp_servers.context7]
args = ['-y', 'x']
command = 'npx'
EOF
current <<'EOF'
user_key = 'keep'

[projects."/tmp/p"]
trust_level = 'trusted'
EOF
first=$(merged)
printf '%s\n' "$first" | current
if [[ "$(merged)" == "$first" ]]; then pass "M7: merging its own output changes nothing"; else fail_case "M7: merging its own output changes nothing"; fi

new_case
base <<'EOF'
network_access = true

[model_providers.x]
name = 'X'
EOF
printf "user_key = 'keep'\n" | current
expect "M8: model_providers in base is emitted as a default (the one rule change from the old merge)" \
    '.model_providers.x.name == "X" and .user_key == "keep"'

# Known limitation (spec R7): chezmoi's TOML round trip shifts dates and times without a time zone by the process
# time zone. This case pins that behavior so a chezmoi upgrade that fixes it shows up here (then update R7 and docs).
new_case
printf 'network_access = true\n' | base
printf 'ld = 2024-01-02\nodt = 2024-01-02T03:04:05Z\n' | current
out=$(TZ=Asia/Tokyo merged)
if grep -qx 'ld = 2024-01-01' <<<"$out" && grep -qx 'odt = 2024-01-02T03:04:05Z' <<<"$out"; then
    pass "M9: a local date shifts by the time zone (R7) while an offset datetime is kept"
else
    fail_case "M9: local-date behavior changed; revisit spec R7 and docs/codex-config.md (got: $out)"
fi

echo "Passed: $PASSED, Failed: $FAILED"
[[ "$FAILED" -eq 0 ]]
