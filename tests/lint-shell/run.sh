#!/usr/bin/env bash
# Contract tests for scripts/lint-shell.sh: exit codes (0 pass / 1 findings / 2 tools missing),
# render targets, path mode, and the pinned-version check. Uses stubs only; no real mise,
# chezmoi or shellcheck is reached because PATH holds the stub dir and /usr/bin:/bin
# (neither has mise or chezmoi on macOS or ubuntu-latest).
# shellcheck disable=SC2317,SC2329 # test_* functions are called through the declare -F loop
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
TMP_BASE=$(mktemp -d -t lint-shell-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"

record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac; }

# make_fixture <pin-line>: a repo with lint-shell.sh, .mise.toml, two .sh files (a.sh and the copied
# scripts/lint-shell.sh), one shebang file (tool) and one non-shell file (notes.md).
make_fixture() {
  local root pin=${1:-'"github:koalaman/shellcheck" = "0.11.0"'}
  root=$(mktemp -d "$TMP_BASE/repo-XXXXXX")
  mkdir -p "$root/scripts" "$root/home" "$root/sub"
  cp "$REPO_ROOT/scripts/lint-shell.sh" "$root/scripts/lint-shell.sh"
  printf '[tools]\n%s\n' "$pin" >"$root/.mise.toml"
  printf '#!/bin/bash\necho ok\n' >"$root/a.sh"
  printf '#!/usr/bin/env bash\necho ok\n' >"$root/tool"
  printf '# not shell\n' >"$root/notes.md"
  printf '%s\n' "$root"
}
# stub_path <tool...>: a dir holding copies of the named stubs, for tests that hide a tool
stub_path() {
  local dir; dir=$(mktemp -d "$TMP_BASE/path-XXXXXX")
  for t in "$@"; do cp "$TEST_DIR/stubs/bin/$t" "$dir/"; done
  printf '%s\n' "$dir"
}
# run_lint <root> [args...]: runs lint-shell.sh with a clean env; sets OUT and RC.
# LINT_PATH (stub dir) and LINT_CWD may be set by the caller.
run_lint() {
  local root=$1; shift
  RC=0
  mkdir -p "$root/.tmp-render"
  OUT=$(cd "${LINT_CWD:-$root}" && env -i HOME="$HOME" TMPDIR="$root/.tmp-render" PATH="${LINT_PATH:-$TEST_DIR/stubs/bin}:/usr/bin:/bin" \
    STUB_LOG="$root/log" STUB_INSTALL_DIR="$TEST_DIR/stubs/install" \
    STUB_SHELLCHECK_RC="${STUB_SHELLCHECK_RC:-0}" STUB_SHELLCHECK_VERSION="${STUB_SHELLCHECK_VERSION:-0.11.0}" \
    STUB_MISE_WHERE_FAIL="${STUB_MISE_WHERE_FAIL:-}" STUB_CHEZMOI_FAIL_ON="${STUB_CHEZMOI_FAIL_ON:-}" \
    bash "$root/scripts/lint-shell.sh" "$@" 2>&1) || RC=$?
}
log_of() { cat "$1/log" 2>/dev/null || true; }

test_passes_and_prints_version() {
  local r; r=$(make_fixture); run_lint "$r"
  assert_eq 0 "$RC" "clean files exit 0"
  assert_contains "$OUT" "version: 0.11.0" "the shellcheck version is printed"
  assert_contains "$OUT" "Found 2 .sh, 0 .sh.tmpl and 1 shebang-detected file(s) to check" "discovery line unchanged"
  assert_contains "$(log_of "$r")" "[--] [./tool]" "files are passed after --"
}
test_not_installed_exits_2() {
  local r; r=$(make_fixture); STUB_MISE_WHERE_FAIL=1 run_lint "$r"
  assert_eq 2 "$RC" "pinned version not installed exits 2"
  assert_contains "$OUT" "mise install github:koalaman/shellcheck" "recovery shown"
  assert_not_contains "$(log_of "$r")" "shellcheck [" "no file was checked"
}
test_no_mise_exits_2() {
  local r; r=$(make_fixture); LINT_PATH=$(stub_path chezmoi) run_lint "$r"
  assert_eq 2 "$RC" "no mise exits 2"
}
test_version_mismatch_exits_2() {
  local r; r=$(make_fixture '"github:koalaman/shellcheck" = "0.12.0"'); run_lint "$r"
  assert_eq 2 "$RC" "a different running version exits 2"
  assert_contains "$OUT" "0.12.0" "the expected version is shown"
  assert_contains "$OUT" "0.11.0" "the running version is shown"
  r=$(make_fixture '"github:koalaman/shellcheck" = "0.11.0"'); STUB_SHELLCHECK_VERSION=0.11.0-rc run_lint "$r"
  assert_eq 2 "$RC" "a prefix match does not count"
}
test_unreadable_pin_exits_2() {
  local r
  r=$(make_fixture '"github:koalaman/shellcheck" = { version = "0.11.0" }'); run_lint "$r"
  assert_eq 2 "$RC" "a table-form pin exits 2"
  r=$(make_fixture '"github:koalaman/shellcheck" = "latest"'); run_lint "$r"
  assert_eq 2 "$RC" "a non-pinned value exits 2"
  r=$(make_fixture '"github:mizchi/actrun" = "0.29.0"'); run_lint "$r"
  assert_eq 2 "$RC" "a missing pin exits 2"
}
test_findings_exit_1_even_when_shellcheck_returns_2() {
  local r; r=$(make_fixture)
  STUB_SHELLCHECK_RC=1 run_lint "$r"; assert_eq 1 "$RC" "findings exit 1"
  STUB_SHELLCHECK_RC=2 run_lint "$r"; assert_eq 1 "$RC" "shellcheck's own 2 folds into 1"
}
test_template_rendered_for_three_targets() {
  local r; r=$(make_fixture)
  printf '#!/bin/bash\necho {{ .chezmoi.os }}\n' >"$r/home/x.sh.tmpl"
  STUB_SHELLCHECK_RC=1 run_lint "$r"
  local log; log=$(log_of "$r")
  assert_contains "$log" '"os":"darwin"' "darwin rendered"
  assert_contains "$log" '"osrelease":"6.8.0-generic"' "linux rendered"
  assert_contains "$log" 'microsoft-standard-WSL2' "linux-wsl rendered"
  assert_contains "$OUT" "./home/x.sh.tmpl (rendered: linux-wsl)" "the finding is relabelled with the target"
  assert_contains "$OUT" "Checking (rendered: darwin): ./home/x.sh.tmpl" "the checking line names the target"
}
test_one_target_render_failure_continues() {
  local r; r=$(make_fixture)
  printf '#!/bin/bash\necho hi\n' >"$r/home/x.sh.tmpl"
  STUB_CHEZMOI_FAIL_ON=darwin run_lint "$r"
  assert_eq 1 "$RC" "a failed render exits 1"
  assert_contains "$OUT" "Template render failed (darwin): ./home/x.sh.tmpl" "the failed target is named"
  assert_contains "$OUT" "Checking (rendered: linux-wsl): ./home/x.sh.tmpl" "the other targets are still checked"
}
test_template_without_chezmoi_exits_2() {
  local r; r=$(make_fixture)
  printf '#!/bin/bash\necho hi\n' >"$r/home/x.sh.tmpl"
  LINT_PATH=$(stub_path mise) run_lint "$r"
  assert_eq 2 "$RC" "a template without chezmoi exits 2"
}
test_all_targets_empty_prints_note() {
  local r; r=$(make_fixture)
  printf '# only a comment\n' >"$r/home/empty.sh.tmpl"
  run_lint "$r"
  assert_eq 0 "$RC" "an always-empty template is not a failure"
  assert_contains "$OUT" "NOTE: ./home/empty.sh.tmpl renders empty for every target" "a NOTE names it"
}
test_path_mode_classifies_and_skips() {
  local r; r=$(make_fixture)
  LINT_CWD="$r/sub" run_lint "$r" tool notes.md missing.sh
  assert_eq 0 "$RC" "path mode exits 0"
  local log; log=$(log_of "$r")
  assert_contains "$log" "[tool]" "the shebang file is checked (paths are relative to the repo root, cwd is a subdirectory)"
  assert_not_contains "$log" "notes.md" "a non-shell file is skipped"
  assert_not_contains "$log" "a.sh" "files not passed are not checked"
}
test_path_mode_without_shell_files_does_not_need_mise() {
  local r; r=$(make_fixture); LINT_PATH=$(stub_path chezmoi) run_lint "$r" notes.md
  assert_eq 0 "$RC" "no shell file among the paths: mise is not needed"
}
test_path_with_space_and_leading_dash() {
  local r; r=$(make_fixture)
  printf '#!/bin/bash\necho ok\n' >"$r/with space.sh"
  printf '#!/bin/bash\necho ok\n' >"$r/-x.sh"
  run_lint "$r" "with space.sh" "-x.sh"
  local log; log=$(log_of "$r")
  assert_contains "$log" "[--] [with space.sh]" "a path with a space reaches shellcheck as one argument after --"
  assert_contains "$log" "[--] [-x.sh]" "a path starting with - is passed after --"
}
test_render_dir_is_removed() {
  local r; r=$(make_fixture)
  printf '#!/bin/bash\necho hi\n' >"$r/home/x.sh.tmpl"
  run_lint "$r"
  assert_contains "$OUT" "Checking (rendered: darwin)" "a render happened"
  assert_eq 0 "$(find "$r/.tmp-render" -mindepth 1 | wc -l | tr -d ' ')" "the render directory is removed on exit"
}

count=0
for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  count=$((count + 1))
  # errexit is off inside a subshell on the left of ||, so a crash is detected by the missing
  # DONE line (set -u errors and explicit exits stop the subshell before it), not by the status.
  ( "$t"; printf 'DONE %s\n' "$t" >>"$RESULTS_FILE" ) || true
  grep -qx "DONE $t" "$RESULTS_FILE" || record "FAIL $t crashed before finishing"
done
fails=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
echo "${count} tests, $(grep -c '^PASS\|^FAIL' "$RESULTS_FILE" | tr -d ' ') assertions, ${fails} failed"
[[ "$fails" -eq 0 ]]
