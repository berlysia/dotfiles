#!/usr/bin/env bash
# Tests for home/dot_local/bin/executable_ask-grokbot.
# Fixtures live under mktemp. The real home directory and webhook are not used.
# Usage: run.sh
# The command under test runs on $BASH, so CI's /bin/bash (3.2 on macOS) is the interpreter.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/home/dot_local/bin/executable_ask-grokbot"
TMP_BASE=$(cd -P "$(mktemp -d -t ask-grokbot-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT

HOME_DIR="$TMP_BASE/home"
STUB_DIR="$TMP_BASE/bin"
STUB_LOG="$TMP_BASE/curl.log"
STUB_BODY="$TMP_BASE/curl.body"
WORK="$TMP_BASE/work"
ERR="$TMP_BASE/stderr"
ORIG_PATH=$PATH
mkdir -p "$HOME_DIR" "$STUB_DIR" "$WORK"

cat >"$STUB_DIR/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" >> "$STUB_LOG"
cat > "$STUB_BODY"
if [ "${STUB_EXIT:-0}" -eq 0 ] && [ -n "${STUB_REPLY:-}" ]; then
  reply=$(jq -r '.reply_to' "$STUB_BODY")
  mkdir -p "$(dirname "$reply")"
  printf '%s\n' "$STUB_REPLY" > "$reply"
fi
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$STUB_DIR/curl"

export HOME="$HOME_DIR" PATH="$STUB_DIR:$ORIG_PATH" STUB_LOG STUB_BODY STUB_EXIT
unset ASK_GROKBOT_WEBHOOK_URL ASK_GROKBOT_AUTH ASK_GROKBOT_MACHINE ASK_GROKBOT_AGENT \
    CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID STUB_REPLY || true
STUB_EXIT=0

FAILED=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }

reset_case() {
    unset ASK_GROKBOT_WEBHOOK_URL ASK_GROKBOT_AUTH ASK_GROKBOT_MACHINE ASK_GROKBOT_AGENT \
        CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID STUB_REPLY RUN_CWD RUN_STDIN || true
    STUB_EXIT=0
    export STUB_EXIT
    : >"$STUB_LOG"
    : >"$STUB_BODY"
    rm -rf "$HOME_DIR/.ask-grokbot" "$HOME_DIR/.config"
    mkdir -p "$HOME_DIR"
}

# run_ask [args...]: stdin is /dev/null unless RUN_STDIN is set (exact bytes).
# RUN_CWD, when set, is the working directory of the command.
run_ask() {
    local dir=${RUN_CWD:-$PWD}
    export STUB_EXIT
    if [[ -n ${STUB_REPLY+x} ]]; then
        export STUB_REPLY
    fi
    RC=0
    if [[ -n ${RUN_STDIN+x} ]]; then
        OUT=$(cd "$dir" && printf '%s' "$RUN_STDIN" | "$BASH" "$SCRIPT" "$@" 2>"$ERR") || RC=$?
    else
        OUT=$(cd "$dir" && "$BASH" "$SCRIPT" "$@" </dev/null 2>"$ERR") || RC=$?
    fi
    ERR_TEXT=$(cat "$ERR")
}

assert_eq() {
    if [[ $1 == "$2" ]]; then pass "$3"; else fail "$3 (expected: $1 / actual: $2)"; fi
}
assert_rc() {
    if [[ $RC -eq $1 ]]; then pass "$2"; else fail "$2 (exit $RC, stderr: $ERR_TEXT)"; fi
}
json_get() { jq -r "$1" <<<"$OUT" 2>/dev/null || printf '%s' 'INVALID'; }

# ---- dry-run payload -------------------------------------------------------

test_dry_run_payload() {
    reset_case
    local req reply
    req=$'say "hi"\n$(not-run)\n`id`\n\\path'
    export CLAUDE_SESSION_ID=sess-old CLAUDE_CODE_SESSION_ID=sess-new
    export ASK_GROKBOT_MACHINE=win-box ASK_GROKBOT_AGENT=codex
    export ASK_GROKBOT_WEBHOOK_URL=https://secret.example/hook ASK_GROKBOT_AUTH='Bearer secret'
    RUN_CWD=$WORK run_ask -t reviewer --dry-run "$req"
    assert_rc 0 "dry-run exits 0"
    if [[ ! -s $STUB_LOG ]]; then pass "dry-run does not call curl"; else fail "dry-run called curl"; fi
    if [[ ! -e $HOME_DIR/.ask-grokbot ]]; then pass "dry-run does not create the inbox"; else fail "dry-run created the inbox"; fi
    assert_eq "win-box" "$(json_get .machine)" "machine override"
    assert_eq "codex" "$(json_get .agent)" "agent override"
    assert_eq "$WORK" "$(json_get .cwd)" "cwd is the working directory"
    assert_eq "sess-new" "$(json_get .session)" "CLAUDE_CODE_SESSION_ID wins"
    assert_eq "$req" "$(json_get .request)" "request keeps quotes, newlines, and substitutions"
    assert_eq "reviewer" "$(json_get .to)" "to is the handler name"
    reply=$(json_get .reply_to)
    case $reply in
        "$HOME_DIR"/.ask-grokbot/inbox/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*.md)
            pass "reply_to is an absolute inbox path"
            ;;
        *) fail "reply_to pattern ($reply)" ;;
    esac
    case $OUT in
        *secret.example* | *Bearer\ secret*) fail "dry-run payload contains credentials" ;;
        *) pass "dry-run payload omits credentials" ;;
    esac
    assert_eq "7" "$(jq 'keys | length' <<<"$OUT")" "payload has the seven fields"
}

test_omits_to_without_handler() {
    reset_case
    run_ask --dry-run "plain"
    assert_rc 0 "dry-run without -t exits 0"
    assert_eq "false" "$(jq 'has("to")' <<<"$OUT")" "to is omitted without -t"
    assert_eq "claude-code" "$(json_get .agent)" "agent defaults to claude-code"
    assert_eq "" "$(json_get .session)" "session is empty when no session id is set"
    assert_eq "$(hostname)" "$(json_get .machine)" "machine defaults to hostname"
}

test_session_falls_back() {
    reset_case
    CLAUDE_SESSION_ID=only-old run_ask --dry-run "x"
    assert_eq "only-old" "$(json_get .session)" "session falls back to CLAUDE_SESSION_ID"
}

test_stdin_request() {
    reset_case
    local req
    req=$'line1\nline2\n'
    RUN_STDIN=$req run_ask --dry-run
    unset RUN_STDIN || true
    assert_rc 0 "stdin dry-run exits 0"
    if jq -e --arg req "$req" '.request == $req' <<<"$OUT" >/dev/null; then
        pass "stdin keeps internal and trailing newlines"
    else
        fail "stdin request was changed"
    fi
}

test_env_file_fills_machine_only_when_unset() {
    reset_case
    mkdir -p "$HOME_DIR/.config/ask-grokbot"
    printf '%s\r\n' \
        '# local' \
        'export ASK_GROKBOT_WEBHOOK_URL=https://from-file.example/hook' \
        'ASK_GROKBOT_AUTH="Bearer from-file"' \
        'ASK_GROKBOT_MACHINE=from-file' \
        >"$HOME_DIR/.config/ask-grokbot/env"
    ASK_GROKBOT_MACHINE=from-env run_ask --dry-run "x"
    assert_eq "from-env" "$(json_get .machine)" "environment wins over the env file"
    case $OUT in
        *from-file.example* | *from-file*) fail "env file secrets leaked into dry-run ($OUT)" ;;
        *) pass "env file credentials stay out of the payload" ;;
    esac
    # machine in the file is "from-file", which also appears in the negative case above
    # only when it was selected. Re-run without the override.
    unset ASK_GROKBOT_MACHINE
    run_ask --dry-run "x"
    assert_eq "from-file" "$(json_get .machine)" "env file supplies machine when unset"
}

# ---- send ------------------------------------------------------------------

arm_secrets() {
    ASK_GROKBOT_WEBHOOK_URL=https://hooks.example.test/in
    ASK_GROKBOT_AUTH='Bearer raw-token'
    export ASK_GROKBOT_WEBHOOK_URL ASK_GROKBOT_AUTH
}

test_post_prints_reply_path_and_headers() {
    reset_case
    arm_secrets
    RUN_CWD=$WORK run_ask "please look"
    assert_rc 0 "POST exits 0"
    case $OUT in
        "$HOME_DIR"/.ask-grokbot/inbox/*.md) pass "stdout is the reply path" ;;
        *) fail "stdout is not the reply path ($OUT)" ;;
    esac
    if [[ -d $HOME_DIR/.ask-grokbot/inbox && ! -e $OUT ]]; then
        pass "inbox dir exists and the reply file is not created locally"
    else
        fail "inbox setup (dir or file)"
    fi
    mode=$(stat -c %a "$HOME_DIR/.ask-grokbot/inbox" 2>/dev/null || stat -f %OLp "$HOME_DIR/.ask-grokbot/inbox")
    assert_eq "700" "$mode" "inbox directory is mode 700"
    if grep -Fxq -- '-fsS' "$STUB_LOG"; then pass "curl is invoked with -fsS"; else fail "curl args missing -fsS"; fi
    if grep -Fxq -- 'Authorization: Bearer raw-token' "$STUB_LOG"; then pass "Authorization value is sent unchanged"; else fail "Authorization header"; fi
    if grep -Fxq -- 'Content-Type: application/json' "$STUB_LOG"; then pass "JSON content type"; else fail "content type"; fi
    if grep -Fxq -- 'https://hooks.example.test/in' "$STUB_LOG"; then pass "webhook URL is the curl URL"; else fail "webhook URL"; fi
    assert_eq "$OUT" "$(jq -r .reply_to "$STUB_BODY")" "posted reply_to matches stdout"
    assert_eq "$WORK" "$(jq -r .cwd "$STUB_BODY")" "posted cwd"
    assert_eq "false" "$(jq 'has("to")' "$STUB_BODY")" "posted JSON omits to"
}

test_post_includes_to() {
    reset_case
    arm_secrets
    run_ask -t pal "please look"
    assert_rc 0 "POST with -t exits 0"
    assert_eq "pal" "$(jq -r .to "$STUB_BODY")" "posted to"
}

test_env_file_supplies_credentials() {
    reset_case
    mkdir -p "$HOME_DIR/.config/ask-grokbot"
    printf '%s\n' \
        'ASK_GROKBOT_WEBHOOK_URL=https://hooks.example.test/from-file' \
        "ASK_GROKBOT_AUTH='Token abc'" \
        >"$HOME_DIR/.config/ask-grokbot/env"
    run_ask "from file"
    assert_rc 0 "POST with env file exits 0"
    if grep -Fxq -- 'https://hooks.example.test/from-file' "$STUB_LOG"; then pass "URL came from the env file"; else fail "URL from file"; fi
    if grep -Fxq -- 'Authorization: Token abc' "$STUB_LOG"; then
        pass "auth quotes are stripped"
    else
        fail "auth from file"
    fi
}

test_missing_secrets() {
    reset_case
    run_ask "hello"
    assert_rc 1 "missing secrets exit 1"
    case $ERR_TEXT in
        *ASK_GROKBOT_WEBHOOK_URL*ASK_GROKBOT_AUTH*"$HOME_DIR/.config/ask-grokbot/env"*)
            pass "missing secrets name the variables and the env file"
            ;;
        *) fail "missing-secrets message ($ERR_TEXT)" ;;
    esac
    if [[ ! -s $STUB_LOG ]]; then pass "missing secrets do not call curl"; else fail "curl was called without secrets"; fi
}

test_rejects_non_http_url() {
    reset_case
    ASK_GROKBOT_WEBHOOK_URL=file:///tmp/hook ASK_GROKBOT_AUTH=token run_ask "hello"
    assert_rc 1 "non-http URL exits 1"
    case $ERR_TEXT in
        *http://\ or\ https://*) pass "non-http URL is rejected" ;;
        *) fail "non-http message ($ERR_TEXT)" ;;
    esac
}

test_curl_failure_does_not_print_the_path() {
    reset_case
    arm_secrets
    STUB_EXIT=22 run_ask "hello"
    assert_eq "22" "$RC" "curl failure is the curl exit code"
    assert_eq "" "$OUT" "curl failure prints no reply path"
}

test_wait_prints_reply() {
    reset_case
    arm_secrets
    STUB_REPLY='the answer' run_ask --wait 5 "please look"
    assert_rc 0 "wait exits 0"
    local path body
    path=${OUT%%$'\n'*}
    body=${OUT#*$'\n'}
    case $path in
        "$HOME_DIR"/.ask-grokbot/inbox/*.md) pass "wait still prints the reply path first" ;;
        *) fail "wait path ($path)" ;;
    esac
    assert_eq "the answer" "$body" "wait prints the reply file"
}

test_wait_timeout() {
    reset_case
    arm_secrets
    run_ask --wait 1 "please look"
    assert_rc 1 "wait timeout exits 1"
    case $ERR_TEXT in
        *no\ reply\ at\ *) pass "wait timeout names the reply path" ;;
        *) fail "wait timeout message ($ERR_TEXT)" ;;
    esac
}

test_help_and_usage_errors() {
    reset_case
    run_ask --help
    assert_rc 0 "help exits 0"
    case $OUT in
        *ASK_GROKBOT_WEBHOOK_URL*) pass "help names the webhook variable" ;;
        *) fail "help text" ;;
    esac
    run_ask
    assert_rc 1 "no request and empty stdin exits 1"
    run_ask -t
    assert_rc 1 "-t without a name exits 1"
    run_ask --wait=nope "x"
    assert_rc 1 "non-numeric --wait exits 1"
    RUN_STDIN='' run_ask --dry-run
    unset RUN_STDIN
    assert_rc 1 "empty stdin is an empty request"
}

test_dry_run_payload
test_omits_to_without_handler
test_session_falls_back
test_stdin_request
test_env_file_fills_machine_only_when_unset
test_post_prints_reply_path_and_headers
test_post_includes_to
test_env_file_supplies_credentials
test_missing_secrets
test_rejects_non_http_url
test_curl_failure_does_not_print_the_path
test_wait_prints_reply
test_wait_timeout
test_help_and_usage_errors

if [[ $FAILED -eq 0 ]]; then
    printf 'ok\n'
else
    printf '%d failed\n' "$FAILED" >&2
    exit 1
fi
