#!/usr/bin/env bash
# Integration tests for agent-vm-node-modules: real bind mounts under sudo, in the throwaway test store root.
# Linux with passwordless sudo only (the CI runner, or a throwaway agent-vm machine); skipped elsewhere.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
HELPER="$REPO_ROOT/home/dot_local/bin/executable_agent-vm-node-modules"
if [[ "$(uname -s)" != Linux ]] || ! sudo -n true 2>/dev/null; then echo "skipped: needs Linux and passwordless sudo"; exit 0; fi
TMP_BASE=$(mktemp -d -t agent-vm-nm-XXXXXX)
# The test store root lets the helper stand in for a VM without /etc/agent-vm (the CI runner has none).
export AGENT_VM_NM_STORE=/var/lib/agent-vm-test/node_modules AGENT_VM_NM_ASSUME_VM=1 RESULTS_FILE="$TMP_BASE/results"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"
teardown() {
  local mp
  while IFS= read -r mp; do sudo -n umount -l -- "$mp" || true; done < <(awk '$4 ~ /agent-vm-test/ {print $5}' /proc/self/mountinfo)
  sudo -n rm -rf /var/lib/agent-vm-test
}
trap 'teardown; rm -rf "$TMP_BASE"' EXIT

helper() { bash "$HELPER" "$@"; }
key() { printf '%s' "$1" | sha256sum | cut -c1-16; }
is_mounted() { [[ -d "$1/node_modules" && "$(stat -c %d:%i "$1/node_modules")" == "$(stat -c %d:%i "$AGENT_VM_NM_STORE/$(key "$1")/data" 2>/dev/null)" ]]; }
mount_rows() { awk -v k="$(key "$1")" '$4 ~ k {n++} END {print n+0}' /proc/self/mountinfo; }
store_count() { find "$AGENT_VM_NM_STORE" -mindepth 1 -maxdepth 1 -regextype posix-extended -regex '.*/[0-9a-f]{16}' | wc -l | tr -d ' '; }
check_mounted() { if is_mounted "$1"; then record "PASS $2"; else record "FAIL $2"; fi; }
check_not_mounted() { if is_mounted "$1"; then record "FAIL $2"; else record "PASS $2"; fi; }
check_store() { if [[ -d "$AGENT_VM_NM_STORE/$(key "$1")" ]]; then record "PASS $2"; else record "FAIL $2"; fi; }
check_no_store() { if [[ -d "$AGENT_VM_NM_STORE/$(key "$1")" ]]; then record "FAIL $2"; else record "PASS $2"; fi; }
check_absent() { if [[ -e "$1" ]]; then record "FAIL $2"; else record "PASS $2"; fi; }
mk_repo() { # dir: a git repository with a root package and packages/a, packages/b
  local r=$1
  mkdir -p "$r/packages/a" "$r/packages/b"; git -C "$r" init -q
  printf '{"name":"root","private":true}\n' >"$r/package.json"
  printf '{"name":"a"}\n' >"$r/packages/a/package.json"
  printf '{"name":"b"}\n' >"$r/packages/b/package.json"
  printf 'node_modules\n' >"$r/.gitignore"
  git -C "$r" add -A; git -C "$r" commit -qm init
}
fail_git() { # pattern -> a directory holding a git that fails when its arguments contain pattern
  mkdir -p "$TMP_ROOT/bin"
  printf '#!/bin/sh\ncase "$*" in *"%s"*) exit 1 ;; esac\nexec "%s" "$@"\n' "$1" "$(command -v git)" >"$TMP_ROOT/bin/git"
  chmod +x "$TMP_ROOT/bin/git"
  printf '%s' "$TMP_ROOT/bin"
}

# --- T1 ---
test_contract_prints_1() { assert_eq 1 "$(helper --contract)" "contract version"; }
test_usage_error_exits_64() { assert_status 64 "unknown subcommand" -- helper bogus; }
test_store_root_is_one_of_two_fixed_values() {
  assert_status 64 "an arbitrary store root is refused" -- env AGENT_VM_NM_STORE=/tmp/elsewhere bash "$HELPER" sync /
}
test_outside_a_vm_does_nothing() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  if [[ -e /etc/agent-vm ]]; then record "SKIP outside-a-VM checks (this is an agent-vm machine)"; return 0; fi
  assert_status 0 "exit 0 without the marker" -- env -u AGENT_VM_NM_ASSUME_VM bash "$HELPER" sync "$r"
  check_no_store "$r" "nothing created without the marker"
  assert_status 0 "the stand-in is ignored for the real store root" -- env -u AGENT_VM_NM_STORE bash "$HELPER" sync "$r"
  check_absent "/var/lib/agent-vm/node_modules/$(key "$r")" "nothing created in the real store root"
}

# --- T2 ---
test_sync_mounts_each_package() {
  local r="$TMP_ROOT/r" out; mk_repo "$r"
  out=$(helper sync "$r")
  check_mounted "$r" "root package mounted"
  check_mounted "$r/packages/a" "packages/a mounted"
  check_mounted "$r/packages/b" "packages/b mounted"
  assert_contains "$out" "$(printf 'empty\t%s' "$r")" "an empty root is reported"
  assert_contains "$out" "$(printf 'mounted\t%s' "$r/packages/a")" "a non-root package is reported as mounted"
  touch "$r/node_modules/marker"
  if [[ -e "$AGENT_VM_NM_STORE/$(key "$r")/data/marker" ]]; then record "PASS writes land in the store"; else record "FAIL writes land in the store"; fi
  out=$(helper sync "$r")
  assert_contains "$out" "$(printf 'mounted\t%s' "$r")" "a filled root is reported as mounted"
}
test_sync_is_idempotent() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null; helper sync "$r" >/dev/null
  assert_eq 1 "$(mount_rows "$r")" "one mount row after two syncs"
}
test_stale_mount_is_restored() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  sudo -n umount -l "$r/node_modules"
  helper sync "$r" >/dev/null
  check_mounted "$r" "a lost mount is restored"
}
test_shared_mount_target_is_mounted() {
  # The repository shared with the host is virtiofs, which reports the owner as whoever looks (root sees 0).
  # Only a checkout on virtiofs, inside an agent-vm machine, shows it; CI and macOS skip this test.
  local base r
  if [[ "$(findmnt -no FSTYPE -T "${REPO_ROOT:?}" 2>/dev/null)" != virtiofs ]]; then
    record "SKIP shared-mount check (this checkout is not on virtiofs)"; return 0
  fi
  mkdir -p "$REPO_ROOT/.tmp"
  base=$(mktemp -d "$REPO_ROOT/.tmp/agent-vm-nm-test.XXXXXX"); r="$base/r"; mk_repo "$r"
  helper sync "$r" >/dev/null 2>&1 || true   # the checks below say what failed
  check_mounted "$r" "a package on the shared mount is mounted"
  check_mounted "$r/packages/a" "a nested package on the shared mount is mounted"
  sudo -n umount -l "$r/node_modules" "$r/packages/a/node_modules" "$r/packages/b/node_modules" 2>/dev/null || true
  rm -rf --one-file-system "$base"
}
test_symlinked_node_modules_is_skipped() {
  local r="$TMP_ROOT/r" out; mk_repo "$r"
  ln -s "$TMP_ROOT" "$r/packages/a/node_modules"
  assert_status 1 "a symlinked node_modules makes the run partial" -- helper sync "$r"
  out=$(helper sync "$r" 2>/dev/null || true)
  assert_contains "$out" "$(printf 'skipped\t%s' "$r/packages/a")" "skipped record"
  assert_eq 0 "$(mount_rows "$r/packages/a")" "nothing mounted through the symlink"
}
test_control_characters_make_the_run_partial() {
  local r="$TMP_ROOT/r" bad; mk_repo "$r"; bad="$r/packages/x"$'\n'"y"
  mkdir -p "$bad"; printf '{}\n' >"$bad/package.json"; git -C "$r" add -A; git -C "$r" commit -qm bad
  assert_status 1 "a package path with a newline makes the run partial" -- helper sync "$r"
  assert_eq 3 "$(store_count)" "only the three ordinary packages have stores"
}
test_symlinked_package_json_is_not_a_package() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  mkdir -p "$r/packages/c"; ln -s ../a/package.json "$r/packages/c/package.json"; git -C "$r" add -A; git -C "$r" commit -qm c
  assert_status 0 "sync" -- helper sync "$r"
  check_no_store "$r/packages/c" "no store behind a symlinked package.json"
}
test_worktree_outside_repo_is_ignored() {
  local r="$TMP_ROOT/r" err; mk_repo "$r"
  git -C "$r" worktree add -q "$TMP_ROOT/outside" -b outside
  err=$(helper sync "$r" 2>&1 >/dev/null || true)
  assert_contains "$err" "outside the repository" "the outside worktree is reported"
  check_no_store "$TMP_ROOT/outside" "no store for the outside worktree"
}
test_worktree_under_dot_git_worktree_is_mounted() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  helper sync "$r" >/dev/null
  check_mounted "$r/.git/worktree/feat" "the worktree's root package"
  check_mounted "$r/.git/worktree/feat/packages/a" "the worktree's packages/a"
}
test_package_json_under_node_modules_is_not_a_package() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  rm "$r/.gitignore"; mkdir -p "$r/node_modules/dep"; printf '{}\n' >"$r/node_modules/dep/package.json"
  helper sync "$r" >/dev/null
  check_no_store "$r/node_modules/dep" "no store for a dependency's package.json"
}
test_non_js_repo_is_silent() {
  local r="$TMP_ROOT/r" out; mkdir -p "$r"; git -C "$r" init -q; printf 'x\n' >"$r/README"; git -C "$r" add -A; git -C "$r" commit -qm init
  out=$(helper sync "$r" 2>&1)
  assert_eq "" "$out" "no output for a repository without package.json"
  assert_status 0 "exit 0" -- helper sync "$r"
  check_absent "$r/node_modules" "no node_modules created"
}
test_cap_falls_back_to_the_root_package() {
  local r="$TMP_ROOT/r" i; mk_repo "$r"
  for i in $(seq 1 501); do mkdir -p "$r/p/$i"; printf '{}\n' >"$r/p/$i/package.json"; done
  assert_status 3 "over the cap (501 > 500), reclaim is aborted" -- helper sync "$r"
  check_mounted "$r" "the root package is mounted"
  check_not_mounted "$r/p/1" "other packages are not mounted"
}
test_attach_mounts_one_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 0 "attach" -- helper attach "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat" "the attached worktree"
  check_not_mounted "$r" "the main worktree is left to sync"
}
test_attach_rejects_a_path_that_is_not_a_listed_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 64 "a directory inside a worktree is refused" -- helper attach "$r/.git/worktree/feat/packages"
}
test_attach_exits_1_when_ls_files_fails() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git ls-files)
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  assert_status 1 "attach reports that nothing could be mounted" -- env PATH="$bin:$PATH" bash "$HELPER" attach "$r/.git/worktree/feat"
}
test_attach_keeping_stores_exits_0() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper attach "$wt" >/dev/null
  rm "$wt/package.json" "$wt/packages/a/package.json" "$wt/packages/b/package.json"
  assert_status 0 "zero packages with stores is no failure for attach" -- helper attach "$wt"
}
test_attach_ignores_an_unresolvable_sibling() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/gone" -b gone
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  mv "$r/.git/worktree/gone" "$TMP_ROOT/gone.off"
  assert_status 0 "attach goes on while a sibling worktree is missing" -- helper attach "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat" "the attached worktree"
}
test_lock_timeout_exits_2() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  ( flock 8; sleep 5 ) 8<"$AGENT_VM_NM_STORE/.lock" &
  sleep 1
  assert_status 2 "lock held elsewhere" -- env AGENT_VM_NM_LOCK_WAIT=1 bash "$HELPER" sync "$r"
  wait
}

# --- T3 ---
test_removed_package_is_reclaimed() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 0 "sync after removing a package" -- helper sync "$r"
  check_no_store "$r/packages/b" "the removed package's store is gone"
  assert_eq 0 "$(mount_rows "$r/packages/b")" "and its mount"
  check_store "$r/packages/a" "other stores stay"
}
test_ls_files_failure_keeps_stores() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git ls-files)
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted" -- env PATH="$bin:$PATH" bash "$HELPER" sync "$r"
  check_store "$r/packages/b" "the store survives a failing ls-files"
}
test_zero_packages_with_stores_keeps_them() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  rm "$r/package.json" "$r/packages/a/package.json" "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted" -- helper sync "$r"
  check_store "$r" "the root store survives"
}
test_worktree_list_failure_keeps_stores() {
  local r="$TMP_ROOT/r" bin; mk_repo "$r"; bin=$(fail_git "worktree list")
  helper sync "$r" >/dev/null
  rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted for the repository" -- env PATH="$bin:$PATH" bash "$HELPER" sync "$r"
  check_store "$r/packages/b" "the store survives a failing worktree list"
}
test_list_without_the_main_worktree_keeps_stores() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$wt/packages/b/package.json"
  assert_status 3 "a linked worktree given as the repository aborts reclaim" -- helper sync "$wt"
  check_store "$wt/packages/b" "the worktree's store survives"
  check_store "$r" "the main worktree's store survives"
}
test_invisible_repository_keeps_stores() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  mv "$r/.git" "$r/.git.off"
  assert_status 3 "reclaim aborted" -- helper sync "$r"
  check_store "$r" "the root store survives"
}
test_main_abort_does_not_block_a_worktree() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$r/package.json" "$r/packages/a/package.json" "$r/packages/b/package.json"
  rm "$wt/packages/b/package.json"
  assert_status 3 "the main worktree's reclaim is aborted" -- helper sync "$r"
  check_store "$r/packages/a" "the main worktree's stores are kept"
  check_no_store "$wt/packages/b" "the nested worktree's removed package is reclaimed"
}
test_partial_wins_over_reclaim_abort() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  rm "$wt/package.json" "$wt/packages/a/package.json" "$wt/packages/b/package.json"
  sudo -n umount -l "$r/packages/a/node_modules"; rmdir "$r/packages/a/node_modules"; ln -s "$TMP_ROOT" "$r/packages/a/node_modules"
  assert_status 1 "1 wins over 3" -- helper sync "$r"
}
test_inconsistent_records_are_kept() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  helper sync "$r" >/dev/null
  sudo -n mkdir "$AGENT_VM_NM_STORE/zz" "$AGENT_VM_NM_STORE/0123456789abcdef" "$AGENT_VM_NM_STORE/fedcba9876543210"
  printf '%s\n' "$r/elsewhere" | sudo -n tee "$AGENT_VM_NM_STORE/0123456789abcdef/path" >/dev/null
  printf '/etc\n' | sudo -n tee "$AGENT_VM_NM_STORE/fedcba9876543210/path" >/dev/null
  helper sync "$r" >/dev/null 2>&1 || true
  if [[ -d "$AGENT_VM_NM_STORE/zz" && -d "$AGENT_VM_NM_STORE/0123456789abcdef" && -d "$AGENT_VM_NM_STORE/fedcba9876543210" ]]; then
    record "PASS foreign and inconsistent store dirs kept"; else record "FAIL foreign and inconsistent store dirs kept"; fi
}
test_nested_repository_store_is_kept() {
  local r="$TMP_ROOT/r" b; mk_repo "$r"; b="$r/vendor/B"; mk_repo "$b"
  helper sync "$b" >/dev/null
  assert_status 0 "sync of the outer repository" -- helper sync "$r"
  check_store "$b/packages/a" "the nested repository's store is kept"
  check_mounted "$b/packages/a" "and stays mounted"
}
test_unresolvable_worktree_keeps_stores() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat
  helper sync "$r" >/dev/null
  sudo -n umount -l "$wt/node_modules" "$wt/packages/a/node_modules" "$wt/packages/b/node_modules"
  mv "$wt" "$TMP_ROOT/feat.off"; rm "$r/packages/b/package.json"
  assert_status 3 "reclaim aborted while a listed worktree is missing" -- helper sync "$r"
  check_store "$wt" "the missing worktree's store is kept"
  check_store "$r/packages/b" "and so is the main worktree's"
}

# --- T4 ---
test_remove_reclaims_after_success() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 0 "remove succeeds" -- helper remove "$wt" -- git -C "$r" worktree remove -- "$wt"
  check_absent "$wt" "the worktree is gone"
  check_no_store "$wt" "its store is gone"
  assert_eq 0 "$(mount_rows "$wt")" "its mount is gone"
  check_mounted "$r" "the main worktree keeps its mount"
}
test_remove_failure_reattaches() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 1 "the command's status is returned" -- helper remove "$wt" -- false
  check_mounted "$wt" "the worktree is mounted again"
}
test_remove_matches_the_path_boundary() {
  local r="$TMP_ROOT/r"; mk_repo "$r"
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  git -C "$r" worktree add -q "$r/.git/worktree/feat2" -b feat2
  helper sync "$r" >/dev/null
  helper remove "$r/.git/worktree/feat" -- git -C "$r" worktree remove -- "$r/.git/worktree/feat"
  check_mounted "$r/.git/worktree/feat2" "feat2 keeps its mount"
}
test_remove_usage_error_exits_64() {
  assert_status 64 "remove without a command" -- helper remove "$TMP_ROOT" --
  assert_status 64 "remove without --" -- helper remove "$TMP_ROOT" touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
}
test_remove_refuses_the_main_worktree() {
  local r="$TMP_ROOT/r"; mk_repo "$r"; helper sync "$r" >/dev/null
  assert_status 64 "the main worktree is refused" -- helper remove "$r" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  check_mounted "$r" "the main worktree keeps its mount"
}
test_remove_exits_70_when_it_cannot_detach() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 70 "a detach failure" -- env AGENT_VM_NM_TEST_FAIL_UNMOUNT=1 bash "$HELPER" remove "$wt" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  check_mounted "$wt" "the worktree keeps its mount"
}
test_remove_ignores_an_unresolvable_sibling() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$r/.git/worktree/gone" -b gone
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  sudo -n umount -l "$r/.git/worktree/gone/node_modules" "$r/.git/worktree/gone/packages/a/node_modules" "$r/.git/worktree/gone/packages/b/node_modules"
  mv "$r/.git/worktree/gone" "$TMP_ROOT/gone.off"
  assert_status 0 "remove goes on while a sibling worktree is missing" -- helper remove "$wt" -- git -C "$r" worktree remove -- "$wt"
  check_no_store "$wt" "the removed worktree's store is gone"
  check_store "$r/.git/worktree/gone" "the missing sibling's store is kept"
}
test_remove_keeps_the_store_when_the_worktree_stays() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  assert_status 0 "the command's status is returned" -- helper remove "$wt" -- true
  check_store "$wt" "the store is kept"
  check_mounted "$wt" "and mounted again"
}
test_remove_lock_timeout_exits_71() {
  local r="$TMP_ROOT/r" wt; mk_repo "$r"; wt="$r/.git/worktree/feat"
  git -C "$r" worktree add -q "$wt" -b feat; helper sync "$r" >/dev/null
  ( flock 8; sleep 5 ) 8<"$AGENT_VM_NM_STORE/.lock" &
  sleep 1
  assert_status 71 "lock held elsewhere" -- env AGENT_VM_NM_LOCK_WAIT=1 bash "$HELPER" remove "$wt" -- touch "$TMP_ROOT/ran"
  check_absent "$TMP_ROOT/ran" "the command did not run"
  wait
}

# Each test runs as an asynchronous subshell, which keeps set -e in force inside it.
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( TMP_ROOT=$(mktemp -d "$TMP_BASE/XXXXXX"); export TMP_ROOT; "$t" ) </dev/null &
  wait $! || record "FAIL $t (test aborted)"
  teardown
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
