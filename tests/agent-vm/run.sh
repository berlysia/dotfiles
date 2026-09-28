#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
LAUNCHER="$REPO_ROOT/home/dot_local/bin/executable_agent-vm"
TMP_BASE=$(mktemp -d -t agent-vm-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

test_help_exits_zero() {
  assert_status 0 "help exits 0" -- bash "$LAUNCHER" --help
}

test_machine_name_is_stable_and_sanitized() {
  local repo="$TMP_ROOT/My_Repo.Name-With-A-Very-Long-Tail"
  mkdir -p "$repo"
  local name; name=$(derive_machine_name "$repo")
  # lowercased, [^a-z0-9-] -> '-', first 20 chars ("my-repo-name-with-a-"), trailing '-' trimmed, then '-' + 6 hex
  case "$name" in
    agent-my-repo-name-with-a-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "PASS machine name pattern" ;;
    *) record "FAIL machine name pattern ($name)" ;;
  esac
  assert_eq "$name" "$(derive_machine_name "$repo")" "machine name stable"
}
test_machine_name_falls_back_for_symbol_only_basename() {
  case "$(derive_machine_name "$TMP_ROOT/___")" in
    agent-repo-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "PASS fallback base" ;;
    *) record "FAIL fallback base" ;;
  esac
}
test_worktree_resolves_to_main_repo_root() {
  local repo="$TMP_ROOT/wt-main"
  mkdir -p "$repo" && git -C "$repo" init -q
  git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$repo" worktree add -q "$repo/.git/worktree/feat" -b feat
  assert_eq "$(cd -P "$repo" && pwd -P)" "$(cd "$repo/.git/worktree/feat" && resolve_repo_root)" "worktree -> main root"
}
test_outside_git_repo_fails() {
  mkdir -p "$TMP_ROOT/plain"
  assert_status 1 "non-repo fails" -- bash -c "cd '$TMP_ROOT/plain' && GIT_CEILING_DIRECTORIES='$TMP_ROOT' AGENT_VM_LIB=1 . '$LAUNCHER' && resolve_repo_root"
}

test_meta_roundtrip_with_equals_in_path() {
  write_machine_meta agent-x-000000 "/tmp/a=b/repo"
  assert_eq "/tmp/a=b/repo" "$(read_meta_field agent-x-000000 repo_path)" "repo_path keeps '='"
  assert_eq "1" "$(read_meta_field agent-x-000000 format)" "format=1"
}
test_meta_rejects_newline_path() {
  # die exits, so run it in a child process like the other fail-closed tests
  assert_status 1 "newline path rejected" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; write_machine_meta agent-x-000000 \"\$(printf '/tmp/a\\nb')\""
}
test_exclude_prefix_on_directory_boundary() {
  mkdir -p "$AGENT_VM_CONFIG_DIR" "$TMP_ROOT/ex/repo" "$TMP_ROOT/ex/repo2"
  printf '# comment\n%s  # trailing comment\n' "$TMP_ROOT/ex/repo" >"$AGENT_VM_CONFIG_DIR/config"
  assert_status 0 "exact match excluded" -- is_excluded "$(cd -P "$TMP_ROOT/ex/repo" && pwd -P)"
  assert_status 1 "sibling with same prefix not excluded" -- is_excluded "$(cd -P "$TMP_ROOT/ex/repo2" && pwd -P)"
}
test_exclude_missing_config_means_not_excluded() {
  assert_status 1 "no config" -- is_excluded "$TMP_ROOT/any"
}

test_health_fails_closed_when_orb_hangs() {
  local out status=0 start end
  start=$(date +%s)
  out=$(STUB_ORB_SLEEP=5 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; check_health" 2>&1) || status=$?
  end=$(date +%s)
  assert_eq 1 "$status" "hung orb fails"
  assert_contains "$out" "AGENT_VM=off" "guidance printed"
  if [[ $((end - start)) -le 4 ]]; then record "PASS gives up within ~3s"; else record "FAIL gives up within ~3s ($((end - start))s)"; fi
}
test_health_fails_when_orb_missing() {
  local out status=0
  out=$(PATH="/usr/bin:/bin" bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; check_health" 2>&1) || status=$?
  assert_eq 1 "$status" "missing orb fails"
  assert_contains "$out" "AGENT_VM=off" "guidance printed"
}
test_working_tree_resolved_from_chezmoi_source_path() {
  local wt="$TMP_ROOT/dotfiles"; mkdir -p "$wt/home" && git -C "$wt" init -q
  assert_eq "$(cd -P "$wt" && pwd -P)" "$(cd -P "$(STUB_CHEZMOI_STDOUT="$wt/home" resolve_working_tree)" && pwd -P)" "workingTree = git toplevel of source-path"
}
test_working_tree_failure_fails_closed() {
  assert_status 1 "chezmoi failure fails closed" -- env STUB_CHEZMOI_EXIT=1 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; resolve_working_tree"
}

try_lock() { # machine -> exit status of a fresh process trying the lock for 1s
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1
}
test_second_acquirer_is_refused_while_held() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock agent-l-000000 1 && sleep 3" </dev/null &
  sleep 1
  local status=0; try_lock agent-l-000000 || status=$?
  assert_eq 1 "$status" "busy lock refused"
  wait
}
test_lock_released_when_holder_is_killed() {
  # exec (not a plain "sleep 30") so bash replaces itself in place: a forked child would
  # inherit fd 9 as a duplicate of the same open file description, and flock(2) only
  # releases once every duplicate fd is closed, so kill -9 on the parent PID alone
  # would leave the lock held by the orphaned child.
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock agent-k-000000 1 && exec sleep 30" </dev/null &
  local pid=$!
  sleep 1; kill -9 "$pid"; wait "$pid" 2>/dev/null || true
  local status=0; try_lock agent-k-000000 || status=$?
  assert_eq 0 "$status" "lock free after kill -9"
}
test_release_allows_reacquire() {
  acquire_lock agent-r-000000 1
  release_lock
  local status=0; try_lock agent-r-000000 || status=$?
  assert_eq 0 "$status" "reacquire after release"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  (
    TMP_ROOT="$TMP_BASE/$t"; mkdir -p "$TMP_ROOT"
    export TMP_ROOT STUB_LOG="$TMP_ROOT/stub.log"
    export AGENT_VM_STATE_DIR="$TMP_ROOT/state" AGENT_VM_CONFIG_DIR="$TMP_ROOT/config"
    : >"$STUB_LOG"
    AGENT_VM_LIB=1 . "$LAUNCHER"
    "$t"
  ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
