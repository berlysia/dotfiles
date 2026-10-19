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

check_case() { # shell script expected-log description
  local sh=$1 script=$2 expected=$3 desc=$4 log="$TMP_BASE/$1.log"
  local -a flags=(); IFS=' ' read -r -a flags <<<"$(shell_flags "$sh")"
  : >"$log"
  STUB_LOG="$log" "$sh" ${flags[@]+"${flags[@]}"} -c ". '$FUNCS'; $script"
  assert_eq "$expected" "$(cat "$log")" "$sh: $desc"
}
check_shell() { # shell
  local sh=$1
  check_case "$sh" "claude -p hi" "claude -p hi" "claude is the host binary"
  check_case "$sh" "codex --help" "codex --help" "codex is the host binary"
  check_case "$sh" "vclaude -p hi" "agent-vm claude -p hi" "vclaude goes through agent-vm"
  check_case "$sh" "vcodex" "agent-vm codex" "vcodex goes through agent-vm"
  check_case "$sh" "AGENT_VM=on claude --version" "claude --version" "AGENT_VM is ignored by claude"
  check_case "$sh" "AGENT_VM=off vclaude --version" "agent-vm claude --version" "AGENT_VM is ignored by vclaude"
}
check_without_launcher() { # shell: without agent-vm on PATH vclaude / vcodex are not defined
  local sh=$1 log bin
  log="$TMP_BASE/$sh-nolauncher.log"
  bin="$TMP_BASE/bin-$sh"
  mkdir -p "$bin"; cp "$TEST_DIR/stubs/claude" "$bin/claude"
  : >"$log"
  local -a flags=(); IFS=' ' read -r -a flags <<<"$(shell_flags "$sh")"
  STUB_LOG="$log" PATH="$bin:/usr/bin:/bin" "$sh" ${flags[@]+"${flags[@]}"} -c ". '$FUNCS'; if command -v vclaude >/dev/null; then echo 'vclaude defined' >>\"\$STUB_LOG\"; fi; claude -p hi"
  assert_eq "claude -p hi" "$(cat "$log")" "$sh: no launcher -> vclaude undefined, plain claude"
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
