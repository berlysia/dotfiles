#!/usr/bin/env bash
# Tests for the global textlint runtime: the staleness warning of
# home/dot_local/bin/executable_textlint-global and the state files written by
# home/.chezmoiscripts/run_after_10-install-textlint-deps.sh.tmpl.
# Everything runs in a mktemp dir: the wrapper gets TEXTLINT_HOME pointed there
# with a stub textlint binary, the install script gets CHEZMOI_TEXTLINT_INSTALL_DIR
# pointed there with a stub bun, and mise is kept off PATH so `mise env` cannot
# hide the stub. HOME is never changed.
# Usage: run.sh
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
WRAPPER="$REPO_ROOT/home/dot_local/bin/executable_textlint-global"
INSTALL_TMPL="$REPO_ROOT/home/.chezmoiscripts/run_after_10-install-textlint-deps.sh.tmpl"
TMP_BASE=$(cd -P "$(mktemp -d -t textlint-global-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT

FAILED=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILED=$((FAILED + 1)); }
check() { # check <label> <condition: 0 = ok>
  if [[ "$2" == 0 ]]; then pass "$1"; else fail "$1"; fi
}

# ---- wrapper -------------------------------------------------------------------------------------
CASE_N=0
HOME_DIR=""
new_home() {
  CASE_N=$((CASE_N + 1))
  HOME_DIR="$TMP_BASE/w$CASE_N"
  mkdir -p "$HOME_DIR/node_modules/.bin"
  printf '#!/bin/sh\necho stub-textlint-ran\n' >"$HOME_DIR/node_modules/.bin/textlint"
  chmod +x "$HOME_DIR/node_modules/.bin/textlint"
  printf '{"name":"x"}\n' >"$HOME_DIR/package.json"
  printf 'lock-v1\n' >"$HOME_DIR/bun.lock"
}

# run_wrapper: sets WOUT / WERR / WRC
run_wrapper() {
  WRC=0
  WOUT=$(TEXTLINT_HOME="$HOME_DIR" bash "$WRAPPER" some.md 2>"$HOME_DIR/stderr" </dev/null) || WRC=$?
  WERR=$(cat "$HOME_DIR/stderr")
}

# expect_warning <label> <yes|no>
expect_warning() {
  local has=1
  case "$WERR" in *"older than its package.json / bun.lock"*) has=0 ;; esac
  if [[ "$2" == yes ]]; then check "$1: warns" "$has"; else check "$1: no warning" "$((has == 0 ? 1 : 0))"; fi
  check "$1: textlint still runs" "$([[ "$WOUT" == *stub-textlint-ran* && "$WRC" == 0 ]] && echo 0 || echo 1)"
}

test_wrapper_state_matches() {
  new_home
  cp "$HOME_DIR/package.json" "$HOME_DIR/.install-state"
  cp "$HOME_DIR/bun.lock" "$HOME_DIR/.install-state.lock"
  run_wrapper
  expect_warning "wrapper: both state files match" no
}

test_wrapper_old_format_state() {
  new_home
  cp "$HOME_DIR/package.json" "$HOME_DIR/.install-state"
  run_wrapper
  expect_warning "wrapper: .install-state only (no .install-state.lock)" yes
}

test_wrapper_package_json_differs() {
  new_home
  cp "$HOME_DIR/package.json" "$HOME_DIR/.install-state"
  cp "$HOME_DIR/bun.lock" "$HOME_DIR/.install-state.lock"
  printf '{"name":"changed"}\n' >"$HOME_DIR/package.json"
  run_wrapper
  expect_warning "wrapper: package.json differs" yes
}

test_wrapper_bun_lock_differs() {
  new_home
  cp "$HOME_DIR/package.json" "$HOME_DIR/.install-state"
  cp "$HOME_DIR/bun.lock" "$HOME_DIR/.install-state.lock"
  printf 'lock-v2\n' >"$HOME_DIR/bun.lock"
  run_wrapper
  expect_warning "wrapper: bun.lock differs" yes
}

test_wrapper_no_deployed_lock() {
  new_home
  rm "$HOME_DIR/bun.lock"
  cp "$HOME_DIR/package.json" "$HOME_DIR/.install-state"
  run_wrapper
  expect_warning "wrapper: no deployed bun.lock, .install-state matches" no
}

# ---- install script ------------------------------------------------------------------------------
# The .tmpl wraps the script in a chezmoi `if` on the OS; render it by dropping the {{ }} lines.
RENDERED="$TMP_BASE/install.sh"
grep -v '^{{' "$INSTALL_TMPL" >"$RENDERED"

# run_install <ok|fail>: sets INSTALL_DIR / IOUT / IRC. PATH holds only the stub bun and the
# system dirs, so neither mise nor a real bun is reachable.
run_install() {
  CASE_N=$((CASE_N + 1))
  INSTALL_DIR="$TMP_BASE/i$CASE_N"
  local stubs="$TMP_BASE/stubs$CASE_N"
  mkdir -p "$INSTALL_DIR" "$stubs"
  printf '{"name":"y"}\n' >"$INSTALL_DIR/package.json"
  printf 'lock-y\n' >"$INSTALL_DIR/bun.lock"
  if [[ "$1" == ok ]]; then
    printf '#!/bin/sh\necho "stub-bun $*"\nexit 0\n' >"$stubs/bun"
  else
    printf '#!/bin/sh\necho "stub-bun $*"\nexit 1\n' >"$stubs/bun"
  fi
  chmod +x "$stubs/bun"
  IRC=0
  IOUT=$(PATH="$stubs:/usr/bin:/bin" CHEZMOI_TEXTLINT_INSTALL_DIR="$INSTALL_DIR" bash "$RENDERED" 2>&1) || IRC=$?
}

test_install_success() {
  if PATH=/usr/bin:/bin command -v mise >/dev/null 2>&1; then fail "install: mise is reachable on the trimmed PATH"; return; fi
  run_install ok
  check "install success: exit 0" "$IRC"
  case "$IOUT" in *"bun install --frozen-lockfile --ignore-scripts"*) pass "install success: frozen install" ;; *) fail "install success: frozen install ($IOUT)" ;; esac
  check "install success: .install-state.lock equals bun.lock" "$(cmp -s "$INSTALL_DIR/bun.lock" "$INSTALL_DIR/.install-state.lock" && echo 0 || echo 1)"
  check "install success: .install-state equals package.json" "$(cmp -s "$INSTALL_DIR/package.json" "$INSTALL_DIR/.install-state" && echo 0 || echo 1)"
  check "install success: no temp files left" "$([[ -z "$(find "$INSTALL_DIR" -name '*.tmp.*')" ]] && echo 0 || echo 1)"
}

test_install_failure() {
  run_install fail
  check "install failure: exit 0" "$IRC"
  check "install failure: no .install-state" "$([[ ! -e "$INSTALL_DIR/.install-state" ]] && echo 0 || echo 1)"
  check "install failure: no .install-state.lock" "$([[ ! -e "$INSTALL_DIR/.install-state.lock" ]] && echo 0 || echo 1)"
  case "$IOUT" in *"regenerate bun.lock in the chezmoi source"*) pass "install failure: logs regenerate hint" ;; *) fail "install failure: logs regenerate hint ($IOUT)" ;; esac
}

test_install_failure_keeps_old_state() {
  run_install fail
  printf 'old-lock\n' >"$INSTALL_DIR/.install-state.lock"
  printf 'old-pkg\n' >"$INSTALL_DIR/.install-state"
  local stubs="$TMP_BASE/stubs$CASE_N"
  PATH="$stubs:/usr/bin:/bin" CHEZMOI_TEXTLINT_INSTALL_DIR="$INSTALL_DIR" bash "$RENDERED" >/dev/null 2>&1 || true
  check "install failure: previous state files unchanged" "$([[ "$(cat "$INSTALL_DIR/.install-state.lock")$(cat "$INSTALL_DIR/.install-state")" == "old-lockold-pkg" ]] && echo 0 || echo 1)"
}

test_install_dir_override_ignored_when_relative() {
  # A relative override must be ignored: the script falls back to $HOME/.config/textlint.
  # Checked by the log line only; the stub bun fails so nothing is written there.
  local stubs="$TMP_BASE/stubs-rel"
  mkdir -p "$stubs"
  printf '#!/bin/sh\nexit 1\n' >"$stubs/bun"
  chmod +x "$stubs/bun"
  local out
  out=$(PATH="$stubs:/usr/bin:/bin" CHEZMOI_TEXTLINT_INSTALL_DIR="relative/dir" bash "$RENDERED" 2>&1) || true
  case "$out" in *"relative/dir"*) fail "install: relative override is ignored" ;; *) pass "install: relative override is ignored" ;; esac
}

test_help_without_runtime() {
  local home="$TMP_BASE/help-empty" out err rc=0
  mkdir -p "$home"
  out=$(TEXTLINT_HOME="$home" bash "$WRAPPER" --help 2>"$home/stderr" </dev/null) || rc=$?
  err=$(cat "$home/stderr")
  check "help without runtime: exit 0" "$((rc == 0 ? 0 : 1))"
  check "help without runtime: stdout has --text" "$([[ "$out" == *--text* ]] && echo 0 || echo 1)"
  check "help without runtime: stderr empty" "$([[ -z "$err" ]] && echo 0 || echo 1)"
}

test_help_with_runtime() {
  new_home
  printf '#!/bin/sh\necho stub-textlint-help\n' >"$HOME_DIR/node_modules/.bin/textlint"
  local out err rc=0
  out=$(TEXTLINT_HOME="$HOME_DIR" bash "$WRAPPER" -h 2>"$HOME_DIR/stderr" </dev/null) || rc=$?
  err=$(cat "$HOME_DIR/stderr")
  check "help with runtime: exit 0" "$((rc == 0 ? 0 : 1))"
  check "help with runtime: wrapper usage and textlint help" "$([[ "$out" == *--text* && "$out" == *stub-textlint-help* ]] && echo 0 || echo 1)"
  check "help with runtime: stderr empty (no stale warning)" "$([[ -z "$err" ]] && echo 0 || echo 1)"
}

test_wrapper_state_matches
test_help_without_runtime
test_help_with_runtime
test_wrapper_old_format_state
test_wrapper_package_json_differs
test_wrapper_bun_lock_differs
test_wrapper_no_deployed_lock
test_install_success
test_install_failure
test_install_failure_keeps_old_state
test_install_dir_override_ignored_when_relative

if [[ "$FAILED" -ne 0 ]]; then
  printf '%s case(s) failed\n' "$FAILED"
  exit 1
fi
echo "all passed"
