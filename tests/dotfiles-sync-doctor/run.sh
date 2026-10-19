#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# Tests for dotfiles-sync-doctor and the chezmoi hooks.update.pre that calls it. Every fixture lives in a throwaway
# directory under $TMP_BASE; the real repository, 1Password and ~/.local/bin are never touched. The signer is a fake
# script set as gpg.ssh.program; `chezmoi` is a PATH stub, except in the hook section, which runs the real chezmoi.
# Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
DSD="$REPO_ROOT/home/dot_local/bin/executable_dotfiles-sync-doctor"
TMP_BASE=$(cd -P "$(mktemp -d -t dsd-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT
# When started from a git hook, these variables would point fixtures at the real repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_SSH_COMMAND GIT_SSH GIT_ASKPASS GIT_PROXY_COMMAND GIT_EXEC_PATH \
  DOTFILES_SYNC_DOCTOR_SKIP DOTFILES_SYNC_DOCTOR_SIGN_TIMEOUT
# The real chezmoi (hook section only) is found before PATH is narrowed for the other sections.
CHEZMOI_REAL=$(command -v chezmoi || true)
export GIT_CEILING_DIRECTORIES="$TMP_BASE" HOME="$TMP_BASE/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP_BASE/gitconfig" GIT_TERMINAL_PROMPT=0
mkdir -p "$HOME"
git config -f "$GIT_CONFIG_GLOBAL" user.name t
git config -f "$GIT_CONFIG_GLOBAL" user.email t@t
git config -f "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config -f "$GIT_CONFIG_GLOBAL" init.defaultBranch main
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
REAL_GIT=$(command -v git)
# git and the base system only
BASE_PATH="$(dirname "$REAL_GIT"):/usr/bin:/bin"

# ---- assert ----------------------------------------------------------------
record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2 / in: $1)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2 / in: $1)" ;; *) record "PASS $3" ;; esac; }
assert_exists() { if [[ -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (missing: $1)"; fi; }
assert_no_file() { if [[ ! -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (exists: $1)"; fi; }
# assert_line_start <text> <prefix> <label>: some line of <text> starts with <prefix>
assert_line_start() { if [[ "$(line_no "$1" "$2")" -gt 0 ]]; then record "PASS $3"; else record "FAIL $3 (no line starts with: $2 / in: $1)"; fi; }
# line_no <text> <prefix>: number of the first line starting with <prefix> (0 when none)
line_no() { printf '%s\n' "$1" | awk -v p="$2" 'index($0, p) == 1 { print NR; found = 1; exit } END { if (!found) print 0 }'; }
line_count() { if [[ -z "$1" ]]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }

# ---- fixture -----------------------------------------------------------------
# A fake signer. FAKE_SIGNER_MODE: ok | fail | fail_after (succeed for the first FAKE_SIGNER_FAIL_AFTER calls) |
# sleep (record the pid, sleep 5, succeed) | hang_grandchild (leave a `sleep 5` holding its stdout, then sleep itself).
# Every call is logged to $FAKE_SIGNER_LOG: the arguments and, for -f, the content of the key file at that moment.
write_signer() {
  cat >"$1" <<'EOF'
#!/bin/sh
{
  printf 'call\n'
  prev=
  for a in "$@"; do
    printf 'arg:%s\n' "$a"
    if [ "$prev" = -f ]; then printf 'keyfile-content:%s\n' "$(cat "$a" 2>/dev/null)"; fi
    prev=$a
    last=$a
  done
} >>"$FAKE_SIGNER_LOG"
if [ -n "${FAKE_SIGNER_PIDFILE:-}" ]; then echo $$ >"$FAKE_SIGNER_PIDFILE"; fi
fail() { echo "1Password: Could not connect to socket. Is the agent running?" >&2; exit 1; }
case "${FAKE_SIGNER_MODE:-ok}" in
ok) ;;
fail) fail ;;
fail_after)
  n=$(cat "$FAKE_SIGNER_LOG.count" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" >"$FAKE_SIGNER_LOG.count"
  if [ "$n" -gt "$FAKE_SIGNER_FAIL_AFTER" ]; then fail; fi
  ;;
sleep) sleep 5 ;;
hang_grandchild)
  sleep 5 &
  sleep 5
  ;;
esac
printf 'fake-signature\n' >"$last.sig"
EOF
  chmod +x "$1"
}
# make_fixture <name>: bare origin, a seed clone (the "other machine"), and $REPO (the chezmoi source repo, with
# the source dir $REPO/home). Signing stays off until enable_signing. Exports the env of the stubs.
make_fixture() {
  FX="$TMP_BASE/$1"
  ORIGIN="$FX/origin.git"
  SEED="$FX/seed"
  REPO="$FX/repo"
  mkdir -p "$FX/bin" "$FX/tmp"
  git init -q --bare "$ORIGIN"
  git init -q "$SEED"
  printf 'base\n' >"$SEED/shared.txt"
  printf 'base\n' >"$SEED/dirty.txt"
  printf 'base\n' >"$SEED/a.txt"
  git -C "$SEED" add -A
  git -C "$SEED" commit -q -m seed
  git -C "$SEED" remote add origin "$ORIGIN"
  git -C "$SEED" push -q -u origin main
  git clone -q "$ORIGIN" "$REPO"
  mkdir -p "$REPO/home"
  printf 'x\n' >"$REPO/home/x"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m "add source dir"
  git -C "$REPO" push -q origin main
  git -C "$SEED" pull -q
  REPO=$(cd -P "$REPO" && pwd -P)
  printf 'fake key\n' >"$FX/key"
  SIGNER="$FX/signer"
  write_signer "$SIGNER"
  : >"$FX/agent.sock"
  export FAKE_SIGNER_LOG="$FX/signer.log" FAKE_SIGNER_MODE=ok
  unset FAKE_SIGNER_PIDFILE FAKE_SIGNER_FAIL_AFTER
  : >"$FAKE_SIGNER_LOG"
  export SSH_AUTH_SOCK="$FX/agent.sock" DOTFILES_SYNC_DOCTOR_SIGN_TIMEOUT=5
  export STUB_SOURCE_PATH="$REPO/home" STUB_APPLY_LOG="$FX/apply.log" STUB_CONFIG_FILE="$FX/config.toml"
  unset STUB_SOURCE_PATH_FAIL STUB_APPLY_RC STUB_APPLY_SLEEP DSD_TMPDIR
  printf '[onepassword]\nprompt = false\n\n[hooks.update.pre]\ncommand = "sh"\n' >"$STUB_CONFIG_FILE"
  cat >"$FX/bin/chezmoi" <<'EOF'
#!/bin/sh
case "$1" in
source-path)
  if [ -n "${STUB_SOURCE_PATH_FAIL:-}" ]; then exit 1; fi
  printf '%s\n' "$STUB_SOURCE_PATH"
  ;;
cat-config) cat "$STUB_CONFIG_FILE" ;;
apply)
  echo apply >>"$STUB_APPLY_LOG"
  if [ -n "${STUB_APPLY_SLEEP:-}" ]; then sleep "$STUB_APPLY_SLEEP"; fi
  exit "${STUB_APPLY_RC:-0}"
  ;;
*) exit 64 ;;
esac
EOF
  # ssh-add -l against the fake agent: 1 (no identities) when the socket exists, 2 when it does not
  cat >"$FX/bin/ssh-add" <<'EOF'
#!/bin/sh
if [ -e "${SSH_AUTH_SOCK:-}" ]; then exit 1; fi
echo "Could not open a connection to your authentication agent." >&2
exit 2
EOF
  # `timeout` must never be needed: a stub that records any use and fails
  cat >"$FX/bin/timeout" <<'EOF'
#!/bin/sh
echo "timeout $*" >>"$STUB_APPLY_LOG.timeout"
exit 97
EOF
  chmod +x "$FX/bin/chezmoi" "$FX/bin/ssh-add" "$FX/bin/timeout"
}
enable_signing() {
  git -C "$REPO" config commit.gpgsign true
  git -C "$REPO" config gpg.format ssh
  git -C "$REPO" config gpg.ssh.program "$SIGNER"
  git -C "$REPO" config user.signingkey "$FX/key"
}
# add_ahead [file] [content]: a local commit not on origin (signing is off for the setup commit)
add_ahead() {
  printf '%s\n' "${2:-ahead}" >"$REPO/${1:-ahead.txt}"
  git -C "$REPO" add -A
  git -C "$REPO" -c commit.gpgsign=false commit -q -m "ahead ${1:-ahead.txt}"
}
# add_behind [file] [content]: a commit on origin made elsewhere, fetched into $REPO's tracking ref
add_behind() {
  printf '%s\n' "${2:-behind}" >"$SEED/${1:-behind.txt}"
  git -C "$SEED" add -A
  git -C "$SEED" commit -q -m "behind ${1:-behind.txt}"
  git -C "$SEED" push -q origin main
  git -C "$REPO" fetch -q origin
}
# stuck_rebase [pull flags]: `git pull --rebase` with a failing signer, which stops the rebase at the first pick
stuck_rebase() {
  FAKE_SIGNER_MODE=fail git -C "$REPO" pull -q --rebase "$@" >/dev/null 2>&1 || true
  : >"$FAKE_SIGNER_LOG"
  rm -f "$FAKE_SIGNER_LOG.count"
}
git_path() { printf '%s/%s\n' "$REPO" "$(git -C "$REPO" rev-parse --git-path "$1")"; }
rebase_dir() { git_path rebase-merge; }
signer_calls() { grep -c '^call$' "$FAKE_SIGNER_LOG" || true; }
apply_calls() { if [[ -f "$STUB_APPLY_LOG" ]]; then wc -l <"$STUB_APPLY_LOG" | tr -d ' '; else echo 0; fi; }
stash_ref() { git -C "$REPO" rev-parse -q --verify refs/stash || true; }
# run_dsd <args...>: the script under /bin/sh, from outside the repo, with the stubs in front of the base PATH.
# Sets STDOUT, STDERR and RC.
run_dsd() {
  STDOUT=$(cd "$FX" && PATH="$FX/bin:$BASE_PATH" TMPDIR="${DSD_TMPDIR:-$FX/tmp}" /bin/sh "$DSD" "$@" 2>"$FX/stderr") && RC=0 || RC=$?
  STDERR=$(cat "$FX/stderr")
}
tmp_leftovers() { ls -A "$FX/tmp"; }

# ---- preflight -------------------------------------------------------------------
test_01_preflight_ahead0_behind1_does_not_sign() {
  make_fixture t01
  enable_signing
  add_behind
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 0 "$RC" "01 exit 0"
  assert_eq 0 "$(signer_calls)" "01 signer not called"
}

test_02_preflight_blocks_with_fix_and_skip_lines() {
  make_fixture t02
  enable_signing
  add_ahead
  add_behind
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 1 "$RC" "02 exit 1"
  assert_line_start "$STDERR" "fix: start and unlock 1Password" "02 fix line at line start"
  assert_line_start "$STDERR" "skip: DOTFILES_SYNC_DOCTOR_SKIP=1 chezmoi update" "02 skip line at line start"
  fix_n=$(line_no "$STDERR" "fix: start")
  skip_n=$(line_no "$STDERR" "skip: ")
  if [[ "$fix_n" -gt 0 && "$skip_n" -gt "$fix_n" ]]; then record "PASS 02 skip after fix"; else record "FAIL 02 skip after fix ($fix_n / $skip_n)"; fi
  assert_not_contains "$STDOUT" "fix:" "02 stdout has no fix:"
  assert_not_contains "$STDOUT" "skip:" "02 stdout has no skip:"
}

test_03_preflight_ahead1_behind0_blocks() {
  make_fixture t03
  enable_signing
  add_ahead
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 1 "$RC" "03 exit 1 (behind is not consulted)"
}

test_04_preflight_ahead1_sign_ok() {
  make_fixture t04
  enable_signing
  add_ahead
  run_dsd preflight
  assert_eq 0 "$RC" "04 exit 0"
  assert_eq 1 "$(signer_calls)" "04 signer called once"
}

test_05_preflight_signing_disabled() {
  make_fixture t05
  enable_signing
  git -C "$REPO" config commit.gpgsign false
  add_ahead
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 0 "$RC" "05 exit 0"
  assert_eq 0 "$(signer_calls)" "05 signer not called"
}

test_06_preflight_non_ssh_format_warns() {
  make_fixture t06
  enable_signing
  git -C "$REPO" config gpg.format openpgp
  add_ahead
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 0 "$RC" "06 exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "06 one warning line"
  assert_eq 0 "$(signer_calls)" "06 signer not called"
}

test_07_preflight_undecidable_does_not_block() {
  make_fixture t07
  enable_signing
  add_ahead
  export FAKE_SIGNER_MODE=fail
  STUB_SOURCE_PATH_FAIL=1 run_dsd preflight
  assert_eq 0 "$RC" "07 source-path failure: exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "07 source-path failure: one warning line"
  git -C "$REPO" checkout -q -b no-upstream
  run_dsd preflight
  assert_eq 0 "$RC" "07 no upstream: exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "07 no upstream: one warning line"
  git -C "$REPO" checkout -q --detach
  run_dsd preflight
  assert_eq 0 "$RC" "07 detached HEAD: exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "07 detached HEAD: one warning line"
  assert_eq 0 "$(signer_calls)" "07 signer never called"
}

test_08_preflight_blocks_on_operation_in_progress() {
  make_fixture t08
  enable_signing
  mkdir -p "$(git_path rebase-merge)"
  run_dsd preflight
  assert_eq 1 "$RC" "08 rebase-merge: exit 1"
  assert_line_start "$STDERR" "fix: dotfiles-sync-doctor fix" "08 rebase-merge: fix line"
  rmdir "$(git_path rebase-merge)"
  mkdir -p "$(git_path rebase-apply)"
  run_dsd preflight
  assert_eq 1 "$RC" "08 rebase-apply: exit 1"
  assert_line_start "$STDERR" "fix: dotfiles-sync-doctor fix" "08 rebase-apply: fix line"
  rmdir "$(git_path rebase-apply)"
  git -C "$REPO" rev-parse HEAD >"$(git_path MERGE_HEAD)"
  run_dsd preflight
  assert_eq 1 "$RC" "08 merge: exit 1"
  assert_line_start "$STDERR" "fix: resolve or abort the merge in $REPO" "08 merge: fix line"
}

test_09_preflight_timeout_without_timeout_command() {
  make_fixture t09
  enable_signing
  add_ahead
  export FAKE_SIGNER_MODE=hang_grandchild DOTFILES_SYNC_DOCTOR_SIGN_TIMEOUT=1
  start=$SECONDS
  run_dsd preflight
  elapsed=$((SECONDS - start))
  assert_eq 1 "$RC" "09 exit 1"
  if [[ "$elapsed" -le 4 ]]; then record "PASS 09 finished in ${elapsed}s (<= 4s)"; else record "FAIL 09 took ${elapsed}s"; fi
  assert_eq "" "$(tmp_leftovers)" "09 no temp dir left"
  assert_no_file "$STUB_APPLY_LOG.timeout" "09 timeout command not used"
  assert_line_start "$STDERR" "fix: start and unlock 1Password" "09 fix line"
}

test_09b_preflight_term_during_signing() {
  make_fixture t09b
  enable_signing
  add_ahead
  export FAKE_SIGNER_MODE=sleep FAKE_SIGNER_PIDFILE="$FX/signer.pid"
  cd "$FX"
  PATH="$FX/bin:$BASE_PATH" TMPDIR="$FX/tmp" /bin/sh "$DSD" preflight >"$FX/out" 2>"$FX/err" &
  dsd_pid=$!
  i=0
  while [[ ! -s "$FX/signer.pid" && $i -lt 50 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  signer_pid=$(cat "$FX/signer.pid" 2>/dev/null || echo 0)
  kill -TERM "$dsd_pid"
  wait "$dsd_pid" && rc=0 || rc=$?
  assert_eq 143 "$rc" "09b exit 143"
  i=0
  while kill -0 "$signer_pid" 2>/dev/null && [[ $i -lt 20 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  if kill -0 "$signer_pid" 2>/dev/null; then record "FAIL 09b signer pid $signer_pid still alive"; else record "PASS 09b signer process gone"; fi
  assert_eq "" "$(tmp_leftovers)" "09b no temp dir left"
}

test_10_preflight_key_forms() {
  make_fixture t10
  enable_signing
  add_ahead
  git -C "$REPO" config user.signingkey "ssh-ed25519 AAAAFAKEKEY comment"
  run_dsd preflight
  assert_eq 0 "$RC" "10 literal key: exit 0"
  log=$(cat "$FAKE_SIGNER_LOG")
  assert_contains "$log" "arg:-U" "10 literal key: -U passed"
  assert_contains "$log" "keyfile-content:ssh-ed25519 AAAAFAKEKEY comment" "10 literal key: key written to the -f file"
  assert_eq "" "$(tmp_leftovers)" "10 literal key: no temp files left"
  : >"$FAKE_SIGNER_LOG"
  git -C "$REPO" config user.signingkey "key::ssh-ed25519 AAAAFAKEKEY comment"
  run_dsd preflight
  log=$(cat "$FAKE_SIGNER_LOG")
  assert_contains "$log" "keyfile-content:ssh-ed25519 AAAAFAKEKEY comment" "10 key:: prefix stripped"
  : >"$FAKE_SIGNER_LOG"
  git -C "$REPO" config user.signingkey "$FX/key"
  run_dsd preflight
  log=$(cat "$FAKE_SIGNER_LOG")
  assert_contains "$log" "arg:$FX/key" "10 path key: path passed"
  assert_not_contains "$log" "arg:-U" "10 path key: no -U"
  assert_eq "" "$(tmp_leftovers)" "10 path key: no temp files left"
}

test_11_preflight_missing_signer_program() {
  make_fixture t11
  enable_signing
  git -C "$REPO" config gpg.ssh.program "$FX/does-not-exist"
  add_ahead
  run_dsd preflight
  assert_eq 1 "$RC" "11 exit 1"
  assert_line_start "$STDERR" "fix: check gpg.ssh.program" "11 fix line"
}

# ---- check --------------------------------------------------------------------------
test_12_check_healthy() {
  make_fixture t12
  enable_signing
  run_dsd
  assert_eq 0 "$RC" "12 exit 0"
  assert_contains "$STDOUT" "ssh agent: reachable" "12 agent reachable"
  assert_contains "$STDOUT" "signing: ok" "12 signing ok"
  assert_contains "$STDOUT" "update hook: installed" "12 hook installed"
}

test_13_check_tries_signing_with_ahead0() {
  make_fixture t13
  enable_signing
  FAKE_SIGNER_MODE=fail run_dsd check
  assert_eq 1 "$RC" "13 exit 1"
  assert_contains "$STDOUT" "signing: FAILED" "13 signing line shows the failure"
  assert_eq 1 "$(signer_calls)" "13 signer tried"
}

test_14_check_hook_missing() {
  make_fixture t14
  enable_signing
  printf '[onepassword]\n  prompt = false\n' >"$STUB_CONFIG_FILE"
  run_dsd check
  assert_eq 1 "$RC" "14 exit 1"
  assert_line_start "$STDERR" "fix: chezmoi init" "14 fix line"
  assert_contains "$STDOUT" "update hook: MISSING" "14 hook line"
}

test_15_check_agent_unreachable_is_informational() {
  make_fixture t15
  enable_signing
  SSH_AUTH_SOCK="$FX/no-such-socket" run_dsd check
  assert_eq 0 "$RC" "15 exit 0"
  assert_contains "$STDOUT" "ssh agent: not reachable" "15 agent line shows the failure"
  assert_contains "$STDOUT" "signing: ok" "15 signing ok"
}

test_16_check_non_ssh_format_not_checked() {
  make_fixture t16
  enable_signing
  git -C "$REPO" config gpg.format openpgp
  FAKE_SIGNER_MODE=fail run_dsd check
  assert_eq 0 "$RC" "16 exit 0"
  assert_contains "$STDOUT" "signing: not checked" "16 signing not checked"
  assert_eq 0 "$(signer_calls)" "16 signer not called"
}

# ---- fix ------------------------------------------------------------------------------
test_17_fix_finishes_the_rebase_and_applies() {
  make_fixture t17
  enable_signing
  add_ahead
  add_behind
  stuck_rebase
  assert_exists "$(rebase_dir)" "17 setup: rebase is stopped"
  run_dsd fix
  assert_eq 0 "$RC" "17 exit 0 ($STDERR)"
  assert_no_file "$(rebase_dir)" "17 rebase finished"
  assert_eq "$(git -C "$REPO" rev-parse origin/main)" "$(git -C "$REPO" rev-parse HEAD^)" "17 HEAD sits on origin's tip"
  assert_eq 1 "$(apply_calls)" "17 apply ran once"
}

test_18_fix_does_not_fall_back_to_unsigned() {
  make_fixture t18
  enable_signing
  add_ahead
  add_behind
  stuck_rebase
  FAKE_SIGNER_MODE=fail run_dsd fix
  assert_eq 1 "$RC" "18 exit 1"
  assert_exists "$(rebase_dir)" "18 rebase left in place"
  assert_eq 0 "$(apply_calls)" "18 apply not run"
  assert_line_start "$STDERR" "fix: start and unlock 1Password" "18 fix line"
  assert_not_contains "$STDERR" "skip:" "18 no skip line outside preflight"
}

test_19_fix_reports_conflicts() {
  make_fixture t19
  enable_signing
  add_ahead shared.txt local
  add_behind shared.txt origin
  stuck_rebase
  assert_exists "$(rebase_dir)" "19 setup: rebase is stopped"
  run_dsd fix
  assert_eq 1 "$RC" "19 exit 1"
  assert_contains "$STDERR" "shared.txt" "19 conflicting file named"
  assert_eq 0 "$(signer_calls)" "19 signer not called"
  assert_line_start "$STDERR" "fix: resolve the conflicts, git add them, then run dotfiles-sync-doctor fix" "19 fix line"
  assert_eq 0 "$(apply_calls)" "19 apply not run"
}

test_20_fix_stops_again_on_a_later_pick() {
  make_fixture t20
  enable_signing
  add_ahead ahead1.txt
  add_ahead ahead2.txt
  add_behind
  stuck_rebase
  assert_exists "$(rebase_dir)" "20 setup: rebase is stopped"
  export FAKE_SIGNER_MODE=fail_after FAKE_SIGNER_FAIL_AFTER=2
  run_dsd fix
  assert_eq 1 "$RC" "20 exit 1"
  assert_exists "$(rebase_dir)" "20 rebase left in place"
  assert_line_start "$STDERR" "fix: dotfiles-sync-doctor fix" "20 fix line"
  assert_eq 0 "$(apply_calls)" "20 apply not run"
  assert_eq 3 "$(signer_calls)" "20 probe + two picks"
}

test_21_fix_apply_failure_is_reported() {
  make_fixture t21
  enable_signing
  add_ahead
  add_behind
  stuck_rebase
  STUB_APPLY_RC=3 run_dsd fix
  assert_eq 3 "$RC" "21 exit code of apply"
  assert_no_file "$(rebase_dir)" "21 rebase finished"
  assert_line_start "$STDERR" "fix: chezmoi apply" "21 fix line"
}

test_22_fix_restores_the_autostash() {
  make_fixture t22
  enable_signing
  add_ahead
  add_behind
  printf 'dirty\n' >"$REPO/dirty.txt"
  before=$(stash_ref)
  stuck_rebase --autostash
  assert_exists "$(rebase_dir)/autostash" "22 setup: autostash recorded"
  run_dsd fix
  assert_eq 0 "$RC" "22 exit 0 ($STDERR)"
  assert_eq dirty "$(cat "$REPO/dirty.txt")" "22 working tree change restored"
  assert_eq "$before" "$(stash_ref)" "22 refs/stash unchanged"
  assert_eq 1 "$(apply_calls)" "22 apply ran"
}

test_22b_fix_stops_when_the_autostash_conflicts() {
  make_fixture t22b
  enable_signing
  add_ahead
  add_behind shared.txt origin
  printf 'local-dirty\n' >"$REPO/shared.txt"
  before=$(stash_ref)
  stuck_rebase --autostash
  assert_exists "$(rebase_dir)/autostash" "22b setup: autostash recorded"
  run_dsd fix
  assert_eq 1 "$RC" "22b exit 1"
  assert_no_file "$(rebase_dir)" "22b rebase finished"
  if [[ "$(stash_ref)" != "$before" && -n "$(stash_ref)" ]]; then record "PASS 22b refs/stash grew"; else record "FAIL 22b refs/stash did not change"; fi
  pop_n=$(line_no "$STDERR" "fix: git -C $REPO stash pop")
  apply_n=$(line_no "$STDERR" "fix: chezmoi apply")
  if [[ "$pop_n" -gt 0 && "$apply_n" -gt "$pop_n" ]]; then record "PASS 22b fix lines in order"; else record "FAIL 22b fix lines ($pop_n / $apply_n) in: $STDERR"; fi
  assert_eq 0 "$(apply_calls)" "22b apply not run"
}

test_23_fix_with_merge_in_progress() {
  make_fixture t23
  enable_signing
  git -C "$REPO" rev-parse HEAD >"$(git_path MERGE_HEAD)"
  run_dsd fix
  assert_eq 1 "$RC" "23 exit 1"
  assert_line_start "$STDERR" "fix: resolve or abort the merge in $REPO" "23 merge instructions"
  assert_eq 0 "$(apply_calls)" "23 apply not run"
}

test_24_fix_without_operation_equals_check() {
  make_fixture t24
  enable_signing
  add_ahead
  run_dsd check
  check_out=$STDOUT
  check_rc=$RC
  run_dsd fix
  assert_eq "$check_out" "$STDOUT" "24 same stdout"
  assert_eq "$check_rc" "$RC" "24 same exit code"
  assert_eq 0 "$(apply_calls)" "24 apply not run"
}

# ---- other ---------------------------------------------------------------------------
test_25_unknown_subcommand() {
  make_fixture t25
  run_dsd nope
  assert_eq 2 "$RC" "25 exit 2"
  run_dsd check extra
  assert_eq 2 "$RC" "25 extra argument: exit 2"
}

test_26_no_signing_key_is_not_checked() {
  make_fixture t26
  enable_signing
  git -C "$REPO" config --unset user.signingkey
  add_ahead
  FAKE_SIGNER_MODE=fail run_dsd preflight
  assert_eq 0 "$RC" "26 preflight exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "26 preflight one warning line"
  assert_eq 0 "$(signer_calls)" "26 signer not called"
  run_dsd check
  assert_eq 0 "$RC" "26 check exit 0"
  assert_contains "$STDOUT" "signing: not checked" "26 check signing not checked"
}

test_27_unusable_tmpdir_is_not_checked() {
  make_fixture t27
  enable_signing
  add_ahead
  export FAKE_SIGNER_MODE=fail DSD_TMPDIR="$FX/no/such/tmpdir"
  run_dsd preflight
  assert_eq 0 "$RC" "27 preflight exit 0"
  assert_eq 1 "$(line_count "$STDERR")" "27 preflight one warning line"
  assert_eq 0 "$(signer_calls)" "27 signer not called"
  run_dsd check
  assert_contains "$STDOUT" "signing: not checked" "27 check signing not checked"
}

test_28_source_path_failure() {
  make_fixture t28
  enable_signing
  export STUB_SOURCE_PATH_FAIL=1
  run_dsd fix
  assert_eq 1 "$RC" "28 fix exit 1"
  assert_contains "$STDERR" "source-path" "28 fix warns"
  run_dsd check
  assert_eq 0 "$RC" "28 check exit 0"
  assert_contains "$STDOUT" "source repo: not found" "28 check shows it"
}

test_29_fix_stops_when_the_pick_commit_fails() {
  make_fixture t29
  enable_signing
  add_ahead
  add_behind
  stuck_rebase
  assert_exists "$(rebase_dir)" "29 setup: rebase is stopped"
  export FAKE_SIGNER_MODE=fail_after FAKE_SIGNER_FAIL_AFTER=1
  run_dsd fix
  assert_eq 1 "$RC" "29 exit 1"
  assert_exists "$(rebase_dir)" "29 rebase left in place"
  assert_line_start "$STDERR" "fix: dotfiles-sync-doctor fix" "29 fix line"
  assert_eq 0 "$(apply_calls)" "29 apply not run"
  assert_eq 2 "$(signer_calls)" "29 probe + commit -C"
}

test_30_term_during_apply() {
  make_fixture t30
  enable_signing
  add_ahead
  add_behind
  stuck_rebase
  export STUB_APPLY_SLEEP=5
  cd "$FX"
  PATH="$FX/bin:$BASE_PATH" TMPDIR="$FX/tmp" /bin/sh "$DSD" fix >"$FX/out" 2>"$FX/err" &
  dsd_pid=$!
  i=0
  while [[ ! -s "$STUB_APPLY_LOG" && $i -lt 100 ]]; do
    sleep 0.1
    i=$((i + 1))
  done
  kill -TERM "$dsd_pid"
  wait "$dsd_pid" && rc=0 || rc=$?
  assert_eq 143 "$rc" "30 exit 143"
  assert_line_start "$(cat "$FX/err")" "fix: chezmoi apply" "30 fix line"
  assert_no_file "$(rebase_dir)" "30 rebase finished"
}

# ---- hooks.update.pre in home/.chezmoi.toml.tmpl (real chezmoi) ---------------------------
# require_chezmoi <label>: the hook section needs the real chezmoi. A missing chezmoi is a SKIP locally, but a FAIL
# on CI, so that a broken chezmoi install cannot silently drop the hook checks.
require_chezmoi() {
  if [[ -n "$CHEZMOI_REAL" ]]; then return 0; fi
  if [[ "${CI:-}" == true ]]; then record "FAIL $1 (chezmoi not found on CI)"; else record "SKIP $1 (chezmoi not found)"; fi
  return 1
}
# make_hook_env <name> [stub-behaviour]: renders the config from the template into a throwaway HOME. The stub at
# $HOME/.local/bin/dotfiles-sync-doctor records its call and then behaves as asked: exit-N | term | noexec | none.
make_hook_env() {
  HK="$TMP_BASE/$1"
  HKHOME="$HK/home"
  HK_LOG="$HK/stub.log"
  mkdir -p "$HKHOME/.local/bin" "$HK/src"
  HK_CFG="$HK/chezmoi.toml"
  HOME="$HKHOME" "$CHEZMOI_REAL" execute-template <"$REPO_ROOT/home/.chezmoi.toml.tmpl" >"$HK_CFG"
  case "${2:-none}" in
  none) ;;
  exit-* | term | noexec)
    {
      printf '#!/bin/sh\n'
      printf 'echo "$@" >>%q\n' "$HK_LOG"
      case "$2" in
      exit-*) printf 'exit %s\n' "${2#exit-}" ;;
      term) printf 'kill -TERM $$\n' ;;
      noexec) printf 'exit 0\n' ;;
      esac
    } >"$HKHOME/.local/bin/dotfiles-sync-doctor"
    if [[ "$2" != noexec ]]; then chmod +x "$HKHOME/.local/bin/dotfiles-sync-doctor"; fi
    ;;
  esac
}
# run_update: `chezmoi update --apply=false` against an empty source; the hook runs first, and git fails after it
run_update() {
  HK_ERR=$(cd "$HK" && HOME="$HKHOME" PATH="$BASE_PATH:$(dirname "$CHEZMOI_REAL")" "$CHEZMOI_REAL" --config "$HK_CFG" --source "$HK/src" --destination "$HKHOME" --no-tty update --apply=false 2>&1 >/dev/null) && HK_RC=0 || HK_RC=$?
}
hook_ran() { if [[ -s "$HK_LOG" ]]; then echo yes; else echo no; fi; }

test_h1_hook_without_executable_lets_update_run() {
  require_chezmoi h1 || return 0
  make_hook_env h1 none
  run_update
  assert_eq no "$(hook_ran)" "h1 no stub call"
  assert_not_contains "$HK_ERR" "pre:" "h1 hook did not fail ($HK_ERR)"
}

test_h2_hook_with_non_executable_file_lets_update_run() {
  require_chezmoi h2 || return 0
  make_hook_env h2 noexec
  run_update
  assert_eq no "$(hook_ran)" "h2 no stub call"
  assert_not_contains "$HK_ERR" "pre:" "h2 hook did not fail ($HK_ERR)"
}

test_h3_hook_exit1_stops_update() {
  require_chezmoi h3 || return 0
  make_hook_env h3 exit-1
  run_update
  assert_eq yes "$(hook_ran)" "h3 stub called"
  assert_eq "preflight" "$(tr -d '\n' <"$HK_LOG")" "h3 called with preflight"
  if [[ "$HK_RC" -ne 0 ]]; then record "PASS h3 exit non-zero"; else record "FAIL h3 exit was 0"; fi
  assert_contains "$HK_ERR" "update: pre:" "h3 chezmoi aborted in pre"
}

test_h4_hook_other_statuses_warn_and_continue() {
  require_chezmoi h4 || return 0
  for behaviour in exit-2 exit-126 term; do
    make_hook_env "h4-$behaviour" "$behaviour"
    run_update
    assert_eq yes "$(hook_ran)" "h4 $behaviour: stub called"
    assert_not_contains "$HK_ERR" "pre:" "h4 $behaviour: update not stopped by the hook ($HK_ERR)"
    assert_eq 1 "$(printf '%s\n' "$HK_ERR" | grep -c 'dotfiles-sync-doctor: preflight ended')" "h4 $behaviour: one warning line"
  done
}

test_h5_hook_skip_env_bypasses() {
  require_chezmoi h5 || return 0
  make_hook_env h5 exit-1
  DOTFILES_SYNC_DOCTOR_SKIP=1 run_update
  assert_eq no "$(hook_ran)" "h5 stub not called"
  assert_contains "$HK_ERR" "skipped by DOTFILES_SYNC_DOCTOR_SKIP" "h5 skip notice"
  assert_not_contains "$HK_ERR" "pre:" "h5 update not stopped"
}

test_h6_hook_skip_requires_exact_one() {
  require_chezmoi h6 || return 0
  make_hook_env h6 exit-1
  DOTFILES_SYNC_DOCTOR_SKIP=0 run_update
  assert_eq yes "$(hook_ran)" "h6 stub called"
  assert_contains "$HK_ERR" "update: pre:" "h6 update stopped"
}

test_h7_rendered_config_has_the_hook() {
  require_chezmoi h7 || return 0
  make_hook_env h7 none
  assert_contains "$(cat "$HK_CFG")" "[hooks.update.pre]" "h7 rendered config has the table"
  cat_out=$(HOME="$HKHOME" "$CHEZMOI_REAL" --config "$HK_CFG" --source "$HK/src" --destination "$HKHOME" cat-config 2>&1) && cat_rc=0 || cat_rc=$?
  assert_eq 0 "$cat_rc" "h7 cat-config reads the config"
  assert_contains "$cat_out" "update" "h7 cat-config shows the hook"
}

# ---- runner -----------------------------------------------------------------------------
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
skip=$(grep -c '^SKIP' "$RESULTS_FILE" || true)
echo "PASS: $pass FAIL: $fail SKIP: $skip"
if [[ "$fail" -gt 0 ]]; then exit 1; fi
