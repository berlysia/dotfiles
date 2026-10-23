#!/usr/bin/env bash
# Process-level tests for scripts/format-staged.sh and its wiring in scripts/hooks/pre-commit.
# Every case runs in a throwaway git repo under mktemp -d; the real working tree is never
# touched, so unrelated uncommitted work in it cannot influence or be altered by the tests.
# shellcheck disable=SC2317,SC2016 # t_* are invoked dynamically; bash -c bodies are single-quoted on purpose
set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
TMP_BASE=$(mktemp -d -t format-staged-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT

# A leaked index/dir from a parent git process would redirect git in the fixtures.
unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE SKIP_HOOKS
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
check() { # check <description> <command...>
  local desc=$1
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}

# Same text before/after oxfmt: UNFMT changes under formatting, FMT does not.
UNFMT=$'#  Title\n\n*   item\n*   other\n'
FMT=$'# Title\n\n- item\n- other\n'
# Printed by format-staged.sh when it rewrote and re-staged a file.
RESTAGED_MARK='整形して stage し直した'

REPO=""
OUT=""
RC=0

# new_repo <name>: fresh fixture repo with the pieces format-staged.sh and the hook need.
# node_modules is a symlink to the real one so the pinned oxfmt runs without an install.
# lint-shell.sh is a stub: the hook calls it for every staged path and the real one
# needs mise-pinned shellcheck, which is not what these tests cover.
new_repo() {
  REPO="$TMP_BASE/$1"
  mkdir -p "$REPO/scripts/hooks" "$REPO/.skills/tanteki"
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name t
  cp "$REPO_ROOT/.oxfmtignore" "$REPO/.oxfmtignore"
  cat >"$REPO/package.json" <<'JSON'
{
  "name": "fixture",
  "private": true,
  "scripts": {
    "format:files": "oxfmt --ignore-path .oxfmtignore --no-error-on-unmatched-pattern",
    "lint:oxlint": "true"
  }
}
JSON
  ln -s "$REPO_ROOT/node_modules" "$REPO/node_modules"
  cp "$REPO_ROOT/scripts/format-staged.sh" "$REPO/scripts/format-staged.sh" 2>/dev/null || true
  cp "$REPO_ROOT/scripts/hooks/pre-commit" "$REPO/scripts/hooks/pre-commit"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$REPO/scripts/lint-shell.sh"
  chmod +x "$REPO/scripts/lint-shell.sh"
  printf '/node_modules\n' >"$REPO/.gitignore"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m base
}

# run_script: run format-staged.sh inside $REPO, capturing OUT and RC.
run_script() {
  OUT=$(cd "$REPO" && bash scripts/format-staged.sh 2>&1)
  RC=$?
}

# A PATH without gitleaks and codex, so the hook takes its skip branches for them.
hook_path() {
  local bin="$TMP_BASE/hookbin" t p
  if [ ! -d "$bin" ]; then
    mkdir -p "$bin"
    for t in git bun node jq bash sh env grep sed awk head tail cat sort tr cut wc dirname basename mkdir rm cp mktemp od date uname; do
      p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$bin/$t"
    done
  fi
  echo "$bin"
}

run_hook() {
  OUT=$(cd "$REPO" && PATH="$(hook_path)" bash scripts/hooks/pre-commit 2>&1)
  RC=$?
}

# --- state helpers (all relative to $REPO) ---
wt_hash() { git -C "$REPO" hash-object -- "$1"; }
idx_hash() { git -C "$REPO" rev-parse ":$1"; }
fmt_hash() { printf '%s' "$FMT" | git hash-object --stdin; }
unfmt_hash() { printf '%s' "$UNFMT" | git hash-object --stdin; }
put() { # put <path> <content>
  mkdir -p "$(dirname "$REPO/$1")"
  printf '%s' "$2" >"$REPO/$1"
}
stage() { git -C "$REPO" add -- "$@"; }
out_has() { printf '%s' "$OUT" | grep -qF -- "$1"; }
eq() { [ "$1" = "$2" ]; }

# partial_stage <path> <index content> <worktree content>
partial_stage() {
  put "$1" "$2"
  stage "$1"
  put "$1" "$3"
}

t01_full_formatted_unstaged_untouched() {
  new_repo t01
  put b.md "$FMT"; stage b.md; git -C "$REPO" commit -q -m b
  put b.md "$UNFMT"   # tracked file with an unstaged, unformatted edit
  put a.md "$UNFMT"; stage a.md
  local b_before; b_before=$(wt_hash b.md)
  run_script
  check "1 rc=0" eq "$RC" 0
  check "1 a.md worktree formatted" eq "$(wt_hash a.md)" "$(fmt_hash)"
  check "1 a.md index formatted" eq "$(idx_hash a.md)" "$(fmt_hash)"
  check "1 b.md byte-identical" eq "$(wt_hash b.md)" "$b_before"
}

t02_partial_index_violation_blocks() {
  new_repo t02
  partial_stage c.md "$UNFMT" "$UNFMT"$'\n*   extra\n'
  local w i; w=$(wt_hash c.md); i=$(idx_hash c.md)
  run_script
  check "2 rc=1" eq "$RC" 1
  check "2 output names c.md" out_has c.md
  check "2 worktree unchanged" eq "$(wt_hash c.md)" "$w"
  check "2 index unchanged" eq "$(idx_hash c.md)" "$i"
}

t03_partial_index_clean_unstaged_hunk_dirty() {
  new_repo t03
  partial_stage c.md "$FMT" "$FMT"$'\n*   extra\n'
  local w i; w=$(wt_hash c.md); i=$(idx_hash c.md)
  run_script
  check "3 rc=0" eq "$RC" 0
  check "3 worktree unchanged" eq "$(wt_hash c.md)" "$w"
  check "3 index unchanged" eq "$(idx_hash c.md)" "$i"
}

t04_mixed_full_and_partial() {
  new_repo t04
  put a.md "$UNFMT"; stage a.md
  partial_stage c.md "$UNFMT" "$UNFMT"$'\n*   extra\n'
  local w i; w=$(wt_hash c.md); i=$(idx_hash c.md)
  run_script
  check "4 rc=1" eq "$RC" 1
  check "4 a.md formatted in worktree" eq "$(wt_hash a.md)" "$(fmt_hash)"
  check "4 a.md formatted in index" eq "$(idx_hash a.md)" "$(fmt_hash)"
  check "4 c.md worktree unchanged" eq "$(wt_hash c.md)" "$w"
  check "4 c.md index unchanged" eq "$(idx_hash c.md)" "$i"
}

t05_unsupported_type() {
  new_repo t05
  put x.rules 'a   b'; stage x.rules
  run_script
  check "5 full-stage unsupported rc=0" eq "$RC" 0
  new_repo t05b
  partial_stage x.rules 'a   b' 'a   b changed'
  run_script
  check "5 partial-stage unsupported rc=0" eq "$RC" 0
}

t06_ignored_path() {
  new_repo t06
  put .skills/tanteki/z.md "$UNFMT"; stage .skills/tanteki/z.md
  local w; w=$(wt_hash .skills/tanteki/z.md)
  run_script
  check "6 full-stage ignored rc=0" eq "$RC" 0
  check "6 full-stage ignored not rewritten" eq "$(wt_hash .skills/tanteki/z.md)" "$w"
  new_repo t06b
  partial_stage .skills/tanteki/z.md "$UNFMT" "$UNFMT"$'\n*   extra\n'
  w=$(wt_hash .skills/tanteki/z.md); local i; i=$(idx_hash .skills/tanteki/z.md)
  run_script
  check "6 partial-stage ignored rc=0" eq "$RC" 0
  check "6 partial-stage ignored worktree unchanged" eq "$(wt_hash .skills/tanteki/z.md)" "$w"
  check "6 partial-stage ignored index unchanged" eq "$(idx_hash .skills/tanteki/z.md)" "$i"
}

t07_space_in_name() {
  new_repo t07
  put "d e.md" "$UNFMT"; stage "d e.md"
  run_script
  check "7 rc=0" eq "$RC" 0
  check "7 worktree formatted" eq "$(wt_hash 'd e.md')" "$(fmt_hash)"
  check "7 index formatted" eq "$(idx_hash 'd e.md')" "$(fmt_hash)"
}

t08_rename() {
  new_repo t08
  put r.md "$UNFMT"; stage r.md
  git -C "$REPO" commit -q -m r
  git -C "$REPO" mv r.md s.md
  run_script
  check "8 rc=0" eq "$RC" 0
  check "8 new path formatted in worktree" eq "$(wt_hash s.md)" "$(fmt_hash)"
  check "8 new path formatted in index" eq "$(idx_hash s.md)" "$(fmt_hash)"
}

t09_deleted_from_worktree() {
  new_repo t09
  put g.md "$UNFMT"; stage g.md
  rm -f "$REPO/g.md"
  local i; i=$(idx_hash g.md)
  run_script
  check "9 rc=1" eq "$RC" 1
  check "9 output names g.md" out_has g.md
  check "9 no file recreated" test ! -e "$REPO/g.md"
  check "9 index unchanged" eq "$(idx_hash g.md)" "$i"
}

t10_already_formatted_is_quiet() {
  new_repo t10
  put h.md "$FMT"; stage h.md
  run_script
  check "10 rc=0" eq "$RC" 0
  check "10 no restaged list" bash -c '! printf %s "$1" | grep -qF -- "$2"' _ "$OUT" "$RESTAGED_MARK"
}

t11_formatter_failure() {
  new_repo t11
  put i.md "$UNFMT"; stage i.md
  sed -i 's#"format:files": "[^"]*"#"format:files": "false"#' "$REPO/package.json"
  run_script
  check "11 rc=1" eq "$RC" 1
}

t11b_partial_syntax_error() {
  new_repo t11b
  partial_stage j.json '{"a":1,' '{"a":1,}'$'\n'
  run_script
  check "11b rc=1" eq "$RC" 1
  check "11b output names j.json" out_has j.json
}

t12_hook_formats_only_staged() {
  new_repo t12
  put b.md "$FMT"; git -C "$REPO" add b.md; git -C "$REPO" commit -q -m b
  put b.md "$UNFMT"   # tracked file with an unstaged, unformatted edit
  put a.md "$UNFMT"; stage a.md
  local b_before; b_before=$(wt_hash b.md)
  run_hook
  check "12 hook rc=0" eq "$RC" 0
  check "12 a.md formatted in index" eq "$(idx_hash a.md)" "$(fmt_hash)"
  check "12 b.md byte-identical" eq "$(wt_hash b.md)" "$b_before"
}

t13_hook_blocks_partial_violation() {
  new_repo t13
  partial_stage c.md "$UNFMT" "$UNFMT"$'\n*   extra\n'
  run_hook
  check "13 hook rc!=0" bash -c '[ "$1" -ne 0 ]' _ "$RC"
}

echo "format-staged tests"
for t in $(declare -F | awk '{print $3}' | grep -E '^t[0-9]+b?_' | sort); do
  echo "$t"
  "$t"
done

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
