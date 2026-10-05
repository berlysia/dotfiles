#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# Tests for git-worktree-cleanup. Every fixture lives in a throwaway directory under $TMP_BASE;
# the real repository is never touched. Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
CREATE="$REPO_ROOT/home/dot_local/bin/executable_git-worktree-create"
CLEANUP="$REPO_ROOT/home/dot_local/bin/executable_git-worktree-cleanup"
TMP_BASE=$(cd -P "$(mktemp -d -t gwc-test-XXXXXX)" && pwd -P)
: >"$TMP_BASE/pids"
cleanup_tmp() {
  while IFS= read -r pid; do kill "$pid" 2>/dev/null || true; done <"$TMP_BASE/pids"
  rm -rf "$TMP_BASE"
}
trap cleanup_tmp EXIT
# When started from a git hook, these variables would point fixtures at the real repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_SSH_COMMAND GIT_SSH GIT_ASKPASS GIT_PROXY_COMMAND GIT_EXEC_PATH
export GIT_CEILING_DIRECTORIES="$TMP_BASE" HOME="$TMP_BASE/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP_BASE/gitconfig" GIT_TERMINAL_PROMPT=0
# Not an agent-vm machine unless a test says so: inside one, the real helper would mount over the fixtures
export AGENT_VM_MARKER="$TMP_BASE/no-agent-vm"
mkdir -p "$HOME"
git config -f "$GIT_CONFIG_GLOBAL" user.name t
git config -f "$GIT_CONFIG_GLOBAL" user.email t@t
git config -f "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config -f "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config -f "$GIT_CONFIG_GLOBAL" advice.detachedHead false
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
SKIPPED=0
REAL_GIT=$(command -v git)

# ---- assert ----------------------------------------------------------------
record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac; }
assert_dir() { if [[ -d "$1" ]]; then record "PASS $2"; else record "FAIL $2 (missing dir: $1)"; fi; }
assert_no_dir() { if [[ ! -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (still exists: $1)"; fi; }
# "removed" means the directory is gone and git no longer lists it.
assert_removed() {
  local listed=no
  if git -C "$REPO" worktree list --porcelain | grep -qxF "worktree $1"; then listed=yes; fi
  if [[ ! -e "$1" && "$listed" == no ]]; then record "PASS $2"; else record "FAIL $2 (not removed: $1, listed: $listed)"; fi
}
assert_kept() { assert_dir "$1" "$2"; }

# ---- fixture -----------------------------------------------------------------
guard_tmp() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel)
  case "$top" in
    "$TMP_BASE/"*) ;;
    *) echo "refusing: $top is outside $TMP_BASE" >&2; exit 99 ;;
  esac
}

make_repo() {
  NAME=$1
  BASE="$TMP_BASE/$NAME"
  mkdir -p "$BASE"
  git init -q --bare "$BASE/origin.git"
  git clone -q "$BASE/origin.git" "$BASE/repo" 2>/dev/null
  git clone -q "$BASE/origin.git" "$BASE/merger" 2>/dev/null
  REPO=$(cd -P "$BASE/repo" && pwd -P)
  MERGER=$(cd -P "$BASE/merger" && pwd -P)
  guard_tmp "$REPO"
  guard_tmp "$MERGER"
  printf '%s\n' '.tmp/' '.entire/' 'node_modules/' >"$REPO/.gitignore"
  git -C "$REPO" add .gitignore
  git -C "$REPO" commit -qm init
  git -C "$REPO" push -q -u origin main 2>/dev/null
  git -C "$REPO" remote set-head origin -a >/dev/null
  git -C "$MERGER" fetch -q origin
  git -C "$MERGER" checkout -q -B main origin/main
}

# Create a worktree through the real git-worktree-create; prints its path.
wt() {
  (cd "$REPO" && bash "$CREATE" "$1" >/dev/null 2>&1)
  echo "$REPO/.git/worktree/$1"
}
commit_in() {
  printf '%s\n' "$2" >"$1/$2"
  git -C "$1" add -- "$2"
  git -C "$1" commit -qm "$2"
}
push_branch() { git -C "$1" push -q -u origin HEAD >/dev/null 2>&1; }
sync_repo() { git -C "$REPO" fetch -q --prune origin; }

merger_update() {
  git -C "$MERGER" fetch -q origin
  git -C "$MERGER" merge -q --ff-only origin/main
}
squash_merge() {
  merger_update
  git -C "$MERGER" merge -q --squash "origin/$1" >/dev/null 2>&1
  git -C "$MERGER" commit -qm "squash $1"
  git -C "$MERGER" push -q origin main 2>/dev/null
  git -C "$MERGER" push -q origin --delete "$1" 2>/dev/null
}
rebase_merge() {
  merger_update
  printf '%s\n' x >"$MERGER/merger-$1.txt"
  git -C "$MERGER" add -- "merger-$1.txt"
  git -C "$MERGER" commit -qm "merger-$1"
  local c
  for c in $(git -C "$MERGER" rev-list --reverse "origin/main..origin/$1"); do
    git -C "$MERGER" cherry-pick "$c" >/dev/null 2>&1
  done
  git -C "$MERGER" push -q origin main 2>/dev/null
  git -C "$MERGER" push -q origin --delete "$1" 2>/dev/null
}
ff_merge() {
  merger_update
  git -C "$MERGER" merge -q --ff-only "origin/$1"
  git -C "$MERGER" push -q origin main 2>/dev/null
  git -C "$MERGER" push -q origin --delete "$1" 2>/dev/null
}

# mk_pushed <branch> <ncommits>: worktree with n commits, pushed. Prints the path.
mk_pushed() {
  local d i
  d=$(wt "$1")
  i=1
  while [[ $i -le $2 ]]; do commit_in "$d" "$1-$i.txt"; i=$((i + 1)); done
  push_branch "$d"
  echo "$d"
}
# mk_squashed <branch> [ncommits]: pushed, then squash-merged on origin. Prints the path.
mk_squashed() {
  local d
  d=$(mk_pushed "$1" "${2:-2}")
  squash_merge "$1"
  echo "$d"
}

run_cleanup() {
  OUT=$(cd "$REPO" && bash "$CLEANUP" "$@" </dev/null 2>&1) && STATUS=0 || STATUS=$?
}
run_cleanup_in() {
  local dir=$1
  shift
  OUT=$(cd "$dir" && bash "$CLEANUP" "$@" </dev/null 2>&1) && STATUS=0 || STATUS=$?
}

# add_tmp <worktree> [n]: n ignored files under .tmp/sessions/x (default 1)
add_tmp() {
  local i=1
  mkdir -p "$1/.tmp/sessions/x"
  while [[ $i -le ${2:-1} ]]; do
    printf 'plan\n' >"$1/.tmp/sessions/x/plan-$i.md"
    i=$((i + 1))
  done
}
# tmp_id_of: the id in the first "--discard-tmp=<id>" of $OUT (empty when there is none)
tmp_id_of() { sed -n 's/.*--discard-tmp=\([0-9a-f]\{12\}\) .*/\1/p' <<<"$OUT" | head -n 1; }

# Runs inside a pipeline element (so the cd stays local): script(1) gives the cleanup a pty.
tty_run() {
  local log=$1
  shift
  cd "$REPO"
  if [[ "$(uname -s)" == Darwin ]]; then
    script -q "$log" bash "$CLEANUP" "$@"
  else
    timeout 60 script -qec "bash $(printf '%q ' "$CLEANUP" "$@")" "$log"
  fi
}
# run_cleanup_tty <answer> <before_answer_cmd> [args...]
# Waits for the prompt in the pty log, runs <before_answer_cmd>, then types <answer>.
run_cleanup_tty() {
  local answer=$1 before=$2 log i
  shift 2
  SKIPPED=0
  if ! command -v script >/dev/null 2>&1; then
    record "SKIP run_cleanup_tty (no script)"
    SKIPPED=1
    return 0
  fi
  log=$(mktemp "$TMP_BASE/tty.XXXXXX")
  set +e
  set +o pipefail
  {
    i=0
    while [[ $i -lt 100 ]] && ! grep -q 'Delete anyway' "$log" 2>/dev/null; do
      sleep 0.1
      i=$((i + 1))
    done
    if [[ -n "$before" ]]; then eval "$before"; fi
    printf '%s' "$answer"
    sleep 1
  } | tty_run "$log" "$@" >/dev/null 2>&1
  STATUS=${PIPESTATUS[1]}
  set -e -o pipefail
  OUT=$(cat "$log")
}

# hold_cwd <dir>: a background process whose cwd is <dir>; prints its pid.
hold_cwd() {
  (cd "$1" && exec sleep 60) >/dev/null 2>&1 </dev/null &
  local pid=$! i=0 seen=0 cwd
  echo "$pid" >>"$TMP_BASE/pids"
  while [[ $i -lt 50 && $seen -eq 0 ]]; do
    if [[ -d "/proc/$pid" ]]; then
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      if [[ "$cwd" == "$1" ]]; then seen=1; fi
    elif lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -qxF "n$1"; then
      seen=1
    fi
    if [[ $seen -eq 0 ]]; then sleep 0.1; fi
    i=$((i + 1))
  done
  echo "$pid"
}

# ---- 機能適合性 ----------------------------------------------------------------
test_C1() {
  make_repo c1
  local outer rc=0
  outer=$(wt fix/outer)
  (cd "$outer" && bash "$CREATE" fix/inner >/dev/null 2>&1) || rc=$?
  assert_eq 0 "$rc" "C1 exit"
  assert_dir "$REPO/.git/worktree/fix/inner" "C1 created under the main .git/worktree"
  assert_no_dir "$outer/.git/worktree" "C1 nothing created inside the outer worktree"
  assert_eq "fix/inner" "$(git -C "$REPO/.git/worktree/fix/inner" branch --show-current)" "C1 branch"
}

test_F1() {
  make_repo f1
  local d
  d=$(wt wip)
  commit_in "$d" wip-1.txt
  run_cleanup -n
  assert_kept "$d" "F1 kept"
  assert_contains "$OUT" "1 commits not on origin" "F1 reason"
  assert_eq 0 "$STATUS" "F1 exit"
}

test_F2() {
  make_repo f2
  local d
  d=$(wt wip)
  commit_in "$d" wip-1.txt
  run_cleanup --yes
  assert_kept "$d" "F2 kept"
  assert_contains "$OUT" "--yes does not answer this" "F2 message"
}

test_F3() {
  make_repo f3
  local d
  d=$(wt wip)
  commit_in "$d" wip-1.txt
  run_cleanup_tty y ""
  if [[ "$SKIPPED" == 1 ]]; then return 0; fi
  assert_removed "$d" "F3 removed"
  if git -C "$REPO" rev-parse --verify -q refs/heads/wip >/dev/null; then record "PASS F3 branch kept"; else record "FAIL F3 branch kept"; fi
}

test_F4() {
  make_repo f4
  local d
  d=$(mk_squashed sq 2)
  run_cleanup -n
  assert_removed "$d" "F4 removed"
  assert_contains "$OUT" "(squash)" "F4 how"
}

test_F5() {
  make_repo f5
  local d
  d=$(mk_pushed rb 2)
  rebase_merge rb
  run_cleanup -n
  assert_removed "$d" "F5 removed"
  assert_contains "$OUT" "(rebase)" "F5 how"
}

test_F6() {
  make_repo f6
  local d
  d=$(mk_pushed ff 1)
  ff_merge ff
  run_cleanup -n
  assert_removed "$d" "F6 removed"
  assert_contains "$OUT" "(ancestor)" "F6 how"
}

test_F7() {
  make_repo f7
  local d
  d=$(mk_pushed pushed 1)
  run_cleanup -n
  assert_kept "$d" "F7 kept"
  assert_contains "$OUT" "pushed but not merged" "F7 reason"
  run_cleanup_tty y ""
  if [[ "$SKIPPED" == 1 ]]; then return 0; fi
  assert_removed "$d" "F7 removed on tty y"
}

test_F7b() {
  make_repo f7b
  local d
  d=$(mk_pushed pushed 1)
  run_cleanup --yes
  assert_removed "$d" "F7b removed"
}

test_F8() {
  make_repo f8
  local d
  d=$(mk_squashed sq 2)
  printf 'more\n' >>"$d/sq-1.txt"
  run_cleanup --yes
  assert_kept "$d" "F8 kept"
  assert_contains "$OUT" "uncommitted changes" "F8 reason"
}

test_F9() {
  make_repo f9
  local d
  d=$(mk_squashed sq 2)
  printf 'x\n' >"$d/new.txt"
  run_cleanup --yes
  assert_kept "$d" "F9 kept"
  assert_contains "$OUT" "uncommitted changes" "F9 reason"
}

test_F10() {
  make_repo f10
  local d
  d=$(mk_squashed sq 2)
  mkdir -p "$d/.tmp/sessions/x"
  printf 'plan\n' >"$d/.tmp/sessions/x/plan.md"
  run_cleanup --yes
  assert_kept "$d" "F10 kept"
  assert_contains "$OUT" ".tmp/" "F10 mentions .tmp"
  assert_contains "$OUT" "(merged: squash)" "F10 merged note"
  assert_contains "$OUT" "answer y on a terminal" "F10 guidance"
  assert_contains "$OUT" "re-run with --discard-tmp=" "F10 next step"
  assert_contains "$OUT" "see the --discard-tmp command above" "F10 --yes answer points at it"
}

test_F11() {
  make_repo f11
  local d
  d=$(mk_squashed sq 2)
  mkdir -p "$d/node_modules"
  printf 'x\n' >"$d/node_modules/x"
  run_cleanup -n
  assert_removed "$d" "F11 removed"
}

test_F12() {
  make_repo f12
  local d
  d=$(wt fresh)
  run_cleanup --yes
  assert_kept "$d" "F12 kept"
  assert_contains "$OUT" "no commits since the worktree was created" "F12 reason"
}

reflog_all_same() {
  local head lines others
  head=$(git -C "$1" rev-parse HEAD)
  lines=$(git -C "$1" reflog show --format=%H HEAD -- 2>/dev/null || true)
  if [[ -z "$lines" ]]; then echo empty; return 0; fi
  others=$(printf '%s\n' "$lines" | grep -vc "^$head$" || true)
  echo "$others"
}
test_F12b() {
  make_repo f12b
  local fresh2 old rem det
  fresh2=$(wt fresh2)
  git -C "$REPO" switch -q -c old
  commit_in "$REPO" old-1.txt
  git -C "$REPO" push -q -u origin old >/dev/null 2>&1
  git -C "$REPO" switch -q main
  old=$(wt old)
  git -C "$MERGER" push -q origin main:remote-only 2>/dev/null
  sync_repo
  if git -C "$REPO" rev-parse --verify -q refs/remotes/origin/remote-only >/dev/null; then record "PASS F12b remote-only exists"; else record "FAIL F12b remote-only exists"; fi
  rem=$(wt remote-only)
  det="$REPO/.git/worktree/det"
  git -C "$REPO" worktree add -q --detach "$det" HEAD
  assert_eq 0 "$(reflog_all_same "$fresh2")" "F12b reflog fresh2"
  assert_eq 0 "$(reflog_all_same "$old")" "F12b reflog old"
  assert_eq 0 "$(reflog_all_same "$rem")" "F12b reflog remote-only"
  assert_eq 0 "$(reflog_all_same "$det")" "F12b reflog det"
  run_cleanup --yes
  assert_kept "$fresh2" "F12b fresh2 kept"
  assert_kept "$old" "F12b old kept"
  assert_kept "$rem" "F12b remote-only kept"
  assert_kept "$det" "F12b det kept"
  commit_in "$old" old-2.txt
  push_branch "$old"
  run_cleanup --yes
  assert_removed "$old" "F12b old removed after commit+push"
}

test_F12c() {
  make_repo f12c
  git -C "$REPO" switch -q -c base
  commit_in "$REPO" base-1.txt
  git -C "$REPO" push -q -u origin base >/dev/null 2>&1
  local d
  d=$(wt child)
  git -C "$REPO" switch -q main
  run_cleanup --yes
  assert_kept "$d" "F12c kept"
  assert_contains "$OUT" "no commits since the worktree was created" "F12c reason"
}

test_F13() {
  make_repo f13
  local d
  d=$(mk_squashed sq 2)
  printf 'more\n' >>"$d/sq-1.txt"
  git -C "$d" stash -q
  run_cleanup -n
  assert_removed "$d" "F13 removed"
  assert_eq 1 "$(git -C "$REPO" stash list | wc -l | tr -d ' ')" "F13 stash survives"
}

test_F14() {
  make_repo f14
  local a b
  a=$(mk_squashed a 2)
  b=$(mk_squashed b 2)
  run_cleanup -n a
  assert_removed "$a" "F14 a removed"
  assert_kept "$b" "F14 b kept"
  assert_eq 0 "$STATUS" "F14 exit"
}

test_F15() {
  make_repo f15
  local a b
  a=$(mk_squashed a 2)
  b=$(mk_squashed b 2)
  run_cleanup -n a
  run_cleanup -n "$b"
  assert_removed "$b" "F15 b removed by path"
  assert_eq 0 "$STATUS" "F15 exit 0"
  run_cleanup -n a
  assert_eq 1 "$STATUS" "F15 vanished target exit 1"
  assert_contains "$OUT" "Not a removable worktree: a" "F15 message"
  assert_contains "$OUT" "see 'git worktree list'" "F15 hint"
  [[ -n "$a" ]]
}

test_F16a() {
  make_repo f16a
  run_cleanup -n nosuch
  assert_eq 1 "$STATUS" "F16a exit"
  assert_contains "$OUT" "Not a removable worktree: nosuch" "F16a message"
}

test_F16b() {
  make_repo f16b
  local c
  c=$(mk_squashed c 2)
  run_cleanup -n c nosuch
  assert_eq 1 "$STATUS" "F16b exit"
  assert_kept "$c" "F16b c kept"
}

test_F17() {
  make_repo f17
  run_cleanup -n "$REPO"
  assert_eq 1 "$STATUS" "F17 exit"
  assert_contains "$OUT" "Refusing to remove the main worktree" "F17 message"
}

test_F18() {
  make_repo f18
  local d
  d=$(wt wip)
  commit_in "$d" wip-1.txt
  run_cleanup -n wip
  assert_kept "$d" "F18 kept"
  assert_eq 2 "$STATUS" "F18 exit"
}

test_F19() {
  make_repo f19
  local d="$BASE/outside"
  git -C "$REPO" worktree add -q -b out "$d"
  commit_in "$d" out-1.txt
  push_branch "$d"
  squash_merge out
  run_cleanup -n
  assert_kept "$d" "F19 kept"
  assert_contains "$OUT" "outside .git/worktree" "F19 message"
  assert_contains "$OUT" "outside .git/worktree 1" "F19 summary"
  run_cleanup -n out
  assert_removed "$d" "F19 removed by target"
}

test_F20() {
  make_repo f20
  run_cleanup --frobnicate
  assert_eq 1 "$STATUS" "F20 unknown option exit"
  assert_contains "$OUT" "Unknown option" "F20 unknown option message"
  run_cleanup help
  assert_eq 1 "$STATUS" "F20 help exit"
  assert_contains "$OUT" "Not a removable worktree: help" "F20 help as target"
}

test_F21() {
  make_repo f21
  local s w
  s=$(mk_squashed sq 2)
  w=$(wt wip)
  commit_in "$w" wip-1.txt
  run_cleanup -n
  assert_removed "$s" "F21 sq removed"
  assert_kept "$w" "F21 wip kept"
  assert_eq 0 "$STATUS" "F21 exit"
}

test_F22a() {
  make_repo f22a
  run_cleanup -h
  assert_eq 0 "$STATUS" "F22a exit"
  assert_contains "$OUT" "Usage" "F22a usage"
}

test_F22b() {
  make_repo f22b1
  local d
  d=$(mk_pushed pushed 1)
  run_cleanup --yes -n
  assert_kept "$d" "F22b --yes -n keeps"
  run_cleanup -n --yes
  assert_removed "$d" "F22b -n --yes removes"
  make_repo f22b2
  d=$(mk_pushed pushed2 1)
  run_cleanup -y
  assert_removed "$d" "F22b -y removes"
}

test_F23() {
  make_repo f23
  run_cleanup -n -- nosuch
  assert_eq 1 "$STATUS" "F23 exit"
  assert_contains "$OUT" "Not a removable worktree: nosuch" "F23 message"
}

test_F24() {
  make_repo f24
  local d
  d=$(mk_pushed ahead 1)
  commit_in "$d" ahead-2.txt
  run_cleanup --yes
  assert_kept "$d" "F24 kept"
  assert_contains "$OUT" "ahead of origin/ahead by 1 commits" "F24 reason"
}

test_F25() {
  make_repo f25
  local d
  d=$(mk_pushed det2 1)
  git -C "$d" switch -q --detach
  run_cleanup -n
  assert_kept "$d" "F25 kept"
  assert_contains "$OUT" "detached HEAD, not merged" "F25 reason"
  run_cleanup --yes
  assert_removed "$d" "F25 removed with --yes"
}

test_F26() {
  make_repo f26
  # git >= 2.48 re-creates origin/HEAD on fetch, which would hand the script a main branch
  git -C "$REPO" config remote.origin.followRemoteHEAD never
  git -C "$REPO" push -q origin main:trunk 2>/dev/null
  git -C "$BASE/origin.git" symbolic-ref HEAD refs/heads/trunk
  git -C "$REPO" push -q origin --delete main 2>/dev/null
  git -C "$REPO" remote set-head origin -d >/dev/null
  local d
  d=$(mk_pushed p26 1)
  run_cleanup -n
  assert_kept "$d" "F26 kept"
  assert_contains "$OUT" "no origin main branch to compare with" "F26 reason"
}

test_F27() {
  make_repo f27
  local d id
  d=$(mk_squashed sq 2)
  add_tmp "$d" 2
  mkdir -p "$d/node_modules/p"
  printf 'x\n' >"$d/node_modules/p/index.js"
  run_cleanup -n sq
  id=$(tmp_id_of)
  assert_kept "$d" "F27 kept"
  assert_eq 2 "$STATUS" "F27 exit"
  assert_eq 12 "${#id}" "F27 id is 12 hex digits"
  assert_contains "$OUT" "2 ignored files in .tmp/ or .entire/ (id $id):" "F27 count and id"
  assert_contains "$OUT" ".tmp/sessions/x/plan-1.md" "F27 lists file 1"
  assert_contains "$OUT" ".tmp/sessions/x/plan-2.md" "F27 lists file 2"
  assert_contains "$OUT" "re-run with --discard-tmp=$id sq," "F27 next step"
  assert_contains "$OUT" "other ignored paths that go with the worktree:" "F27 others heading"
  assert_contains "$OUT" "node_modules/" "F27 others listed"
}

test_F28() {
  make_repo f28
  local d
  d=$(mk_squashed sq 2)
  add_tmp "$d" 25
  run_cleanup -n sq
  assert_contains "$OUT" "25 ignored files in .tmp/ or .entire/" "F28 count"
  assert_contains "$OUT" "... and 5 more" "F28 cut at 20"
  rm "$d"/.tmp/sessions/x/plan-2[1-5].md
  run_cleanup -n sq
  assert_contains "$OUT" "20 ignored files in .tmp/ or .entire/" "F28 count at the limit"
  assert_not_contains "$OUT" "more" "F28 no cut at 20"
}

test_F29() {
  make_repo f29
  local d
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  run_cleanup_tty y "" sq
  if [[ "$SKIPPED" == 1 ]]; then return 0; fi
  assert_removed "$d" "F29 removed on tty y"
  assert_contains "$OUT" ".tmp/sessions/x/plan-1.md" "F29 lists before the prompt"
}

test_F30() {
  make_repo f30
  local d id
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  run_cleanup -n sq
  id=$(tmp_id_of)
  run_cleanup -n "--discard-tmp=$id" sq
  assert_removed "$d" "F30 removed"
  assert_eq 0 "$STATUS" "F30 exit"
  assert_contains "$OUT" "[--discard-tmp=$id]" "F30 answer"
  assert_contains "$OUT" ".tmp/sessions/x/plan-1.md" "F30 record of what was discarded"
}

test_F31() {
  make_repo f31
  local d id
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  run_cleanup -n sq
  id=$(tmp_id_of)
  run_cleanup "--discard-tmp=$id"
  assert_eq 1 "$STATUS" "F31 exit without a target"
  assert_kept "$d" "F31 kept without a target"
  assert_contains "$OUT" "--discard-tmp needs the worktrees named as targets" "F31 message"
  run_cleanup --discard-tmp=xyz sq
  assert_eq 1 "$STATUS" "F31 exit with a malformed id"
  assert_contains "$OUT" "--discard-tmp needs the id printed with the worktree's file list" "F31 malformed message"
  run_cleanup --discard-tmp sq
  assert_eq 1 "$STATUS" "F31 exit without an id"
  assert_kept "$d" "F31 kept"
}

test_F32() {
  make_repo f32
  local d
  d=$(mk_pushed pushed 1)
  add_tmp "$d" 1
  run_cleanup --yes --discard-tmp=0123456789ab pushed
  assert_kept "$d" "F32 unmerged kept"
  assert_eq 2 "$STATUS" "F32 exit"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F32 no id offered"
  assert_not_contains "$OUT" "(y/N) y" "F32 nothing answered yes"
}

test_F33() {
  make_repo f33
  local d
  d=$(wt fresh)
  add_tmp "$d" 1
  run_cleanup -n --discard-tmp=0123456789ab fresh
  assert_kept "$d" "F33 just created kept"
  assert_eq 2 "$STATUS" "F33 exit"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F33 no id offered"
}

test_F34() {
  make_repo f34
  local d id
  d=$(mk_squashed sq 2)
  mkdir -p "$d/.entire"
  printf 'x\n' >"$d/.entire/log"
  run_cleanup -n sq
  id=$(tmp_id_of)
  assert_contains "$OUT" ".entire/log" "F34 lists .entire"
  run_cleanup -n "--discard-tmp=$id" sq
  assert_removed "$d" "F34 removed"
}

test_F35() {
  make_repo f35
  local a b wip ida idb
  a=$(mk_squashed sq-a 2)
  b=$(mk_squashed sq-b 2)
  add_tmp "$a" 1
  add_tmp "$b" 1
  wip=$(wt wip)
  commit_in "$wip" wip-1.txt
  run_cleanup -n sq-a sq-b
  ida=$(sed -n 's/.*--discard-tmp=\([0-9a-f]\{12\}\) sq-a,.*/\1/p' <<<"$OUT")
  idb=$(sed -n 's/.*--discard-tmp=\([0-9a-f]\{12\}\) sq-b,.*/\1/p' <<<"$OUT")
  if [[ "$ida" != "$idb" ]]; then record "PASS F35 ids differ per worktree"; else record "FAIL F35 ids differ per worktree ($ida)"; fi
  run_cleanup -n "--discard-tmp=$ida" sq-a sq-b wip
  assert_removed "$a" "F35 sq-a removed"
  assert_kept "$b" "F35 sq-b kept: its id was not given"
  assert_kept "$wip" "F35 wip kept"
  assert_eq 2 "$STATUS" "F35 exit"
  assert_contains "$OUT" "no --discard-tmp id matches this list" "F35 mismatch message"
  run_cleanup -n "--discard-tmp=$ida" "--discard-tmp=$idb" sq-b
  assert_removed "$b" "F35 sq-b removed with its own id among several"
}

test_F36() {
  make_repo f36
  local d id
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  run_cleanup -n sq
  id=$(tmp_id_of)
  printf 'later\n' >"$d/.tmp/sessions/x/later.md"
  run_cleanup -n "--discard-tmp=$id" sq
  assert_kept "$d" "F36 kept: a file was added after the id was printed"
  assert_eq 2 "$STATUS" "F36 exit"
  assert_contains "$OUT" "no --discard-tmp id matches this list" "F36 message"
  assert_contains "$OUT" ".tmp/sessions/x/later.md" "F36 lists the new file"
}

test_F37() {
  make_repo f37
  local d id
  d=$(mk_pushed ff 1)
  ff_merge ff
  add_tmp "$d" 1
  run_cleanup -n ff
  id=$(tmp_id_of)
  assert_contains "$OUT" "(merged: ancestor)" "F37 how"
  run_cleanup -n "--discard-tmp=$id" ff
  assert_removed "$d" "F37 ancestor with its own commit removed"
}

test_F38() {
  make_repo f38
  local d
  d=$(wt plan-only)
  mk_pushed other 1 >/dev/null
  ff_merge other
  sync_repo
  git -C "$d" merge -q --ff-only origin/main
  add_tmp "$d" 1
  run_cleanup -n --discard-tmp=0123456789ab plan-only
  assert_kept "$d" "F38 fast-forwarded worktree with only a plan kept"
  assert_contains "$OUT" "(merged: ancestor)" "F38 how"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F38 no id offered"
}

test_F40() {
  make_repo f40
  local d
  d=$(mk_pushed ff 1)
  ff_merge ff
  mk_pushed other 1 >/dev/null
  squash_merge other
  sync_repo
  git -C "$d" reset -q --hard origin/main
  add_tmp "$d" 1
  run_cleanup -n --discard-tmp=0123456789ab ff
  assert_kept "$d" "F40 kept: reset to main after its commit, then only a plan"
  assert_contains "$OUT" "(merged: ancestor)" "F40 how"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F40 no id offered"
}

test_F41() {
  make_repo f41
  local d
  d=$(wt mine)
  mk_pushed other 2 >/dev/null
  sync_repo
  git -C "$d" merge -q --ff-only origin/other
  squash_merge other
  add_tmp "$d" 1
  run_cleanup -n --discard-tmp=0123456789ab mine
  assert_kept "$d" "F41 kept: fast-forwarded to someone else's branch, then only a plan"
  assert_contains "$OUT" "(merged: squash), but its tip was not made in this worktree" "F41 how and why no id"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F41 no id offered"
}

test_F44() {
  make_repo f44
  local d
  d=$(wt mine)
  mk_pushed other 2 >/dev/null
  sync_repo
  # What a plain "git merge" does under merge.ff=false: a merge commit even where a fast-forward was possible.
  git -C "$d" merge -q --no-ff -m "merge other" origin/other
  squash_merge other
  add_tmp "$d" 1
  run_cleanup -n --discard-tmp=0123456789ab mine
  assert_kept "$d" "F44 kept: a merge commit over someone else's branch, then only a plan"
  assert_contains "$OUT" "but its tip was not made in this worktree" "F44 why no id"
  assert_not_contains "$OUT" "re-run with --discard-tmp=" "F44 no id offered"
}

test_F45() {
  make_repo f45
  local d id
  d=$(mk_pushed topic 1)
  mk_pushed other 1 >/dev/null
  squash_merge other
  sync_repo
  git -C "$d" merge -q --no-ff -m "merge main" origin/main
  push_branch "$d"
  squash_merge topic
  add_tmp "$d" 1
  run_cleanup -n topic
  id=$(tmp_id_of)
  assert_eq 12 "${#id}" "F45 id offered: main merged into the worktree's own commit"
  run_cleanup -n "--discard-tmp=$id" topic
  assert_removed "$d" "F45 removed"
}

test_F46() {
  make_repo f46
  local d id
  d=$(mk_pushed topic 1)
  mk_pushed other 1 >/dev/null
  squash_merge other
  git -C "$d" pull -q --rebase origin main 2>/dev/null
  git -C "$d" push -q -f origin HEAD 2>/dev/null
  squash_merge topic
  add_tmp "$d" 1
  run_cleanup -n topic
  id=$(tmp_id_of)
  assert_eq 12 "${#id}" "F46 id offered: the tip was replayed by git pull --rebase in this worktree"
}

test_F42() {
  make_repo f42
  local d id
  d=$(mk_pushed topic 2)
  mk_pushed other 1 >/dev/null
  ff_merge other
  sync_repo
  git -C "$d" rebase -q origin/main
  git -C "$d" push -q -f origin HEAD 2>/dev/null
  squash_merge topic
  add_tmp "$d" 1
  run_cleanup -n topic
  id=$(tmp_id_of)
  assert_eq 12 "${#id}" "F42 id offered: the tip was replayed by a rebase in this worktree"
  run_cleanup -n "--discard-tmp=$id" topic
  assert_removed "$d" "F42 removed"
}

# shellcheck disable=SC2016 # the branch name holds a literal $( ) on purpose
test_F39() {
  make_repo f39
  local d id
  d=$(mk_squashed 'we$(id)rd' 2)
  add_tmp "$d" 1
  printf 'x\n' >"$d/.tmp/日本語.md"
  run_cleanup -n 'we$(id)rd'
  id=$(tmp_id_of)
  assert_contains "$OUT" "re-run with --discard-tmp=$id we\\\$\\(id\\)rd," "F39 branch name quoted for the shell"
  assert_contains "$OUT" ".tmp/日本語.md" "F39 non-ASCII name readable"
}

test_F43() {
  make_repo f43
  local d
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  printf 'x\n' >"$d/.tmp/note re-run with --discard-tmp=0123456789ab other, now.md"
  run_cleanup -n sq
  assert_contains "$OUT" "     | .tmp/sessions/x/plan-1.md" "F43 every listed name follows a bar"
  assert_contains "$OUT" "     | .tmp/note\\ re-run\\ with\\ --discard-tmp=0123456789ab\\ other\\,\\ now.md" "F43 a name with blanks is shell-quoted"
  assert_eq 1 "$(grep -c 're-run with --discard-tmp=' <<<"$OUT")" "F43 one line reads as the command to re-run"
}

# ---- 信頼性 ----------------------------------------------------------------------
test_R1() {
  make_repo r1
  local p f
  p=$(mk_pushed pushed 1)
  f=$(mk_pushed ff 1)
  ff_merge ff
  sync_repo
  git -C "$REPO" remote set-url origin "$BASE/missing.git"
  run_cleanup --yes
  assert_kept "$p" "R1 pushed kept"
  assert_contains "$OUT" "Could not fetch origin" "R1 offline notice"
  assert_contains "$OUT" "[--yes, offline]" "R1 offline answer"
  assert_removed "$f" "R1 ff removed"
  run_cleanup --yes pushed
  assert_eq 2 "$STATUS" "R1 target exit 2"
}

test_R2() {
  make_repo r2
  local lk after
  lk=$(mk_squashed lk 2)
  after=$(mk_squashed after 2)
  git -C "$REPO" worktree lock --reason test "$lk"
  run_cleanup -n
  assert_kept "$lk" "R2 lk kept"
  assert_contains "$OUT" "locked" "R2 reason"
  assert_removed "$after" "R2 after removed"
}

test_R3() {
  make_repo r3
  local d
  d=$(mk_squashed held 2)
  hold_cwd "$d" >/dev/null
  run_cleanup -n
  assert_kept "$d" "R3 kept"
  assert_contains "$OUT" "in use" "R3 reason"
}

test_R4() {
  make_repo r4
  local d
  d=$(mk_squashed here 2)
  run_cleanup_in "$d" -n
  assert_kept "$d" "R4 kept"
  assert_contains "$OUT" "in use" "R4 reason"
}

test_R5() {
  make_repo r5
  local d="$BASE/with space"
  git -C "$REPO" worktree add -q -b sp "$d"
  commit_in "$d" sp-1.txt
  push_branch "$d"
  squash_merge sp
  run_cleanup -n "$d"
  assert_removed "$d" "R5 removed"
}

test_R6() {
  make_repo r6
  local d="$REPO/-x"
  git -C "$REPO" worktree add -q -b dash "$d"
  commit_in "$d" dash-1.txt
  push_branch "$d"
  squash_merge dash
  run_cleanup_in "$REPO" -n -- -x
  assert_removed "$d" "R6 removed"
}

test_R7() {
  make_repo r7
  local d="$REPO/.git/worktree-x"
  git -C "$REPO" worktree add -q -b wx "$d"
  commit_in "$d" wx-1.txt
  push_branch "$d"
  squash_merge wx
  run_cleanup -n
  assert_kept "$d" "R7 kept"
  assert_contains "$OUT" "outside .git/worktree" "R7 message"
}

test_R8() {
  make_repo r8
  local l1 l2
  l1=$(mk_squashed l1 2)
  l2=$(mk_squashed l2 2)
  ln -s "$l1" "$BASE/link"
  run_cleanup -n "$BASE/link"
  assert_removed "$l1" "R8 linked worktree removed"
  assert_kept "$l2" "R8 other kept"
}

test_R9() {
  make_repo r9
  local d
  d=$(mk_pushed pushed 1)
  run_cleanup_tty y "touch $d/late.txt" pushed
  if [[ "$SKIPPED" == 1 ]]; then return 0; fi
  assert_kept "$d" "R9 kept"
  assert_contains "$OUT" "state changed since the check" "R9 message"
  assert_eq 2 "$STATUS" "R9 exit"
}

test_R10() {
  make_repo r10
  local a b
  a=$(mk_squashed wt 2)
  b=$(mk_squashed wt-foo 2)
  hold_cwd "$b" >/dev/null
  run_cleanup -n
  assert_removed "$a" "R10 wt removed"
  assert_kept "$b" "R10 wt-foo kept"
}

test_R11() {
  if [[ "$(uname -s)" != Darwin ]]; then
    record "SKIP R11 (cwd detection uses /proc on this OS)"
    return 0
  fi
  make_repo r11
  local a b
  a=$(mk_squashed rs 2)
  b=$(mk_squashed rd 2)
  printf 'more\n' >>"$b/rd-1.txt"
  mkdir -p "$TMP_BASE/stub-bin"
  printf '#!/bin/sh\nexit 1\n' >"$TMP_BASE/stub-bin/lsof"
  chmod +x "$TMP_BASE/stub-bin/lsof"
  PATH="$TMP_BASE/stub-bin:$PATH" run_cleanup -n
  assert_kept "$a" "R11 rs kept"
  assert_kept "$b" "R11 rd kept"
  assert_contains "$OUT" "cannot detect whether it is in use" "R11 reason"
  assert_contains "$OUT" "uncommitted changes" "R11 dirty not skipped"
}

test_R12() {
  make_repo r12
  local a b
  a=$(mk_squashed r1 2)
  b=$(mk_squashed r2 2)
  mkdir -p "$TMP_BASE/stub-git"
  {
    printf '#!/bin/bash\n'
    printf 'case " $* " in *" worktree remove "*) echo "fatal: stub refusal" >&2; exit 128 ;; esac\n'
    printf 'exec %q "$@"\n' "$REAL_GIT"
  } >"$TMP_BASE/stub-git/git"
  chmod +x "$TMP_BASE/stub-git/git"
  PATH="$TMP_BASE/stub-git:$PATH" run_cleanup -n r1 r2
  assert_kept "$a" "R12 r1 kept"
  assert_kept "$b" "R12 r2 kept"
  assert_contains "$OUT" "git refused to remove it" "R12 message"
  assert_contains "$OUT" "stub refusal" "R12 git stderr"
  assert_eq 2 "$STATUS" "R12 exit"
}

test_R13() {
  make_repo r13
  local d id
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  sync_repo
  git -C "$REPO" remote set-url origin "$BASE/missing.git"
  run_cleanup -n sq
  id=$(tmp_id_of)
  run_cleanup -n "--discard-tmp=$id" sq
  assert_contains "$OUT" "Could not fetch origin" "R13 offline notice"
  assert_removed "$d" "R13 removed offline"
}

test_R15() {
  make_repo r15
  local d
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  git config -f "$GIT_CONFIG_GLOBAL" status.showUntrackedFiles no
  run_cleanup -n
  git config -f "$GIT_CONFIG_GLOBAL" --unset status.showUntrackedFiles
  assert_kept "$d" "R15 kept: .tmp/ is seen with status.showUntrackedFiles=no"
  assert_contains "$OUT" ".tmp/sessions/x/plan-1.md" "R15 lists the file"
}

test_R14() {
  make_repo r14
  local d
  d=$(mk_squashed sq 2)
  add_tmp "$d" 1
  run_cleanup_tty y "printf 'late\n' >$d/.tmp/sessions/x/late.md" sq
  if [[ "$SKIPPED" == 1 ]]; then return 0; fi
  assert_kept "$d" "R14 kept: a file was added while the prompt waited"
  assert_contains "$OUT" "state changed since the check" "R14 message"
  assert_eq 2 "$STATUS" "R14 exit"
}

# ---- agent-vm（ADR-0022） ------------------------------------------------------------
# nm_helper_stub <status>: an agent-vm-node-modules in $TMP_BASE/nm-bin that logs each argument on its own line.
# With 0 it runs the command after "remove <wt> --", as the real helper does; otherwise it prints a reason and exits
# with the status without running anything.
# A second argument is a warning it prints on stderr before running the command (with status 0 only).
# $TMP_BASE is shared by every test, so each call starts a fresh log.
nm_helper_stub() {
  mkdir -p "$TMP_BASE/nm-bin"
  rm -f "$TMP_BASE/nm.log"
  {
    printf '#!/bin/bash\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$TMP_BASE/nm.log"
    printf 'if [ %d -ne 0 ]; then echo "agent-vm-node-modules: stub status %d" >&2; exit %d; fi\n' "$1" "$1" "$1"
    if [[ -n "${2:-}" ]]; then printf 'echo %q >&2\n' "$2"; fi
    printf 'shift 3\nexec "$@"\n'
  } >"$TMP_BASE/nm-bin/agent-vm-node-modules"
  chmod +x "$TMP_BASE/nm-bin/agent-vm-node-modules"
  : >"$TMP_BASE/vm-marker"
}
# run_cleanup_vm [args...]: run_cleanup as inside an agent-vm machine with the stub helper
run_cleanup_vm() {
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" PATH="$TMP_BASE/nm-bin:$PATH" run_cleanup "$@"
}

test_N1() {
  make_repo n1
  local d
  d=$(mk_squashed n1 2)
  nm_helper_stub 0
  run_cleanup_vm -n n1
  assert_removed "$d" "N1 removed through the helper"
  assert_eq "$(printf '%s\n' remove "$d" -- git -C "$REPO" worktree remove -- "$d")" "$(cat "$TMP_BASE/nm.log")" "N1 remove <wt> -- git -C <main> worktree remove -- <wt>"
  assert_eq 0 "$STATUS" "N1 exit"
}
test_N2() {
  make_repo n2
  local d
  d=$(mk_squashed n2 2)
  nm_helper_stub 70
  run_cleanup_vm -n n2
  assert_kept "$d" "N2 kept"
  assert_contains "$OUT" "could not detach its VM-local node_modules: agent-vm-node-modules: stub status 70 - skipping" "N2 message with the helper's output"
  assert_eq 2 "$STATUS" "N2 exit"
}
test_N3() {
  make_repo n3
  local d
  d=$(mk_squashed n3 2)
  nm_helper_stub 71
  run_cleanup_vm -n n3
  assert_kept "$d" "N3 kept"
  assert_contains "$OUT" "another node_modules sync held the lock (try again)" "N3 message"
  assert_eq 2 "$STATUS" "N3 exit"
}
test_N4() {
  make_repo n4
  local d
  d=$(mk_squashed n4 2)
  nm_helper_stub 64
  run_cleanup_vm -n n4
  assert_kept "$d" "N4 kept, git is not run directly"
  assert_contains "$OUT" "the node_modules helper refused it" "N4 message"
  assert_eq 2 "$STATUS" "N4 exit"
}
test_N5() {
  make_repo n5
  local d
  d=$(mk_squashed n5 2)
  nm_helper_stub 0
  mkdir -p "$TMP_BASE/stub-git"
  {
    printf '#!/bin/bash\n'
    printf 'case " $* " in *" worktree remove "*) echo "fatal: stub refusal" >&2; exit 128 ;; esac\n'
    printf 'exec %q "$@"\n' "$REAL_GIT"
  } >"$TMP_BASE/stub-git/git"
  chmod +x "$TMP_BASE/stub-git/git"
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" PATH="$TMP_BASE/nm-bin:$TMP_BASE/stub-git:$PATH" run_cleanup -n n5
  assert_kept "$d" "N5 kept"
  assert_contains "$OUT" "git refused to remove it: fatal: stub refusal" "N5 git's refusal through the helper"
  assert_eq 2 "$STATUS" "N5 exit"
}
test_N6() {
  if command -v agent-vm-node-modules >/dev/null 2>&1; then
    record "SKIP N6 (agent-vm-node-modules is on the PATH of this machine)"; return 0
  fi
  make_repo n6
  local d
  d=$(mk_squashed n6 2)
  : >"$TMP_BASE/vm-marker"
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" run_cleanup -n n6
  assert_removed "$d" "N6 inside a machine without the helper, git removes it as before"
  assert_eq 0 "$STATUS" "N6 exit"
}
test_N7() {
  make_repo n7
  local d
  d=$(mk_squashed n7 2)
  nm_helper_stub 0
  PATH="$TMP_BASE/nm-bin:$PATH" run_cleanup -n n7
  assert_removed "$d" "N7 on the host, git removes it as before"
  assert_no_dir "$TMP_BASE/nm.log" "N7 the helper is not called on the host"
}
test_N8() {
  make_repo n8
  local d="$BASE/outside"
  git -C "$REPO" worktree add -q -b out "$d"
  commit_in "$d" out-1.txt
  push_branch "$d"
  squash_merge out
  nm_helper_stub 0
  run_cleanup_vm -n out
  assert_removed "$d" "N8 a worktree outside .git/worktree is removed when named"
  assert_no_dir "$TMP_BASE/nm.log" "N8 without the helper, which owns no mounts there"
}
test_N9() {
  make_repo n9
  local d
  d=$(mk_squashed n9 2)
  nm_helper_stub 0 "agent-vm-node-modules: could not delete the store 0123456789abcdef; the next sync deletes it"
  run_cleanup_vm -n n9
  assert_removed "$d" "N9 removed"
  assert_contains "$OUT" "could not delete the store 0123456789abcdef; the next sync deletes it" "N9 the helper's warning after a removal is shown"
  assert_eq 0 "$STATUS" "N9 exit"
}

# ---- 使用性 ------------------------------------------------------------------------
test_U1() {
  make_repo u1
  local wip pushed sq fresh tmpd
  wip=$(wt wip)
  commit_in "$wip" wip-1.txt
  pushed=$(mk_pushed pushed 1)
  sq=$(mk_squashed sq 2)
  fresh=$(wt fresh)
  tmpd=$(mk_squashed tmpd 2)
  mkdir -p "$tmpd/.tmp"
  printf 'x\n' >"$tmpd/.tmp/note"
  run_cleanup --yes
  assert_kept "$wip" "U1 wip kept"
  assert_removed "$pushed" "U1 pushed removed"
  assert_removed "$sq" "U1 sq removed"
  assert_kept "$fresh" "U1 fresh kept"
  assert_kept "$tmpd" "U1 tmpd kept"
}

test_U2() {
  make_repo u2
  run_cleanup --help
  assert_eq 0 "$STATUS" "U2 exit"
  assert_contains "$OUT" "answers only the questions about worktrees whose commits are all on origin" "U2 --yes scope"
  assert_contains "$OUT" "Branches are not deleted" "U2 branches"
  assert_contains "$OUT" "Assumes the remote is named origin" "U2 origin"
  assert_contains "$OUT" "removed only when named as a target" "U2 outside"
  assert_contains "$OUT" "removes nothing more than --non-interactive" "U2 offline"
  assert_contains "$OUT" "Exit codes" "U2 exit codes section"
  assert_contains "$OUT" "  2  " "U2 exit code 2"
  assert_contains "$OUT" "--discard-tmp=<id>" "U2 discard-tmp"
}

test_U3() {
  make_repo u3
  local d
  d=$(wt keep)
  run_cleanup -n keep nosuch
  assert_eq 1 "$STATUS" "U3 exit"
  assert_kept "$d" "U3 keep kept"
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
  if [[ $rc -eq 99 ]]; then exit 99; fi
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
