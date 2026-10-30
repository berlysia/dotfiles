#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# Tests for git-worktree-deps (docs/decisions/0022-agent-vm-node-modules.md, docs/decisions/0033-claude-worktrees-under-git-dir.md).
# Every fixture lives in a throwaway directory under $TMP_BASE; HOME, PATH and the agent-vm marker are replaced, so
# nothing of the machine running the tests is touched. The fake package managers and helpers log their arguments.
# Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
DEPS="$REPO_ROOT/home/dot_local/bin/executable_git-worktree-deps"
TMP_BASE=$(cd -P "$(mktemp -d -t gwdeps-test-XXXXXX)" && pwd -P)
# A fixture may leave a directory that cannot be deleted on purpose
trap 'chmod -R u+rwx "$TMP_BASE" 2>/dev/null || true; rm -rf "$TMP_BASE"' EXIT
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
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2 / in: $1)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac; }
assert_no_file() { if [[ ! -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (exists: $1)"; fi; }
assert_file() { if [[ -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (missing: $1)"; fi; }
assert_between() { if [[ "$3" -ge "$1" && "$3" -le "$2" ]]; then record "PASS $4"; else record "FAIL $4 (expected $1..$2 / actual: $3)"; fi; }
# assert_empty_dir <dir> <label>: the directory exists and has nothing in it, dotfiles included
assert_empty_dir() {
  # shellcheck disable=SC2012 # only the emptiness and a message are needed, names are not parsed
  if [[ -d "$1" && -z "$(ls -A "$1")" ]]; then record "PASS $2"; else record "FAIL $2 (not an empty dir: $1: $(ls -A "$1" 2>&1 | tr '\n' ' '))"; fi
}
# assert_dead <pid file> <label>: the process in the file is gone (a zombie is gone)
assert_dead() {
  local pid state
  pid=$(cat "$1" 2>/dev/null) || { record "FAIL $2 (no pid file: $1)"; return 0; }
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d ' ') || state=""
  case "$state" in
  "" | Z*) record "PASS $2" ;;
  *)
    kill -KILL "$pid" 2>/dev/null || true
    record "FAIL $2 (pid $pid is still alive, state $state)"
    ;;
  esac
}
count_lines() { if [[ -f "$1" ]]; then wc -l <"$1" | tr -d ' '; else echo 0; fi; }

# ---- fixture -----------------------------------------------------------------
# make_wt <name> [lockfile...]: a repository with package.json and the lockfiles committed, and a linked worktree
# of it at $WT. $REPO is the main checkout, $STUB an empty directory for the fakes.
make_wt() {
  local name=$1 lock
  shift
  mkdir -p "$TMP_BASE/$name/repo" "$TMP_BASE/$name/bin"
  REPO=$(cd -P "$TMP_BASE/$name/repo" && pwd -P)
  STUB="$TMP_BASE/$name/bin"
  WT="$TMP_BASE/$name/wt"
  git -C "$REPO" init -q
  printf '{}\n' >"$REPO/package.json"
  for lock in "$@"; do printf '\n' >"$REPO/$lock"; done
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m init
  git -C "$REPO" worktree add -q "$WT" -b feat
}
# stub <command> <status> [stdout line] [stderr line]: a command in $STUB that logs each argument on its own line
# to $STUB/<command>.log and its working directory to $STUB/<command>.cwd, prints the lines, and exits with the status
stub() {
  {
    printf '#!/bin/sh\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$STUB/$1.log"
    printf 'pwd -P >%q\n' "$STUB/$1.cwd"
    if [[ -n "${3:-}" ]]; then printf 'printf "%%s\\n" %q\n' "$3"; fi
    if [[ -n "${4:-}" ]]; then printf 'printf "%%s\\n" %q >&2\n' "$4"; fi
    printf 'exit %d\n' "$2"
  } >"$STUB/$1"
  chmod +x "$STUB/$1"
}
# stub_body <command> <shell body>: like stub, with the body run after the argument log instead of a fixed status
stub_body() {
  {
    printf '#!/bin/sh\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$STUB/$1.log"
    printf '%s\n' "$2"
  } >"$STUB/$1"
  chmod +x "$STUB/$1"
}
# run_deps <marker> <args...>: the real git-worktree-deps, with $RUN_PATH (default: $STUB in front of the base PATH)
run_deps() {
  OUT=$(AGENT_VM_MARKER="$1" PATH="${RUN_PATH:-$STUB:$BASE_PATH}" bash "$DEPS" "${@:2}" 2>&1) && STATUS=0 || STATUS=$?
}
now() { date +%s; }
# path_without_timeout [gtimeout]: a PATH directory with the tools the script and the fakes need, and no timeout
# (the base PATH has the real one); with "gtimeout" it also holds the real timeout under that name
path_without_timeout() {
  local dir=$TMP_BASE/nobin-$1-$$ tool real
  mkdir -p "$dir"
  for tool in bash sed tr ls find rm dirname git sleep mkdir touch cat date chmod head sh uname; do
    real=$(PATH="$BASE_PATH" command -v "$tool") || continue
    ln -sf "$real" "$dir/$tool"
  done
  if [[ "$1" == gtimeout ]]; then ln -sf "$(command -v timeout)" "$dir/gtimeout"; fi
  printf '%s' "$dir"
}

# ---- 機能適合性: --source, --no-install ------------------------------------------------
test_S1_new_and_local_install_once() {
  local src
  for src in new local; do
    make_wt "s1-$src" pnpm-lock.yaml
    stub pnpm 0
    run_deps "$AGENT_VM_MARKER" --source "$src" "$WT"
    assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "S1 --source $src runs pnpm once"
    assert_eq "$WT" "$(cat "$STUB/pnpm.cwd")" "S1 --source $src runs in the worktree"
    assert_contains "$OUT" "Dependencies installed" "S1 --source $src reports success"
    assert_eq 0 "$STATUS" "S1 --source $src exit 0"
  done
  make_wt s1-default pnpm-lock.yaml
  stub pnpm 0
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_eq 1 "$(($(count_lines "$STUB/pnpm.log") / 2))" "S1 the default source installs"
}
test_S2_remote_is_shown_not_run() {
  make_wt s2 pnpm-lock.yaml
  stub pnpm 0
  run_deps "$AGENT_VM_MARKER" --source remote "$WT"
  assert_no_file "$STUB/pnpm.log" "S2 pnpm is not run"
  assert_contains "$OUT" "💡 Dependencies are not installed (not run automatically because the branch comes from origin;" "S2 the reason"
  assert_contains "$OUT" "To install them: cd $WT && pnpm install --frozen-lockfile" "S2 the command"
  assert_eq 0 "$STATUS" "S2 exit 0"
}
test_S3_host_no_install_still_syncs() {
  make_wt s3 pnpm-lock.yaml
  stub pnpm 0
  stub agent-vm 0
  run_deps "$AGENT_VM_MARKER" --no-install "$WT"
  assert_no_file "$STUB/pnpm.log" "S3 pnpm is not run"
  assert_contains "$OUT" "💡 Dependencies are not installed (--no-install). To install them: cd $WT && pnpm install --frozen-lockfile" "S3 the command is shown"
  assert_eq $'node-modules-sync\n'"$REPO" "$(cat "$STUB/agent-vm.log")" "S3 one sync of the main checkout"
}
test_S4_vm_no_install_still_attaches() {
  make_wt s4 pnpm-lock.yaml
  stub pnpm 0
  stub agent-vm-node-modules 0
  stub agent-vm 0
  run_deps "$VM_MARKER" --no-install "$WT"
  assert_eq $'attach\n'"$WT" "$(cat "$STUB/agent-vm-node-modules.log")" "S4 one attach"
  assert_no_file "$STUB/pnpm.log" "S4 pnpm is not run"
  assert_no_file "$STUB/agent-vm.log" "S4 no host sync inside a machine"
}
test_S5_vm_attach_failure_blocks_install() {
  make_wt s5 pnpm-lock.yaml
  stub pnpm 0
  stub agent-vm-node-modules 1 "" "could not mount"
  run_deps "$VM_MARKER" "$WT"
  assert_no_file "$STUB/pnpm.log" "S5 pnpm is not run"
  assert_contains "$OUT" "do not install there until this succeeds: agent-vm-node-modules attach $WT" "S5 the warning with the recovery"
  assert_eq 0 "$STATUS" "S5 exit 0"
}
test_S6_vm_without_helper_installs_nothing() {
  make_wt s6 pnpm-lock.yaml
  stub pnpm 0
  run_deps "$VM_MARKER" "$WT"
  assert_no_file "$STUB/pnpm.log" "S6 pnpm is not run"
  assert_contains "$OUT" "agent-vm-node-modules is missing" "S6 the warning"
  assert_eq 0 "$STATUS" "S6 exit 0"
}
test_S7_attach_that_eats_the_time_blocks_install() {
  make_wt s7 pnpm-lock.yaml
  stub pnpm 0
  stub_body agent-vm-node-modules 'sleep 2'
  run_deps "$VM_MARKER" --timeout 1 "$WT"
  assert_no_file "$STUB/pnpm.log" "S7 pnpm is not run"
  assert_contains "$OUT" "the time for the install ran out before it could start (--timeout 1)" "S7 the reason"
  assert_contains "$OUT" "To install them: cd $WT && pnpm install --frozen-lockfile" "S7 the command"
  assert_eq 0 "$STATUS" "S7 exit 0"
}
test_S8_attach_is_retried_by_a_second_run() {
  make_wt s8 pnpm-lock.yaml
  stub_body agent-vm-node-modules "if [ -e $STUB/attached-once ]; then exit 0; fi; : >$STUB/attached-once; echo could-not-mount >&2; exit 1"
  run_deps "$VM_MARKER" --no-install "$WT"
  assert_contains "$OUT" "may be shared with the host" "S8 the first run warns"
  run_deps "$VM_MARKER" --no-install "$WT"
  assert_not_contains "$OUT" "shared with the host" "S8 the second run has no warning"
  assert_not_contains "$OUT" "⚠️" "S8 the second run has no warning sign"
  assert_eq 4 "$(count_lines "$STUB/agent-vm-node-modules.log")" "S8 attach ran twice"
}
test_S9_usage_errors() {
  make_wt s9 pnpm-lock.yaml
  run_deps "$AGENT_VM_MARKER" --source bogus "$WT"
  assert_eq 1 "$STATUS" "S9 unknown --source exits 1"
  run_deps "$AGENT_VM_MARKER" --timeout abc "$WT"
  assert_eq 1 "$STATUS" "S9 --timeout abc exits 1"
  run_deps "$AGENT_VM_MARKER" --timeout 0 "$WT"
  assert_eq 1 "$STATUS" "S9 --timeout 0 exits 1"
  run_deps "$AGENT_VM_MARKER" --bogus "$WT"
  assert_eq 1 "$STATUS" "S9 unknown option exits 1"
  run_deps "$AGENT_VM_MARKER"
  assert_eq 1 "$STATUS" "S9 no worktree exits 1"
  run_deps "$AGENT_VM_MARKER" "$TMP_BASE/nowhere"
  assert_eq 1 "$STATUS" "S9 a missing directory exits 1"
  run_deps "$AGENT_VM_MARKER" "$WT" --help
  assert_eq 0 "$STATUS" "S9 --help at any position exits 0"
  assert_contains "$OUT" "git-worktree-deps - Prepare the dependencies" "S9 --help prints the help"
}

# ---- 信頼性: timeout --------------------------------------------------------------------
test_T1_timeout_clears_the_partial_install() {
  local start elapsed
  make_wt t1 pnpm-lock.yaml
  stub_body pnpm 'mkdir -p node_modules/pkg && touch node_modules/pkg/file; sleep 30'
  start=$(now)
  run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  elapsed=$(($(now) - start))
  assert_eq 0 "$STATUS" "T1 exit 0"
  assert_contains "$OUT" "dependencies are not installed in $WT (pnpm install --frozen-lockfile: timed out after 1s" "T1 the warning"
  assert_empty_dir "$WT/node_modules" "T1 node_modules is empty"
  assert_no_file "$WT/node_modules/.git-worktree-deps-incomplete" "T1 no marker"
  assert_between 1 5 "$elapsed" "T1 ended within the limit plus a margin"
}
test_T2_term_ignoring_package_manager_is_killed() {
  local start elapsed
  make_wt t2 pnpm-lock.yaml
  stub_body pnpm "trap '' TERM; echo \$\$ >$STUB/pm.pid; mkdir -p node_modules; sleep 30; sleep 30"
  start=$(now)
  run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  elapsed=$(($(now) - start))
  assert_eq 0 "$STATUS" "T2 exit 0"
  assert_between 5 9 "$elapsed" "T2 ended about 6 seconds after the start (TERM at 1, KILL 5 later)"
  assert_dead "$STUB/pm.pid" "T2 the package manager is gone"
  assert_empty_dir "$WT/node_modules" "T2 node_modules is empty"
}
test_T3_term_ignoring_child_is_killed() {
  local start elapsed
  make_wt t3 pnpm-lock.yaml
  stub_body pnpm "(trap '' TERM; exec sleep 30) & echo \$! >$STUB/child.pid; sleep 30"
  start=$(now)
  run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  elapsed=$(($(now) - start))
  assert_eq 0 "$STATUS" "T3 exit 0"
  assert_between 1 5 "$elapsed" "T3 ended without waiting for the child"
  assert_dead "$STUB/child.pid" "T3 the child is gone"
}
test_T4_gtimeout_is_used_when_timeout_is_missing() {
  make_wt t4 pnpm-lock.yaml
  stub pnpm 0
  RUN_PATH="$STUB:$(path_without_timeout gtimeout)" run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "T4 pnpm ran through gtimeout"
  assert_contains "$OUT" "Dependencies installed" "T4 success"
}
test_T5_no_timeout_command_installs_nothing() {
  make_wt t5 pnpm-lock.yaml
  stub pnpm 0
  RUN_PATH="$STUB:$(path_without_timeout none)" run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  assert_no_file "$STUB/pnpm.log" "T5 pnpm is not run"
  assert_contains "$OUT" "neither timeout nor gtimeout is on PATH" "T5 the reason"
  assert_contains "$OUT" "To install them: cd $WT && pnpm install --frozen-lockfile" "T5 the command"
  assert_eq 0 "$STATUS" "T5 exit 0"
}
test_T6_no_timeout_option_needs_no_timeout_command() {
  make_wt t6 pnpm-lock.yaml
  stub pnpm 0
  RUN_PATH="$STUB:$(path_without_timeout none)" run_deps "$AGENT_VM_MARKER" "$WT"
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "T6 without --timeout pnpm runs as before"
}

# ---- 信頼性: node_modules after a failed install ----------------------------------------
test_N1_failed_install_clears_what_it_created() {
  make_wt n1 pnpm-lock.yaml
  stub_body pnpm 'mkdir -p node_modules/pkg/deep && touch node_modules/pkg/deep/file node_modules/.hidden; exit 3'
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_eq 0 "$STATUS" "N1 exit 0"
  assert_contains "$OUT" "(pnpm install --frozen-lockfile: status 3); the worktree itself is created" "N1 the warning"
  assert_empty_dir "$WT/node_modules" "N1 node_modules is empty, dotfiles included"
}
test_N2_empty_node_modules_before_is_cleared() {
  make_wt n2 pnpm-lock.yaml
  mkdir "$WT/node_modules"
  stub_body pnpm 'mkdir -p node_modules/pkg; exit 1'
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_empty_dir "$WT/node_modules" "N2 the directory stays, empty"
}
test_N3_stuck_clear_out_leaves_the_marker() {
  if [[ "$(id -u)" -eq 0 ]]; then
    record "PASS N3 skipped (root can delete a read-only directory)"
    return 0
  fi
  make_wt n3 pnpm-lock.yaml
  stub_body pnpm 'mkdir -p node_modules/stuck node_modules/other; touch node_modules/stuck/file; chmod 555 node_modules/stuck; exit 1'
  run_deps "$AGENT_VM_MARKER" "$WT"
  chmod -R u+rwx "$WT/node_modules"
  assert_eq 0 "$STATUS" "N3 exit 0"
  assert_file "$WT/node_modules/.git-worktree-deps-incomplete" "N3 the marker stays"
  assert_contains "$OUT" "could not be cleared; it is marked as incomplete. To clear it and install: git-worktree-deps $WT" "N3 the warning names the recovery"
}
test_N4_marker_is_cleared_before_the_install() {
  make_wt n4 pnpm-lock.yaml
  mkdir -p "$WT/node_modules/old/deep"
  touch "$WT/node_modules/old/deep/file" "$WT/node_modules/.git-worktree-deps-incomplete"
  stub pnpm 0
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_eq 1 "$(($(count_lines "$STUB/pnpm.log") / 2))" "N4 pnpm ran once"
  assert_empty_dir "$WT/node_modules" "N4 the old contents and the marker are gone"
}
test_N5_marker_with_a_stuck_clear_out_blocks_the_install() {
  if [[ "$(id -u)" -eq 0 ]]; then
    record "PASS N5 skipped (root can delete a read-only directory)"
    return 0
  fi
  make_wt n5 pnpm-lock.yaml
  mkdir -p "$WT/node_modules/stuck"
  touch "$WT/node_modules/stuck/file" "$WT/node_modules/.git-worktree-deps-incomplete"
  chmod 555 "$WT/node_modules/stuck"
  stub pnpm 0
  run_deps "$AGENT_VM_MARKER" "$WT"
  chmod -R u+rwx "$WT/node_modules"
  assert_no_file "$STUB/pnpm.log" "N5 pnpm is not run over the leftover"
  assert_file "$WT/node_modules/.git-worktree-deps-incomplete" "N5 the marker stays"
  assert_eq 0 "$STATUS" "N5 exit 0"
}
test_N6_populated_node_modules_is_never_cleared() {
  make_wt n6 pnpm-lock.yaml
  mkdir -p "$WT/node_modules/mine"
  touch "$WT/node_modules/mine/file"
  stub pnpm 1
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_file "$WT/node_modules/mine/file" "N6 the file stays"
  assert_contains "$OUT" "(pnpm install --frozen-lockfile: status 1)" "N6 the failure warning"
  assert_contains "$OUT" "had contents before this install, so it is left as it is" "N6 the warning about the contents"
  assert_no_file "$WT/node_modules/.git-worktree-deps-incomplete" "N6 no marker"
  assert_eq 0 "$STATUS" "N6 exit 0"
}
test_N7_symlinked_node_modules_is_never_followed() {
  make_wt n7 pnpm-lock.yaml
  mkdir -p "$TMP_BASE/n7/outside/pkg"
  touch "$TMP_BASE/n7/outside/pkg/file" "$TMP_BASE/n7/outside/.git-worktree-deps-incomplete"
  ln -s "$TMP_BASE/n7/outside" "$WT/node_modules"
  stub pnpm 1
  run_deps "$AGENT_VM_MARKER" "$WT"
  assert_file "$TMP_BASE/n7/outside/pkg/file" "N7 the file behind the link stays"
  assert_eq "$TMP_BASE/n7/outside" "$(readlink "$WT/node_modules")" "N7 the link stays"
  assert_eq 0 "$STATUS" "N7 exit 0"
}
test_N8_symlinked_empty_target_is_never_followed_after_timeout() {
  make_wt n8 pnpm-lock.yaml
  mkdir -p "$TMP_BASE/n8/outside"
  touch "$TMP_BASE/n8/outside/file"
  ln -s "$TMP_BASE/n8/outside" "$WT/node_modules"
  stub_body pnpm 'sleep 30'
  run_deps "$AGENT_VM_MARKER" --timeout 1 "$WT"
  assert_file "$TMP_BASE/n8/outside/file" "N8 the file behind the link stays after a timeout"
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
