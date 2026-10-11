#!/usr/bin/env bash
# Tests for the host package install scripts: the shared run_installer partial and the rendered linux script.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
HELPER="$REPO_ROOT/home/.chezmoitemplates/run-installer.sh"
LINUX_TEMPLATE="$REPO_ROOT/home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl"
TMP_BASE=$(mktemp -d -t install-packages-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"

record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { # expected actual label
  if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi
}
assert_contains() { # haystack needle label
  case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2)" ;; esac
}
assert_not_contains() { # haystack needle label
  case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac
}

# write_stub <name> <body>: an executable in $TMP_ROOT/stubs that records its argv to $STUB_LOG first.
write_stub() {
  mkdir -p "$TMP_ROOT/stubs"
  {
    printf '#!/bin/bash\n'
    # shellcheck disable=SC2016 # "$@" and $STUB_LOG are expanded when the stub runs, not here
    printf '{ printf %%s %q; printf " %%q" "$@"; printf "\\n"; } >>"$STUB_LOG"\n' "$1"
    printf '%s\n' "$2"
  } >"$TMP_ROOT/stubs/$1"
  chmod +x "$TMP_ROOT/stubs/$1"
}
# The curl stub writes a one-line installer to the `-o` file; the installer logs its own argv and exits
# with STUB_INSTALLER_EXIT. STUB_CURL_EXIT makes the download itself fail before anything is written.
write_curl_stub() {
  # shellcheck disable=SC2016 # the body is expanded when the stub runs, not here
  write_stub curl '
if [[ "${STUB_CURL_EXIT:-0}" -ne 0 ]]; then exit "$STUB_CURL_EXIT"; fi
out=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then out=$2; shift; fi
  shift
done
[[ -n "$out" ]] || { echo "installer piped to stdout" >>"$STUB_LOG"; exit 0; }
printf "echo \"installer-ran \$*\" >>%q\nexit %q\n" "$STUB_LOG" "${STUB_INSTALLER_EXIT:-0}" >"$out"'
}
# An isolated PATH: the stubs plus only the real tools the code under test needs, so tools installed on
# the machine running the tests (mise, starship, bat, batcat, ...) are invisible.
setup_path() {
  local tool
  mkdir -p "$TMP_ROOT/tools" "$TMP_ROOT/tmp"
  # sh mktemp rm ln: used by the code under test. The rest: used by this file's own helpers and assertions.
  for tool in sh mktemp rm ln readlink cat find wc tr mkdir chmod; do ln -s "$(command -v "$tool")" "$TMP_ROOT/tools/$tool"; done
  export PATH="$TMP_ROOT/stubs:$TMP_ROOT/tools" TMPDIR="$TMP_ROOT/tmp"
  write_curl_stub
}
leftover_temp_files() { find "$TMP_ROOT/tmp" -mindepth 1 | wc -l | tr -d ' '; }
# Aborts the test when the partial does not define run_installer: without it the "nothing was executed"
# assertions below would pass for the wrong reason.
load_helper() {
  # shellcheck source=home/.chezmoitemplates/run-installer.sh
  . "$HELPER" 2>/dev/null || true
  [[ "$(type -t run_installer)" == function ]] || exit 1
}

test_helper_downloads_to_a_file_then_runs_it_with_the_arguments() {
  setup_path
  load_helper
  local status=0
  run_installer https://example.test/install.sh --yes --bin-dir /x || status=$?
  local log; log=$(cat "$STUB_LOG")
  assert_eq 0 "$status" "run_installer returns 0 when the download and the installer succeed"
  assert_contains "$log" "curl -fsSL" "the download fails on an HTTP error and follows redirects"
  assert_contains "$log" " -o " "the installer is downloaded to a file"
  assert_not_contains "$log" "installer piped to stdout" "the installer is not piped into sh"
  assert_contains "$log" "installer-ran --yes --bin-dir /x" "the downloaded installer runs with the given arguments"
  assert_eq 0 "$(leftover_temp_files)" "no temp file is left after a successful run"
}
test_helper_does_not_run_anything_when_the_download_fails() {
  setup_path
  load_helper
  local status=0 err
  err=$(STUB_CURL_EXIT=22 run_installer https://example.test/install.sh 2>&1) || status=$?
  assert_eq 22 "$status" "run_installer returns curl's exit status"
  assert_not_contains "$(cat "$STUB_LOG")" "installer-ran" "nothing is executed after a failed download"
  assert_contains "$err" "https://example.test/install.sh" "the error names the URL"
  assert_eq 0 "$(leftover_temp_files)" "no temp file is left after a failed download"
}
test_helper_returns_the_installer_exit_status() {
  setup_path
  load_helper
  local status=0
  STUB_INSTALLER_EXIT=7 run_installer https://example.test/install.sh 2>/dev/null || status=$?
  assert_eq 7 "$status" "run_installer returns the installer's exit status"
  assert_eq 0 "$(leftover_temp_files)" "no temp file is left after a failed installer"
}

# Renders the linux script and runs it under an isolated HOME and PATH. sudo is a stub that only records,
# so apt is never run. Prints the rendered script's stderr; returns its exit status.
run_linux_script() {
  local rendered="$TMP_ROOT/rendered.sh"
  "$CHEZMOI" execute-template --source "$REPO_ROOT/home" <"$LINUX_TEMPLATE" >"$rendered"
  # shellcheck disable=SC2069 # on purpose: stderr goes to the caller's stdout, the script's stdout is dropped
  HOME="$TMP_ROOT/home" /bin/bash "$rendered" 2>&1 >/dev/null
}
setup_linux_env() { # apt "succeeded": batcat and fdfind exist; mise, starship, bat and fd do not
  setup_path
  write_stub sudo 'exit 0'
  write_stub batcat 'exit 0'
  write_stub fdfind 'exit 0'
  mkdir -p "$TMP_ROOT/home/.local/bin"
}
linux_script_is_testable() { # the linux branch renders to nothing on other systems
  CHEZMOI=$(command -v chezmoi) && [[ "$(uname -s)" == Linux ]]
}

test_linux_script_installs_through_run_installer() {
  linux_script_is_testable || { record "PASS (skipped: needs chezmoi on Linux)"; return 0; }
  setup_linux_env
  local status=0
  run_linux_script >/dev/null || status=$?
  local log; log=$(cat "$STUB_LOG")
  assert_eq 0 "$status" "the linux script exits 0 on a machine with nothing installed"
  assert_contains "$log" "https://mise.run" "mise comes from its installer"
  assert_contains "$log" "installer-ran --yes --bin-dir $TMP_ROOT/home/.local/bin" "starship installs into ~/.local/bin"
  assert_not_contains "$log" "installer piped to stdout" "no installer is piped into sh"
  assert_eq "$TMP_ROOT/stubs/batcat" "$(readlink "$TMP_ROOT/home/.local/bin/bat")" "bat links to batcat"
  assert_eq "$TMP_ROOT/stubs/fdfind" "$(readlink "$TMP_ROOT/home/.local/bin/fd")" "fd links to fdfind"
}
test_linux_script_stops_when_an_installer_download_fails() {
  linux_script_is_testable || { record "PASS (skipped: needs chezmoi on Linux)"; return 0; }
  setup_linux_env
  local status=0
  STUB_CURL_EXIT=22 run_linux_script >/dev/null || status=$?
  assert_eq 22 "$status" "the linux script exits with curl's status"
  assert_not_contains "$(cat "$STUB_LOG")" "installer-ran" "nothing is executed after a failed download"
}
test_linux_script_repairs_a_dangling_bat_link() {
  linux_script_is_testable || { record "PASS (skipped: needs chezmoi on Linux)"; return 0; }
  setup_linux_env
  ln -s "$TMP_ROOT/gone" "$TMP_ROOT/home/.local/bin/bat"
  local status=0
  run_linux_script >/dev/null || status=$?
  assert_eq 0 "$status" "a dangling bat link does not stop the script"
  assert_eq "$TMP_ROOT/stubs/batcat" "$(readlink "$TMP_ROOT/home/.local/bin/bat")" "the dangling link is replaced"
  assert_contains "$(cat "$STUB_LOG")" "https://starship.rs/install.sh" "the steps after the link still run"
}
test_linux_script_names_the_missing_debian_command() {
  linux_script_is_testable || { record "PASS (skipped: needs chezmoi on Linux)"; return 0; }
  setup_linux_env
  rm "$TMP_ROOT/stubs/batcat"
  local status=0 err
  err=$(run_linux_script) || status=$?
  assert_eq 1 "$status" "a missing batcat stops the script with exit 1"
  assert_contains "$err" "batcat" "the error names the missing command"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  (
    TMP_ROOT="$TMP_BASE/$t"; mkdir -p "$TMP_ROOT"
    export TMP_ROOT STUB_LOG="$TMP_ROOT/stub.log"; : >"$STUB_LOG"
    "$t"
  ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
