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

test_create_uses_isolation_flags_and_mounts() {
  ensure_machine agent-c-000000 /repo/path /wt
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "orb create" "create called"
  assert_contains "$log" "--isolated" "isolated"
  assert_contains "$log" "--isolate-network" "network isolated"
  assert_contains "$log" "--forward-ssh-agent" "agent forwarded"
  assert_contains "$log" "-c /wt/agent-vm/cloud-init.yaml" "cloud-init from working tree"
  assert_contains "$log" "--mount /repo/path:/repo/path" "repo mounted at same path"
  assert_contains "$log" "--mount $AGENT_VM_STATE_DIR/staging/agent-c-000000:/opt/agent-vm/src" "staging mount"
  assert_contains "$log" "--mount $AGENT_VM_STATE_DIR/outbox/agent-c-000000:/opt/agent-vm/outbox" "outbox mount"
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
test_codex_login_runs_only_when_auth_missing() {
  STUB_ORB_EXIT=1 ensure_codex_auth agent-a-000000 || true
  # the stub logs argv with printf %q, so the single bash -lc script shows escaped spaces
  assert_contains "$(cat "$STUB_LOG")" 'bash -lc codex\ login\ --device-auth' "device auth in a login shell when missing"
  : >"$STUB_LOG"
  ensure_codex_auth agent-a-000000
  assert_not_contains "$(cat "$STUB_LOG")" "login" "no login when present"
}
test_session_runs_without_holding_the_lock() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  notice_orphan_env() { :; } # implemented in T10
  session_exec() { # replaces the real orb session in this subshell only
    if bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1; then
      record "PASS lock free during session"
    else
      record "FAIL lock free during session"
    fi
  }
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" run_tool claude) 2>/dev/null
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
