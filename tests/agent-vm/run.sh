#!/usr/bin/env bash
# shellcheck disable=SC2154,SC2153 # MACHINE/REPO are exported globally by executable_agent-vm's
# prepare_machine once it is sourced (dynamic `. "$LAUNCHER"`, which shellcheck cannot follow)
# shellcheck disable=SC2317,SC2329 # test cases redefine launcher functions (session_exec,
# notice_orphan_env, run_tool, cmd_*) as stubs that the code under test calls indirectly
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
  git -C "$repo" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
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
test_valid_proxy_port_accepts_only_five_digits_in_range() {
  local v
  for v in 17300 17350 17399; do
    if valid_proxy_port "$v"; then record "PASS $v is a valid proxy port"; else record "FAIL $v is a valid proxy port"; fi
  done
  # 017300 and 041624 are octal to bash arithmetic (041624 is 17300); the digit test must reject them first.
  for v in 17299 17400 "" 0 80 017300 017308 041624 "1730 0" 17300x 18446744073709568916; do
    if valid_proxy_port "$v" 2>"$TMP_ROOT/valid.err"; then record "FAIL '$v' is not a valid proxy port"; else record "PASS '$v' is not a valid proxy port"; fi
    assert_eq "" "$(cat "$TMP_ROOT/valid.err")" "no arithmetic error for '$v'"
  done
  # A value with a newline never reaches a label: the results file is one line per assertion.
  if valid_proxy_port $'17300\n' || valid_proxy_port $'\n17300' || valid_proxy_port $'17300\n17301'; then
    record "FAIL a value with a newline is not a valid proxy port"
  else
    record "PASS a value with a newline is not a valid proxy port"
  fi
}
test_meta_third_argument_writes_the_proxy_port() {
  write_machine_meta agent-a-000000 /tmp/a 17305
  assert_eq 17305 "$(read_meta_field agent-a-000000 proxy_port)" "proxy_port written from the third argument"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "repo_path still written"
  assert_eq 1 "$(read_meta_field agent-a-000000 format)" "format still written"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "a two-argument rewrite drops proxy_port (the documented contract)"
  write_machine_meta agent-a-000000 /tmp/a 041624
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "an invalid third argument writes no proxy_port"
}
test_meta_is_replaced_through_a_hidden_temp_file() {
  write_machine_meta agent-a-000000 /tmp/a 17300
  assert_eq "" "$(find "$AGENT_VM_STATE_DIR/machines" -name '.agent-a-000000.*')" "no temp file left"
  ln "$AGENT_VM_STATE_DIR/machines/agent-a-000000" "$TMP_ROOT/held" # a second name for the same file: an in-place write would change what it shows
  write_machine_meta agent-a-000000 /tmp/a 17301
  assert_contains "$(cat "$TMP_ROOT/held")" "proxy_port=17300" "the record is replaced, not rewritten in place"
  assert_eq 17301 "$(read_meta_field agent-a-000000 proxy_port)" "the new record holds the new value"
  : >"$AGENT_VM_STATE_DIR/machines/.agent-z-000000.abc123"
  assert_eq "agent-a-000000" "$(machine_rows | cut -f1)" "a leftover temp file is not listed as a machine"
}
test_assign_first_machine_gets_the_lowest_slot() {
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "first machine gets 17300"
  assert_eq "" "$PROXY_PORT_PREV" "no previous port on the first assignment"
  assert_eq 17300 "$(read_meta_field agent-a-000000 proxy_port)" "the record holds the port"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "repo_path written"
}
test_assign_skips_ports_held_by_other_records() {
  write_machine_meta agent-b-000000 /tmp/b 17300
  write_machine_meta agent-c-000000 /tmp/c 17302
  : >"$AGENT_VM_STATE_DIR/machines/agent-b-000000.lock"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17301 "$PROXY_PORT" "lowest free slot between held ones"
}
test_assign_keeps_the_port_across_launches() {
  write_machine_meta agent-a-000000 /tmp/a 17350
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17350 "$PROXY_PORT" "own port kept, not moved to the lowest slot"
  assert_eq 17350 "$PROXY_PORT_PREV" "previous port reported"
}
test_assign_reads_a_record_written_before_this_change() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/a\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "a record without proxy_port gets a slot"
  assert_eq "" "$PROXY_PORT_PREV" "no previous port for an old record"
}
test_assign_moves_only_the_launching_machine_off_a_shared_port() {
  write_machine_meta agent-a-000000 /tmp/a 17300
  write_machine_meta agent-b-000000 /tmp/b 17300
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17301 "$PROXY_PORT" "launching machine moves off a shared port"
  assert_eq 17300 "$PROXY_PORT_PREV" "the port it held is reported"
  assert_eq 17300 "$(read_meta_field agent-b-000000 proxy_port)" "the other record is untouched"
}
test_assign_ignores_invalid_values_in_any_record() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=80\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  printf 'format=1\nrepo_path=/tmp/c\nproxy_port=041624\n' >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  printf 'format=1\nrepo_path=/tmp/a\nproxy_port=17400\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "invalid values hold no slot"
  assert_eq "" "$PROXY_PORT_PREV" "an invalid own value is not a previous port"
}
test_assign_with_a_full_pool_records_no_port() {
  local p status=0
  for ((p = 17300; p <= 17399; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  assign_proxy_port agent-a-000000 /tmp/a || status=$?
  assert_eq 0 "$status" "a full pool is not an error"
  assert_eq "" "$PROXY_PORT" "no port when the pool is full"
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "no port recorded"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "the record is still written"
}
test_assign_can_take_the_last_slot() {
  local p
  for ((p = 17300; p <= 17398; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17399 "$PROXY_PORT" "the last slot is usable"
}
test_assign_reports_a_lost_port_when_the_pool_is_full() {
  local p
  for ((p = 17300; p <= 17399; p++)); do write_machine_meta "agent-p$p-000000" "/tmp/$p" "$p"; done
  write_machine_meta agent-a-000000 /tmp/a 17300
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq "" "$PROXY_PORT" "no slot left"
  assert_eq 17300 "$PROXY_PORT_PREV" "the lost port is reported"
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "no port recorded"
}
test_assign_uses_only_the_first_proxy_port_line() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=17301\nproxy_port=17300\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  assign_proxy_port agent-a-000000 /tmp/a
  assert_eq 17300 "$PROXY_PORT" "only the first proxy_port line holds a slot"
}
test_assign_stops_when_the_port_lock_cannot_be_opened() {
  mkdir -p "$AGENT_VM_STATE_DIR/ports.lock" # a directory in the lock file's place: exec 6> fails
  assert_status 1 "an unopenable port lock stops the launch" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; assign_proxy_port agent-a-000000 /tmp/a"
  assert_status 1 "no record is written without the lock" -- test -f "$AGENT_VM_STATE_DIR/machines/agent-a-000000"
}
test_assign_releases_the_port_lock() {
  assign_proxy_port agent-a-000000 /tmp/a
  if { : >&6; } 2>/dev/null; then record "FAIL fd 6 is closed after assign_proxy_port"; else record "PASS fd 6 is closed after assign_proxy_port"; fi
  local status=0
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 0 "$status" "port lock is free after assign_proxy_port returns"
  assert_status 0 "port lock file is outside machine records" -- test -f "$AGENT_VM_STATE_DIR/ports.lock"
  assert_eq "agent-a-000000" "$(machine_rows | cut -f1)" "ports.lock is not listed as a machine"
}
test_port_lock_excludes_a_second_holder_and_is_independent() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1 && sleep 3" </dev/null &
  sleep 1
  local status=0
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "a second holder times out while the port lock is held"
  status=0; try_lock agent-g-000000 || status=$?
  assert_eq 0 "$status" "repo lock unaffected by the port lock"
  wait
}
test_assign_concurrent_launches_get_distinct_ports() {
  local i
  for i in 1 2 3 4 5 6; do
    bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; assign_proxy_port agent-m$i-000000 /tmp/m$i" </dev/null >/dev/null 2>&1 &
  done
  wait
  local ports; ports=$(for i in 1 2 3 4 5 6; do read_meta_field "agent-m$i-000000" proxy_port; done | sort -u | wc -l | tr -d ' ')
  assert_eq 6 "$ports" "six concurrent launches record six distinct ports"
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

test_outside_a_repo_claude_runs_on_the_host() {
  mkdir -p "$TMP_ROOT/plain"
  local out; out=$(cd "$TMP_ROOT/plain" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude -p hi 2>&1)
  assert_contains "$(cat "$STUB_LOG")" "claude -p hi" "host claude executed with the same args"
  assert_not_contains "$(cat "$STUB_LOG")" "orb " "no VM involved"
  assert_contains "$out" "on the host" "says where it runs"
}
test_excluded_repo_runs_on_the_host() {
  local repo; repo=$(make_flow_repo)
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf '%s\n' "$(cd -P "$repo" && pwd -P)" >"$AGENT_VM_CONFIG_DIR/config"
  (cd "$repo" && bash "$LAUNCHER" codex </dev/null 2>/dev/null) || true
  assert_contains "$(cat "$STUB_LOG")" "codex" "host codex (stub) executed"
  assert_not_contains "$(cat "$STUB_LOG")" "orb " "excluded repo does not touch OrbStack"
}
test_broken_git_dir_fails_closed_instead_of_running_on_the_host() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  printf 'not a git dir\n' >"$repo/.git/HEAD"; printf '[broken\n' >"$repo/.git/config"
  local status=0 out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "broken repo -> refuse"
  assert_contains "$out" "not inside a usable git repository" "refused by the repository check itself"
  assert_contains "$out" "AGENT_VM=off" "hint printed"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_git_file_worktree_marker_counts_as_a_repo() {
  local wt; wt=$(make_dotfiles_fixture)
  mkdir -p "$TMP_ROOT/wt"; printf 'gitdir: /nonexistent\n' >"$TMP_ROOT/wt/.git"
  local status=0 out; out=$(cd "$TMP_ROOT/wt" && STUB_CHEZMOI_STDOUT="$wt/home" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "a .git file with a broken target is not 'outside a repo'"
  assert_contains "$out" "not inside a usable git repository" "refused by the repository check itself"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_known_repo_with_deleted_git_dir_is_refused() {
  local repo; repo=$(make_flow_repo)
  local real; real=$(cd -P "$repo" && pwd -P)
  write_machine_meta "$(derive_machine_name "$real")" "$real"
  rm -rf "$repo/.git"
  local status=0 out; out=$(cd "$repo" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "a previously used repo whose .git vanished -> refuse"
  assert_contains "$out" ".git is missing" "names the reason"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_unreadable_record_fails_closed_outside_a_repo() {
  mkdir -p "$TMP_ROOT/plain" "$AGENT_VM_STATE_DIR/machines"
  printf 'garbage\n' >"$AGENT_VM_STATE_DIR/machines/agent-bad-000000"
  local status=0; (cd "$TMP_ROOT/plain" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude </dev/null >/dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "an unreadable record blocks host passthrough"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_rm_works_for_a_known_repo_without_git() {
  local repo; repo=$(make_flow_repo)
  local real m; real=$(cd -P "$repo" && pwd -P); m=$(derive_machine_name "$real")
  write_machine_meta "$m" "$real"
  rm -rf "$repo/.git"
  printf 'y\n' | (cd "$TMP_ROOT" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" cmd_rm "$real") >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $m" "machine of the .git-less repo deleted"
  assert_status 1 "record removed" -- test -e "$AGENT_VM_STATE_DIR/machines/$m"
}
test_op_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_OP_EXIT=1 bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired on an op inject failure"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c 'failed unexpectedly')" "reported once, not per subshell"
}
test_secret_handoff_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  # the in-VM write script contains "agent-vm.env"; only that orb call fails
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_OP_STDOUT="A=x" STUB_ORB_FAIL_ON="agent-vm.env" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired when handing secrets to the VM fails"
}
test_empty_chezmoi_source_path_fails_closed() {
  local repo; repo=$(make_flow_repo)
  local status=0 out; out=$(cd "$repo" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" STUB_CHEZMOI_STDOUT="" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "empty source path -> refuse"
  assert_contains "$out" "cannot resolve chezmoi source path" "does not fall back to git in the cwd"
}
test_shell_outside_a_repo_is_refused() {
  mkdir -p "$TMP_ROOT/plain"
  assert_status 1 "agent-vm shell needs a repo" -- bash -c "cd '$TMP_ROOT/plain' && GIT_CEILING_DIRECTORIES='$TMP_ROOT' bash '$LAUNCHER' shell"
}
test_unexpected_failure_prints_the_host_hint() {
  # health check and `orb list` succeed; only `orb create` fails, i.e. strictly after check_health
  local wt repo; wt=$(make_golden_fixture); repo=$(make_flow_repo)
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_FAIL_ON="create" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired"
  assert_contains "$out" "AGENT_VM=off" "hint on an unexpected failure"
}
test_bootstrap_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_ORB_FAIL_ON="bootstrap.sh" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired on a bootstrap failure"
}

try_lock() { # machine -> exit status of a fresh process trying the lock for 1s
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1
}
try_golden_lock() { # -> exit status of a fresh process trying the golden lock for 1s
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_golden_lock 1" </dev/null >/dev/null 2>&1
}
test_golden_lock_is_exclusive_and_independent_of_other_locks() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_golden_lock 1 && sleep 3" </dev/null &
  sleep 1
  local status=0; try_golden_lock || status=$?
  assert_eq 1 "$status" "second golden lock refused"
  status=0; try_lock agent-g-000000 || status=$?
  assert_eq 0 "$status" "repo lock unaffected"
  status=0; bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_store_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 0 "$status" "browser store lock unaffected"
  wait
}
test_golden_lock_lives_outside_machine_records() {
  acquire_golden_lock 1
  release_golden_lock
  assert_status 0 "lock file under golden/" -- test -f "$AGENT_VM_STATE_DIR/golden/lock"
  assert_eq "" "$(machine_rows)" "golden is not a machine record"
}
test_golden_meta_round_trip_and_format_guard() {
  write_golden_meta abc sealed v1:h
  assert_eq sealed "$(golden_meta_field state)" "state read back"
  assert_eq v1:h "$(golden_meta_field staging_hash)" "staging hash read back"
  assert_eq abc "$(golden_meta_field cloud_init_hash)" "cloud-init hash read back"
  assert_eq 1 "$(golden_meta_field contract)" "contract recorded"
  assert_eq "" "$(find "$AGENT_VM_STATE_DIR/golden" -name 'meta.*')" "no temp file left"
  printf 'format=2\nstate=sealed\n' >"$AGENT_VM_STATE_DIR/golden/meta"
  local status=0; golden_meta_field state >/dev/null || status=$?
  assert_eq 2 "$status" "unknown format is not read"
  rm "$AGENT_VM_STATE_DIR/golden/meta"
  status=0; golden_meta_field state >/dev/null || status=$?
  assert_eq 1 "$status" "absent record"
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

make_dotfiles_fixture() { # -> path of a git repo with tracked + untracked files
  local wt="$TMP_ROOT/df"; mkdir -p "$wt/home" "$wt/.skills/s"
  git -C "$wt" init -q
  printf 'a\n' >"$wt/home/dot_a"; printf 's\n' >"$wt/.skills/s/SKILL.md"
  git -C "$wt" add . && git -C "$wt" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m init
  printf 'secret\n' >"$wt/.env.local" # untracked, must not be staged
  printf '%s\n' "$wt"
}
test_generation_contains_tracked_files_only() {
  local wt gen hash; wt=$(make_dotfiles_fixture)
  read -r gen hash <<<"$(build_staging agent-s-000000 "$wt")"
  local st="$AGENT_VM_STATE_DIR/staging/agent-s-000000/$gen"
  assert_eq "a" "$(cat "$st/home/dot_a")" "tracked file copied"
  assert_eq "s" "$(cat "$st/.skills/s/SKILL.md")" "repo-root .skills copied"
  assert_status 1 "untracked secret not copied" -- test -e "$st/.env.local"
  assert_contains "$hash" "v1:" "hash is versioned"
}
test_vm_planted_entries_are_removed_without_following_symlinks() {
  local wt gen hash; wt=$(make_dotfiles_fixture)
  local st="$AGENT_VM_STATE_DIR/staging/agent-s-000001" outside="$TMP_ROOT/outside"
  mkdir -p "$st" "$outside"; printf 'keep\n' >"$outside/victim"
  ln -s "$outside" "$st/evil-link"; printf 'x\n' >"$st/injected"
  read -r gen hash <<<"$(build_staging agent-s-000001 "$wt")"
  assert_eq "$gen" "$(ls "$st")" "only the new generation remains"
  assert_eq "keep" "$(cat "$outside/victim")" "symlink target untouched"
}
test_hash_reflects_uncommitted_edits() {
  local wt g1 h1 g2 h2; wt=$(make_dotfiles_fixture)
  read -r g1 h1 <<<"$(build_staging agent-s-000002 "$wt")"
  printf 'edited\n' >"$wt/home/dot_a"
  read -r g2 h2 <<<"$(build_staging agent-s-000002 "$wt")"
  if [[ "$h1" != "$h2" ]]; then record "PASS uncommitted edit changes hash"; else record "FAIL uncommitted edit changes hash"; fi
  if [[ "$g1" != "$g2" ]]; then record "PASS new generation name"; else record "FAIL new generation name"; fi
}

write_config_show() { # file machine mounts [extra_line]: the 10 keys OrbStack 2.2.3 prints per machine
  local k
  {
    for k in cpu disk_bytes forward_ssh_agent http_port https_port isolate_network isolated memory_mib mounts username; do
      case "$k" in
        isolated | isolate_network | forward_ssh_agent) printf 'machine.%s.%s: true\n' "$2" "$k" ;;
        mounts) printf 'machine.%s.mounts: %s\n' "$2" "$3" ;;
        username) printf 'machine.%s.username: u\n' "$2" ;;
        *) printf 'machine.%s.%s: 0\n' "$2" "$k" ;;
      esac
    done
    if [[ -n "${4:-}" ]]; then printf '%s\n' "$4"; fi
  } >>"$1"
}
test_mount_paths_with_separators_are_refused() {
  local status
  status=0; (check_mount_paths /ok "/a,b") 2>/dev/null || status=$?
  assert_eq 1 "$status" "comma refused"
  status=0; (check_mount_paths "/a:b") 2>/dev/null || status=$?
  assert_eq 1 "$status" "colon refused"
  status=0; (check_mount_paths "$(printf '/a\nb')") 2>/dev/null || status=$?
  assert_eq 1 "$status" "newline refused"
  assert_status 0 "plain paths pass" -- check_mount_paths /a/b "/with space/c"
  local err; err=$( (check_mount_paths "/a,b") 2>&1 || true)
  assert_contains "$err" "/a,b" "message names the path"
  assert_contains "$err" "AGENT_VM=off" "message gives the host fallback"
}
test_vm_mounts_browsers_destination_is_what_bootstrap_checks() {
  # bootstrap's claude_keep decides on the presence of BROWSERS_ROOT; the golden keeps the browser MCP entries for
  # its clones only if the launcher mounts the browsers dir exactly there (spec K6).
  local dest; dest=$(vm_mounts "$GOLDEN_MACHINE" | tr ',' '\n' | awk -F: '$2 ~ /^\/opt\/agent-vm\/browsers$/ { print $2 }')
  assert_contains "$(grep -E '^BROWSERS_ROOT=' "$REPO_ROOT/agent-vm/bootstrap.sh")" ":-$dest}" "bootstrap's default BROWSERS_ROOT is the launcher's browsers destination"
}
test_vm_mounts_give_the_golden_and_repo_shapes_from_one_place() {
  local st="$AGENT_VM_STATE_DIR"
  assert_eq "/r:/r,$st/staging/agent-x-000000:/opt/agent-vm/src,$st/outbox/agent-x-000000:/opt/agent-vm/outbox,$st/browsers/agent-x-000000:/opt/agent-vm/browsers" \
    "$(vm_mounts agent-x-000000 /r)" "repo machine: repo, staging, outbox, browsers"
  assert_eq "$st/staging/$GOLDEN_MACHINE:/opt/agent-vm/src,$st/outbox/$GOLDEN_MACHINE:/opt/agent-vm/outbox,$st/browsers/$GOLDEN_MACHINE:/opt/agent-vm/browsers" \
    "$(vm_mounts "$GOLDEN_MACHINE")" "golden: the same shape without the repo"
}
test_machine_config_must_match_exactly() {
  local f="$TMP_ROOT/show"
  write_config_show "$f" agent-x-000000 "/r:/r"
  write_config_show "$f" agent-x-0000001 "/other:/other" # a machine whose name extends ours must not leak in
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 0 "exact settings pass" -- verify_machine_config agent-x-000000 "/r:/r"
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 1 "different mounts fail" -- verify_machine_config agent-x-000000 "/r:/r,/x:/y"
  local g="$TMP_ROOT/show-unknown"
  write_config_show "$g" agent-x-000000 "/r:/r" "machine.agent-x-000000.share_home: true"
  STUB_ORB_CONFIG_SHOW_FILE="$g" assert_status 1 "unknown key fails" -- verify_machine_config agent-x-000000 "/r:/r"
  local err; err=$(STUB_ORB_CONFIG_SHOW_FILE="$g" verify_machine_config agent-x-000000 "/r:/r" 2>&1 || true)
  assert_contains "$err" "share_home" "unknown key named"
  local h="$TMP_ROOT/show-net"
  write_config_show "$h" agent-x-000000 "/r:/r"
  sed -i.bak 's/isolate_network: true/isolate_network: false/' "$h"
  STUB_ORB_CONFIG_SHOW_FILE="$h" assert_status 1 "network isolation off fails" -- verify_machine_config agent-x-000000 "/r:/r"
  local k="$TMP_ROOT/show-missing"
  write_config_show "$k" agent-x-000000 "/r:/r"
  grep -v forward_ssh_agent "$k" >"$k.2"
  STUB_ORB_CONFIG_SHOW_FILE="$k.2" assert_status 1 "missing key fails" -- verify_machine_config agent-x-000000 "/r:/r"
  err=$(STUB_ORB_CONFIG_SHOW_FILE="$k.2" verify_machine_config agent-x-000000 "/r:/r" 2>&1 || true)
  assert_contains "$err" "forward_ssh_agent" "missing key named"
}
test_empty_config_key_counts_as_unknown() {
  local f="$TMP_ROOT/show"
  write_config_show "$f" agent-x-000000 "/r:/r" "machine.agent-x-000000.: x"
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 1 "empty key fails" -- verify_machine_config agent-x-000000 "/r:/r"
}
test_machine_state_reads_listing_rows() {
  assert_eq "stopped" "$(STUB_ORB_LIST_STDOUT="$(printf 'a running ubuntu\nagent-x-000000 stopped ubuntu')" orb_machine_state agent-x-000000)" "state column"
  assert_eq "present" "$(STUB_ORB_LIST_STDOUT="agent-x-000000" orb_machine_state agent-x-000000)" "a row with only the name still counts as existing"
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="agent-x-0000001 running" orb_machine_state agent-x-000000)" "absent"
}
test_failed_machine_listing_is_an_error_not_absence() {
  export STUB_ORB_FAIL_ON="list"
  local out
  # shellcheck disable=SC2016 # snippet text; expands inside errexit_run's fresh bash
  out=$(errexit_run 'vm=$(orb_machine_state agent-x-000000); echo "state=$vm"')
  assert_not_contains "$out" "reached" "a failed orb list stops the caller"
  assert_not_contains "$out" "state=" "the caller did not continue"
}
test_orb_q_closes_every_lock_fd() {
  orb() { ls /dev/fd >"$TMP_ROOT/fds"; } # replaces the stub for this subshell only
  exec 6>"$TMP_ROOT/l6" 7>"$TMP_ROOT/l7" 8>"$TMP_ROOT/l8" 9>"$TMP_ROOT/l9"
  orb list # positive control: a direct call does see the lock fds, so the listing below can detect a leak
  assert_contains " $(tr '\n' ' ' <"$TMP_ROOT/fds")" " 7 " "control: a direct call inherits fd 7"
  assert_contains " $(tr '\n' ' ' <"$TMP_ROOT/fds")" " 6 " "control: a direct call inherits fd 6"
  orb_q list
  exec 6>&- 7>&- 8>&- 9>&-
  local fds; fds=" $(tr '\n' ' ' <"$TMP_ROOT/fds")"
  assert_not_contains "$fds" " 6 " "fd 6 not inherited"
  assert_not_contains "$fds" " 7 " "fd 7 not inherited"
  assert_not_contains "$fds" " 8 " "fd 8 not inherited"
  assert_not_contains "$fds" " 9 " "fd 9 not inherited"
}
clone_ready_fixture() { # wt machine repo -> config-show file holding a sealed golden and a correctly mounted clone
  local show; show=$(sealed_golden_fixture "$1")
  write_config_show "$show" "$2" "$(vm_mounts "$2" "$3")"
  printf '%s\n' "$show"
}
log_line_of() { grep -n -F -- "$1" "$STUB_LOG" | head -1 | cut -d: -f1 || true; } # needle -> first line number, "" when absent
test_new_machine_is_cloned_mounted_checked_then_started() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  local c s t
  c=$(log_line_of "orb clone $GOLDEN_MACHINE agent-c-000000")
  s=$(log_line_of "orb config set machine.agent-c-000000.mounts $(printf '%q' "$(vm_mounts agent-c-000000 /repo/path)")") # the stub logs argv with %q, which escapes the commas
  t=$(log_line_of "orb start agent-c-000000")
  if [[ -n "$c" && -n "$s" && -n "$t" && "$c" -lt "$s" && "$s" -lt "$t" ]]; then record "PASS clone, then mounts, then start"; else record "FAIL clone, then mounts, then start ($c $s $t)"; fi
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no direct create for a repo machine"
  assert_status 1 "sentinel removed" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  assert_status 0 "browsers mount source exists" -- test -d "$AGENT_VM_STATE_DIR/browsers/agent-c-000000"
}
test_no_orb_call_inherits_a_lock_fd_during_creation() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  orb() { # wraps the stub for this subshell only
    local fd
    for fd in 7 8 9; do if [[ -e "/dev/fd/$fd" ]]; then printf 'leak %s %s\n' "$fd" "$*" >>"$TMP_ROOT/leaks"; fi; done
    command orb "$@"
  }
  exec 9>"$TMP_ROOT/repo.lock" # as prepare_machine holds it
  orb version >/dev/null # positive control: a direct call is seen holding fd 9
  assert_contains "$(cat "$TMP_ROOT/leaks" 2>/dev/null || true)" "leak 9" "control: the wrapper detects an inherited fd"
  rm -f "$TMP_ROOT/leaks"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  exec 9>&-
  assert_eq "" "$(cat "$TMP_ROOT/leaks" 2>/dev/null || true)" "no orb call saw fd 7, 8 or 9"
}
test_clone_with_unswapped_mounts_is_deleted_not_started() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_config_show "$show" agent-c-000000 "$(vm_mounts "$GOLDEN_MACHINE")" # the set did not take effect
  : >"$STUB_LOG"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>&1) || status=$?
  assert_eq 1 "$status" "refused"
  assert_contains "$err" "OrbStack" "message names OrbStack (and its version when available)"
  assert_contains "$err" "AGENT_VM=off" "message gives the host fallback"
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "clone deleted"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "never started"
  assert_status 1 "sentinel cleared once deleted" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_each_failure_after_the_clone_deletes_it_and_never_starts_it() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  # A failing `config show` is not used here: the golden check reads it first, so the launch stops before cloning.
  : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="config set" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "config set failure deletes the clone"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "config set failure never starts it"
  local net="$TMP_ROOT/show-net"; cp "$show" "$net"
  sed -i.bak "s/machine.agent-c-000000.isolate_network: true/machine.agent-c-000000.isolate_network: false/" "$net"; : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$net" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "clone without network isolation never starts"
  : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="start agent-c-000000" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "failed start deletes the clone"
}
test_failed_clone_deletes_nothing() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  local status=0; (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="clone" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || status=$?
  assert_eq 1 "$status" "stops"
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "a failed clone never deletes by name"
  assert_status 0 "sentinel kept, so a machine the clone may have left is recreated next time" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_unfinished_clone_is_recreated_with_fresh_browser_state() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  mkdir -p "$AGENT_VM_STATE_DIR/creating" "$AGENT_VM_STATE_DIR/browser-records" "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  printf 'mcp-0.0.1\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.id"; : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$(printf '%s\n%s' "$GOLDEN_MACHINE stopped ubuntu" "agent-c-000000 stopped ubuntu")" STUB_ORB_CONFIG_SHOW_FILE="$show" \
    ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  local d c; d=$(log_line_of "orb delete -f agent-c-000000"); c=$(log_line_of "orb clone $GOLDEN_MACHINE agent-c-000000")
  if [[ -n "$d" && -n "$c" && "$d" -lt "$c" ]]; then record "PASS deleted, then cloned again"; else record "FAIL deleted, then cloned again ($d $c)"; fi
  assert_status 1 "the old browser generation is gone" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  assert_status 1 "the old browser id is gone" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.id"
  assert_status 0 "the mount marker is written again" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.mount"
}
test_leftover_sentinel_without_a_machine_is_harmless() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  mkdir -p "$AGENT_VM_STATE_DIR/creating" "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"; : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "created normally"
  assert_status 1 "a browser copy left by the earlier attempt is cleared" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  assert_status 1 "sentinel cleared" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_failed_delete_keeps_the_sentinel_and_says_how_to_recover() {
  local wt; wt=$(make_golden_fixture)
  mkdir -p "$AGENT_VM_STATE_DIR/creating"; : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="agent-c-000000 stopped ubuntu" STUB_ORB_FAIL_ON="delete -f agent-c-000000" ensure_machine agent-c-000000 /repo/path "$wt" 2>&1) || status=$?
  assert_eq 1 "$status" "stops"
  assert_contains "$err" "recover: orb delete -f agent-c-000000" "recovery shown"
  assert_status 0 "sentinel kept for the next launch" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_repo_path_with_a_comma_is_refused_before_cloning() {
  local wt; wt=$(make_golden_fixture)
  local status=0; (ensure_machine agent-c-000000 "/a,b" "$wt") 2>/dev/null || status=$?
  assert_eq 1 "$status" "refused"
  assert_not_contains "$(cat "$STUB_LOG")" "orb clone" "no clone"
}
test_golden_lock_is_released_before_the_clone_starts() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  # shellcheck disable=SC2329 # replaces the real orb; the code under test calls it indirectly (via orb_q)
  orb() { # wraps the stub for this subshell only
    if [[ "$1" == start && "${2:-}" == agent-c-000000 ]]; then
      if try_golden_lock; then record "PASS golden lock free at start"; else record "FAIL golden lock free at start"; fi
    fi
    command orb "$@"
  }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
}
test_forget_machine_removes_the_sentinel() {
  mkdir -p "$AGENT_VM_STATE_DIR/creating"; : >"$AGENT_VM_STATE_DIR/creating/agent-z-000000"
  forget_machine agent-z-000000
  assert_status 1 "sentinel gone" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-z-000000"
}
test_existing_machine_is_not_recreated() {
  STUB_ORB_LIST_STDOUT="agent-e-000000  running  ubuntu" ensure_machine agent-e-000000 /r /wt
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no create for existing"
}
test_bootstrap_skipped_when_hash_matches() {
  STUB_ORB_STDOUT="v1:abc" maybe_bootstrap agent-b-000000 gen-x "v1:abc"
  assert_not_contains "$(cat "$STUB_LOG")" "bootstrap.sh" "skip on match"
}
test_bootstrap_runs_with_generation_and_hash() {
  STUB_ORB_STDOUT="v1:old" maybe_bootstrap agent-b-000000 gen-abc "v1:new"
  assert_contains "$(cat "$STUB_LOG")" "bash /opt/agent-vm/src/gen-abc/agent-vm/bootstrap.sh 1 v1:new /opt/agent-vm/src/gen-abc" "bootstrap contract v1"
}
test_applied_hash_is_read_from_vm_home_not_cwd() {
  STUB_ORB_STDOUT="v1:abc" maybe_bootstrap agent-b-000000 gen-x "v1:abc"
  # shellcheck disable=SC2016 # asserts the literal command text sent to the VM
  assert_contains "$(cat "$STUB_LOG")" '$HOME/.local/state/agent-vm/applied-hash' "absolute HOME path"
}

test_only_host_owned_env_files_are_resolved() {
  local repo="$TMP_ROOT/sec-repo"; mkdir -p "$repo" "$AGENT_VM_CONFIG_DIR/repos"
  printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  printf 'B=op://v/b/x\n' >"$AGENT_VM_CONFIG_DIR/repos/agent-p-000000.env.1password"
  printf 'EVIL=op://v/other/x\n' >"$repo/.env"
  local files; files=$(cd "$repo" && env_files_for agent-p-000000)
  assert_contains "$files" "$AGENT_VM_CONFIG_DIR/env.1password" "global file"
  assert_contains "$files" "agent-p-000000.env.1password" "per-repo host file"
  assert_not_contains "$files" "$repo/.env" "repo .env never resolved"
}
test_secret_values_never_appear_in_argv() {
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  STUB_CAPTURE_STDIN=1 STUB_OP_STDOUT="A=s3cr3t-value" STUB_ORB_STDOUT="/dev/shm/agent-vm.env.abc123" inject_secrets agent-p-000000 >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "s3cr3t-value" "secret not in any argv"
  assert_contains "$(cat "$STUB_LOG.stdin")" "s3cr3t-value" "secret delivered on stdin"
  assert_contains "$(cat "$STUB_LOG")" "-mmin +1" "stale env files swept before write"
}
test_empty_handoff_reply_is_a_failure_not_no_secrets() {
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  # The VM side answered but printed no path (e.g. mktemp failed): launching without the secrets is wrong.
  local status=0; (STUB_OP_STDOUT="A=v" STUB_ORB_STDOUT="" inject_secrets agent-p-000000 >/dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "empty reply from the VM aborts"
}
test_no_env_files_means_no_op_call() {
  inject_secrets agent-n-000000 >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "op inject" "op not called"
}

make_flow_repo() { local repo="$TMP_ROOT/flow-repo"; mkdir -p "$repo" && git -C "$repo" init -q; printf '%s\n' "$repo"; }

test_launch_script_without_args_succeeds() {
  local cmd; cmd=$(build_launch_script claude /repo/path "")
  assert_contains "$cmd" 'exec claude' "no-arg launch builds"
  assert_not_contains "$cmd" '. ' "no env sourcing when no env file"
}
test_launch_script_sources_and_deletes_env_file() {
  local cmd; cmd=$(build_launch_script claude "/repo/with space" /dev/shm/agent-vm.env.x --resume 'a;b')
  assert_contains "$cmd" 'cd /repo/with\ space' "cwd quoted"
  assert_contains "$cmd" '. /dev/shm/agent-vm.env.x' "env sourced"
  assert_contains "$cmd" 'rm -f /dev/shm/agent-vm.env.x' "env deleted"
  assert_contains "$cmd" 'exec claude --resume a\;b' "args quoted"
}
test_launch_script_forwards_allowlisted_env_only_when_set() {
  local cmd
  cmd=$(env -u CLAUDE_CODE_AUTO_COMPACT_WINDOW -u CLAUDE_CODE_MAX_OUTPUT_TOKENS bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; build_launch_script claude /r ''" 2>/dev/null)
  assert_not_contains "$cmd" 'export CLAUDE_CODE' "nothing exported when unset on the host"
  cmd=$(CLAUDE_CODE_AUTO_COMPACT_WINDOW='1 0;x' CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; build_launch_script claude /r ''" 2>/dev/null)
  assert_contains "$cmd" 'export CLAUDE_CODE_AUTO_COMPACT_WINDOW=1\ 0\;x; ' "value shell-quoted"
  assert_contains "$cmd" 'export CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000; exec claude' "exported before exec"
}
test_launch_script_exports_the_proxy_port_after_the_env_file() {
  local cmd
  cmd=$(PROXY_PORT=17305 build_launch_script claude /r /dev/shm/agent-vm.env.x)
  assert_contains "$cmd" "export PORTLESS_PORT=17305 PORTLESS_HTTPS=0; " "proxy port and no-TLS exported"
  assert_not_contains "$cmd" "unset PORTLESS" "nothing unset when a port is assigned"
  local env_at port_at
  env_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "agent-vm.env.x") }')
  port_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "PORTLESS_PORT") }')
  if [[ "$env_at" -gt 0 && "$port_at" -gt "$env_at" ]]; then record "PASS the assignment wins over the env file"; else record "FAIL the assignment wins over the env file ($env_at/$port_at)"; fi
}
test_launch_script_without_a_valid_proxy_port_unsets_the_variables() {
  local cmd v env_at unset_at
  cmd=$(PROXY_PORT="" build_launch_script claude /r /dev/shm/agent-vm.env.x)
  assert_contains "$cmd" "unset PORTLESS_PORT PORTLESS_HTTPS; " "an env file value does not survive without an assigned port"
  assert_not_contains "$cmd" "export PORTLESS" "nothing exported without an assigned port"
  env_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "agent-vm.env.x") }')
  unset_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "unset PORTLESS_PORT") }')
  if [[ "$env_at" -gt 0 && "$unset_at" -gt "$env_at" ]]; then record "PASS the unset comes after the env file"; else record "FAIL the unset comes after the env file ($env_at/$unset_at)"; fi
  # The whole script is compared: "the value does not appear" would miss a quoted or misplaced embedding, and a short
  # value such as 80 can appear by chance in a forwarded host knob. The two allowlisted knobs are unset for that reason.
  unset CLAUDE_CODE_AUTO_COMPACT_WINDOW CLAUDE_CODE_MAX_OUTPUT_TOKENS
  for v in 041624 80 '17300; touch /tmp/pwned' "\$(id)"; do
    cmd=$(PROXY_PORT="$v" build_launch_script claude /r "" 2>/dev/null)
    assert_eq "cd /r; unset PORTLESS_PORT PORTLESS_HTTPS; exec claude" "$cmd" "an invalid PROXY_PORT ('$v') yields only the unset"
  done
  cmd=$(PROXY_PORT=$'17300\n17301' build_launch_script claude /r "" 2>/dev/null)
  assert_eq "cd /r; unset PORTLESS_PORT PORTLESS_HTTPS; exec claude" "$cmd" "a PROXY_PORT with a newline yields only the unset"
}
test_notice_proxy_port_names_the_port_on_stderr_only() {
  local out err
  err=$(PROXY_PORT=17305 notice_proxy_port 2>&1 >/dev/null)
  assert_contains "$err" "http://<app>.localhost:17305" "the notice carries the port"
  assert_contains "$err" "portless run" "the notice names the command"
  out=$(PROXY_PORT=17305 notice_proxy_port 2>/dev/null)
  assert_eq "" "$out" "nothing on stdout"
  err=$(PROXY_PORT="" notice_proxy_port 2>&1)
  assert_eq "" "$err" "silent without an assigned port"
}
test_notice_proxy_port_assignment_shows_a_change_and_a_full_pool() {
  local err
  err=$(PROXY_PORT=17301 PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "proxy port for agent-a-000000 changed 17300 -> 17301" "old and new port in fixed positions"
  assert_contains "$err" "recover: run 'portless proxy stop' in the VM" "the recovery step"
  err=$(PROXY_PORT=17300 PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_eq "" "$err" "silent when the port is kept"
  err=$(PROXY_PORT=17300 PROXY_PORT_PREV="" notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_eq "" "$err" "silent on the first assignment"
  err=$(PROXY_PORT="" PROXY_PORT_PREV=17300 notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "changed 17300 -> none" "a port lost to a full pool is a change"
  assert_contains "$err" "agent-vm rm <repo>" "the full-pool warning names the recovery that frees a slot"
  err=$(PROXY_PORT="" PROXY_PORT_PREV="" notice_proxy_port_assignment agent-a-000000 2>&1)
  assert_contains "$err" "do not go through portless" "the full-pool warning says what stops working"
  assert_not_contains "$err" "changed" "no change line without a previous port"
}
test_run_tool_hands_the_port_to_the_session_and_names_it() {
  local wt repo m err; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  session_exec() { printf '%s\n' "$2" >"$TMP_ROOT/launch-script"; } # replaces the real orb session in this subshell only
  err=$( (cd "$repo" && PROXY_PORT=99999 STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>&1 >/dev/null) || true
  assert_eq 17300 "$(read_meta_field "$m" proxy_port)" "the launch records a port"
  assert_contains "$(cat "$TMP_ROOT/launch-script")" "export PORTLESS_PORT=17300 PORTLESS_HTTPS=0; " "the session receives the recorded port"
  assert_contains "$err" "localhost:17300" "the launch names the port on stderr"
  assert_not_contains "$err" "changed" "no change line on the first assignment"
}
test_prepare_machine_ignores_proxy_port_from_the_host_environment() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  session_exec() { printf '%s\n' "$2" >"$TMP_ROOT/launch-script"; }
  assign_proxy_port() { :; } # replaces the assignment in this subshell only: only the clearing in prepare_machine is left
  (cd "$repo" && PROXY_PORT=17305 PROXY_PORT_PREV=17306 STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) >/dev/null 2>&1 || true
  assert_contains "$(cat "$TMP_ROOT/launch-script")" "unset PORTLESS_PORT PORTLESS_HTTPS; " "a PROXY_PORT from the host environment is not used"
  assert_not_contains "$(cat "$TMP_ROOT/launch-script")" "export PORTLESS" "nothing exported from the host environment's value"
}
test_prewarm_reports_a_changed_port_and_names_no_url() {
  local wt repo m err; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta "$m" "$(cd -P "$repo" && pwd -P)" 17300
  write_machine_meta agent-other-000000 /tmp/other 17300
  session_exec() { record "FAIL prewarm must not start a session"; }
  err=$( (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" cmd_prewarm) 2>&1 >/dev/null) || true
  assert_eq 17301 "$(read_meta_field "$m" proxy_port)" "prewarm moves the machine off the shared port"
  assert_contains "$err" "changed 17300 -> 17301" "prewarm shows the recovery for the change it made"
  assert_not_contains "$err" "dev servers: run them" "prewarm does not name a URL to open"
}
test_list_shows_only_a_valid_proxy_port() {
  mkdir -p "$TMP_ROOT/repo-a" "$TMP_ROOT/repo-b" "$TMP_ROOT/repo-c"
  write_machine_meta agent-a-000000 "$TMP_ROOT/repo-a" 17300
  write_machine_meta agent-b-000000 "$TMP_ROOT/repo-b"
  printf 'format=1\nrepo_path=%s\nproxy_port=041624\n' "$TMP_ROOT/repo-c" >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  local rows; rows=$(machine_rows)
  assert_contains "$rows" "agent-a-000000	present	$TMP_ROOT/repo-a	17300" "4th column is the proxy port"
  assert_eq "agent-b-000000	present	$TMP_ROOT/repo-b	" "$(printf '%s\n' "$rows" | grep '^agent-b-')" "a record without a port ends in a tab"
  assert_eq "agent-c-000000	present	$TMP_ROOT/repo-c	" "$(printf '%s\n' "$rows" | grep '^agent-c-')" "an invalid stored value is not shown"
}
test_launch_warns_about_unforwarded_claude_code_vars_by_name_only() {
  local err
  # env -u: the suite itself may run inside a Claude Code session, which silences the warning.
  err=$(env -u CLAUDECODE CLAUDE_CODE_SOME_KNOB=knob-value CLAUDE_CODE_OAUTH_TOKEN=sekrit-value CLAUDE_CODE_AUTO_COMPACT_WINDOW=1 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; build_launch_script claude /r '' >/dev/null" 2>&1)
  assert_contains "$err" "not forwarded to the VM: " "warning printed"
  assert_contains "$err" "CLAUDE_CODE_SOME_KNOB" "unlisted name reported"
  assert_not_contains "$err" "knob-value" "value never printed"
  assert_not_contains "$err" "OAUTH_TOKEN" "withheld-by-design token not reported"
  assert_not_contains "$err" "AUTO_COMPACT_WINDOW" "forwarded name not reported"
  err=$(CLAUDECODE=1 CLAUDE_CODE_SOME_KNOB=x bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; build_launch_script claude /r '' >/dev/null" 2>&1)
  assert_not_contains "$err" "not forwarded" "silent inside a Claude Code session"
}
test_confirm_prompts_treat_eof_as_no_without_the_error_trap() {
  local repo real m out rc=0
  repo=$(make_flow_repo); real=$(cd -P "$repo" && pwd -P); m=$(derive_machine_name "$real")
  write_machine_meta "$m" "$real"
  # Run the real entry point (ERR trap installed) with stdin closed.
  out=$(cd "$repo" && AGENT_VM_STATE_DIR="$AGENT_VM_STATE_DIR" bash "$LAUNCHER" rm </dev/null 2>&1) || rc=$?
  assert_eq 0 "$rc" "rm on EOF: exit 0 like an explicit N"
  assert_contains "$out" "no input; aborted" "rm on EOF: message"
  assert_not_contains "$out" "failed unexpectedly" "rm on EOF: no ERR trap"
  assert_not_contains "$(cat "$STUB_LOG")" "delete" "rm on EOF: nothing deleted"
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  rc=0; out=$(cmd_gc </dev/null 2>&1) || rc=$?
  assert_eq 0 "$rc" "gc on EOF: exit 0"
  assert_contains "$out" "no input; aborted" "gc on EOF: message"
  assert_not_contains "$(cat "$STUB_LOG")" "delete" "gc on EOF: nothing deleted"
}
test_codex_login_runs_only_when_auth_missing() {
  STUB_ORB_EXIT=1 ensure_codex_auth agent-a-000000 || true
  # the stub logs argv with printf %q, so the single bash -lc script shows escaped spaces
  assert_contains "$(cat "$STUB_LOG")" 'bash -lc codex\ login\ --device-auth' "device auth in a login shell when missing"
  : >"$STUB_LOG"
  ensure_codex_auth agent-a-000000
  assert_not_contains "$(cat "$STUB_LOG")" "login" "no login when present"
}
test_session_runs_without_holding_the_lock() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  notice_orphan_env() { :; } # implemented in T10
  session_exec() { # replaces the real orb session in this subshell only
    if bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1; then
      record "PASS lock free during session"
    else
      record "FAIL lock free during session"
    fi
  }
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>/dev/null
}
test_prewarm_stops_before_secrets_and_session() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  session_exec() { record "FAIL prewarm must not start a session"; }
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" cmd_prewarm) 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "existing machine reused"
  assert_contains "$(cat "$STUB_LOG")" "bootstrap.sh" "prewarm bootstraps"
  assert_not_contains "$(cat "$STUB_LOG")" "op inject" "prewarm injects no secrets"
}
test_stub_serves_config_show_from_a_file() {
  printf 'machine.a.mounts: /x:/y\n' >"$TMP_ROOT/show"
  assert_eq "machine.a.mounts: /x:/y" "$(STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" STUB_ORB_STDOUT=other orb config show)" "config show from file"
  assert_eq "other" "$(STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" STUB_ORB_STDOUT=other orb list)" "other subcommands unchanged"
}
test_main_dispatches_commands() {
  run_tool() { printf 'run_tool %s\n' "$*"; }
  cmd_list() { echo list; }; cmd_gc() { echo gc; }; cmd_rm() { echo "rm $*"; }
  cmd_prewarm() { echo prewarm; }; cmd_env_edit() { echo env-edit; }; cmd_env_adopt() { echo "env-adopt $*"; }
  assert_eq "run_tool claude -p x" "$(main claude -p x)" "claude"
  assert_eq "run_tool codex" "$(main codex)" "codex"
  assert_eq "run_tool bash" "$(main shell)" "shell"
  assert_eq "prewarm" "$(main prewarm)" "prewarm"
  assert_eq "list" "$(main list)" "list"
  assert_eq "gc" "$(main gc)" "gc"
  assert_eq "rm /r" "$(main rm /r)" "rm"
  assert_eq "env-edit" "$(main env edit)" "env edit"
  assert_eq "env-adopt agent-old-000000" "$(main env adopt agent-old-000000)" "env adopt"
  assert_status 1 "unknown env subcommand" -- main env frobnicate
}

test_list_marks_missing_repos_and_skips_lock_files() {
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  : >"$AGENT_VM_STATE_DIR/machines/agent-live-000000.lock"
  local out; out=$(cmd_list)
  assert_contains "$out" "agent-live-000000	present" "live listed"
  assert_contains "$out" "agent-gone-000000	missing" "gone repo marked missing"
  assert_not_contains "$out" ".lock" "lock files are not machines"
}
test_list_shows_orphaned_env_files() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  assert_contains "$(cmd_list)" "orphaned env: agent-gone-000000" "orphan env listed"
}
test_gc_deletes_missing_machines_but_keeps_env_files() {
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_STATE_DIR/staging/agent-gone-000000" "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  printf 'y\n' | cmd_gc >/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-gone-000000" "orb delete for missing"
  assert_not_contains "$(cat "$STUB_LOG")" "agent-live-000000" "live untouched"
  assert_status 1 "staging of gone removed" -- test -e "$AGENT_VM_STATE_DIR/staging/agent-gone-000000"
  assert_status 0 "host-authored env file kept" -- test -f "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}
test_gc_aborts_without_yes() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  printf 'n\n' | cmd_gc >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "delete" "no deletion on 'n'"
}
test_launch_notices_orphan_env_when_own_is_missing() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  assert_contains "$(notice_orphan_env agent-new-000000 2>&1)" "agent-vm env adopt agent-gone-000000" "adopt hint"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-new-000000.env.1password"
  assert_eq "" "$(notice_orphan_env agent-new-000000 2>&1)" "silent when own env exists"
}
test_env_adopt_renames_orphan_to_current_machine() {
  local repo="$TMP_ROOT/adopt-repo"; mkdir -p "$repo" && git -C "$repo" init -q
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  (cd "$repo" && cmd_env_adopt agent-gone-000000) 2>/dev/null
  assert_eq "A=op://v/a/x" "$(cat "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password")" "adopted"
  assert_status 1 "old name gone" -- test -e "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}
test_env_adopt_refuses_non_orphan() {
  local repo="$TMP_ROOT/adopt-repo2"; mkdir -p "$repo" && git -C "$repo" init -q
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-live-000000.env.1password"
  assert_status 1 "live repo env not adoptable" -- bash -c "cd '$repo' && AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_CONFIG_DIR='$AGENT_VM_CONFIG_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; cmd_env_adopt agent-live-000000"
}
test_env_edit_creates_private_file() {
  local repo="$TMP_ROOT/edit-repo"; mkdir -p "$repo" && git -C "$repo" init -q
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  (cd "$repo" && EDITOR=true cmd_env_edit)
  local f="$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  assert_status 0 "file created" -- test -f "$f"
  assert_eq "600" "$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$f")" "mode 600 from creation"
}

setup_ingest() { # -> sets OB (outbox claude dir) and HP (host projects dir)
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  OB="$AGENT_VM_STATE_DIR/outbox/agent-i-000000/claude-projects/-repo"
  HP="$AGENT_VM_CLAUDE_PROJECTS_DIR/-repo"
  mkdir -p "$OB" "$AGENT_VM_STATE_DIR/build"
}
test_ingest_copies_new_and_appends_growth() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "a" "$(cat "$HP/s.jsonl")" "new log copied"
  printf 'b\n' >>"$OB/s.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "$(printf 'a\nb')" "$(cat "$HP/s.jsonl")" "appended tail only"
}
test_ingest_refuses_rewritten_prefix() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  printf 'X\nlonger\n' >"$OB/s.jsonl"
  local status=0 err; err=$(ingest_outbox agent-i-000000 2>&1) || status=$?
  assert_eq 4 "$status" "divergence reported by status"
  assert_contains "$err" "agent-vm sync --inspect" "recover hint names the command"
  assert_eq "a" "$(cat "$HP/s.jsonl")" "host copy untouched"
  status=0; ingest_outbox agent-i-000000 2>/dev/null || status=$?
  assert_eq 4 "$status" "still reported on the next run (not recorded)"
}
test_ingest_refuses_truncation() {
  setup_ingest
  printf 'abc\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  printf 'a\n' >"$OB/s.jsonl"
  local status=0; ingest_outbox agent-i-000000 2>/dev/null || status=$?
  assert_eq 4 "$status" "truncation reported"
  assert_eq "abc" "$(cat "$HP/s.jsonl")" "host copy untouched"
}
test_ingest_ignores_symlinks_and_non_jsonl() {
  setup_ingest
  printf 'secret\n' >"$TMP_ROOT/outside.jsonl"
  ln -s "$TMP_ROOT/outside.jsonl" "$OB/link.jsonl"
  printf 'x\n' >"$OB/notes.txt"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_status 1 "symlinked log ignored" -- test -e "$HP/link.jsonl"
  assert_status 1 "non-jsonl ignored" -- test -e "$HP/notes.txt"
}
test_ingest_ignores_symlinked_tree_root() {
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/agent-i-000000" "$AGENT_VM_STATE_DIR/build" "$TMP_ROOT/elsewhere/-repo"
  printf 'x\n' >"$TMP_ROOT/elsewhere/-repo/s.jsonl"
  ln -s "$TMP_ROOT/elsewhere" "$AGENT_VM_STATE_DIR/outbox/agent-i-000000/claude-projects"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_status 1 "symlinked root not followed" -- test -e "$AGENT_VM_CLAUDE_PROJECTS_DIR/-repo/s.jsonl"
}
test_ingest_recopies_after_host_deletion_and_tolerates_bad_records() {
  setup_ingest
  printf 'a\n' >"$OB/s.jsonl"; ingest_outbox agent-i-000000 2>/dev/null
  rm "$HP/s.jsonl"
  printf 'garbage line without tabs\n' >>"$AGENT_VM_STATE_DIR/ingested/agent-i-000000"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "a" "$(cat "$HP/s.jsonl")" "re-copied after host deletion"
  assert_eq "format=1" "$(head -1 "$AGENT_VM_STATE_DIR/ingested/agent-i-000000")" "record header"
}
test_ingest_handles_codex_sessions_tree() {
  setup_ingest
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/agent-i-000000/codex-sessions/2026/09"
  printf 'c\n' >"$AGENT_VM_STATE_DIR/outbox/agent-i-000000/codex-sessions/2026/09/r.jsonl"
  ingest_outbox agent-i-000000 2>/dev/null
  assert_eq "c" "$(cat "$AGENT_VM_CODEX_SESSIONS_DIR/2026/09/r.jsonl")" "codex session ingested"
}

make_git_repo() { # -> repo path with one commit
  local repo="$TMP_ROOT/g-repo"
  mkdir -p "$repo" && git -C "$repo" init -q
  git -C "$repo" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
  (cd -P "$repo" && pwd -P)
}
surface_status() { # machine repo -> exit status of check_git_surfaces
  local s=0; check_git_surfaces "$1" "$2" >/dev/null 2>&1 || s=$?; printf '%s\n' "$s"
}
test_first_check_baselines_silently() {
  local repo; repo=$(make_git_repo)
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "first run is clean"
  assert_status 0 "baseline written" -- test -f "$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline"
}
test_added_hook_is_reported_until_resolved() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho pwned\n' >"$repo/.git/hooks/post-checkout"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_contains "$out" "added" "added hook reported"
  assert_contains "$out" "post-checkout" "names the hook"
  assert_contains "$out" "recover: agent-vm restore-git" "recover hint"
  assert_contains "$out" "agent-vm accept-git" "accept hint"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "still reported on the next check"
}
test_changed_hook_and_redirected_hooks_dir_are_reported() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "changed hook content"
  local repo2="$TMP_ROOT/g2"; mkdir -p "$repo2" && git -C "$repo2" init -q; repo2=$(cd -P "$repo2" && pwd -P)
  surface_status agent-g-000001 "$repo2" >/dev/null
  mkdir -p "$TMP_ROOT/evil-hooks"; printf '#!/bin/sh\n' >"$TMP_ROOT/evil-hooks/pre-push"
  rm -rf "$repo2/.git/hooks"; ln -s "$TMP_ROOT/evil-hooks" "$repo2/.git/hooks"
  assert_eq 3 "$(surface_status agent-g-000001 "$repo2")" "hooks dir replaced by a symlink"
}
test_exec_config_keys_are_reported_but_benign_keys_are_not() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config branch.main.remote origin
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "benign config ignored"
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "core.fsmonitor reported"
}
test_hookspath_target_contents_are_hashed() {
  local repo; repo=$(make_git_repo)
  mkdir -p "$repo/tools/hooks"; printf '#!/bin/sh\n' >"$repo/tools/hooks/pre-commit"
  git -C "$repo" config core.hooksPath tools/hooks
  surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/tools/hooks/pre-commit"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "hooksPath target change reported"
}
test_untracked_envrc_reported_tracked_not() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  printf 'export X=1\n' >"$repo/.envrc"
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "untracked .envrc reported"
  local repo2="$TMP_ROOT/g3"; mkdir -p "$repo2" && git -C "$repo2" init -q; repo2=$(cd -P "$repo2" && pwd -P)
  printf 'export X=1\n' >"$repo2/.envrc"; git -C "$repo2" add .envrc
  git -C "$repo2" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m envrc
  surface_status agent-g-000002 "$repo2" >/dev/null
  printf 'export X=2\n' >"$repo2/.envrc"
  assert_eq 0 "$(surface_status agent-g-000002 "$repo2")" "tracked .envrc left to git diff"
}
test_version_bump_adopts_only_new_kinds() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  surface_status agent-g-000000 "$repo" >/dev/null
  local b="$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline"
  # Simulate a future version 2 that starts monitoring "untracked": the version-1 baseline has none.
  GIT_SURFACE_MONITORED=2
  surface_kinds_since() { if [[ "$1" -lt 2 ]]; then echo untracked; else echo; fi; }
  { printf 'format=1\nmonitored=1\n'; grep -v -e '^untracked' -e '^format=' -e '^monitored=' "$b"; } >"$b.tmp" && mv "$b.tmp" "$b"
  printf 'export X=1\n' >"$repo/.envrc"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-merge"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_not_contains "$out" ".envrc" "new-kind item adopted silently"
  assert_contains "$out" "changed	hookfile	.git/hooks/pre-commit" "old-kind change still reported"
  assert_contains "$out" "added	hookfile	.git/hooks/post-merge" "old-kind addition still reported"
  assert_contains "$(cat "$b")" "monitored=2" "baseline moves to the new version"
}
test_rebaseline_keeps_reporting_the_same_diff_and_clears_after_fix() {
  local repo; repo=$(make_git_repo)
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; surface_status agent-g-000000 "$repo" >/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  local d="$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/diff" first second
  surface_status agent-g-000000 "$repo" >/dev/null; first=$(cat "$d")
  surface_status agent-g-000000 "$repo" >/dev/null; second=$(cat "$d")
  assert_eq "$first" "$second" "identical diff on the next check (no baseline corruption)"
  assert_not_contains "$(cat "$AGENT_VM_STATE_DIR/snapshots/agent-g-000000/baseline")" "changed	" "no diff lines leaked into the baseline"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"; rm "$repo/.git/hooks/post-checkout"
  assert_eq 0 "$(surface_status agent-g-000000 "$repo")" "clean once the changes are undone"
}
test_symlinked_git_dir_is_reported() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  mv "$repo/.git" "$TMP_ROOT/moved-git"; ln -s "$TMP_ROOT/moved-git" "$repo/.git"
  local out; out=$(check_git_surfaces agent-g-000000 "$repo" 2>&1) || true
  assert_contains "$out" "changed	gitdir	.git" ".git replaced by a symlink reported"
}
test_ls_files_does_not_run_planted_fsmonitor() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config core.fsmonitor "touch $TMP_ROOT/fsmonitor-ran; false"
  printf 'export X=1\n' >"$repo/.envrc"
  surface_status agent-g-000000 "$repo" >/dev/null
  assert_status 1 "planted fsmonitor not executed" -- test -e "$TMP_ROOT/fsmonitor-ran"
}
test_fetch_time_exec_keys_are_monitored() {
  local repo; repo=$(make_git_repo); surface_status agent-g-000000 "$repo" >/dev/null
  git -C "$repo" config url."ext::sh -c touch% /tmp/x".insteadOf https://example.com/
  assert_eq 3 "$(surface_status agent-g-000000 "$repo")" "url.*.insteadOf reported"
}

test_restore_git_undoes_hook_config_and_envrc_changes() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\necho pwned\n' >"$repo/.git/hooks/post-checkout"
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  printf 'export X=1\n' >"$repo/.envrc"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1
  assert_eq "#!/bin/sh" "$(cat "$repo/.git/hooks/pre-commit")" "changed hook restored"
  assert_status 1 "added hook removed" -- test -e "$repo/.git/hooks/post-checkout"
  assert_status 1 "added exec config unset" -- git -C "$repo" config --get core.fsmonitor
  assert_status 0 ".envrc quarantined" -- test -f "$repo/.envrc.agent-vm-quarantine"
  assert_eq 0 "$(surface_status "$m" "$repo")" "clean after restore"
}
test_restore_git_fixes_symlinked_hooks_dir_before_files() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  local outside="$TMP_ROOT/outside-hooks"; mkdir -p "$outside"
  printf 'keep\n' >"$outside/victim"
  rm -rf "$repo/.git/hooks"; ln -s "$outside" "$repo/.git/hooks"
  printf '#!/bin/sh\n' >"$outside/post-checkout"
  cp "$outside/victim" "$outside/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_eq "keep" "$(cat "$outside/victim")" "file outside the repo untouched"
  assert_eq "keep" "$(cat "$outside/pre-commit")" "same-named file outside the repo not overwritten"
  assert_status 0 "file outside the repo not deleted" -- test -e "$outside/post-checkout"
  assert_status 1 "hooks dir is a real directory again" -- test -L "$repo/.git/hooks"
}
test_restore_git_skips_a_tampered_saved_copy() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  # simulate a copy captured through a swapped-in symlink: content differs from the baseline hash
  printf '#!/bin/sh\necho planted\n' >"$AGENT_VM_STATE_DIR/snapshots/$m/files/hooks/pre-commit"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_status 1 "tampered copy not written back (file left removed)" -- test -e "$repo/.git/hooks/pre-commit"
}
test_restore_git_refuses_symlinked_git_dir() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"; check_git_surfaces "$m" "$repo" 2>/dev/null
  mv "$repo/.git" "$TMP_ROOT/moved-git"; ln -s "$TMP_ROOT/moved-git" "$repo/.git"
  assert_status 1 "symlinked .git refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; printf 'y\n' | cmd_restore_git '$repo'"
}
test_restore_git_does_nothing_without_yes() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"; check_git_surfaces "$m" "$repo" 2>/dev/null
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  printf 'n\n' | cmd_restore_git "$repo" >/dev/null 2>&1
  assert_status 0 "hook left in place" -- test -f "$repo/.git/hooks/post-checkout"
}
test_restore_git_refuses_snapshot_of_another_path() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "/somewhere/else"
  assert_status 1 "path mismatch refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; printf 'y\n' | cmd_restore_git '$repo'"
}

# --- accept-git ----------------------------------------------------------------------------------
# Scripted /dev/tty: the tests source the launcher with AGENT_VM_LIB=1, which lets AGENT_VM_TTY replace /dev/tty.
accept_setup() { # sets repo, m (callers declare them local); baseline taken with a plain pre-commit
  repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  check_git_surfaces "$m" "$repo" 2>/dev/null
}
accept_run() { # tty_content -> ACC_OUT (stdout+stderr), ACC_RC; runs cmd_accept_git against $repo
  printf '%s' "$1" >"$TMP_ROOT/tty"
  # errexit stays on inside the substitution, as in the real command (`|| rc=$?` would switch it off)
  set +e
  ACC_OUT=$(set -e; AGENT_VM_TTY="$TMP_ROOT/tty" cmd_accept_git "$repo" 2>&1)
  ACC_RC=$?
  set -e
}
accept_baseline_sha() { shasum -a 256 <"$AGENT_VM_STATE_DIR/snapshots/$m/baseline"; }
accept_check_out() { check_git_surfaces "$m" "$repo" 2>&1 || true; }

test_accept_git_adopts_hook_changes() {
  local repo m; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  accept_run $'y\n'
  assert_eq 0 "$ACC_RC" "accept adopts: exit 0"
  assert_eq 0 "$(surface_status "$m" "$repo")" "accept adopts: next check is clean"
}
test_accept_git_refreshes_saved_copies_for_restore() {
  local repo m; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"; chmod 755 "$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  printf '#!/bin/sh\necho again\n' >"$repo/.git/hooks/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_eq "$(printf '#!/bin/sh\necho changed')" "$(cat "$repo/.git/hooks/pre-commit")" "restore writes back the accepted version"
  assert_status 0 "accepted hook keeps its executable bit" -- test -x "$repo/.git/hooks/pre-commit"
}
test_accept_git_accepts_a_removed_hook() {
  local repo m; accept_setup
  rm "$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  assert_eq 0 "$ACC_RC" "removed hook accepted: exit 0"
  assert_eq 0 "$(surface_status "$m" "$repo")" "removed hook accepted: next check is clean"
}
test_accept_git_does_not_treat_a_retyped_hook_as_removed() {
  local repo m; accept_setup
  rm "$repo/.git/hooks/pre-commit"; ln -s /bin/sh "$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "retyped hook is not accepted: exit 3"
  assert_contains "$(accept_check_out)" ".git/hooks/pre-commit" "retyped hook is still reported"
}
test_accept_git_does_nothing_without_yes() {
  local repo m; accept_setup
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  accept_run $'n\n'
  assert_eq 0 "$ACC_RC" "n: exit 0"
  assert_eq 3 "$(surface_status "$m" "$repo")" "n: still reported"
}
test_accept_git_treats_eof_as_no() {
  local repo m before; accept_setup
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  before=$(accept_baseline_sha)
  accept_run ''
  assert_eq 0 "$ACC_RC" "EOF: exit 0"
  assert_eq "$before" "$(accept_baseline_sha)" "EOF: baseline untouched"
}
test_accept_git_aborts_when_a_hook_changes_after_display() {
  local repo m before; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  before=$(accept_baseline_sha)
  # shellcheck disable=SC2162 # forwards the caller's own flags (-r) to the builtin
  read() { if [[ "${!#}" == answer ]]; then printf '#!/bin/sh\necho late\n' >"$repo/.git/hooks/pre-commit"; fi; builtin read "$@"; }
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "late content change: exit 3"
  assert_contains "$ACC_OUT" "changed after it was shown" "late content change: message"
  assert_eq "$before" "$(accept_baseline_sha)" "late content change: baseline untouched"
  if grep -q 'echo late' "$repo/.git/hooks/pre-commit"; then record "PASS late overwrite fired"; else record "FAIL late overwrite fired"; fi
}
test_accept_git_aborts_when_a_hook_mode_changes_after_display() {
  local repo m before; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  before=$(accept_baseline_sha)
  # shellcheck disable=SC2162 # forwards the caller's own flags (-r) to the builtin
  read() { if [[ "${!#}" == answer ]]; then chmod 600 "$repo/.git/hooks/pre-commit"; fi; builtin read "$@"; }
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "late mode change: exit 3"
  assert_contains "$ACC_OUT" "changed after it was shown" "late mode change: message"
  assert_eq "$before" "$(accept_baseline_sha)" "late mode change: baseline untouched"
}
test_accept_git_aborts_when_the_baseline_changes_meanwhile() {
  local repo m; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  # shellcheck disable=SC2162 # forwards the caller's own flags (-r) to the builtin
  read() { if [[ "${!#}" == answer ]]; then printf 'config\tx:y\tabc\n' >>"$AGENT_VM_STATE_DIR/snapshots/$m/baseline"; fi; builtin read "$@"; }
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "baseline race: exit 3"
  assert_contains "$ACC_OUT" "baseline changed meanwhile" "baseline race: message"
  assert_eq "#!/bin/sh" "$(cat "$AGENT_VM_STATE_DIR/snapshots/$m/files/hooks/pre-commit")" "baseline race: saved copy untouched"
}
test_accept_git_shows_sanitized_hook_diff() {
  local repo m; accept_setup
  printf '#!/bin/sh\necho changed\033[2J\r\n' >"$repo/.git/hooks/pre-commit"
  accept_run $'n\n'
  assert_contains "$ACC_OUT" "+echo changed" "diff body is shown"
  assert_not_contains "$ACC_OUT" $'\033' "no raw ESC in accept output"
  assert_not_contains "$ACC_OUT" $'\r' "no raw CR in accept output"
}
test_check_git_surfaces_sanitizes_reported_names() {
  local repo m out; accept_setup
  git -C "$repo" config "filter.$(printf 'a\033b').clean" x
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  out=$(check_git_surfaces "$m" "$repo" 2>&1) || true
  assert_not_contains "$out" $'\033' "no raw ESC in the warning"
  assert_eq 1 "$([[ $(printf '%s\n' "$out" | grep -c '^  added') -ge 2 ]] && echo 1 || echo 0)" "items stay on separate lines"
}
test_restore_git_sanitizes_its_listing() {
  local repo m out; accept_setup
  git -C "$repo" config "filter.$(printf 'a\033b').clean" x
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  out=$(printf 'n\n' | cmd_restore_git "$repo" 2>&1) || true
  assert_not_contains "$out" $'\033' "no raw ESC in the restore listing"
  assert_eq 1 "$([[ $(printf '%s\n' "$out" | grep -c '^  added') -ge 2 ]] && echo 1 || echo 0)" "restore items stay on separate lines"
}
test_step_and_die_sanitize_messages() {
  local s out rc=0; s=$(printf 'a\033]52;c;x\007b')
  out=$(step "$s" 2>&1)
  assert_not_contains "$out" $'\033' "step: no ESC"
  assert_not_contains "$out" $'\007' "step: no BEL"
  out=$( (die "$s") 2>&1) || rc=$?
  assert_eq 1 "$rc" "die: exit 1"
  assert_not_contains "$out" $'\033' "die: no ESC"
  assert_not_contains "$out" $'\007' "die: no BEL"
}
test_restore_git_aborts_when_changed_after_display() {
  local repo m out rc=0; accept_setup
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-merge"
  # shellcheck disable=SC2162 # forwards the caller's own flags (-r) to the builtin
  read() { if [[ "${!#}" == answer ]]; then printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"; fi; builtin read "$@"; }
  out=$(printf 'y\n' | cmd_restore_git "$repo" 2>&1) || rc=$?
  assert_eq 3 "$rc" "restore race: exit 3"
  assert_contains "$out" "changed after it was shown" "restore race: message"
  assert_status 0 "restore race: nothing was restored" -- test -e "$repo/.git/hooks/post-merge"
}
test_accept_git_with_nothing_to_accept() {
  local repo m before; accept_setup
  before=$(accept_baseline_sha)
  accept_run $'y\n'
  assert_eq 0 "$ACC_RC" "nothing to accept: exit 0"
  assert_contains "$ACC_OUT" "nothing to accept" "nothing to accept: message"
  assert_eq "$before" "$(accept_baseline_sha)" "nothing to accept: baseline untouched"
}
test_accept_git_with_only_unacceptable_changes() {
  local repo m; accept_setup
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "only unacceptable: exit 3"
  assert_contains "$ACC_OUT" "nothing to accept" "only unacceptable: nothing to accept"
  assert_contains "$ACC_OUT" "not accepted" "only unacceptable: listed"
}
test_accept_git_leaves_non_hook_changes_reported() {
  local repo m out; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  git -C "$repo" config core.fsmonitor "sh -c 'echo pwned'"
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "mixed: exit 3"
  assert_contains "$ACC_OUT" "still reported" "mixed: still reported"
  out=$(accept_check_out)
  assert_contains "$out" "core.fsmonitor" "mixed: config stays reported"
  assert_not_contains "$out" ".git/hooks/pre-commit" "mixed: the hook was accepted"
}
test_accept_git_leaves_unreviewable_hooks_reported() {
  local repo m out unreadable=0; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  head -c 71680 /dev/zero | tr '\0' a >"$repo/.git/hooks/post-checkout"
  { head -c 500 /dev/zero | tr '\0' a; echo; } >"$repo/.git/hooks/post-merge"
  printf 'a\0b\n' >"$repo/.git/hooks/pre-rebase"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/bad name"
  # root reads mode-000 files anyway
  if [[ "$(id -u)" -ne 0 ]]; then unreadable=1; printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-push"; chmod 000 "$repo/.git/hooks/pre-push"; fi
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "unreviewable hooks: exit 3"
  assert_contains "$ACC_OUT" "not accepted (stays reported): size hookfile .git/hooks/post-checkout" "size refused"
  assert_contains "$ACC_OUT" "not accepted (stays reported): line length hookfile .git/hooks/post-merge" "line length refused"
  assert_contains "$ACC_OUT" "not accepted (stays reported): binary hookfile .git/hooks/pre-rebase" "NUL refused"
  assert_contains "$ACC_OUT" "not accepted (stays reported): name hookfile .git/hooks/bad name" "odd name refused"
  out=$(accept_check_out)
  assert_not_contains "$out" ".git/hooks/pre-commit" "the reviewable hook was accepted"
  assert_contains "$out" ".git/hooks/post-checkout" "oversized hook still reported"
  assert_contains "$out" ".git/hooks/pre-rebase" "NUL hook still reported"
  if [[ "$unreadable" -eq 1 ]]; then
    assert_contains "$ACC_OUT" "not accepted (stays reported): unreadable hookfile .git/hooks/pre-push" "unreadable refused"
    assert_contains "$out" ".git/hooks/pre-push" "unreadable hook still reported"
  else
    record "PASS unreadable hook refused (skipped: running as root)"
  fi
}
test_accept_git_rejects_forged_duplicate_entries() {
  local repo m d out; accept_setup
  # The nested path makes hash_hook_dir print a second, 3-column "hookfile .git/hooks/pre-commit" line.
  d=$'x\nhookfile\t.git'
  mkdir -p "$repo/.git/hooks/$d/hooks"
  printf '#!/bin/sh\necho forged\n' >"$repo/.git/hooks/$d/hooks/pre-commit"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "forged duplicate: exit 3"
  assert_contains "$ACC_OUT" "duplicate" "forged duplicate: reason"
  out=$(accept_check_out)
  assert_contains "$out" ".git/hooks/pre-commit" "forged duplicate: pre-commit stays reported"
}
test_accept_git_keeps_existing_hooks_ahead_of_new_ones() {
  local repo m c out; accept_setup
  for c in {a..t}; do printf '#!/bin/sh\n' >"$repo/.git/hooks/0$c"; done
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "budget with an existing hook: exit 3"
  assert_contains "$ACC_OUT" "budget" "budget reason shown"
  out=$(accept_check_out)
  assert_not_contains "$out" ".git/hooks/pre-commit" "the existing hook is accepted first"
}
test_accept_git_respects_the_display_budget() {
  local repo m c out; accept_setup
  for c in {a..t}; do printf '#!/bin/sh\n' >"$repo/.git/hooks/0$c"; done
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "16 of 20 accepted: exit 3"
  assert_eq 4 "$(printf '%s\n' "$ACC_OUT" | grep -c '^not accepted.*budget')" "4 hooks refused for budget"
  out=$(accept_check_out)
  assert_eq 4 "$(printf '%s\n' "$out" | grep -c '^  added')" "4 hooks remain reported"
}
test_accept_git_is_not_disturbed_by_special_files() {
  local repo m rc=0; accept_setup
  mkfifo "$repo/.git/hooks/post-merge"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  printf 'y\n' >"$TMP_ROOT/tty"
  AGENT_VM_TTY="$TMP_ROOT/tty" perl -e 'alarm shift; exec @ARGV' 10 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; cmd_accept_git '$repo'" >/dev/null 2>&1 </dev/null || rc=$?
  assert_eq 0 "$rc" "FIFO in hooks does not stall accept (142 would be the alarm)"
  assert_eq 0 "$(surface_status "$m" "$repo")" "hook accepted despite the FIFO"
}
test_accept_git_caps_the_not_accepted_listing() {
  local repo m i; accept_setup
  mkdir -p "$repo/.git/hooks/sub"
  for i in $(seq 1 60); do printf '#!/bin/sh\n' >"$repo/.git/hooks/sub/f$i"; done
  accept_run $'y\n'
  assert_eq 3 "$ACC_RC" "60 not accepted: exit 3"
  assert_eq 50 "$(printf '%s\n' "$ACC_OUT" | grep -c '^not accepted')" "listing capped at 50"
  assert_contains "$ACC_OUT" "and 10 more" "remainder summarized"
}
test_accept_copy_hook_refuses_non_regular_and_oversized() {
  local d="$TMP_ROOT/ach" r rc
  mkdir -p "$d/dir"; mkfifo "$d/fifo"; ln -s /bin/sh "$d/link"
  head -c 65536 /dev/zero | tr '\0' a >"$d/ok"; head -c 65537 /dev/zero | tr '\0' a >"$d/big"
  rc=0; r=$(AGENT_VM_LIB=1 perl -e 'alarm shift; exec @ARGV' 10 bash -c ". '$LAUNCHER'; accept_copy_hook '$d/fifo' '$d/out-fifo'") || rc=$?
  assert_eq "1 type" "$rc $r" "FIFO is refused without blocking"
  rc=0; r=$(accept_copy_hook "$d/link" "$d/out-link") || rc=$?
  assert_eq "1 unreadable" "$rc $r" "symlink is refused"
  rc=0; r=$(accept_copy_hook "$d/dir" "$d/out-dir") || rc=$?
  assert_eq "1 type" "$rc $r" "directory is refused"
  rc=0; r=$(accept_copy_hook "$d/ok" "$d/out-ok") || rc=$?
  assert_eq "0 0644" "$rc $r" "65536 bytes accepted (prints the mode)"
  rc=0; r=$(accept_copy_hook "$d/big" "$d/out-big") || rc=$?
  assert_eq "1 size" "$rc $r" "65537 bytes refused"
  assert_status 1 "no partial copy left for a refused file" -- test -e "$d/out-big"
}
test_accept_git_limits_are_inclusive() {
  local repo m h c; accept_setup
  h="$repo/.git/hooks/lim"
  seq 1 1000 >"$h"; accept_run $'n\n'
  assert_not_contains "$ACC_OUT" "not accepted" "1000 lines accepted"
  seq 1 1001 >"$h"; accept_run $'n\n'
  assert_contains "$ACC_OUT" "not accepted (stays reported): lines hookfile .git/hooks/lim" "1001 lines refused"
  { seq 1 1000; printf 'x'; } >"$h"; accept_run $'n\n'
  assert_contains "$ACC_OUT" "not accepted (stays reported): lines hookfile .git/hooks/lim" "unterminated 1001st line counts"
  head -c 400 /dev/zero | tr '\0' a >"$h"; echo >>"$h"; accept_run $'n\n'
  assert_not_contains "$ACC_OUT" "not accepted" "400-byte line accepted"
  head -c 401 /dev/zero | tr '\0' a >"$h"; echo >>"$h"; accept_run $'n\n'
  assert_contains "$ACC_OUT" "not accepted (stays reported): line length hookfile .git/hooks/lim" "401-byte line refused"
  rm "$h"
  for c in a b c d; do seq 1 1000 >"$repo/.git/hooks/b$c"; done
  accept_run $'n\n'
  assert_eq 1 "$(printf '%s\n' "$ACC_OUT" | grep -c '^not accepted')" "4 x 1000 lines: one hook over the 3000-line budget"
  assert_contains "$ACC_OUT" "not accepted (stays reported): budget hookfile .git/hooks/bd" "the 4th is refused for budget"
}
test_restore_git_cleans_up_its_workdir() {
  local repo m; accept_setup
  printf '#!/bin/sh\n' >"$repo/.git/hooks/post-checkout"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_eq "" "$(ls -d "$AGENT_VM_STATE_DIR/snapshots/$m"/restore.* 2>/dev/null || true)" "no restore workdir left"
}
test_accept_git_cleans_up_its_workdir() {
  local repo m
  repo=$(make_git_repo); m=$(derive_machine_name "$repo"); write_machine_meta "$m" "$repo"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/pre-commit"
  chmod 500 "$repo/.git/hooks"
  check_git_surfaces "$m" "$repo" 2>/dev/null
  chmod 700 "$repo/.git/hooks"
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  accept_run $'y\n'
  assert_eq 0 "$ACC_RC" "read-only saved copy: accept succeeds"
  assert_eq "" "$(ls -d "$AGENT_VM_STATE_DIR/snapshots/$m"/accept.* 2>/dev/null || true)" "no accept workdir left"
  printf '#!/bin/sh\necho again\n' >"$repo/.git/hooks/pre-commit"
  printf 'y\n' | cmd_restore_git "$repo" >/dev/null 2>&1 || true
  assert_eq "$(printf '#!/bin/sh\necho changed')" "$(cat "$repo/.git/hooks/pre-commit")" "restore writes back the accepted version"
}
test_accept_git_only_considers_hooks_in_the_report() {
  local repo m reported candidates; accept_setup
  printf '#!/bin/sh\n' >"$repo/.git/hooks/h1"; printf '#!/bin/sh\n' >"$repo/.git/hooks/h2"
  mkdir -p "$repo/.git/hooks/sub"; printf '#!/bin/sh\n' >"$repo/.git/hooks/sub/x"
  ln -s /bin/sh "$repo/.git/hooks/lnk"
  printf '#!/bin/sh\n' >"$repo/.git/hooks/bad name"
  reported=$(accept_check_out | sed -n 's/^  [a-z]*	[a-z]*	//p' | sort -u)
  accept_run $'n\n'
  candidates=$({
    printf '%s\n' "$ACC_OUT" | sed -n 's/^not accepted (stays reported): [^ ]* [^ ]* //p'
    printf '%s\n' "$ACC_OUT" | awk -F'\t' '$1 == "added" || $1 == "changed" || $1 == "removed" { print $2 }'
  } | sort -u)
  assert_eq "$reported" "$candidates" "accept's candidates are exactly the reported items"
}
test_accept_git_requires_a_terminal() {
  local repo m; accept_setup
  printf '#!/bin/sh\necho changed\n' >"$repo/.git/hooks/pre-commit"
  assert_status 1 "no readable tty refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 AGENT_VM_TTY='$TMP_ROOT/missing' . '$LAUNCHER'; cmd_accept_git '$repo'"
}
test_accept_git_refuses_snapshot_of_another_path() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "/somewhere/else"
  printf 'y\n' >"$TMP_ROOT/tty"
  assert_status 1 "path mismatch refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 AGENT_VM_TTY='$TMP_ROOT/tty' . '$LAUNCHER'; cmd_accept_git '$repo'"
}
test_accept_git_refuses_symlinked_git_dir() {
  local repo m; repo=$(make_git_repo); m=$(derive_machine_name "$repo")
  write_machine_meta "$m" "$repo"; check_git_surfaces "$m" "$repo" 2>/dev/null
  mv "$repo/.git" "$TMP_ROOT/moved-git"; ln -s "$TMP_ROOT/moved-git" "$repo/.git"
  printf 'y\n' >"$TMP_ROOT/tty"
  assert_status 1 "symlinked .git refused" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 AGENT_VM_TTY='$TMP_ROOT/tty' . '$LAUNCHER'; cmd_accept_git '$repo'"
}

test_session_logs_are_ingested_after_the_session() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  notice_orphan_env() { :; }
  session_exec() { mkdir -p "$AGENT_VM_STATE_DIR/outbox/$1/claude-projects/-r"; printf 'x\n' >"$AGENT_VM_STATE_DIR/outbox/$1/claude-projects/-r/s.jsonl"; }
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>/dev/null
  assert_eq "x" "$(cat "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl")" "ingested on exit"
}
test_git_surface_change_during_session_sets_exit_code() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  notice_orphan_env() { :; }
  session_exec() { printf '#!/bin/sh\n' >"$REPO/.git/hooks/post-checkout"; }
  local status=0
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>/dev/null || status=$?
  assert_eq 3 "$status" "exit code 3 when git surfaces changed"
}
test_tool_failure_status_wins() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  notice_orphan_env() { :; }
  session_exec() { printf '#!/bin/sh\n' >"$REPO/.git/hooks/post-checkout"; return 7; }
  local status=0
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" run_tool claude) 2>/dev/null || status=$?
  assert_eq 7 "$status" "tool status preferred"
}
test_finish_reports_lock_timeout_with_recover_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  notice_orphan_env() { :; }
  session_exec() {
    bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$m' 1 && exec sleep 5" </dev/null >/dev/null 2>&1 &
    sleep 1
  }
  local status=0 err
  err=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" AGENT_VM_FINISH_WAIT=1 run_tool claude 2>&1) || status=$?
  assert_eq 5 "$status" "exit code 5 on lock timeout"
  assert_contains "$err" "recover: agent-vm sync" "recover hint"
  wait
}
test_sync_inspect_lists_divergence_without_writing() {
  local repo m; repo=$(make_flow_repo); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  export AGENT_VM_CLAUDE_PROJECTS_DIR="$TMP_ROOT/host-projects" AGENT_VM_CODEX_SESSIONS_DIR="$TMP_ROOT/host-codex"
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/$m/claude-projects/-r" "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r"
  printf 'abc\n' >"$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl"
  printf 'XYZ\n' >"$AGENT_VM_STATE_DIR/outbox/$m/claude-projects/-r/s.jsonl"
  local out; out=$(cd "$repo" && cmd_sync --inspect 2>&1)
  assert_contains "$out" "diverged" "divergence listed"
  assert_eq "abc" "$(cat "$AGENT_VM_CLAUDE_PROJECTS_DIR/-r/s.jsonl")" "inspect writes nothing"
}
test_main_dispatches_sync_and_restore_git() {
  cmd_sync() { echo "sync $*"; }; cmd_restore_git() { echo "restore-git $*"; }; cmd_accept_git() { echo "accept-git $*"; }
  assert_eq "sync --inspect" "$(main sync --inspect)" "sync"
  assert_eq "restore-git /r" "$(main restore-git /r)" "restore-git"
  assert_eq "accept-git /r" "$(main accept-git /r)" "accept-git"
  assert_contains "$(main --help)" "agent-vm accept-git" "help lists accept-git"
}
test_failed_copy_publishes_no_staging_generation() {
  # build_staging runs inside out=$(...), where set -e is not inherited: failures must be checked explicitly
  # root reads mode-000 files anyway, so the copy cannot be made to fail this way
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS copy failure is reported (skipped: running as root)"; return 0; fi
  local wt; wt=$(make_dotfiles_fixture)
  chmod 000 "$wt/home/dot_a"
  local status=0
  (out=$(build_staging agent-f-000000 "$wt")) 2>/dev/null || status=$?
  chmod 644 "$wt/home/dot_a"
  if [[ "$status" -ne 0 ]]; then record "PASS copy failure is reported"; else record "FAIL copy failure is reported"; fi
  assert_eq "" "$(ls "$AGENT_VM_STATE_DIR/staging/agent-f-000000" 2>/dev/null)" "no partial generation published"
}

test_gh_repo_from_url_accepts_three_github_forms() {
  assert_eq "Owner/Repo" "$(gh_repo_from_url git@github.com:Owner/Repo.git)" "scp form with .git"
  assert_eq "Owner/Repo" "$(gh_repo_from_url ssh://git@github.com/Owner/Repo)" "ssh url"
  assert_eq "Owner/Repo" "$(gh_repo_from_url https://github.com/Owner/Repo/)" "https with trailing slash"
  assert_status 1 "other host rejected" -- gh_repo_from_url git@gitlab.com:Owner/Repo.git
  assert_status 1 "nested path rejected" -- gh_repo_from_url https://github.com/a/b/c
  assert_status 1 "dot-dot rejected" -- gh_repo_from_url https://github.com/../Repo
  assert_status 1 "control character rejected" -- gh_repo_from_url "$(printf 'https://github.com/O/R\033[2J')"
}
test_gh_same_repo_ignores_case() {
  assert_status 0 "case-insensitive match" -- gh_same_repo Owner/Repo owner/repo
  assert_status 1 "different repo" -- gh_same_repo Owner/Repo Owner/Other
}
test_gh_vault_days_maps_only_the_two_vaults() {
  assert_eq 90 "$(gh_vault_days Personal)" "Personal is 90 days"
  assert_eq 30 "$(gh_vault_days Formal)" "Formal is 30 days"
  assert_status 1 "lowercase rejected" -- gh_vault_days personal
  assert_status 1 "unknown rejected" -- gh_vault_days Shared
}
test_gh_pat_name_and_expiry_use_utc() {
  # 1767225600 = 2026-01-01T00:00:00Z
  assert_eq "repo-abc123-2601010000" "$(gh_pat_name agent-repo-abc123 1767225600)" "pat name"
  assert_eq "2026-04-01" "$(gh_utc %Y-%m-%d 1767225600 90)" "expiry after 90 days"
  local longest; longest=$(gh_pat_name agent-aaaaaaaaaaaaaaaaaaaa-abcdef 1767225600)
  if [[ ${#longest} -le 40 ]]; then record "PASS pat name fits 40 chars"; else record "FAIL pat name fits 40 chars (${#longest})"; fi
}
test_gh_template_url_fills_name_expiry_and_permissions() {
  local url; url=$(gh_template_url repo-abc123-2601010000 Owner/Repo 30)
  assert_contains "$url" "https://github.com/settings/personal-access-tokens/new?name=repo-abc123-2601010000&" "name"
  assert_contains "$url" "&expires_in=30&" "expiry"
  assert_contains "$url" "Owner%2FRepo" "description is url-encoded"
  assert_contains "$url" "contents=read&pull_requests=write&issues=write&actions=read" "permissions"
  assert_not_contains "$url" "contents=write" "no push permission"
  assert_not_contains "$url" "target_name" "no target_name"
}

gh_put_state() { # machine content: write a state file fixture
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf '%b' "$2" >"$AGENT_VM_CONFIG_DIR/repos/$1.gh"
}
gh_bytes() { cat "$1"; printf x; } # file content with its trailing newlines kept (strip the x after $(...))
gh_mode() { perl -e 'printf "%o", (stat $ARGV[0])[2] & 0777' "$1"; }
GH_NEW_LINE=GH_TOKEN=op://Formal/zyxwvutsrqponmlkjihgfedcba/credential
test_gh_read_state_classifies_absent_ok_broken() {
  gh_read_state agent-s-000000; assert_eq absent "$GH_STATE" "absent"
  gh_put_state agent-s-000000 'v=1\r\nrepo=Owner/Repo\nvault=Formal\npat_name=s-000000-2601010000\nexpires=2026-01-31\nrepo=Evil/Other\nextra=x\n'
  gh_read_state agent-s-000000
  assert_eq ok "$GH_STATE" "ok with CRLF, duplicate and unknown keys"
  assert_eq "Owner/Repo" "$GH_STATE_REPO" "first repo wins"
  assert_eq "Formal" "$GH_STATE_VAULT" "vault"
  assert_eq "2026-01-31" "$GH_STATE_EXPIRES" "expires"
  gh_put_state agent-s-000000 'v=1\nrepo=Owner/Repo\nvault=Formal\npat_name=s-000000-2601010000\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "missing key is broken"
  gh_put_state agent-s-000000 'v=1\nrepo=Owner/Repo\nvault=personal\npat_name=s\nexpires=2026-01-31\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "bad vault is broken"
  gh_put_state agent-s-000000 'v=2\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31\n'
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "unknown version is broken"
  local bad
  for bad in 'repo=a/b/c' 'repo=../x' 'pat_name=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'expires=2026-1-1' 'vault=Formal ' 'v='; do
    gh_put_state agent-s-000000 "$bad\nv=1\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31\n"
    gh_read_state agent-s-000000
    if [[ "$bad" == 'vault=Formal ' ]]; then assert_eq ok "$GH_STATE" "trailing space trimmed ($bad)"
    else assert_eq broken "$GH_STATE" "first value wins and is checked ($bad)"; fi
  done
  gh_put_state agent-s-000000 ''
  gh_read_state agent-s-000000; assert_eq broken "$GH_STATE" "empty file is broken"
  gh_put_state agent-s-000000 '  v=1  \nnoequals\nrepo=Owner/Repo\nvault=Formal\npat_name=s\nexpires=2026-01-31'
  gh_read_state agent-s-000000; assert_eq ok "$GH_STATE" "padded lines, a line without =, no final newline"
}
test_gh_write_state_roundtrips_with_mode_600() {
  gh_write_state agent-w-000000 Owner/Repo Personal w-000000-2601010000 2026-04-01
  gh_read_state agent-w-000000
  assert_eq "ok Owner/Repo Personal w-000000-2601010000 2026-04-01" \
    "$GH_STATE $GH_STATE_REPO $GH_STATE_VAULT $GH_STATE_PAT_NAME $GH_STATE_EXPIRES" "roundtrip"
  assert_eq 600 "$(gh_mode "$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh")" "mode 600"
  assert_eq "" "$(find "$AGENT_VM_CONFIG_DIR/repos" -name '*.tmp.*')" "no temp file left"
  printf 'extra=1\n' >>"$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh"
  gh_write_state agent-w-000000 Owner/Repo Formal w-000000-2601020000 2026-02-01
  assert_not_contains "$(cat "$AGENT_VM_CONFIG_DIR/repos/agent-w-000000.gh")" "extra=1" "unknown keys dropped on rewrite"
}
test_gh_scan_env_classifies_lines() {
  local f="$TMP_ROOT/e.env"
  gh_scan_env "$f"; assert_eq none "$GH_ENV" "missing file"
  printf 'A=op://v/a/x\n' >"$f"; gh_scan_env "$f"; assert_eq none "$GH_ENV" "no GH_TOKEN"
  printf 'A=1\nGH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\n' >"$f"; gh_scan_env "$f"
  assert_eq "auto Formal abcdefghijklmnopqrstuvwxyz" "$GH_ENV $GH_ENV_VAULT $GH_ENV_ID" "auto line parsed"
  printf 'export GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\n' >"$f"; gh_scan_env "$f"
  assert_eq manual "$GH_ENV" "export is manual"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\nGH_TOKEN=x\n' >"$f"; gh_scan_env "$f"
  assert_eq manual "$GH_ENV" "two lines are manual"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\r\n' >"$f"; gh_scan_env "$f"
  assert_eq crlf "$GH_ENV" "CRLF detected before the format check"
  local line
  for line in '  GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential' \
    'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxy/credential' 'GH_TOKEN=op://Formal/ABCDEFGHIJKLMNOPQRSTUVWXYZ/credential' \
    'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential ' 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/password'; do
    printf '%s\n' "$line" >"$f"; gh_scan_env "$f"; assert_eq manual "$GH_ENV" "not the auto form: '$line'"
  done
  printf '# GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\nGH_TOKEN_X=1\nA=1\r\n' >"$f"; gh_scan_env "$f"
  assert_eq none "$GH_ENV" "comment, GH_TOKEN_X and a CR on another line are not GH_TOKEN lines"
  mkdir -p "$TMP_ROOT/dir.env"; gh_scan_env "$TMP_ROOT/dir.env"
  assert_eq unreadable "$GH_ENV" "a directory is not an env file"
  if [[ "$(id -u)" -ne 0 ]]; then
    chmod 000 "$f"; gh_scan_env "$f"; chmod 600 "$f"
    assert_eq unreadable "$GH_ENV" "unreadable file is not 'none'"
  fi
}
test_gh_rewrite_env_replaces_in_place_or_appends() {
  local f="$TMP_ROOT/r.env"
  printf 'A=op://v/a/x\r\nGH_TOKEN=op://Personal/abcdefghijklmnopqrstuvwxyz/credential\n# note\n' >"$f"; chmod 644 "$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf 'A=op://v/a/x\r\n%s\n# note\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "replaced in place, other bytes kept"
  assert_eq 600 "$(gh_mode "$f")" "rewritten file is 600"
  printf 'A=1' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf 'A=1\n%s\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "newline added before appending, appended line ends with a newline"
  printf 'GH_TOKEN=old' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf '%sx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "last line without newline stays without newline"
  printf '\tGH_TOKEN=old\n' >"$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE"
  assert_eq "$(printf '%s\nx' "$GH_NEW_LINE")" "$(gh_bytes "$f")" "leading whitespace matches the scan's definition"
  gh_rewrite_env "$TMP_ROOT/new/n.env" "$GH_NEW_LINE"
  assert_eq 600 "$(gh_mode "$TMP_ROOT/new/n.env")" "new file is 600"
}
test_gh_rewrite_env_leaves_the_file_alone_on_failure() {
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS unreadable env file kept (skipped: running as root)"; return 0; fi
  local f="$TMP_ROOT/u.env" status=0
  printf 'A=1\nB=2\n' >"$f"; chmod 000 "$f"
  gh_rewrite_env "$f" "$GH_NEW_LINE" 2>/dev/null || status=$?
  chmod 600 "$f"
  assert_eq 1 "$status" "unreadable file is an error"
  assert_eq "$(printf 'A=1\nB=2\nx')" "$(gh_bytes "$f")" "content untouched"
  assert_eq "" "$(find "$TMP_ROOT" -maxdepth 1 -name '*.tmp.*')" "no temp file left"
}

gh_put_auto_env() { # machine vault: write an env file with an auto GH_TOKEN line
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  printf 'GH_TOKEN=op://%s/abcdefghijklmnopqrstuvwxyz/credential\n' "$2" >"$AGENT_VM_CONFIG_DIR/repos/$1.env.1password"
}
test_gh_notice_only_when_near_expiry_or_unknown() {
  export AGENT_VM_NOW=1767225600 # 2026-01-01
  local m=agent-n-000000 out
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2026-03-01\n'
  assert_eq "" "$(notice_gh_token_expiry "$m" 2>&1)" "far expiry is silent"
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2026-01-08\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expires on 2026-01-08; renew with: agent-vm env gh" "within 7 days"
  gh_put_state "$m" 'v=1\nrepo=O/R\nvault=Formal\npat_name=n-000000-2512010000\nexpires=2025-12-31\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expired on 2025-12-31" "expired"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "expiry for this repo is unknown" "auto line without state"
  printf 'export GH_TOKEN=x\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  assert_eq "" "$(notice_gh_token_expiry "$m" 2>&1)" "hand-written line is silent"
  printf 'GH_TOKEN=op://v/i/f\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "every machine gets the same token" "global GH_TOKEN warned"
  assert_status 0 "never fails" -- notice_gh_token_expiry "$m"
}
test_gh_notice_survives_a_broken_state_file() {
  local m=agent-b-000000
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" 'garbage\n'
  assert_contains "$(notice_gh_token_expiry "$m" 2>&1)" "is broken" "broken state reported"
  assert_status 0 "launch not blocked" -- notice_gh_token_expiry "$m"
}

nm_host_install() { mkdir -p "$1/node_modules/pkg"; } # dir: the host has an install there
nm_repo() { # a canonical repository path under TMP_ROOT (macOS /var vs /private/var)
  local r; r="$(cd -P "$TMP_ROOT" && pwd -P)/r"; mkdir -p "$r"; printf '%s' "$r"
}
nm_fake_helper() { # contract sync_status: an agent-vm-node-modules on $TMP_ROOT/vmbin that logs its sync calls
  mkdir -p "$TMP_ROOT/vmbin"
  cat >"$TMP_ROOT/vmbin/agent-vm-node-modules" <<EOF
#!/bin/sh
case "\$1" in
  --contract) printf '%s\n' '$1' ;;
  sync) echo "sync \$2" >>"$TMP_ROOT/helper.log"; printf 'mounted\t%s\n' "\$2"; exit $2 ;;
esac
EOF
  chmod +x "$TMP_ROOT/vmbin/agent-vm-node-modules"
}
test_nm_remote_script_checks_the_helper_and_its_contract() {
  local out
  assert_status 90 "no helper" -- env PATH=/usr/bin:/bin bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  nm_fake_helper 2 0
  assert_status 91 "another contract" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  if [[ -e "$TMP_ROOT/helper.log" ]]; then record "FAIL no sync under another contract"; else record "PASS no sync under another contract"; fi
  nm_fake_helper '' 0
  assert_status 91 "an empty contract" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  nm_fake_helper 1 3
  out=$(PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r) || true
  assert_eq $'ran\nmounted\t/r' "$out" "ran, then the helper's records"
  assert_eq "sync /r" "$(cat "$TMP_ROOT/helper.log")" "sync of the given repository"
  assert_status 3 "the helper's status passes through" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
}
test_nm_sync_is_silent_when_converged() {
  local out
  out=$(STUB_ORB_STDOUT=$'ran\nmounted\t/r' nm_sync agent-r-000000 /r 2>&1)
  assert_eq "" "$out" "nothing to say when every package is mounted"
  assert_contains "$(cat "$STUB_LOG")" "orb -m agent-r-000000 bash -lc" "runs one orb call in the machine"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 /r" "passes the contract and the repository as arguments"
}
test_nm_sync_hints_install_only_when_the_host_has_one() {
  local r out; r=$(nm_repo)
  mkdir -p "$r/node_modules/.cache"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a host node_modules with only dot entries is not an install"
  nm_host_install "$r"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "agent-vm: node_modules in the VM is empty for $r (the host has one); recover: run the package manager's install in $r inside the VM" "$out" "install hint"
  out=$(STUB_ORB_STDOUT=$'ran\nmounted\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "no hint once the VM has its own install"
  mkdir -p "$r/packages/a"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/packages/a" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "no hint when the host has not installed there either"
}
test_nm_sync_trusts_only_paths_inside_the_repository() {
  local r o out; r=$(nm_repo); o="$(cd -P "$TMP_ROOT" && pwd -P)/other"
  nm_host_install "$r"; nm_host_install "$o"
  ln -s "$o" "$r/link"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$o" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path outside the repository is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\tr' nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a relative path is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/../other" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path with .. is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/link" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a symlink resolving outside the repository is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/link/sub" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path passing through a symlink is ignored"
  mkdir -p "$r/real"; nm_host_install "$r/real"; ln -s "$r/real" "$r/inner"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/inner" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a symlink is ignored even when it stays inside the repository"
  mkdir -p "$r/pkg"; ln -s "$o/node_modules" "$r/pkg/node_modules"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/pkg" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a node_modules that is a symlink is not an install"
}
test_nm_sync_drops_paths_with_control_characters() {
  local r out; r=$(nm_repo)
  nm_host_install "$r/"$'\e[31mx'
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/"$'\e[31mx' nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path with an escape character is dropped"
}
test_nm_sync_hints_even_when_the_sync_fails() {
  local r out; r=$(nm_repo)
  nm_host_install "$r"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" STUB_ORB_EXIT=1 nm_sync agent-r-000000 "$r" 2>&1 || true)
  assert_contains "$out" "node_modules in the VM is empty for $r" "records are read whatever the status"
  assert_contains "$out" "(some packages could not be mounted)" "and the failure is reported too"
}
test_nm_sync_warns_once_per_failure_kind() {
  local out status
  nm_try() { status=0; out=$(STUB_ORB_STDOUT="$1" STUB_ORB_EXIT="$2" nm_sync agent-r-000000 /r 2>&1) || status=$?; }
  nm_try "" 90
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (the helper is missing); recover: agent-vm rm /r, then start agent-vm again in /r" "$out" "missing helper"
  assert_eq 90 "$status" "status 90"
  nm_try "" 91
  assert_contains "$out" "(the helper does not speak contract 1); recover: agent-vm rm /r, then start agent-vm again in /r" "contract mismatch"
  assert_eq 91 "$status" "status 91"
  nm_try ran 1
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (some packages could not be mounted); recover: cd /r && agent-vm shell, then agent-vm-node-modules sync /r" "$out" "partial"
  assert_eq 1 "$status" "status 1"
  nm_try ran 2
  assert_contains "$out" "(another sync held the lock)" "lock"
  assert_eq 2 "$status" "status 2"
  nm_try ran 3
  assert_eq "agent-vm: kept VM-local node_modules that may be stale in agent-r-000000 (a worktree or package list could not be trusted); recover: cd /r && agent-vm shell, then agent-vm-node-modules sync /r" "$out" "reclaim aborted"
  assert_eq 3 "$status" "status 3"
  nm_try ran 64
  assert_contains "$out" "(the helper failed: status 64)" "the helper's usage error"
  nm_try "" 1
  assert_contains "$out" "(the sync did not run: status 1)" "orb's own 1 is not the helper's partial failure"
  assert_eq 1 "$status" "status 1 from orb"
  nm_try "" 255
  assert_contains "$out" "(the sync did not run: status 255)" "orb failure"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c .)" "exactly one line"
}
test_nm_sync_quotes_the_repository_in_the_recovery() {
  local out
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 "/a b" 2>&1 || true)
  assert_contains "$out" 'cd /a\ b && agent-vm shell, then agent-vm-node-modules sync /a\ b' "a path with a space is quoted"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 /a\\ b" "and passed as one argument"
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 $'/a\nb' 2>&1 || true)
  assert_contains "$out" "sync \$'/a\\nb'" "a newline is quoted as \$'\\n'"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c .)" "and stays on one line"
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 "/$(printf '\343\201\202')" 2>&1 || true)
  assert_contains "$out" "sync \$'/\\343\\201\\202'" "non-ASCII is quoted in plain ASCII, so the sanitizer keeps it"
}
test_run_tool_syncs_after_the_notices_and_goes_on_when_it_fails() {
  local order="$TMP_ROOT/order"
  prepare_machine() { MACHINE=agent-r-000000 REPO=/r; }
  notice_orphan_env() { :; }
  notice_gh_token_expiry() { echo gh >>"$order"; }
  nm_sync() { echo "nm $1 $2" >>"$order"; return 1; }
  inject_secrets() { :; }
  build_launch_script() { :; }
  finish_session() { :; }
  session_exec() { echo session >>"$order"; }
  host_reason() { :; }
  assert_status 0 "a failing sync does not stop the launch" -- run_tool claude
  assert_eq $'gh\nnm agent-r-000000 /r\nsession' "$(cat "$order")" "sync runs after the notices and before the session"
}

nm_record_machine() { # repo: write the host record of its machine; prints the machine name
  local m; m=$(derive_machine_name "$1")
  write_machine_meta "$m" "$1"; printf '%s' "$m"
}
nm_hold_lock() { # machine secs: a background process holding the repo lock; it creates $TMP_ROOT/held once it has it
  perl -MFcntl=:flock -e 'open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $h, ">", $ARGV[1]) or die; close $h; sleep $ARGV[2]' \
    "$AGENT_VM_STATE_DIR/machines/$1.lock" "$TMP_ROOT/held" "$2" &
}
nm_wait_for_holder() { # waits up to 10 s for nm_hold_lock's marker, so the test never races the holder
  local i
  for ((i = 0; i < 100; i++)); do
    if [[ -e "$TMP_ROOT/held" ]]; then return 0; fi
    sleep 0.1
  done
  record "FAIL the lock holder did not start"
}
nm_git_repo() { # a canonical git repository with one commit
  local r; r=$(nm_repo); git -C "$r" init -q
  git -C "$r" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
  printf '%s' "$r"
}
test_node_modules_sync_is_silent_without_a_machine_record() {
  local r; r=$(nm_git_repo)
  assert_eq "" "$(cmd_node_modules_sync "$r" 2>&1)" "no output for a repository agent-vm never ran in"
  assert_status 0 "exit 0" -- cmd_node_modules_sync "$r"
  assert_not_contains "$(cat "$STUB_LOG")" "orb" "orb is not called"
}
test_node_modules_sync_is_silent_outside_git() {
  mkdir -p "$TMP_ROOT/plain"
  assert_eq "" "$(GIT_CEILING_DIRECTORIES="$TMP_ROOT" cmd_node_modules_sync "$TMP_ROOT/plain" 2>&1)" "no output outside git"
  # shellcheck disable=SC2016 # the inner shell expands $1 and $2
  assert_status 0 "exit 0" -- env GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$TMP_ROOT/plain"
}
test_node_modules_sync_fails_for_a_missing_directory() {
  local out status=0
  out=$(bash "$LAUNCHER" node-modules-sync "$TMP_ROOT/none" 2>&1) || status=$?
  assert_eq 1 "$status" "exit 1"
  assert_contains "$out" "no such directory: $TMP_ROOT/none" "says which directory"
}
test_node_modules_sync_skips_a_stopped_machine() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m stopped" cmd_node_modules_sync "$r" 2>&1)" "no output for a stopped machine"
  # shellcheck disable=SC2016 # the inner shell expands $1 and $2
  assert_status 0 "exit 0" -- env STUB_ORB_LIST_STDOUT="$m stopped" bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
  assert_not_contains "$(cat "$STUB_LOG")" "orb -m $m" "the stopped machine is not started"
}
test_node_modules_sync_is_silent_when_orb_cannot_list() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  assert_eq "" "$(STUB_ORB_FAIL_ON=list cmd_node_modules_sync "$r" 2>&1)" "no output when orb list fails"
  # shellcheck disable=SC2016 # the inner shell expands $1 and $2
  assert_status 0 "exit 0" -- env STUB_ORB_FAIL_ON=list bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
}
test_node_modules_sync_skips_while_a_launch_holds_the_lock() {
  local r m holder; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  # The holder outlives the five quiet tries (about 4 s); the test kills it afterwards
  nm_hold_lock "$m" 30
  holder=$!
  nm_wait_for_holder
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_EXIT=90 cmd_node_modules_sync "$r" 2>&1)" "no missing-helper warning during a bootstrap"
  assert_not_contains "$(cat "$STUB_LOG")" "orb -m $m" "the sync is not attempted"
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
}
test_node_modules_sync_waits_out_a_short_lock_holder() {
  local r m holder; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  # A one-second holder (like ingest_outbox) ends well within the five quiet tries
  nm_hold_lock "$m" 1
  holder=$!
  nm_wait_for_holder
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran cmd_node_modules_sync "$r" 2>&1)" "no waiting messages"
  assert_contains "$(cat "$STUB_LOG")" "orb -m $m bash -lc" "the sync runs once the holder is gone"
  wait "$holder" 2>/dev/null || true
}
test_node_modules_sync_runs_in_a_running_machine() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  # shellcheck disable=SC2016 # the inner shell expands $1 and $2
  assert_status 0 "converged" -- env STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
  assert_contains "$(cat "$STUB_LOG")" "orb -m $m bash -lc" "the sync runs in the machine"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 $r" "for this repository"
}
test_node_modules_sync_fails_with_one_warning_and_no_crash_report() {
  local r m out status=0; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  out=$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_FAIL_ON=agent-vm-node-modules bash "$LAUNCHER" node-modules-sync "$r" 2>&1) || status=$?
  assert_eq 9 "$status" "the VM-side status"
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (the sync did not run: status 9); recover: cd $r && agent-vm shell, then agent-vm-node-modules sync $r" "$out" "one warning line"
  assert_not_contains "$out" "failed unexpectedly" "no ERR trap report"
}
test_node_modules_sync_resolves_a_worktree_to_its_repository() {
  local r m; r=$(nm_git_repo)
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  m=$(nm_record_machine "$r")
  STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran cmd_node_modules_sync "$r/.git/worktree/feat" 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "_ 1 $r" "the main repository is synced"
}
test_main_dispatches_node_modules_sync() {
  cmd_node_modules_sync() { echo "nms $*"; }
  assert_eq "nms /r" "$(main node-modules-sync /r)" "main reaches cmd_node_modules_sync"
}
test_help_lists_node_modules_sync() {
  assert_contains "$(main --help)" "agent-vm node-modules-sync [repo]" "help lists node-modules-sync"
}

gh_fixture_repo() { # origin_url -> a git repo with that origin
  local repo="$TMP_ROOT/ghrepo"
  mkdir -p "$repo" && git -C "$repo" init -q
  if [[ -n "${1:-}" ]]; then git -C "$repo" remote add origin "$1"; fi
  printf '%s\n' "$repo"
}
gh_fake_tools() { # replace op / curl / open with recording functions
  # GH_TEST_OP_FAIL_ON: op fails when its arguments contain this text. LEAK: a token reached a child's environment.
  op() {
    printf 'op %s\n' "$*" >>"$STUB_LOG"
    if [[ -n "$(printenv GH_PAT 2>/dev/null)" ]]; then printf 'LEAK GH_PAT exported to op\n' >>"$STUB_LOG"; fi
    if [[ -n "${GH_TEST_OP_FAIL_ON:-}" && "$*" == *"$GH_TEST_OP_FAIL_ON"* ]]; then cat >/dev/null; return 1; fi
    case "$1 $2" in
      "item create") cat >>"$STUB_LOG.stdin"; printf '{"id":"%s"}\n' "${GH_TEST_ID:-zyxwvutsrqponmlkjihgfedcba}" ;;
      "read "*) printf 'secret-from-op\n' ;;
      "whoami --format") printf '{"url":"https://my.example.1password.com"}\n' ;;
    esac
  }
  curl() {
    printf 'curl %s\n' "$*" >>"$STUB_LOG"
    if [[ -n "$(printenv GH_PAT 2>/dev/null)" ]]; then printf 'LEAK GH_PAT exported to curl\n' >>"$STUB_LOG"; fi
    cat >>"$STUB_LOG.stdin"; printf '%s' "${GH_TEST_HTTP:-200}"
  }
  open() { printf 'open %s\n' "$*" >>"$STUB_LOG"; }
}
gh_tty() { printf '%b' "$1" >"$TMP_ROOT/tty"; export AGENT_VM_TTY="$TMP_ROOT/tty"; }
gh_assert_no_token_at_rest() { # token string: nowhere on disk except the stub's stdin capture
  assert_eq "" "$(grep -rlF "$1" "$AGENT_VM_CONFIG_DIR" "$AGENT_VM_STATE_DIR" "$TMP_ROOT" 2>/dev/null | grep -v '/stub\.log\.stdin$' | grep -v '/tty$' || true)" "token not written to disk"
}
GH_TEST_PAT=github_pat_ABCdef123_secretTail
test_env_gh_first_registration_writes_env_and_state() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  export GH_PAT=preexisting-exported-value # a user environment that already exports the name must not leak the token
  out=$(cd "$repo" && cmd_env_gh 2>&1)
  assert_not_contains "$(cat "$STUB_LOG")" "LEAK" "token not exported to children"
  assert_contains "$(cat "$STUB_LOG")" "curl -q " "curl ignores ~/.curlrc"
  assert_contains "$(cat "$STUB_LOG")" "-H @-" "header read from stdin"
  gh_assert_no_token_at_rest "$GH_TEST_PAT"
  assert_contains "$out" "expires_in=30" "Formal gives 30 days"
  assert_eq "GH_TOKEN=op://Formal/zyxwvutsrqponmlkjihgfedcba/credential" "$(cat "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password")" "env line"
  gh_read_state "$m"
  assert_eq "ok Owner/Repo Formal 2026-01-31" "$GH_STATE $GH_STATE_REPO $GH_STATE_VAULT $GH_STATE_EXPIRES" "state"
  assert_not_contains "$(cat "$STUB_LOG")" "$GH_TEST_PAT" "token never in argv"
  assert_contains "$(cat "$STUB_LOG.stdin")" "Authorization: Bearer $GH_TEST_PAT" "token reaches curl on stdin"
  assert_contains "$(cat "$STUB_LOG.stdin")" "\"value\":\"$GH_TEST_PAT\"" "token reaches op on stdin"
  assert_not_contains "$out" "$GH_TEST_PAT" "token never printed"
  assert_contains "$(cat "$STUB_LOG")" "op vault get Formal" "vault checked"
  assert_contains "$out" "vault Formal of 1Password account https://my.example.1password.com" "account shown before the PAT is created"
  assert_contains "$(cat "$STUB_LOG")" "op read op://Formal/zyxwvutsrqponmlkjihgfedcba/credential" "reference read back"
}
test_env_gh_renewal_prints_cleanup_and_keeps_vault() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo https://github.com/Owner/Repo); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=${m#agent-}-2510010000\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh 2>&1)
  assert_contains "$out" "expires_in=90" "Personal kept, 90 days"
  assert_contains "$out" "${m#agent-}-2510010000" "old PAT name shown"
  assert_contains "$out" "op item delete --archive abcdefghijklmnopqrstuvwxyz --vault Personal" "old item archive command"
  assert_contains "$out" "agent-vm-gh " "title check advised"
  assert_contains "$out" "pat_name=${m#agent-}-2601010000" "state lines shown before writing"
}
test_env_gh_refuses_before_any_pat_is_created() {
  local repo m; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools
  # recorded repo differs from origin
  gh_put_state "$m" "v=1\nrepo=Owner/Other\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  local status=0; (cd "$repo" && cmd_env_gh) >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "origin mismatch dies"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved on origin mismatch"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"
  # hand-written GH_TOKEN line
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf 'export GH_TOKEN=abc\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  local out; out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "agent-vm env edit" "manual line explained"
  assert_not_contains "$out" "personal-access-tokens/new" "no creation page opened"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved"
}
test_env_gh_vault_mismatch_needs_explicit_vault() {
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "--vault" "asks for --vault"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved"
}
test_env_gh_repo_change_does_not_inherit_vault() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:New/Name.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_state "$m" "v=1\nrepo=Old/Name\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "New/Name\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh --repo New/Name 2>&1)
  assert_contains "$out" "Old/Name" "previous repo shown"
  assert_contains "$out" "expires_in=30" "vault chosen again, not inherited"
}
test_env_gh_rejects_bad_token_and_failed_check() {
  local repo out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git)
  gh_fake_tools
  gh_tty "Owner/Repo\nPersonal\nghp_classicToken\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "github_pat_" "classic token rejected"
  assert_not_contains "$out" "ghp_classicToken" "rejected input not echoed"
  assert_not_contains "$(cat "$STUB_LOG")" "curl" "no request with a bad token"
  : >"$STUB_LOG"
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_HTTP=404 cmd_env_gh) 2>&1) || true
  assert_contains "$out" "HTTP 404" "status shown"
  assert_contains "$out" "delete the PAT named" "created PAT mentioned"
  assert_not_contains "$out" "$GH_TEST_PAT" "token not printed on failure"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved after a failed check"
  gh_assert_no_token_at_rest "$GH_TEST_PAT"
}
test_env_gh_refuses_other_unsafe_starts() {
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  printf 'GH_TOKEN=op://v/i/f\n' >"$AGENT_VM_CONFIG_DIR/env.1password"; gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "env.1password sets GH_TOKEN" "global GH_TOKEN refused"
  rm -f "$AGENT_VM_CONFIG_DIR/env.1password"
  printf 'GH_TOKEN=op://Formal/abcdefghijklmnopqrstuvwxyz/credential\r\n' >"$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "CRLF" "CRLF refused"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  gh_put_state "$m" 'garbage\n'
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "is broken" "broken state refused"
  export AGENT_VM_NOW=1767225600
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=${m#agent-}-2601010000\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "wait a minute" "same-minute PAT name refused"
  rm -f "$AGENT_VM_CONFIG_DIR/repos/$m.gh"; gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_OP_FAIL_ON="vault get" cmd_env_gh) 2>&1) || true
  assert_contains "$out" "vault Personal is not available" "missing vault refused"
  assert_not_contains "$out" "personal-access-tokens/new" "before the creation page"
  git -C "$repo" remote remove origin
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "origin cannot be parsed" "unparseable origin refused when a repo is recorded"
  assert_not_contains "$(cat "$STUB_LOG")" "item create" "nothing saved in any of these cases"
}
test_env_gh_failures_after_the_pat_name_what_to_delete() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_fake_tools; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_OP_FAIL_ON="read op://" cmd_env_gh) 2>&1) || true
  assert_contains "$out" "zyxwvutsrqponmlkjihgfedcba in vault Formal" "new item's id and vault shown"
  assert_contains "$out" "${m#agent-}-2601010000" "PAT name shown"
  assert_status 1 "env not written" -- test -e "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  : >"$STUB_LOG"; gh_tty "Owner/Repo\nFormal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (GH_TEST_ID=short cmd_env_gh) 2>&1) || true
  assert_contains "$out" "agent-vm-gh ${m#agent-}-2601010000" "item title to look for"
}
test_env_gh_vault_switch_and_same_repo_update() {
  export AGENT_VM_NOW=1767225600
  local repo m out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git); m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  gh_put_auto_env "$m" Formal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Formal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_fake_tools; gh_tty "$GH_TEST_PAT\n"
  out=$(cd "$repo" && GH_TEST_OP_FAIL_ON=whoami cmd_env_gh --vault Personal 2>&1)
  assert_contains "$out" "of 1Password account (unknown)" "a failing op whoami does not stop the command"
  assert_contains "$out" "from vault Formal to Personal; the new token expires in 90 days" "switch shown with the new lifetime"
  assert_contains "$out" "--vault Formal" "old item archived from the old vault"
  gh_put_auto_env "$m" Personal
  gh_put_state "$m" "v=1\nrepo=Owner/Repo\nvault=Personal\npat_name=x-1\nexpires=2026-01-03\n"
  gh_tty "owner/repo\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && cmd_env_gh --repo owner/repo 2>&1)
  assert_not_contains "$out" "vault for this repo's token" "same repo (case-insensitive) is an update: vault not asked again"
  assert_contains "$out" "expires_in=90" "recorded vault kept"
}
test_env_gh_state_write_failure_prints_lines_to_write() {
  export AGENT_VM_NOW=1767225600
  local repo out; repo=$(gh_fixture_repo git@github.com:Owner/Repo.git)
  gh_fake_tools; gh_write_state() { return 1; }
  gh_tty "Owner/Repo\nPersonal\n$GH_TEST_PAT\n"
  out=$(cd "$repo" && (cmd_env_gh) 2>&1) || true
  assert_contains "$out" "expires=2026-04-01" "lines shown"
  assert_contains "$out" "do not re-run" "told not to re-run"
  assert_not_contains "$out" "$GH_TEST_PAT" "token not printed on failure"
}
test_main_dispatches_env_gh() {
  cmd_env_gh() { echo "env-gh $*"; }
  assert_eq "env-gh --vault Formal" "$(main env gh --vault Formal)" "env gh"
}

test_env_adopt_moves_the_gh_state_file() {
  local repo new; repo=$(make_flow_repo); new=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.gh"
  (cd "$repo" && cmd_env_adopt agent-gone-000000) 2>/dev/null
  assert_status 0 "state moved" -- test -f "$AGENT_VM_CONFIG_DIR/repos/$new.gh"
  assert_status 1 "old state gone" -- test -e "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.gh"
}
test_env_adopt_refuses_when_a_gh_state_file_is_in_the_way() {
  local repo new out; repo=$(make_flow_repo); new=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  : >"$AGENT_VM_CONFIG_DIR/repos/$new.gh"
  out=$(cd "$repo" && (cmd_env_adopt agent-gone-000000) 2>&1) || true
  assert_contains "$out" "$new.gh" "path named"
  assert_status 0 "env file not moved" -- test -f "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}

errexit_run() { # snippet: run it in a fresh bash with the launcher sourced under set -euo pipefail; prints "reached" at the end
  # stderr is kept for diagnosis when "reached" is missing.
  bash -c 'set -euo pipefail; AGENT_VM_LIB=1 . "$1"; eval "$2"; echo reached' _ "$LAUNCHER" "$1" 2>>"$TMP_ROOT/errexit.err" || true
}
test_store_hash_covers_symlinks_and_modes_but_not_meta() {
  local s="$TMP_ROOT/s" h1 h2 h3 h4; mkdir -p "$s/bin" "$s/x"
  printf 'a\n' >"$s/x/f"; ln -s ../x/f "$s/bin/l"; printf 'm\n' >"$s/.meta"
  h1=$(store_hash "$s")
  case "$h1" in v2:[0-9a-f]*) record "PASS store_hash has the v2 prefix" ;; *) record "FAIL store_hash has the v2 prefix ($h1)" ;; esac
  printf 'other\n' >"$s/.meta"; h2=$(store_hash "$s")
  assert_eq "$h1" "$h2" ".meta is excluded"
  ln -sfn ../x/g "$s/bin/l"; h3=$(store_hash "$s")
  if [[ "$h1" != "$h3" ]]; then record "PASS symlink target change is detected"; else record "FAIL symlink target change is detected"; fi
  ln -sfn ../x/f "$s/bin/l"; chmod +x "$s/x/f"; h4=$(store_hash "$s")
  if [[ "$h1" != "$h4" ]]; then record "PASS mode change is detected"; else record "FAIL mode change is detected"; fi
}
test_dir_hash_is_unchanged_by_store_hash() {
  local s="$TMP_ROOT/s"; mkdir -p "$s"; printf 'a\n' >"$s/f"
  case "$(dir_hash "$s")" in v1:*) record "PASS dir_hash keeps v1" ;; *) record "FAIL dir_hash keeps v1" ;; esac
}
test_clone_cmd_defaults_to_clonefile() {
  assert_eq "cp -c -R" "$(clone_cmd)" "clonefile is the default clone command"
  assert_eq "cp -R" "$(AGENT_VM_CLONE_CMD='cp -R' clone_cmd)" "tests can override the clone command"
}
test_run_bounded_stops_a_hung_command() {
  assert_status 142 "a command past its bound is killed by SIGALRM" -- run_bounded 1 sleep 5
  assert_status 0 "a quick command passes through" -- run_bounded 5 true
}

fetch_stubs() { # npm/bunx/file stubs for cmd_fetch_browsers; $1 = playwright version npm reports, $2 = "array" for npm >= 12's shape, $3 = "cft" for the Chrome for Testing layout (playwright >= 1.64)
  mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/wt"; BUNX_LOG="$TMP_ROOT/bunx.log"; : >"$BUNX_LOG"
  printf '{"dependencies":{"@playwright/mcp":"0.0.75"}}\n' >"$TMP_ROOT/wt/package.json"
  local deps="{\"playwright\":\"$1\",\"playwright-core\":\"$1\"}"
  if [[ "${2:-}" == array ]]; then deps="[$deps]"; fi
  printf '#!/bin/sh\nprintf %%s %s\n' "'$deps'" >"$TMP_ROOT/bin/npm"
  local sub=chrome-linux exe=headless_shell
  if [[ "${3:-}" == cft ]]; then sub=chrome-headless-shell-linux-arm64; exe=chrome-headless-shell; fi
  cat >"$TMP_ROOT/bin/bunx" <<EOF
#!/bin/sh
{ printf 'bunx %s\n' "\$*"; env | grep -E '^(PLAYWRIGHT_|HTTPS_PROXY=|NO_PROXY=|EVIL=)' | sort; } >>"$BUNX_LOG"
d="\$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1224/$sub"; mkdir -p "\$d"
printf 'elf\n' >"\$d/$exe"; chmod +x "\$d/$exe"
EOF
  # shellcheck disable=SC2016 # stub script text; $1 expands when the stub runs
  printf '#!/bin/sh\necho "$1: ELF 64-bit LSB pie executable, ARM aarch64"\n' >"$TMP_ROOT/bin/file"
  chmod +x "$TMP_ROOT/bin/npm" "$TMP_ROOT/bin/bunx" "$TMP_ROOT/bin/file"
  export PATH="$TMP_ROOT/bin:$PATH"
}
test_browser_store_id_reads_the_scoped_package() {
  mkdir -p "$TMP_ROOT/wt"; printf '{"dependencies":{"@playwright/mcp":"0.0.75"}}\n' >"$TMP_ROOT/wt/package.json"
  assert_eq "mcp-0.0.75" "$(browser_store_id "$TMP_ROOT/wt")" "the scoped package name is read literally"
}
test_fetch_publishes_store_with_meta_and_stable_link() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local s="$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
  assert_status 0 "store published under the mcp version" -- test -d "$s"
  assert_eq "../chromium_headless_shell-1224/chrome-linux/headless_shell" "$(readlink "$s/bin/headless_shell")" "stable relative link"
  assert_contains "$(cat "$s/.meta")" "playwright_version=1.61.0-alpha-1778188671000" "meta records the playwright version"
  assert_eq "sha256=$(store_hash "$s")" "$(grep '^sha256=' "$s/.meta")" "meta records the store hash"
  assert_eq "700" "$(perl -e 'printf "%o", (stat shift)[2] & 0777' "$AGENT_VM_STATE_DIR/browser-store")" "store dir is 0700"
}
test_fetch_is_a_no_op_when_the_store_exists() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "1" "$(grep -c '^bunx ' "$BUNX_LOG")" "first run downloads once"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "1" "$(grep -c '^bunx ' "$BUNX_LOG")" "second run does not download"
}
test_fetch_force_replaces_an_existing_store() {
  fetch_stubs 1.61.0-alpha-1778188671000
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  printf 'tampered\n' >"$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell"
  cmd_fetch_browsers --force --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_eq "elf" "$(cat "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell")" "--force replaces the store"
  assert_eq "" "$(ls "$AGENT_VM_STATE_DIR/build")" "no leftovers in build/"
}
test_fetch_reads_the_array_npm_12_prints() {
  fetch_stubs 1.61.0-alpha-1778188671000 array
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_status 0 "store published from an array-shaped npm view" -- test -d "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
}
test_fetch_links_the_chrome_for_testing_layout() {
  fetch_stubs 1.64.0-alpha-1789764292000 array cft
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local s="$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
  assert_status 0 "store published from the Chrome for Testing layout" -- test -d "$s"
  assert_eq "../chromium_headless_shell-1224/chrome-headless-shell-linux-arm64/chrome-headless-shell" "$(readlink "$s/bin/headless_shell")" "the stable link keeps its name"
}
test_fetch_refuses_a_range_version() {
  fetch_stubs '^1.61.0'
  assert_status 1 "a range version fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_contains "$(cat "$AGENT_VM_STATE_DIR/browser-store/.last-failure")" "range" "failure reason recorded"
  assert_status 1 "nothing published" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
}
test_fetch_failure_reason_keeps_paths_readable() {
  fetch_stubs 1.61.0-alpha-1778188671000
  printf '#!/bin/sh\nexit 3\n' >"$TMP_ROOT/bin/bunx"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_contains "$(cat "$AGENT_VM_STATE_DIR/browser-store/.last-failure")" "(see $AGENT_VM_STATE_DIR/browser-store/.fetch.log)" "the sanitized reason keeps the log path intact"
}
test_fetch_refuses_a_non_arm64_binary() {
  fetch_stubs 1.61.0-alpha-1778188671000
  # shellcheck disable=SC2016 # stub script text; $1 expands when the stub runs
  printf '#!/bin/sh\necho "$1: Mach-O 64-bit executable arm64"\n' >"$TMP_ROOT/bin/file"
  assert_status 1 "a non-ELF binary fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_status 1 "nothing published" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
}
test_fetch_records_a_failure_when_no_browser_was_installed() {
  fetch_stubs 1.61.0-alpha-1778188671000
  printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/bunx"
  assert_status 1 "an empty install fails the fetch" -- cmd_fetch_browsers --from-apply "$TMP_ROOT/wt"
  assert_status 0 "the failure is recorded" -- test -s "$AGENT_VM_STATE_DIR/browser-store/.last-failure"
}
test_fetch_passes_only_allowlisted_env() {
  fetch_stubs 1.61.0-alpha-1778188671000
  EVIL=1 PLAYWRIGHT_DOWNLOAD_HOST=http://evil HTTPS_PROXY=http://proxy NO_PROXY='*.local, 10.0.0.0/8' \
    cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local log; log=$(cat "$BUNX_LOG")
  assert_not_contains "$log" "EVIL=" "unlisted variables are dropped"
  assert_not_contains "$log" "PLAYWRIGHT_DOWNLOAD_HOST" "playwright overrides are dropped"
  assert_contains "$log" "HTTPS_PROXY=http://proxy" "proxy is passed"
  assert_contains "$log" "NO_PROXY=*.local, 10.0.0.0/8" "a value with spaces and globs is passed intact"
  assert_contains "$log" "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-arm64" "platform override is set"
}
test_fetch_failure_repeats_as_one_line() {
  fetch_stubs '^1.61.0'
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  local second; second=$(cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" 2>&1 || true)
  assert_eq "1" "$(printf '%s\n' "$second" | grep -c .)" "a repeated failure prints one line"
  assert_contains "$second" "agent-vm fetch-browsers" "the line names the recovery"
}
test_fetch_cli_failure_prints_no_unexpected_error() {
  fetch_stubs '^1.61.0'
  local err status=0
  err=$(AGENT_VM_STATE_DIR="$AGENT_VM_STATE_DIR" bash "$LAUNCHER" fetch-browsers --from-apply "$TMP_ROOT/wt" 2>&1 >/dev/null) || status=$?
  assert_eq "1" "$status" "the CLI exits 1 on a fetch failure"
  assert_not_contains "$err" "unexpectedly" "the ERR trap does not add its own report"
}
test_fetch_removes_older_stores_after_publishing() {
  fetch_stubs 1.61.0-alpha-1778188671000
  mkdir -p "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.74"
  cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  assert_status 1 "older store removed" -- test -e "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.74"
}

test_new_machine_gets_browser_mount_and_marker() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-n-000000 "$TMP_ROOT")
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$wt" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "$AGENT_VM_STATE_DIR/browsers/agent-n-000000:/opt/agent-vm/browsers" "browser mount set on the clone"
  assert_status 0 "mount marker written" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
test_new_machine_drops_a_stale_id_record() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-n-000000 "$TMP_ROOT")
  mkdir -p "$AGENT_VM_STATE_DIR/browser-records"; printf 'mcp-0.0.75\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$wt" >/dev/null 2>&1
  assert_status 1 "stale id removed on create" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
}
test_existing_machine_gets_no_marker() {
  export STUB_ORB_LIST_STDOUT="agent-n-000000"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT" >/dev/null 2>&1
  assert_status 1 "no marker for an existing machine" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
test_failed_orb_list_writes_no_marker_and_stops() {
  export STUB_ORB_FAIL_ON="list"
  local out
  # shellcheck disable=SC2016 # snippet text; expands inside errexit_run's fresh bash
  out=$(errexit_run 'ensure_machine agent-n-000000 "$TMP_ROOT" "$TMP_ROOT"')
  assert_not_contains "$out" "reached" "a failed orb list stops the launch"
  assert_status 1 "no marker when orb list failed" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no create after a failed list"
}
test_marker_survives_a_failed_clone() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="clone $GOLDEN_MACHINE agent-n-000000"
  (ensure_machine agent-n-000000 "$TMP_ROOT" "$wt") >/dev/null 2>&1 || true
  assert_contains "$(cat "$STUB_LOG")" "orb clone" "clone was attempted"
  assert_status 0 "marker written before the clone" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}

browsers_ready() { # store published + machine marker present
  fetch_stubs 1.61.0-alpha-1778188671000; cmd_fetch_browsers --from-apply "$TMP_ROOT/wt" >/dev/null 2>&1 || true
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-b-000000" "$AGENT_VM_STATE_DIR/browser-records"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.mount"
  export AGENT_VM_CLONE_CMD='cp -R'
}
test_ensure_browsers_skips_without_marker() {
  browsers_ready; rm "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.mount"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "" "$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")" "nothing published without the marker"
}
test_ensure_browsers_publishes_current_and_records_id() {
  browsers_ready
  local out
  # shellcheck disable=SC2016 # snippet text; expands inside errexit_run's fresh bash
  out=$(errexit_run 'ensure_browsers agent-b-000000 "$TMP_ROOT/wt"')
  assert_contains "$out" "reached" "publishing completes under set -euo pipefail"
  local b="$AGENT_VM_STATE_DIR/browsers/agent-b-000000"
  assert_status 0 "current is a symlink" -- test -L "$b/current"
  case "$(readlink "$b/current")" in gen-mcp-0.0.75.*) record "PASS current points at a gen-<id> dir" ;; *) record "FAIL current points at a gen-<id> dir" ;; esac
  assert_status 0 "headless shell reachable through current" -- test -f "$b/current/bin/headless_shell"
  assert_eq "mcp-0.0.75" "$(cat "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id")" "id recorded"
  local leftover=""; for _ in "$b"/current.*; do [[ -e "$_" || -L "$_" ]] && leftover=1; done
  assert_eq "" "$leftover" "no temporary link left behind"
}
test_ensure_browsers_is_a_no_op_when_current_and_id_match() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  local before; before=$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "$before" "$(ls "$AGENT_VM_STATE_DIR/browsers/agent-b-000000")" "no new generation"
}
test_ensure_browsers_rebuilds_when_current_is_gone() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  rm "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_status 0 "current restored" -- test -L "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
}
test_ensure_browsers_rebuilds_a_dangling_current() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  rm -rf "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/gen-*
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_status 0 "a dangling current is republished" -- test -f "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current/bin/headless_shell"
}
test_ensure_browsers_keeps_old_generations() {
  browsers_ready; ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  printf 'mcp-0.0.74\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "2" "$(find "$AGENT_VM_STATE_DIR/browsers/agent-b-000000" -mindepth 1 -maxdepth 1 -name 'gen-*' | wc -l | tr -d ' ')" "old generation kept while the VM may run"
}
test_ensure_browsers_warns_when_store_is_missing() {
  browsers_ready; rm -rf "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
  printf 'mcp-0.0.75\tnpm view failed\n' >"$AGENT_VM_STATE_DIR/browser-store/.last-failure"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm fetch-browsers" "recovery printed"
  assert_contains "$err" "npm view failed" "the last fetch failure is shown"
  assert_status 1 "no id recorded" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
}
test_ensure_browsers_refuses_a_tampered_store() {
  browsers_ready
  printf 'x\n' >"$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/chromium_headless_shell-1224/chrome-linux/headless_shell"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm fetch-browsers --force" "TOFU mismatch names --force"
  assert_status 1 "current not published" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
}
test_ensure_browsers_does_not_follow_a_planted_current() {
  browsers_ready; mkdir -p "$TMP_ROOT/outside"
  ln -s "$TMP_ROOT/outside" "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>/dev/null
  assert_eq "" "$(ls -A "$TMP_ROOT/outside")" "nothing written through a planted symlink"
  case "$(readlink "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current")" in gen-*) record "PASS planted current replaced" ;; *) record "FAIL planted current replaced" ;; esac
}
test_ensure_browsers_warns_when_current_is_a_directory() {
  browsers_ready; mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current/x"
  local err; err=$(ensure_browsers agent-b-000000 "$TMP_ROOT/wt" 2>&1)
  assert_contains "$err" "agent-vm rm" "a blocked current names agent-vm rm"
  assert_eq "1" "$(find "$AGENT_VM_STATE_DIR/browsers/agent-b-000000" -mindepth 1 -maxdepth 1 -name 'gen-*' 2>/dev/null | wc -l | tr -d ' ')" "a failed publish leaves its generation for forget_machine (no deep delete in the VM-writable tree)"
  assert_status 1 "no id recorded after a failed publish" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
}
test_ensure_browsers_never_fails_and_closes_fd8() {
  browsers_ready
  local path out holder="" before
  for path in clone tofu store busy; do
    rm -rf "$AGENT_VM_STATE_DIR/browsers/agent-b-000000"/* "$AGENT_VM_STATE_DIR/browser-records/agent-b-000000.id"
    case "$path" in
      clone) export AGENT_VM_CLONE_CMD=false ;;
      tofu) export AGENT_VM_CLONE_CMD='cp -R'
            before=$(store_hash "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75")
            chmod 750 "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/bin"
            if [[ "$before" != "$(store_hash "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75")" ]]; then record "PASS tofu: the store hash really changed"; else record "FAIL tofu: the store hash really changed"; fi ;;
      store) chmod 755 "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75/bin"
             mv "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75" "$TMP_ROOT/store-aside" ;;
      busy) mv "$TMP_ROOT/store-aside" "$AGENT_VM_STATE_DIR/browser-store/mcp-0.0.75"
            perl -MFcntl=:flock -e 'open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die;
              open(my $r, ">", $ARGV[1]) or die; close $r; sleep 70' \
              "$AGENT_VM_STATE_DIR/browser-store.lock" "$TMP_ROOT/held" &
            holder=$!
            for _ in $(seq 1 100); do [[ -e "$TMP_ROOT/held" ]] && break; sleep 0.1; done   # the holder has the lock first
            if [[ ! -e "$TMP_ROOT/held" ]]; then record "FAIL busy: the lock holder never started"; continue; fi ;;
    esac
    # shellcheck disable=SC2016 # snippet text; expands inside errexit_run's fresh bash
    out=$(errexit_run 'ensure_browsers agent-b-000000 "$TMP_ROOT/wt"; if test -e /dev/fd/8; then echo fd8-open; fi')
    assert_contains "$out" "reached" "$path: ensure_browsers returns under set -euo pipefail"
    assert_not_contains "$out" "fd8-open" "$path: fd 8 is closed afterwards"
    assert_status 1 "$path: nothing published" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-b-000000/current"
  done
  if [[ -n "$holder" ]]; then kill "$holder" 2>/dev/null || true; fi
}

test_forget_machine_removes_browser_records_and_copies() {
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/gen-x" "$AGENT_VM_STATE_DIR/browser-records"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.mount"; : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.id"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-g-000000.id.tmp.abc123"
  : >"$AGENT_VM_STATE_DIR/browser-records/agent-other-000000.mount"
  forget_machine agent-g-000000 2>/dev/null
  assert_eq "agent-other-000000.mount" "$(ls "$AGENT_VM_STATE_DIR/browser-records")" "only this machine's records removed"
  assert_status 1 "browser copies removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-g-000000"
}
test_forget_machine_removes_a_dir_the_vm_locked_down() {
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS locked-down dir removed (skipped: running as root)"; return 0; fi
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/locked/inner"; chmod 000 "$AGENT_VM_STATE_DIR/browsers/agent-g-000000/locked"
  local out; out=$(errexit_run 'forget_machine agent-g-000000')
  assert_contains "$out" "reached" "forget_machine does not abort"
  assert_status 1 "locked-down dir removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-g-000000"
}

make_golden_fixture() { # -> dotfiles working tree that also tracks agent-vm/cloud-init.yaml
  local wt; wt=$(make_dotfiles_fixture)
  mkdir -p "$wt/agent-vm"; printf '#cloud-config\n' >"$wt/agent-vm/cloud-init.yaml"
  git -C "$wt" add agent-vm && git -C "$wt" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m ci
  printf '%s\n' "$wt"
}
golden_dirs_as_bootstrapped() { # what create_golden and the VM's link_outbox leave on the host side
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects" "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/codex-sessions" \
    "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
}
sealed_golden_fixture() { # wt -> a golden whose record matches the current staging; prints the config-show file
  local out gen hash show="$TMP_ROOT/show"
  out=$(build_staging "$GOLDEN_MACHINE" "$1"); read -r gen hash <<<"$out"
  write_golden_meta "$(sha_of_file "$1/agent-vm/cloud-init.yaml")" sealed "$hash"
  golden_dirs_as_bootstrapped
  write_config_show "$show" "$GOLDEN_MACHINE" "$(vm_mounts "$GOLDEN_MACHINE")"
  printf '%s\n' "$show"
}
test_first_golden_is_created_without_a_repo_and_sealed() {
  local wt; wt=$(make_golden_fixture)
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  maybe_bootstrap() { golden_dirs_as_bootstrapped; } # the VM side would create these
  write_config_show "$TMP_ROOT/show" "$GOLDEN_MACHINE" "$(vm_mounts "$GOLDEN_MACHINE")"
  STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" ensure_golden "$wt" 0 2>/dev/null
  local log st="$AGENT_VM_STATE_DIR"; log=$(cat "$STUB_LOG")
  assert_contains "$log" "orb create --isolated --isolate-network --forward-ssh-agent -c $wt/agent-vm/cloud-init.yaml --mount $st/staging/$GOLDEN_MACHINE:/opt/agent-vm/src --mount $st/outbox/$GOLDEN_MACHINE:/opt/agent-vm/outbox --mount $st/browsers/$GOLDEN_MACHINE:/opt/agent-vm/browsers ubuntu $GOLDEN_MACHINE" \
    "golden created with only its own three mounts"
  assert_contains "$log" "agent-vm/golden-seal.sh" "sealed"
  assert_contains "$log" "orb stop $GOLDEN_MACHINE" "stopped after sealing"
  assert_eq sealed "$(golden_meta_field state)" "recorded as sealed"
  assert_status 1 "the golden gets no browser record" -- test -e "$st/browser-records/$GOLDEN_MACHINE.mount"
  local gen; gen=$(ls "$st/staging/$GOLDEN_MACHINE")
  assert_eq "$(dir_hash "$st/staging/$GOLDEN_MACHINE/$gen")" "$(golden_meta_field staging_hash)" "staging hash recorded"
}
test_unchanged_stopped_golden_is_not_started() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  local log; log=$(cat "$STUB_LOG")
  assert_not_contains "$log" "orb start" "golden not started"
  assert_not_contains "$log" "golden-seal.sh" "not resealed"
  assert_contains "$log" "orb config show" "host-side check still runs"
}
test_forced_refresh_updates_an_unchanged_golden() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 1 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb start $GOLDEN_MACHINE" "started"
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed"
  assert_eq sealed "$(golden_meta_field state)" "sealed again"
}
test_running_golden_is_resealed_not_cloned_as_is() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE running ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start" "already running"
}
test_changed_dotfiles_update_through_the_updating_state() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta "$(sha_of_file "$wt/agent-vm/cloud-init.yaml")" sealed v1:old; : >"$STUB_LOG"
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  seal_golden() { assert_eq updating "$(golden_meta_field state)" "updating while sealing"; }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_eq sealed "$(golden_meta_field state)" "sealed after the update"
  if [[ "$(golden_meta_field staging_hash)" != v1:old ]]; then record "PASS new staging hash recorded"; else record "FAIL new staging hash recorded"; fi
}
test_interrupted_update_is_retried_not_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta "$(sha_of_file "$wt/agent-vm/cloud-init.yaml")" sealed v1:old; : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="golden-seal.sh" ensure_golden "$wt" 0) 2>/dev/null || true
  assert_eq updating "$(golden_meta_field state)" "left as updating"
  : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "retried as an update"
  assert_eq sealed "$(golden_meta_field state)" "sealed on retry"
}
test_golden_is_rebuilt_when_cloud_init_changes() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta other sealed "$(golden_meta_field staging_hash)"; : >"$STUB_LOG"
  printf 'old\n' >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/leftover.jsonl"
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk/sub"; : >"$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk/sub/f"
  chmod 000 "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk"
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  local err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1)
  assert_contains "$err" "cloud-init.yaml changed" "reason shown"
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "old golden deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "new golden created"
  assert_status 1 "old outbox content removed with the old golden" -- test -e "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/leftover.jsonl"
  assert_status 1 "old browsers content removed even without permissions" -- test -e "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk"
}
test_golden_record_of_unknown_format_is_rebuilt_with_its_own_reason() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  printf 'format=2\nstate=sealed\n' >"$AGENT_VM_STATE_DIR/golden/meta"; : >"$STUB_LOG"
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  local err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1)
  assert_contains "$err" "unknown format" "format reason distinguished from a missing record"
}
test_golden_removed_outside_agent_vm_is_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  STUB_ORB_LIST_STDOUT="other running ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing to delete"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "recreated"
}
test_golden_without_a_record_is_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  rm "$AGENT_VM_STATE_DIR/golden/meta"; : >"$STUB_LOG"
  # shellcheck disable=SC2329 # replaces the real function; ensure_golden calls it
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "unrecorded golden deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "recreated"
}
test_golden_outbox_with_any_extra_entry_fails_with_recovery() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  ln -s /etc "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/x"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "extra entry refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_golden_outbox_name_with_a_newline_cannot_pass() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  # A name with a newline is one entry however it would print in a line-based listing.
  : >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/$(printf 'a\nb')"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "extra entry with a newline refused"
  assert_contains "$err" "holds 3 entries" "counted as one more entry"
}
test_missing_golden_outbox_fails_with_recovery() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  rm -rf "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_unreadable_golden_outbox_fails_with_recovery() {
  # root reads mode-000 directories anyway, so the failure cannot be produced this way
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS unreadable outbox refused (skipped: running as root)"; return 0; fi
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  : >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/hidden"; chmod 000 "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  chmod 755 "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects"
  assert_eq 1 "$status" "an outbox the host cannot read in full is refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_golden_browsers_must_stay_empty() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  : >"$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/current"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "a golden with something in its browsers dir is refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_staging_hash_ignores_location_and_mtime() {
  local wt h1 h2 out; wt=$(make_dotfiles_fixture)
  out=$(build_staging agent-s-000003 "$wt"); h1=${out#* }
  cp -R "$wt" "$TMP_ROOT/df-copy"; touch -t 200001010000 "$TMP_ROOT/df-copy/home/dot_a"
  out=$(build_staging agent-s-000004 "$TMP_ROOT/df-copy"); h2=${out#* }
  assert_eq "$h1" "$h2" "same content, same hash"
}
test_golden_rm_removes_record_machine_and_host_state_but_keeps_the_lock() {
  local wt; wt=$(make_golden_fixture); sealed_golden_fixture "$wt" >/dev/null
  acquire_golden_lock 1; release_golden_lock; : >"$STUB_LOG"
  printf 'y\n' | STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" cmd_golden rm >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "golden deleted"
  assert_status 1 "record removed" -- test -e "$AGENT_VM_STATE_DIR/golden/meta"
  assert_status 1 "staging removed" -- test -e "$AGENT_VM_STATE_DIR/staging/$GOLDEN_MACHINE"
  assert_status 1 "outbox removed" -- test -e "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE"
  assert_status 1 "browsers removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
  assert_status 0 "lock file kept" -- test -f "$AGENT_VM_STATE_DIR/golden/lock"
}
test_golden_rm_asks_first() {
  local wt; wt=$(make_golden_fixture); sealed_golden_fixture "$wt" >/dev/null; : >"$STUB_LOG"
  printf 'n\n' | STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" cmd_golden rm >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing deleted without a yes"
}
test_golden_refresh_forces_an_update() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" cmd_golden refresh 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed although unchanged"
}
test_main_dispatches_golden() {
  # shellcheck disable=SC2329 # replaces the real function; main dispatches to it

  cmd_golden() { echo "golden $*"; }
  assert_eq "golden refresh" "$(main golden refresh)" "golden refresh"
  assert_eq "golden rm" "$(main golden rm)" "golden rm"
  assert_contains "$(main --help)" "agent-vm golden refresh|rm" "help lists golden"
}
test_golden_name_is_never_a_repo_machine_name() {
  mkdir -p "$TMP_ROOT/vm"
  if [[ "$(derive_machine_name "$TMP_ROOT/vm")" != "$GOLDEN_MACHINE" ]]; then record "PASS repo 'vm' does not map to the golden"; else record "FAIL repo 'vm' maps to the golden"; fi
  case "$GOLDEN_MACHINE" in
    agent-*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "FAIL golden name has the repo machine shape" ;;
    *) record "PASS golden name is outside the repo machine shape" ;;
  esac
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
