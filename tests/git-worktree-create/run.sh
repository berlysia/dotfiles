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
# run_create <marker> <args...>: the real git-worktree-create in $REPO, with $STUB in front of the base PATH
run_create() {
  OUT=$(cd "$REPO" && AGENT_VM_MARKER="$1" PATH="$STUB:$BASE_PATH" bash "$CREATE" "${@:2}" 2>&1) && STATUS=0 || STATUS=$?
}
# commit_file <path> [content]: a file committed in $REPO, so that a new worktree checks it out
commit_file() {
  printf '%s\n' "${2:-}" >"$REPO/$1"
  git -C "$REPO" add -- "$1"
  git -C "$REPO" commit -q -m "add $1"
}
# push_origin_branch <name> <branch>: HEAD of $REPO as <branch> on a bare origin, known locally only as origin/<branch>
push_origin_branch() {
  git init -q --bare "$TMP_BASE/$1/origin.git"
  git -C "$REPO" remote add origin "$TMP_BASE/$1/origin.git"
  git -C "$REPO" push -q origin "HEAD:refs/heads/$2"
  git -C "$REPO" fetch -q origin
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

# ---- 機能適合性: dependency install --------------------------------------------------
# node_repo <name> [lockfile...]: a repository whose package.json ({}) and the lockfiles are committed
node_repo() {
  local name=$1 lock
  shift
  make_repo "$name"
  commit_file package.json '{}'
  for lock in "$@"; do commit_file "$lock"; done
}
# skip_if_real <command> <label>: records a skip and returns 1 when the base PATH has a real <command>
skip_if_real() {
  if PATH="$STUB:$BASE_PATH" command -v "$1" >/dev/null 2>&1; then
    record "PASS $2 skipped (a real $1 is on the base PATH)"
    return 1
  fi
}
test_D1_pnpm_lockfile_installs_frozen() {
  node_repo d1 pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "D1 exit 0"
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D1 pnpm install --frozen-lockfile"
  assert_eq "$REPO/.git/worktree/feat" "$(cat "$STUB/pnpm.cwd")" "D1 runs in the worktree"
  assert_contains "$OUT" "Installing dependencies: pnpm install --frozen-lockfile" "D1 announces the install"
  assert_contains "$OUT" "Dependencies installed" "D1 reports success"
}
test_D2_bun_lockfile_installs_frozen() {
  node_repo d2 bun.lock
  stub bun 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/bun.log")" "D2 bun install --frozen-lockfile"
}
test_D3_npm_lockfile_runs_ci() {
  node_repo d3 package-lock.json
  stub npm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq "ci" "$(cat "$STUB/npm.log")" "D3 npm ci"
}
test_D16_path_with_a_space() {
  node_repo "d 16" pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq "$REPO/.git/worktree/feat" "$(cat "$STUB/pnpm.cwd")" "D16 one path with a space"
}
test_D22_local_branch_installs() {
  node_repo d22 pnpm-lock.yaml
  git -C "$REPO" branch local-feat
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" local-feat
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D22 a local branch is installed"
}
test_D25_the_path_comes_before_the_install() {
  node_repo d25 pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_contains "${OUT%%Installing dependencies*}" "To switch to this worktree: cd $REPO/.git/worktree/feat" "D25 the path is shown first"
}
test_D5b_declared_pm_settles_two_lockfiles() {
  make_repo d5b
  commit_file package.json '{"packageManager": "pnpm@10.0.0"}'
  commit_file pnpm-lock.yaml
  commit_file bun.lock
  stub pnpm 0
  stub bun 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D5b the declared pm installs"
  assert_no_file "$STUB/bun.log" "D5b the other pm does not run"
}

# ---- 信頼性: dependency install ------------------------------------------------------
test_D4_yarn_is_only_shown() {
  node_repo d4 yarn.lock
  stub yarn 0
  run_create "$AGENT_VM_MARKER" feat
  assert_no_file "$STUB/yarn.log" "D4 yarn is not run"
  assert_contains "$OUT" "Dependencies are not installed (yarn is not run automatically). To install them: cd $REPO/.git/worktree/feat && yarn install" "D4 the command is shown"
}
test_D5_declared_pm_without_its_lockfile() {
  make_repo d5
  commit_file package.json '{"packageManager": "pnpm@10.0.0"}'
  commit_file bun.lock
  stub pnpm 0
  stub bun 0
  run_create "$AGENT_VM_MARKER" feat
  assert_no_file "$STUB/pnpm.log" "D5 pnpm is not run"
  assert_no_file "$STUB/bun.log" "D5 bun is not run"
  assert_contains "$OUT" "Dependencies are not installed (pnpm has no lockfile here, and an install would write one). To install them: cd $REPO/.git/worktree/feat && pnpm install" "D5 the command is shown"
}
test_D6_two_lockfiles_install_nothing() {
  node_repo d6 pnpm-lock.yaml bun.lock
  stub pnpm 0
  stub bun 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "D6 exit 0"
  assert_no_file "$STUB/pnpm.log" "D6 pnpm is not run"
  assert_no_file "$STUB/bun.log" "D6 bun is not run"
  assert_contains "$OUT" "found pnpm-lock.yaml, bun.lock and no packageManager field" "D6 names the lockfiles"
}
test_D7_lockfile_without_package_json() {
  make_repo d7
  commit_file pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_no_file "$STUB/pnpm.log" "D7 pnpm is not run"
  assert_not_contains "$OUT" "ependenc" "D7 no line about dependencies"
}
test_D8_install_failure_keeps_the_worktree() {
  node_repo d8 pnpm-lock.yaml
  stub pnpm 7
  run_create "$AGENT_VM_MARKER" feat
  local wt=$REPO/.git/worktree/feat
  assert_eq 0 "$STATUS" "D8 exit 0"
  assert_dir "$wt" "D8 the worktree is kept"
  assert_contains "$OUT" "dependencies are not installed in $wt (pnpm install --frozen-lockfile: status 7); the worktree itself is created. To retry: cd $wt && pnpm install --frozen-lockfile" "D8 one warning with the retry"
  assert_not_contains "$OUT" "Dependencies installed" "D8 no success line"
}
test_D9_no_install_only_shows_the_command() {
  node_repo d9 pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" --no-install feat
  assert_no_file "$STUB/pnpm.log" "D9 pnpm is not run (before the name)"
  assert_contains "$OUT" "Dependencies are not installed (--no-install). To install them: cd $REPO/.git/worktree/feat && pnpm install --frozen-lockfile" "D9 the command is shown (before the name)"
  run_create "$AGENT_VM_MARKER" feat2 --no-install
  assert_no_file "$STUB/pnpm.log" "D9 pnpm is not run (after the name)"
  assert_contains "$OUT" "Dependencies are not installed (--no-install). To install them: cd $REPO/.git/worktree/feat2 && pnpm install --frozen-lockfile" "D9 the command is shown (after the name)"
}
test_D10_missing_package_manager_is_reported() {
  node_repo d10 bun.lock
  skip_if_real bun D10 || return 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "D10 exit 0"
  assert_contains "$OUT" "(bun is not on PATH). Once it is: cd $REPO/.git/worktree/feat && bun install --frozen-lockfile" "D10 names the pm and the command"
}
test_D17_package_json_alone_is_silent() {
  node_repo d17
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_no_file "$STUB/pnpm.log" "D17 pnpm is not run"
  assert_not_contains "$OUT" "ependenc" "D17 no line about dependencies"
}
test_D26_two_package_manager_lines() {
  make_repo d26
  commit_file package.json $'{"x": "packageManager",\n"packageManager": "pnpm@10.0.0"}'
  commit_file pnpm-lock.yaml
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "D26 exit 0"
  assert_dir "$REPO/.git/worktree/feat" "D26 the worktree is created"
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D26 falls back to the lockfile"
}
test_D20_stdin_is_not_passed_to_the_install() {
  node_repo d20 pnpm-lock.yaml
  printf '#!/bin/sh\ncat >%q\n' "$STUB/pnpm.stdin" >"$STUB/pnpm"
  chmod +x "$STUB/pnpm"
  OUT=$(cd "$REPO" && printf 'typed\n' | AGENT_VM_MARKER="$AGENT_VM_MARKER" PATH="$STUB:$BASE_PATH" bash "$CREATE" feat 2>&1) && STATUS=0 || STATUS=$?
  if [[ -e "$STUB/pnpm.stdin" ]]; then record "PASS D20 the install ran"; else record "FAIL D20 the install ran (no stdin file)"; fi
  assert_eq 0 "$(wc -c <"$STUB/pnpm.stdin" | tr -d ' ')" "D20 stdin is empty"
}

# ---- セキュリティ ------------------------------------------------------------------------
test_D21_origin_branch_is_only_shown() {
  node_repo d21 pnpm-lock.yaml
  push_origin_branch d21 remote-feat
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" remote-feat
  local wt=$REPO/.git/worktree/remote-feat
  assert_dir "$wt" "D21 the worktree is created"
  assert_no_file "$STUB/pnpm.log" "D21 pnpm is not run"
  assert_contains "$OUT" "Dependencies are not installed (not run automatically because the branch comes from origin; an install runs the scripts of its package.json, so review them first). To install them: cd $wt && pnpm install --frozen-lockfile" "D21 the reason and the command"
}
test_D24_relative_path_entry_is_not_used() {
  node_repo d24 pnpm-lock.yaml
  skip_if_real pnpm D24 || return 0
  mkdir "$REPO/relbin"
  printf '#!/bin/sh\necho ran >>%q\n' "$STUB/pnpm.log" >"$REPO/relbin/pnpm"
  chmod +x "$REPO/relbin/pnpm"
  OUT=$(cd "$REPO" && AGENT_VM_MARKER="$AGENT_VM_MARKER" PATH="relbin:$BASE_PATH" bash "$CREATE" feat 2>&1) && STATUS=0 || STATUS=$?
  assert_no_file "$STUB/pnpm.log" "D24 the relative pnpm is not run"
  assert_contains "$OUT" "(pnpm is not on PATH)" "D24 reported as missing"
}

# ---- 互換性: agent-vm and install ------------------------------------------------------
test_D11_vm_attach_failure_installs_nothing() {
  node_repo d11 pnpm-lock.yaml
  stub agent-vm-node-modules 1
  stub pnpm 0
  run_create "$VM_MARKER" feat
  assert_no_file "$STUB/pnpm.log" "D11 pnpm is not run"
  assert_contains "$OUT" "do not install there until this succeeds" "D11 the attach warning stays"
  assert_not_contains "$OUT" "ependencies are not installed" "D11 no second warning"
}
test_D12_vm_without_the_helper_installs_nothing() {
  node_repo d12 pnpm-lock.yaml
  stub pnpm 0
  run_create "$VM_MARKER" feat
  assert_no_file "$STUB/pnpm.log" "D12 pnpm is not run"
  assert_contains "$OUT" "dependencies are not installed in $REPO/.git/worktree/feat (agent-vm-node-modules is missing, so node_modules here is shared with the host); recreate the machine from the host: agent-vm rm $REPO" "D12 the reason and the recovery"
}
test_D13_vm_installs_after_the_attach() {
  node_repo d13 pnpm-lock.yaml
  stub agent-vm-node-modules 0
  stub pnpm 0
  run_create "$VM_MARKER" feat
  assert_eq $'attach\n'"$REPO/.git/worktree/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "D13 attach <worktree>"
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D13 pnpm install --frozen-lockfile"
}
test_D14_host_installs_before_the_sync() {
  node_repo d14 pnpm-lock.yaml
  stub pnpm 0
  {
    printf '#!/bin/sh\n'
    printf 'if [ -e %q ]; then echo after-install >%q; fi\n' "$STUB/pnpm.log" "$STUB/order"
    printf 'exit 3\n'
  } >"$STUB/agent-vm"
  chmod +x "$STUB/agent-vm"
  run_create "$AGENT_VM_MARKER" feat
  assert_eq $'install\n--frozen-lockfile' "$(cat "$STUB/pnpm.log")" "D14 pnpm install --frozen-lockfile"
  assert_eq "after-install" "$(cat "$STUB/order")" "D14 the sync comes after the install"
  assert_contains "$OUT" "(agent-vm node-modules-sync: status 3)" "D14 the sync warning stays"
}
test_D23_vm_attach_failure_hides_the_conflict() {
  node_repo d23 pnpm-lock.yaml bun.lock
  stub agent-vm-node-modules 1
  run_create "$VM_MARKER" feat
  assert_not_contains "$OUT" "install with the project's package manager" "D23 no advice to install"
}
test_D28_vm_without_the_helper_wins_over_conflict() {
  node_repo d28 pnpm-lock.yaml bun.lock
  run_create "$VM_MARKER" feat
  assert_contains "$OUT" "agent-vm-node-modules is missing" "D28 the helper warning"
  assert_not_contains "$OUT" "install with the project's package manager" "D28 no advice to install"
}
test_D29_vm_no_install_without_the_helper() {
  node_repo d29 pnpm-lock.yaml
  stub pnpm 0
  run_create "$VM_MARKER" --no-install feat
  assert_contains "$OUT" "agent-vm-node-modules is missing" "D29 the helper warning"
  assert_not_contains "$OUT" "To install them" "D29 no advice to install"
}

# ---- 互換性: arguments --------------------------------------------------------------
test_D15_unknown_option_creates_nothing() {
  make_repo d15
  run_create "$AGENT_VM_MARKER" --bogus feat
  assert_eq 1 "$STATUS" "D15 exit 1"
  assert_no_file "$REPO/.git/worktree/feat" "D15 no worktree"
  assert_contains "$OUT" "Unknown option: --bogus" "D15 names the option"
}
test_D18_help_exits_zero() {
  make_repo d18
  run_create "$AGENT_VM_MARKER" --help
  assert_eq 0 "$STATUS" "D18 exit 0"
  assert_contains "$OUT" "--no-install" "D18 help lists --no-install"
}
test_D19_no_arguments_exit_one() {
  make_repo d19
  run_create "$AGENT_VM_MARKER"
  assert_eq 1 "$STATUS" "D19 exit 1"
  assert_contains "$OUT" "Branch name is required" "D19 says why"
}
test_D30_help_word_after_the_name_is_not_help() {
  make_repo d30
  run_create "$AGENT_VM_MARKER" feat help
  assert_eq 0 "$STATUS" "D30 exit 0"
  assert_dir "$REPO/.git/worktree/feat" "D30 the worktree is created"
}
test_D31_help_flag_anywhere_creates_nothing() {
  make_repo d31
  run_create "$AGENT_VM_MARKER" feat --help
  assert_eq 0 "$STATUS" "D31 exit 0"
  assert_contains "$OUT" "Usage:" "D31 help is shown"
  assert_no_file "$REPO/.git/worktree/feat" "D31 no worktree"
}
test_D32_the_shown_path_is_quoted() {
  make_repo "d 32"
  run_create "$AGENT_VM_MARKER" feat
  assert_contains "$OUT" "To switch to this worktree: cd $(printf '%q' "$REPO/.git/worktree/feat")" "D32 quoted path"
}
test_D27_later_names_are_ignored() {
  make_repo d27
  run_create "$AGENT_VM_MARKER" a b
  assert_eq 0 "$STATUS" "D27 exit 0"
  assert_dir "$REPO/.git/worktree/a" "D27 the first name is used"
  assert_no_file "$REPO/.git/worktree/b" "D27 the second is ignored"
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
