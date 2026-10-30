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
  HOME="$TMP_BASE/$1/home"
  mkdir -p "$HOME"
  export HOME
  REPO=$(cd -P "$TMP_BASE/$1/repo" && pwd -P)
  WORKTREE_ROOT="$HOME/worktrees/${REPO##*/}"
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
  stub agent-vm-node-modules 0 "mounted	$WORKTREE_ROOT/feat"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C1 exit 0"
  assert_dir "$WORKTREE_ROOT/feat" "C1 worktree created"
  assert_eq $'attach\n'"$WORKTREE_ROOT/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C1 attach <worktree>"
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
  assert_dir "$WORKTREE_ROOT/feat" "C2 worktree kept"
  assert_contains "$OUT" "could not mount a VM-local node_modules" "C2 the helper's stderr is shown"
  assert_contains "$OUT" "node_modules of $WORKTREE_ROOT/feat may be shared with the host (agent-vm-node-modules attach: status 1); do not install there until this succeeds: agent-vm-node-modules attach $WORKTREE_ROOT/feat" "C2 one warning with the recovery"
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
  assert_contains "$OUT" "the running agent-vm machine may not have VM-local node_modules for $WORKTREE_ROOT/feat yet (agent-vm node-modules-sync: status 3); the next agent-vm launch syncs it" "C6 one context line"
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
  assert_contains "$OUT" "Worktree created: $WORKTREE_ROOT/feat" "C7 the usual output"
  assert_eq "$(cd -P "$REPO/.git" && pwd -P)" "$(cat "$WORKTREE_ROOT/.common-dir")" "C7 common-dir marker"
}

test_create_from_linked_worktree_uses_main_repo_location() {
  make_repo linked
  local linked_repo="$TMP_BASE/linked/linked"
  git -C "$REPO" worktree add -q -b linked-source "$linked_repo"
  OUT=$(cd "$linked_repo" && AGENT_VM_MARKER="$AGENT_VM_MARKER" PATH="$STUB:$BASE_PATH" bash "$CREATE" --no-install feat 2>&1) && STATUS=0 || STATUS=$?
  assert_eq 0 "$STATUS" "linked worktree creation exits 0"
  assert_dir "$WORKTREE_ROOT/feat" "linked worktree uses the main repo root"
  assert_eq "$(cd -P "$REPO/.git" && pwd -P)" "$(cat "$WORKTREE_ROOT/.common-dir")" "linked worktree marker uses the main common dir"
}

test_conflicting_location_marker_fails_before_branch_or_registration() {
  make_repo marker-conflict
  local other="$TMP_BASE/marker-conflict/other"
  git -C "$TMP_BASE/marker-conflict" init -q "$other"
  mkdir -p "$WORKTREE_ROOT"
  printf '%s\n' "$(cd -P "$other/.git" && pwd -P)" >"$WORKTREE_ROOT/.common-dir"
  local marker_before; marker_before=$(cat "$WORKTREE_ROOT/.common-dir")
  run_create "$AGENT_VM_MARKER" --no-install feat
  assert_eq 1 "$STATUS" "marker conflict exits 1"
  assert_contains "$OUT" "$WORKTREE_ROOT/.common-dir" "marker conflict names the marker path"
  assert_not_contains "$OUT" "$marker_before" "marker content stays out of stderr"
  assert_eq "$marker_before" "$(cat "$WORKTREE_ROOT/.common-dir")" "marker is unchanged"
  assert_eq "" "$(git -C "$REPO" branch --list worktree-feat)" "no branch created"
  assert_not_contains "$(git -C "$REPO" worktree list --porcelain)" "$WORKTREE_ROOT/feat" "no registration created"
}
test_C8_paths_with_a_space_stay_one_argument() {
  make_repo "c 8"
  stub agent-vm-node-modules 0
  run_create "$VM_MARKER" feat
  assert_eq $'attach\n'"$WORKTREE_ROOT/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C8 VM: one argument"
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
  assert_eq "$WORKTREE_ROOT/feat" "$(cat "$STUB/pnpm.cwd")" "D1 runs in the worktree"
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
  assert_eq "$WORKTREE_ROOT/feat" "$(cat "$STUB/pnpm.cwd")" "D16 one path with a space"
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
  assert_contains "${OUT%%Installing dependencies*}" "To switch to this worktree: cd $WORKTREE_ROOT/feat" "D25 the path is shown first"
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
  assert_contains "$OUT" "Dependencies are not installed (yarn is not run automatically). To install them: cd $WORKTREE_ROOT/feat && yarn install" "D4 the command is shown"
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
  assert_contains "$OUT" "Dependencies are not installed (pnpm has no lockfile here, and an install would write one). To install them: cd $WORKTREE_ROOT/feat && pnpm install" "D5 the command is shown"
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
  local wt=$WORKTREE_ROOT/feat
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
  assert_contains "$OUT" "Dependencies are not installed (--no-install). To install them: cd $WORKTREE_ROOT/feat && pnpm install --frozen-lockfile" "D9 the command is shown (before the name)"
  run_create "$AGENT_VM_MARKER" feat2 --no-install
  assert_no_file "$STUB/pnpm.log" "D9 pnpm is not run (after the name)"
  assert_contains "$OUT" "Dependencies are not installed (--no-install). To install them: cd $WORKTREE_ROOT/feat2 && pnpm install --frozen-lockfile" "D9 the command is shown (after the name)"
}
test_D10_missing_package_manager_is_reported() {
  node_repo d10 bun.lock
  skip_if_real bun D10 || return 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "D10 exit 0"
  assert_contains "$OUT" "(bun is not on PATH). Once it is: cd $WORKTREE_ROOT/feat && bun install --frozen-lockfile" "D10 names the pm and the command"
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
  assert_dir "$WORKTREE_ROOT/feat" "D26 the worktree is created"
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
  local wt=$WORKTREE_ROOT/remote-feat
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
  assert_contains "$OUT" "dependencies are not installed in $WORKTREE_ROOT/feat (agent-vm-node-modules is missing, so node_modules here is shared with the host); recreate the machine from the host: agent-vm rm $REPO" "D12 the reason and the recovery"
}
test_D13_vm_installs_after_the_attach() {
  node_repo d13 pnpm-lock.yaml
  stub agent-vm-node-modules 0
  stub pnpm 0
  run_create "$VM_MARKER" feat
  assert_eq $'attach\n'"$WORKTREE_ROOT/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "D13 attach <worktree>"
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
  assert_no_file "$WORKTREE_ROOT/feat" "D15 no worktree"
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
test_D31_help_flag_anywhere_creates_nothing() {
  make_repo d31
  run_create "$AGENT_VM_MARKER" feat --help
  assert_eq 0 "$STATUS" "D31 exit 0"
  assert_contains "$OUT" "Usage:" "D31 help is shown"
  assert_no_file "$WORKTREE_ROOT/feat" "D31 no worktree"
}
test_D32_the_shown_path_is_quoted() {
  make_repo "d 32"
  run_create "$AGENT_VM_MARKER" feat
  assert_contains "$OUT" "To switch to this worktree: cd $(printf '%q' "$WORKTREE_ROOT/feat")" "D32 quoted path"
}

# ---- base argument and start-point report ------------------------------------------------
# run_create_split <marker> <args...>: like run_create, with stderr kept apart in $ERR (and not in $OUT)
run_create_split() {
  local errf="$TMP_BASE/split-stderr"
  OUT=$(cd "$REPO" && AGENT_VM_MARKER="$1" PATH="$STUB:$BASE_PATH" bash "$CREATE" "${@:2}" 2>"$errf") && STATUS=0 || STATUS=$?
  ERR=$(<"$errf")
}
# behind_repo <name>: $REPO's main tracks origin/main and, as of the last fetch, is one commit behind it
behind_repo() {
  make_repo "$1"
  push_origin_branch "$1" main
  git -C "$REPO" branch -q --set-upstream-to=origin/main main
  git clone -q "$TMP_BASE/$1/origin.git" "$TMP_BASE/$1/other"
  git -C "$TMP_BASE/$1/other" commit -q --allow-empty -m upstream-ahead
  git -C "$TMP_BASE/$1/other" push -q origin HEAD:refs/heads/main
  git -C "$REPO" fetch -q origin
}
# assert_no_upstream <worktree> <branch> <label>
assert_no_upstream() {
  if git -C "$1" rev-parse --abbrev-ref "$2@{upstream}" >/dev/null 2>&1; then record "FAIL $3 (has an upstream)"; else record "PASS $3"; fi
}
# creating_suffix: what follows "from " on the stdout line "Creating new branch", without the closing color code
creating_suffix() {
  local line
  line=$(grep 'Creating new branch' <<<"$OUT")
  line=${line%$'\e[0m'}
  printf '%s' "${line#*from }"
}
# reject_case <label> <message> <args...>: exit 1, the message, no worktree, and no control byte of the arguments
# (the color codes of the Error line are removed first; they are the only ESC the script prints itself)
reject_case() {
  local clean
  run_create "$AGENT_VM_MARKER" "${@:3}"
  assert_eq 1 "$STATUS" "$1 exit 1"
  assert_contains "$OUT" "$2" "$1 message"
  assert_no_file "$WORKTREE_ROOT" "$1 nothing created"
  clean=${OUT//$'\e[0;31m'/}
  clean=${clean//$'\e[0m'/}
  for byte in $'\e' $'\r' $'\a' $'\x7f'; do
    assert_not_contains "$clean" "$byte" "$1 no control byte $(printf '%q' "$byte")"
  done
}

test_B1_base_is_the_start_point() {
  make_repo b1
  commit_file x
  git -C "$REPO" branch old HEAD~1
  run_create "$AGENT_VM_MARKER" feat old
  assert_eq 0 "$STATUS" "B1 exit 0"
  assert_eq "$(git -C "$REPO" rev-parse old)" "$(git -C "$WORKTREE_ROOT/feat" rev-parse HEAD)" "B1 HEAD is old"
  assert_contains "$OUT" "from 'old' ($(git -C "$REPO" rev-parse --short old))" "B1 start point shown"
}
test_B2_remote_tracking_base_gets_no_upstream() {
  make_repo b2
  push_origin_branch b2 base1
  commit_file x
  run_create "$AGENT_VM_MARKER" feat origin/base1
  assert_eq 0 "$STATUS" "B2 exit 0"
  assert_eq "$(git -C "$REPO" rev-parse origin/base1)" "$(git -C "$WORKTREE_ROOT/feat" rev-parse HEAD)" "B2 HEAD is origin/base1"
  assert_no_upstream "$WORKTREE_ROOT/feat" feat "B2 no upstream"
  assert_not_contains "$OUT" "behind" "B2 a remote-tracking start point is not compared"
}
test_B2b_autosetupmerge_always_still_no_upstream() {
  make_repo b2b
  push_origin_branch b2b base1
  git -C "$REPO" config branch.autoSetupMerge always
  run_create "$AGENT_VM_MARKER" feat origin/base1
  assert_eq 0 "$STATUS" "B2b exit 0"
  assert_no_upstream "$WORKTREE_ROOT/feat" feat "B2b no upstream"
}
test_B3_base_with_a_local_branch_is_refused() {
  make_repo b3
  git -C "$REPO" branch old
  git -C "$REPO" branch feat
  run_create "$AGENT_VM_MARKER" feat old
  assert_eq 1 "$STATUS" "B3 exit 1"
  assert_contains "$OUT" "already exists (refs/heads/feat)" "B3 names the ref"
  assert_no_file "$WORKTREE_ROOT" "B3 nothing created"
}
test_B4_base_with_an_origin_branch_is_refused() {
  make_repo b4
  push_origin_branch b4 feat
  run_create "$AGENT_VM_MARKER" feat HEAD
  assert_eq 1 "$STATUS" "B4 exit 1"
  assert_contains "$OUT" "already exists (refs/remotes/origin/feat)" "B4 names the ref"
  assert_no_file "$WORKTREE_ROOT" "B4 nothing created"
}
test_B4b_existing_branch_is_reported_before_a_bad_base() {
  make_repo b4b
  git -C "$REPO" branch feat
  run_create "$AGENT_VM_MARKER" feat no-such-ref
  assert_contains "$OUT" "already exists" "B4b the branch check comes first"
  assert_not_contains "$OUT" "Not a commit" "B4b the base is not looked at"
}
test_B5_unknown_base_is_refused() {
  make_repo b5
  run_create "$AGENT_VM_MARKER" feat no-such-ref
  assert_eq 1 "$STATUS" "B5 exit 1"
  assert_contains "$OUT" "Not a commit: no-such-ref" "B5 message"
  assert_no_file "$WORKTREE_ROOT" "B5 nothing created"
}
test_B5b_unknown_base_creates_no_worktree_dir() {
  make_repo b5b
  mkdir -p "$WORKTREE_ROOT"
  run_create "$AGENT_VM_MARKER" feat no-such-ref
  assert_eq 1 "$STATUS" "B5b exit 1"
  assert_no_file "$WORKTREE_ROOT/feat" "B5b no worktree"
}
test_B6_a_third_argument_is_refused() {
  make_repo b6
  run_create "$AGENT_VM_MARKER" a b c
  assert_eq 1 "$STATUS" "B6 exit 1"
  assert_contains "$OUT" "Too many arguments: c" "B6 message"
  assert_no_file "$WORKTREE_ROOT" "B6 nothing created"
}
test_B6b_help_word_in_second_position_is_a_base() {
  make_repo b6b
  run_create "$AGENT_VM_MARKER" feat help
  assert_eq 1 "$STATUS" "B6b exit 1"
  assert_contains "$OUT" "Not a commit: help" "B6b message"
  assert_no_file "$WORKTREE_ROOT" "B6b nothing created"
}
test_B6c_to_e_rejected_arguments() {
  make_repo b6c
  git -C "$REPO" switch -q -c other
  git -C "$REPO" switch -q main
  reject_case "B6c a/../x" "Not a valid branch name" feat/../x
  reject_case "B6c @{-1}" "Not a valid branch name" '@{-1}'
  reject_case "B6c HEAD" "Not a valid branch name" HEAD
  reject_case "B6d base -x" "Unknown option" feat -x
  reject_case "B6d base --upload-pack" "Unknown option" feat --upload-pack=x
  reject_case "B6d name -x" "Unknown option" -x
  reject_case "B6e base ESC" "Not a commit:" feat $'\e[31mx'
  reject_case "B6e third ESC" "Too many arguments:" a b $'\e[31mx'
  reject_case "B6e name ESC" "Not a valid branch name" $'\e[31mx'
  reject_case "B6e option ESC" "Unknown option" -$'\e'x
  reject_case "B6e base CR BEL DEL" "Not a commit: abxy" feat $'a\rb\ax\x7fy'
}
test_B6f_help_wins_over_the_argument_count() {
  make_repo b6f
  run_create "$AGENT_VM_MARKER" a b c --help
  assert_eq 0 "$STATUS" "B6f exit 0"
  assert_contains "$OUT" "Usage:" "B6f help is shown"
  assert_no_file "$WORKTREE_ROOT" "B6f nothing created"
}
test_B7_behind_start_point_warns_and_annotates() {
  behind_repo b7
  run_create "$AGENT_VM_MARKER" feat HEAD
  assert_eq 0 "$STATUS" "B7 exit 0"
  assert_contains "$OUT" "'main' is 1 commit(s) behind origin/main (as of the last fetch)" "B7 warning"
  assert_contains "$OUT" "merge --ff-only refs/remotes/origin/main" "B7 catch-up step"
  assert_not_contains "${OUT%%To switch to this worktree*}" "To switch" "B7 sanity"
  assert_contains "${OUT%%To switch to this worktree*}" "commit(s) behind" "B7 the warning comes before the path"
  run_create_split "$AGENT_VM_MARKER" feat2 HEAD
  assert_eq "'HEAD' ($(git -C "$REPO" rev-parse --short main)), 1 behind origin/main" "$(creating_suffix)" "B7 stdout line ends with the count"
  assert_contains "$ERR" "commit(s) behind" "B7 the warning is on stderr"
  assert_not_contains "$OUT" "merge --ff-only" "B7 no catch-up step on stdout"
}
test_B7b_sha_and_tag_start_points_are_not_compared() {
  behind_repo b7b
  git -C "$REPO" tag t1 main
  run_create "$AGENT_VM_MARKER" feat "$(git -C "$REPO" rev-parse main)"
  assert_eq 0 "$STATUS" "B7b sha exit 0"
  assert_not_contains "$OUT" "behind" "B7b sha not compared"
  run_create "$AGENT_VM_MARKER" feat2 t1
  assert_eq 0 "$STATUS" "B7b tag exit 0"
  assert_not_contains "$OUT" "behind" "B7b tag not compared"
}
test_B7c_diverged_start_point() {
  behind_repo b7c
  commit_file x
  run_create_split "$AGENT_VM_MARKER" feat HEAD
  assert_eq 0 "$STATUS" "B7c exit 0"
  assert_contains "$ERR" "has diverged from origin/main" "B7c warning"
  assert_not_contains "$OUT$ERR" "merge --ff-only" "B7c no catch-up step"
  assert_eq "'HEAD' ($(git -C "$REPO" rev-parse --short main)), diverged from origin/main" "$(creating_suffix)" "B7c stdout line"
  assert_not_contains "$OUT" "behind" "B7c stdout has no behind"
}
test_B8_branch_start_points_are_compared() {
  behind_repo b8
  run_create "$AGENT_VM_MARKER" feat main
  assert_contains "$OUT" "'main' is 1 commit(s) behind origin/main" "B8 base main"
  run_create "$AGENT_VM_MARKER" feat2 HEAD
  assert_contains "$OUT" "'main' is 1 commit(s) behind origin/main" "B8 base HEAD"
  run_create "$AGENT_VM_MARKER" feat3 @
  assert_contains "$OUT" "'main' is 1 commit(s) behind origin/main" "B8 base @"
}
test_B9_no_upstream_no_comparison() {
  make_repo b9
  run_create "$AGENT_VM_MARKER" feat
  assert_not_contains "$OUT" "behind" "B9 no behind"
  assert_contains "$OUT" "from 'main' ($(git -C "$REPO" rev-parse --short HEAD))" "B9 start point shown"
}
test_B10_up_to_date_upstream_is_silent() {
  make_repo b10
  push_origin_branch b10 main
  git -C "$REPO" branch -q --set-upstream-to=origin/main main
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "B10 exit 0"
  assert_not_contains "$OUT" "behind" "B10 no behind"
}
test_B11_no_install_with_a_base_in_either_order() {
  make_repo b11
  commit_file x
  git -C "$REPO" branch old HEAD~1
  run_create "$AGENT_VM_MARKER" --no-install feat old
  assert_eq 0 "$STATUS" "B11 flag first: exit 0"
  assert_eq "$(git -C "$REPO" rev-parse old)" "$(git -C "$WORKTREE_ROOT/feat" rev-parse HEAD)" "B11 flag first: HEAD"
  run_create "$AGENT_VM_MARKER" feat2 old --no-install
  assert_eq 0 "$STATUS" "B11 flag last: exit 0"
  assert_eq "$(git -C "$REPO" rev-parse old)" "$(git -C "$WORKTREE_ROOT/feat2" rev-parse HEAD)" "B11 flag last: HEAD"
}
test_B12_detached_head_is_named() {
  make_repo b12
  git -C "$REPO" checkout -q --detach
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "B12 exit 0"
  assert_contains "$OUT" "from 'detached HEAD'" "B12 named"
  assert_not_contains "$OUT" "behind" "B12 no behind"
}
test_B13_origin_branch_keeps_its_upstream() {
  make_repo b13
  push_origin_branch b13 feat
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "B13 exit 0"
  assert_eq "origin/feat" "$(git -C "$WORKTREE_ROOT/feat" rev-parse --abbrev-ref 'feat@{upstream}')" "B13 upstream"
}
test_B14_catch_up_step_quotes_the_upstream() {
  behind_repo b14
  git -C "$REPO" push -q origin 'HEAD:refs/heads/a;b'
  git -C "$REPO" fetch -q origin
  git -C "$REPO" branch -q --track x 'origin/a;b'
  git -C "$TMP_BASE/b14/other" push -q origin 'HEAD:refs/heads/a;b'
  git -C "$REPO" fetch -q origin
  run_create "$AGENT_VM_MARKER" feat x
  assert_eq 0 "$STATUS" "B14 exit 0"
  assert_contains "$OUT" 'merge --ff-only refs/remotes/origin/a\;b' "B14 quoted upstream"
}
test_B15_broken_upstream_does_not_stop_the_creation() {
  node_repo b15 pnpm-lock.yaml
  push_origin_branch b15 main
  git -C "$REPO" config branch.main.remote origin
  git -C "$REPO" config branch.main.merge refs/heads/missing
  stub pnpm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "B15 exit 0"
  assert_not_contains "$OUT" "behind" "B15 no behind"
  assert_not_contains "$OUT" "fatal:" "B15 no git error"
  assert_contains "$OUT" "To switch to this worktree" "B15 the path is shown"
  assert_contains "$OUT" "Dependencies installed" "B15 the install ran"
}
test_B16_tag_and_branch_with_the_same_name() {
  make_repo b16
  git -C "$REPO" branch dup
  commit_file x
  git -C "$REPO" tag dup
  push_origin_branch b16 dup
  git -C "$REPO" branch -q --set-upstream-to=origin/dup dup
  run_create "$AGENT_VM_MARKER" feat dup
  assert_eq 0 "$STATUS" "B16 exit 0"
  assert_eq "$(git -C "$REPO" rev-parse 'dup^{commit}' 2>/dev/null)" "$(git -C "$WORKTREE_ROOT/feat" rev-parse HEAD)" "B16 HEAD is the tag's commit"
  assert_not_contains "$OUT" "behind" "B16 no behind"
  assert_not_contains "$OUT" "ambiguous" "B16 no git warning"
}

# ---- default start point: the origin's default branch, fetched first ------------------------
# clone_repo <name>: $REPO is a clone of a bare origin whose main has one commit, so origin/HEAD exists; $OTHER is a
# second clone of it, for moving the origin ahead without $REPO fetching
clone_repo() {
  HOME="$TMP_BASE/$1/home"
  mkdir -p "$HOME"
  export HOME
  mkdir -p "$TMP_BASE/$1/bin" "$TMP_BASE/$1/seed"
  STUB="$TMP_BASE/$1/bin"
  git init -q --bare "$TMP_BASE/$1/origin.git"
  git -C "$TMP_BASE/$1/origin.git" symbolic-ref HEAD refs/heads/main
  git -C "$TMP_BASE/$1/seed" init -q
  git -C "$TMP_BASE/$1/seed" commit -q --allow-empty -m init
  git -C "$TMP_BASE/$1/seed" push -q "$TMP_BASE/$1/origin.git" HEAD:refs/heads/main
  git clone -q "$TMP_BASE/$1/origin.git" "$TMP_BASE/$1/repo" 2>/dev/null
  git clone -q "$TMP_BASE/$1/origin.git" "$TMP_BASE/$1/other" 2>/dev/null
  REPO=$(cd -P "$TMP_BASE/$1/repo" && pwd -P)
  WORKTREE_ROOT="$HOME/worktrees/${REPO##*/}"
  OTHER="$TMP_BASE/$1/other"
}
# origin_advance: one more commit on the origin's main, pushed from $OTHER ($REPO does not fetch it)
origin_advance() {
  git -C "$OTHER" commit -q --allow-empty -m upstream-ahead
  git -C "$OTHER" push -q origin HEAD:refs/heads/main
}
# break_origin: the origin's URL points at a path that does not exist, so every fetch fails
break_origin() { git -C "$REPO" remote set-url origin "$TMP_BASE/no-such-origin.git"; }
wt_head() { git -C "$WORKTREE_ROOT/$1" rev-parse HEAD; }

test_N1_default_start_is_the_fetched_origin_default_branch() {
  clone_repo n1
  origin_advance
  run_create_split "$AGENT_VM_MARKER" feat
  local new
  new=$(git -C "$OTHER" rev-parse HEAD)
  assert_eq 0 "$STATUS" "N1 exit 0"
  assert_eq "$new" "$(wt_head feat)" "N1 HEAD is the new origin/main"
  assert_eq "'origin/main' ($(git -C "$OTHER" rev-parse --short HEAD))" "$(creating_suffix)" "N1 Creating line"
  assert_no_upstream "$WORKTREE_ROOT/feat" feat "N1 no upstream"
}
test_N2_explicit_head_keeps_the_local_branch() {
  clone_repo n2
  origin_advance
  run_create_split "$AGENT_VM_MARKER" feat HEAD
  assert_eq 0 "$STATUS" "N2 exit 0"
  assert_eq "$(git -C "$REPO" rev-parse main)" "$(wt_head feat)" "N2 HEAD is the local main"
  assert_eq "'HEAD' ($(git -C "$REPO" rev-parse --short main)), 1 behind origin/main" "$(creating_suffix)" "N2 the lag is seen after the fetch"
}
test_N3_fetch_failure_warns_and_uses_the_last_fetch() {
  clone_repo n3
  break_origin
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N3 exit 0"
  assert_contains "$ERR" "Could not fetch origin (status " "N3 warning"
  assert_not_contains "$ERR" "status 0" "N3 the status is not 0"
  assert_not_contains "$OUT$ERR" "fatal:" "N3 no git error"
  assert_eq "$(git -C "$REPO" rev-parse origin/main)" "$(wt_head feat)" "N3 HEAD is the last fetched origin/main"
  case "$(creating_suffix)" in *", not fetched") record "PASS N3 Creating line ends with not fetched" ;; *) record "FAIL N3 Creating line ends with not fetched" ;; esac
}
test_N4_unknown_default_branch_falls_back_to_head() {
  behind_repo n4
  git -C "$TMP_BASE/n4/origin.git" symbolic-ref HEAD refs/heads/nonexistent
  # git >= 2.48 creates origin/HEAD on fetch (followRemoteHEAD), so the fixture's fetch already left a valid one
  git -C "$REPO" config remote.origin.followRemoteHEAD never
  git -C "$REPO" remote set-head origin -d >/dev/null 2>&1 || true
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N4 exit 0"
  assert_contains "$ERR" "origin's default branch is unknown" "N4 warning"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(wt_head feat)" "N4 HEAD of the repo"
  assert_eq "'main' ($(git -C "$REPO" rev-parse --short HEAD)), 1 behind origin/main" "$(creating_suffix)" "N4 lag is compared on fallback"
}
test_N4b_missing_origin_head_is_set_by_set_head() {
  clone_repo n4b
  git -C "$REPO" remote set-head origin --delete >/dev/null
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N4b exit 0"
  assert_eq "$(git -C "$REPO" rev-parse origin/main)" "$(wt_head feat)" "N4b HEAD is origin/main"
  assert_not_contains "$ERR" "unknown" "N4b no warning"
  assert_eq "refs/remotes/origin/main" "$(git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD)" "N4b origin/HEAD was created"
}
test_N5_no_origin_means_head_without_warnings() {
  make_repo n5
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N5 exit 0"
  assert_not_contains "$ERR" "default branch is unknown" "N5 no unknown warning"
  assert_not_contains "$ERR" "Could not fetch" "N5 no fetch warning"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(wt_head feat)" "N5 HEAD"
}
test_N6_local_branch_does_not_fetch() {
  clone_repo n6
  break_origin
  git -C "$REPO" branch exist
  run_create_split "$AGENT_VM_MARKER" exist
  assert_eq 0 "$STATUS" "N6 exit 0"
  assert_not_contains "$ERR" "Could not fetch" "N6 not fetched"
}
test_N7_fetch_finds_a_branch_pushed_later() {
  clone_repo n7
  git -C "$OTHER" push -q origin HEAD:refs/heads/late
  run_create_split "$AGENT_VM_MARKER" late
  assert_eq 0 "$STATUS" "N7 exit 0"
  assert_contains "$OUT" "exists on remote" "N7 the origin branch is used"
  assert_eq "origin/late" "$(git -C "$WORKTREE_ROOT/late" rev-parse --abbrev-ref 'late@{upstream}')" "N7 upstream"
}
test_N8_explicit_base_is_resolved_after_the_fetch() {
  clone_repo n8
  origin_advance
  run_create_split "$AGENT_VM_MARKER" feat origin/main
  assert_eq "$(git -C "$OTHER" rev-parse HEAD)" "$(wt_head feat)" "N8 HEAD is the new origin/main"
}
test_N9_existing_branch_check_comes_after_the_fetch() {
  clone_repo n9
  git -C "$OTHER" push -q origin HEAD:refs/heads/late
  run_create "$AGENT_VM_MARKER" late origin/main
  assert_eq 1 "$STATUS" "N9 exit 1"
  assert_contains "$OUT" "already exists (refs/remotes/origin/late)" "N9 names the ref"
  assert_no_file "$WORKTREE_ROOT/late" "N9 nothing created"
}
test_N10_dangling_origin_head_falls_back_to_head() {
  clone_repo n10
  git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/gone
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N10 exit 0"
  assert_contains "$ERR" "default branch is unknown" "N10 warning"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(wt_head feat)" "N10 HEAD"
}
test_N10b_origin_head_outside_origin_falls_back_to_head() {
  clone_repo n10b
  git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/heads/main
  run_create_split "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "N10b exit 0"
  assert_contains "$ERR" "default branch is unknown" "N10b warning"
  assert_eq "$(git -C "$REPO" rev-parse HEAD)" "$(wt_head feat)" "N10b HEAD"
}
test_N12_a_stuck_fetch_is_cut_off() {
  if ! PATH="$BASE_PATH" command -v timeout >/dev/null 2>&1; then
    record "PASS N12 skipped (no timeout command)"
    return 0
  fi
  clone_repo n12
  git -C "$REPO" remote set-url origin ssh://example.invalid/x
  local t0 t1
  t0=$(date +%s%N)
  GIT_SSH_COMMAND='sh -c "sleep 30" --' GIT_WORKTREE_CREATE_FETCH_TIMEOUT=1 run_create_split "$AGENT_VM_MARKER" feat
  t1=$(date +%s%N)
  assert_eq 0 "$STATUS" "N12 exit 0"
  assert_contains "$ERR" "Could not fetch origin (status 124)" "N12 timed out"
  case "$(creating_suffix)" in *", not fetched") record "PASS N12 not fetched shown" ;; *) record "FAIL N12 not fetched shown" ;; esac
  local ms=$(((t1 - t0) / 1000000))
  if [[ $ms -ge 1000 && $ms -le 3000 ]]; then record "PASS N12 took ${ms} ms"; else record "FAIL N12 took ${ms} ms (expected 1000-3000)"; fi
}
test_N13_vm_with_an_unreachable_origin_still_attaches() {
  clone_repo n13
  break_origin
  stub agent-vm-node-modules 0 "mounted	x"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "N13 exit 0"
  assert_dir "$WORKTREE_ROOT/feat" "N13 worktree created"
  assert_eq $'attach\n'"$WORKTREE_ROOT/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "N13 attach <worktree>"
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
