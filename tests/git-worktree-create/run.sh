#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# Tests for git-worktree-create's agent-vm integration (docs/decisions/0022-agent-vm-node-modules.md). Every fixture
# lives in a throwaway directory under $TMP_BASE; the real repository is never touched.
# Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
CREATE="$REPO_ROOT/home/dot_local/bin/executable_git-worktree-create"
TMP_BASE=$(cd -P "$(mktemp -d -t gwcr-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT
# When started from a git hook, these variables would point fixtures at the real repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_SSH_COMMAND GIT_SSH GIT_ASKPASS GIT_PROXY_COMMAND GIT_EXEC_PATH
export GIT_CEILING_DIRECTORIES="$TMP_BASE" HOME="$TMP_BASE/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP_BASE/gitconfig" GIT_TERMINAL_PROMPT=0
# Not an agent-vm machine unless a test says so, even when the tests run inside one
export AGENT_VM_MARKER="$TMP_BASE/no-agent-vm"
mkdir -p "$HOME"
git config -f "$GIT_CONFIG_GLOBAL" user.name t
git config -f "$GIT_CONFIG_GLOBAL" user.email t@t
git config -f "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config -f "$GIT_CONFIG_GLOBAL" init.defaultBranch main
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
REAL_GIT=$(command -v git)
# git and the base system only: no agent-vm or agent-vm-node-modules of the machine running the tests
BASE_PATH="$(dirname "$REAL_GIT"):/usr/bin:/bin"
VM_MARKER="$TMP_BASE/agent-vm-marker"
: >"$VM_MARKER"

# ---- assert ----------------------------------------------------------------
record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac; }
assert_dir() { if [[ -d "$1" ]]; then record "PASS $2"; else record "FAIL $2 (missing dir: $1)"; fi; }
assert_no_file() { if [[ ! -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (exists: $1)"; fi; }

# ---- fixture -----------------------------------------------------------------
# make_repo <name>: a repository with one commit at $REPO, and an empty stub directory at $STUB
make_repo() {
  mkdir -p "$TMP_BASE/$1/repo" "$TMP_BASE/$1/bin"
  REPO=$(cd -P "$TMP_BASE/$1/repo" && pwd -P)
  STUB="$TMP_BASE/$1/bin"
  git -C "$REPO" init -q
  git -C "$REPO" commit -q --allow-empty -m init
}
# stub <command> <status> [stdout line] [stderr line]: a command in $STUB that logs each argument on its own line
# to $STUB/<command>.log, prints the lines, and exits with the status
stub() {
  {
    printf '#!/bin/sh\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$STUB/$1.log"
    if [[ -n "${3:-}" ]]; then printf 'printf "%%s\\n" %q\n' "$3"; fi
    if [[ -n "${4:-}" ]]; then printf 'printf "%%s\\n" %q >&2\n' "$4"; fi
    printf 'exit %d\n' "$2"
  } >"$STUB/$1"
  chmod +x "$STUB/$1"
}
# run_create <marker> <branch>: the real git-worktree-create in $REPO, with $STUB in front of the base PATH
run_create() {
  OUT=$(cd "$REPO" && AGENT_VM_MARKER="$1" PATH="$STUB:$BASE_PATH" bash "$CREATE" "$2" 2>&1) && STATUS=0 || STATUS=$?
}

# ---- 機能適合性 ------------------------------------------------------------------
test_C1_vm_attaches_the_new_worktree() {
  make_repo c1
  stub agent-vm-node-modules 0 "mounted	$REPO/.git/worktree/feat"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C1 exit 0"
  assert_dir "$REPO/.git/worktree/feat" "C1 worktree created"
  assert_eq $'attach\n'"$REPO/.git/worktree/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C1 attach <worktree>"
  assert_not_contains "$OUT" "mounted" "C1 the helper's records are not shown"
  assert_not_contains "$OUT" "node_modules" "C1 no warning when attached"
}
test_C5_host_asks_a_running_machine_to_sync() {
  make_repo c5
  stub agent-vm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C5 exit 0"
  assert_eq $'node-modules-sync\n'"$REPO" "$(cat "$STUB/agent-vm.log")" "C5 node-modules-sync <repo>"
  assert_not_contains "$OUT" "node_modules" "C5 no warning when the sync succeeds or is skipped"
}

# ---- 信頼性 ------------------------------------------------------------------------
test_C2_vm_attach_failure_warns_and_keeps_the_worktree() {
  make_repo c2
  stub agent-vm-node-modules 1 "" "agent-vm-node-modules: could not mount a VM-local node_modules"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C2 the creation still succeeds"
  assert_dir "$REPO/.git/worktree/feat" "C2 worktree kept"
  assert_contains "$OUT" "could not mount a VM-local node_modules" "C2 the helper's stderr is shown"
  assert_contains "$OUT" "node_modules of $REPO/.git/worktree/feat may be shared with the host (agent-vm-node-modules attach: status 1); do not install there until this succeeds: agent-vm-node-modules attach $REPO/.git/worktree/feat" "C2 one warning with the recovery"
}
test_C3_nothing_is_called_when_the_worktree_is_not_created() {
  make_repo c3
  stub agent-vm-node-modules 0
  run_create "$VM_MARKER" "bad..name"
  if [[ "$STATUS" -ne 0 ]]; then record "PASS C3 creation fails"; else record "FAIL C3 creation fails (status 0)"; fi
  assert_no_file "$STUB/agent-vm-node-modules.log" "C3 attach is not called"
}
test_C6_host_sync_failure_adds_one_warning() {
  make_repo c6
  stub agent-vm 3 "" "agent-vm: kept VM-local node_modules that may be stale in agent-r-000000"
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C6 the creation still succeeds"
  assert_contains "$OUT" "kept VM-local node_modules that may be stale" "C6 agent-vm's warning is shown"
  assert_contains "$OUT" "the running agent-vm machine may not have VM-local node_modules for $REPO/.git/worktree/feat yet (agent-vm node-modules-sync: status 3); the next agent-vm launch syncs it" "C6 one context line"
}

# ---- 互換性 ------------------------------------------------------------------------
test_C4_vm_without_the_helper_behaves_as_before() {
  make_repo c4
  stub agent-vm 0
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C4 exit 0"
  assert_no_file "$STUB/agent-vm.log" "C4 agent-vm is not called inside a machine"
  assert_not_contains "$OUT" "node_modules" "C4 no warning without the helper"
}
test_C7_host_without_agent_vm_behaves_as_before() {
  make_repo c7
  stub agent-vm-node-modules 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C7 exit 0"
  assert_no_file "$STUB/agent-vm-node-modules.log" "C7 the helper is not called on the host"
  assert_not_contains "$OUT" "node_modules" "C7 no warning"
  assert_contains "$OUT" "Worktree created: $REPO/.git/worktree/feat" "C7 the usual output"
}
test_C8_paths_with_a_space_stay_one_argument() {
  make_repo "c 8"
  stub agent-vm-node-modules 0
  run_create "$VM_MARKER" feat
  assert_eq $'attach\n'"$REPO/.git/worktree/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C8 VM: one argument"
  make_repo "c 8 host"
  stub agent-vm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq $'node-modules-sync\n'"$REPO" "$(cat "$STUB/agent-vm.log")" "C8 host: one argument"
}

# ---- runner --------------------------------------------------------------------------
run_one() {
  local t=$1 rc
  set +e
  (
    set -e
    "$t"
  )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then record "FAIL $t (aborted, rc=$rc)"; fi
}

tests=()
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    case "$arg" in test_*) tests+=("$arg") ;; *) tests+=("test_$arg") ;; esac
  done
else
  while IFS= read -r name; do tests+=("$name"); done < <(declare -F | sed -n 's/^declare -f \(test_.*\)$/\1/p')
fi

for t in ${tests[@]+"${tests[@]}"}; do
  if declare -F "$t" >/dev/null; then
    run_one "$t"
  else
    record "FAIL $t (no such test)"
  fi
done

cat "$RESULTS_FILE"
pass=$(grep -c '^PASS' "$RESULTS_FILE" || true)
fail=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
echo "PASS: $pass FAIL: $fail"
if [[ "$fail" -gt 0 ]]; then exit 1; fi
