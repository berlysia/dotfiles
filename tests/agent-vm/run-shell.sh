#!/usr/bin/env bash
# Runs the shell-function checks under bash and, when installed, zsh.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
FUNCS="$REPO_ROOT/home/dot_shell_common/agent_vm.sh"
TMP_BASE=$(mktemp -d -t agent-vm-shell-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

# zsh always sources ~/.zshenv, even for `zsh -c`, unlike bash (which only reads a non-interactive
# startup file when $BASH_ENV names one, and that is unset here). On this developer's machine
# ~/.zshenv loads the deployed dotfiles shell init, which can put the real claude/codex ahead of our
# stub dir on PATH and would otherwise make these checks fire a real `claude` invocation. `-f` skips
# all zsh startup files so the check only ever sees the PATH this script builds.
shell_flags() { # shell -> extra argv to insert before -c
  case "$1" in zsh) printf '%s\n' -f ;; esac
}

check_shell() { # shell
  local sh=$1 log
  log="$TMP_BASE/$sh.log"
  : >"$log"
  local -a flags=(); IFS=' ' read -r -a flags <<<"$(shell_flags "$sh")"
  STUB_LOG="$log" "$sh" "${flags[@]}" -c ". '$FUNCS'; claude -p hi; codex; AGENT_VM=off claude --version"
  assert_contains "$(cat "$log")" "agent-vm claude -p hi" "$sh: claude goes through agent-vm"
  assert_contains "$(cat "$log")" "agent-vm codex" "$sh: codex goes through agent-vm"
  assert_contains "$(cat "$log")" "claude --version" "$sh: AGENT_VM=off runs host claude"
  assert_not_contains "$(cat "$log")" "agent-vm claude --version" "$sh: AGENT_VM=off bypasses agent-vm"
}
check_without_launcher() { # shell: without agent-vm on PATH the functions are not defined
  local sh=$1 log bin
  log="$TMP_BASE/$sh-nolauncher.log"
  bin="$TMP_BASE/bin-$sh"
  mkdir -p "$bin"; cp "$TEST_DIR/stubs/claude" "$bin/claude"
  : >"$log"
  local -a flags=(); IFS=' ' read -r -a flags <<<"$(shell_flags "$sh")"
  STUB_LOG="$log" PATH="$bin:/usr/bin:/bin" "$sh" "${flags[@]}" -c ". '$FUNCS'; claude -p hi"
  assert_eq "claude -p hi" "$(cat "$log")" "$sh: no launcher -> plain claude"
}

check_shell bash
check_without_launcher bash
if command -v zsh >/dev/null 2>&1; then
  check_shell zsh
  check_without_launcher zsh
else
  record "PASS zsh checks skipped (zsh not installed)"
fi

failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
