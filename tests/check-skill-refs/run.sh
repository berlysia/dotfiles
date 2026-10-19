#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# shellcheck disable=SC2016 # backticks in single quotes are literal markdown text
# Tests for .github/scripts/check-skill-refs.sh. Every fixture is built per case in a throwaway
# directory; nothing reaches the network or the real home directory.
# Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/check-skill-refs.sh"
TMP_BASE=$(cd -P "$(mktemp -d -t skill-refs-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"

record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2 / in: $1)" ;; esac; }

CASE_N=0
CASE=""
S=""
STDERR=""
RC=0

new_case() {
  CASE_N=$((CASE_N + 1))
  CASE="$TMP_BASE/c$CASE_N"
  S="$CASE/skills"
  mkdir -p "$S"
}

# skill <name> [body]: SKILL.md of <name> with the body (default empty)
skill() {
  mkdir -p "$S/$1"
  printf '# %s\n\n%s\n' "$1" "${2:-}" >"$S/$1/SKILL.md"
}

# file <rel path> [body]: any file under skills, parents created
file() {
  mkdir -p "$(dirname "$S/$1")"
  printf '%s\n' "${2:-}" >"$S/$1"
}

run() {
  RC=0
  STDERR=$(bash "$SCRIPT" "$@" 2>&1 >/dev/null) || RC=$?
}
run_s() { run "$S" "$@"; }
lines() { if [[ -z "$STDERR" ]]; then printf 0; else printf '%s\n' "$STDERR" | wc -l | tr -d ' '; fi; }

# ---- usage ---------------------------------------------------------------------------------------
test_current_skills_pass() {
  run "$REPO_ROOT/.skills"
  assert_eq 0 "$RC" "current .skills exits 0 ($STDERR)"
}
test_usage_errors() {
  new_case
  run
  assert_eq 2 "$RC" "no argument exits 2"
  run "$CASE/nonexistent"
  assert_eq 2 "$RC" "missing dir exits 2"
  : >"$CASE/afile"
  run "$CASE/afile"
  assert_eq 2 "$RC" "a file exits 2"
  run "$S" --names-from "$CASE/nonexistent"
  assert_eq 2 "$RC" "missing --names-from dir exits 2"
  run "$S" --bogus
  assert_eq 2 "$RC" "unknown option exits 2"
}

# ---- (1) existence -------------------------------------------------------------------------------
test_missing_ref() {
  new_case
  skill a 'see ../missing/SKILL.md'
  run_s
  assert_eq 1 "$RC" "missing ref exits 1"
  assert_contains "$STDERR" '../missing/SKILL.md' "missing ref is named"
}
test_two_missing_refs() {
  new_case
  skill a $'../missing1/SKILL.md\n`../missing2/SKILL.md`'
  run_s
  assert_eq 1 "$RC" "two missing refs exit 1"
  assert_eq 2 "$(lines)" "two missing refs print two lines"
}
test_existing_ref_non_role() {
  new_case
  skill pr-description 'see [x](../japanese-tech-writing/SKILL.md).'
  skill japanese-tech-writing
  run_s
  assert_eq 0 "$RC" "non-role skill may reference anything ($STDERR)"
}
test_ellipsis_not_ref() {
  new_case
  skill a 'gh api repos/.../environments/<ENV>'
  run_s
  assert_eq 0 "$RC" "repos/.../environments is not a reference ($STDERR)"
}
test_ref_through_symlink() {
  new_case
  skill a 'x ../tanteki/node_modules/kuromojin'
  skill tanteki
  ln -s ../../../.config/textlint/node_modules "$S/tanteki/node_modules"
  run_s
  assert_eq 1 "$RC" "ref through symlink exits 1"
  assert_contains "$STDERR" 'symlink' "ref through symlink is reported"
}

# ---- (2) role allowlist --------------------------------------------------------------------------
test_role_to_fact_preservation() {
  new_case
  skill ja-x 'see ../ja-fact-preservation/SKILL.md'
  skill ja-fact-preservation
  run_s
  assert_eq 0 "$RC" "role -> ja-fact-preservation/SKILL.md exits 0 ($STDERR)"
}
test_role_to_role() {
  new_case
  skill ja-x 'see ../ja-y/SKILL.md'
  skill ja-y
  run_s
  assert_eq 1 "$RC" "role -> other role exits 1"
}
test_role_to_entries() {
  local t
  for t in tanteki yomiyasu koncise; do
    new_case
    skill ja-x "see ../$t/SKILL.md"
    skill "$t"
    run_s
    assert_eq 1 "$RC" "role -> $t/SKILL.md exits 1"
  done
}
test_role_to_rules() {
  new_case
  skill ja-x 'see ../tanteki/rules/no-ai-jargon.mjs'
  file tanteki/rules/no-ai-jargon.mjs x
  run_s
  assert_eq 1 "$RC" "role -> tanteki/rules exits 1"
}
test_role_to_allowed_dirs() {
  new_case
  skill ja-x $'../yomiyasu/references/slop-catalog.md\n../tanteki/scripts/check.mjs\n../tanteki/references/a.md\n../yomiyasu/scripts/b.sh'
  file yomiyasu/references/slop-catalog.md x
  file tanteki/scripts/check.mjs x
  file tanteki/references/a.md x
  file yomiyasu/scripts/b.sh x
  run_s
  assert_eq 0 "$RC" "role -> allowed dirs exits 0 ($STDERR)"
}
test_dotdot_segment() {
  new_case
  skill ja-x 'see ../tanteki/references/../SKILL.md'
  skill tanteki
  file tanteki/references/a.md x
  run_s
  assert_eq 1 "$RC" "dot-dot segment exits 1"
  assert_contains "$STDERR" '".."' "dot-dot segment is named"
}
test_role_references_scanned() {
  new_case
  skill ja-x
  file ja-x/references/a.md 'see ../tanteki/SKILL.md'
  skill tanteki
  run_s
  assert_eq 1 "$RC" "role references/*.md is scanned"
}
test_nonrole_references_not_scanned() {
  new_case
  skill pr
  file pr/references/a.md 'see ../missing/SKILL.md'
  run_s
  assert_eq 0 "$RC" "non-role references/*.md is not scanned ($STDERR)"
}

# ---- (4) role line -------------------------------------------------------------------------------
test_role_line_missing() {
  new_case
  skill a '役割: ja-nothing'
  run_s
  assert_eq 1 "$RC" "role line naming a missing skill exits 1"
}
test_role_line_ok() {
  new_case
  skill a '役割: ja-x'
  skill ja-x
  run_s
  assert_eq 0 "$RC" "role line naming an existing ja- skill exits 0 ($STDERR)"
}
test_role_line_non_ja() {
  new_case
  skill a '役割: koncise'
  skill koncise
  run_s
  assert_eq 1 "$RC" "role line naming a non ja- skill exits 1"
}

# ---- --names-from --------------------------------------------------------------------------------
test_names_from() {
  new_case
  skill b 'see ../missing/SKILL.md'
  mkdir -p "$CASE/names/a"
  run_s --names-from "$CASE/names"
  assert_eq 0 "$RC" "skill outside --names-from is not scanned ($STDERR)"
  mkdir -p "$CASE/names/b"
  run_s --names-from "$CASE/names"
  assert_eq 1 "$RC" "skill inside --names-from is scanned"
}

# ---- (S) symlinks --------------------------------------------------------------------------------
test_no_symlink() {
  new_case
  skill a
  run_s
  assert_eq 0 "$RC" "no symlink exits 0 ($STDERR)"
}
test_node_modules_ok() {
  new_case
  skill tanteki
  ln -s ../../../.config/textlint/node_modules "$S/tanteki/node_modules"
  run_s
  assert_eq 0 "$RC" "dangling tanteki/node_modules with the right target exits 0 ($STDERR)"
}
test_node_modules_real_dir() {
  new_case
  skill tanteki
  mkdir -p "$S/tanteki/node_modules/x"
  run_s
  assert_eq 1 "$RC" "real tanteki/node_modules exits 1"
}
test_node_modules_wrong_target() {
  new_case
  skill tanteki
  ln -s ../../../elsewhere "$S/tanteki/node_modules"
  run_s
  assert_eq 1 "$RC" "tanteki/node_modules with the wrong target exits 1"
}
test_other_symlink() {
  new_case
  skill foo
  ln -s /etc "$S/foo/link"
  run_s
  assert_eq 1 "$RC" "other symlink exits 1"
  assert_contains "$STDERR" 'foo/link' "other symlink is named"
}
test_tool_owned_symlink() {
  new_case
  skill a
  mkdir -p "$S/.trash"
  ln -s /etc "$S/.trash/link"
  run_s
  assert_eq 0 "$RC" "symlink under a tool-owned dir exits 0 ($STDERR)"
}

# ---- runner --------------------------------------------------------------------------------------
if (($# > 0)); then
  TESTS=("$@")
else
  mapfile -t TESTS < <(declare -F | awk '$3 ~ /^test_/ {print $3}')
fi
for t in "${TESTS[@]}"; do
  "$t"
done

cat "$RESULTS_FILE"
PASS=$(grep -c '^PASS' "$RESULTS_FILE" || true)
FAIL=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
printf '%s passed, %s failed\n' "$PASS" "$FAIL"
((FAIL == 0))
