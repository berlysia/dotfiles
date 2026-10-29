#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
TMP_BASE=$(mktemp -d -t unregister-distill-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
PASS=0 FAIL=0
check() {
  if "$@"; then PASS=$((PASS + 1)); else
    echo "FAIL: $*"
    FAIL=$((FAIL + 1))
  fi
}
setup() {
  local tool
  STATE="$TMP_BASE/$1"
  export STATE
  mkdir -p "$STATE/bin" "$STATE/home/.config/systemd/user/timers.target.wants" "$STATE/home/.claude"
  for tool in systemctl launchctl pgrep id; do ln -s "$TEST_DIR/fake" "$STATE/bin/$tool"; done
  for tool in cat rm; do ln -s "$(command -v "$tool")" "$STATE/bin/$tool"; done
  echo enabled >"$STATE/enabled"
  echo active >"$STATE/timer"
  echo active >"$STATE/service"
  echo yes >"$STATE/loaded"
  touch "$STATE/home/.claude/.distill-insights-plist.sha256"
  : >"$STATE/calls"
  unset UNREACHABLE PGREP_RC STUCK PRINT_ERROR NOFILE
}
run_script() {
  local os=${1:-linux}
  # Select the OS branch without invoking chezmoi or reading machine configuration.
  awk -v os="$os" '/^{{ if / { on = index($0, "\"" os "\"") > 0; next }
    /^{{ else if / { on = index($0, "\"" os "\"") > 0; next }
    /^{{ end/ { on = 0; next } on { print }' \
    "$REPO_ROOT/home/.chezmoiscripts/run_once_after_99-unregister-distill-insights.sh.tmpl" >"$STATE/rendered.sh"
  RC=0
  OUT=$(HOME="$STATE/home" PATH="$STATE/bin" /bin/bash "$STATE/rendered.sh" 2>&1) || RC=$?
}
failure() {
  check test "$RC" -ne 0
  check test -n "$OUT"
  check test "$(printf '%s\n' "$OUT" | wc -l)" -eq 1
}
setup absent
export UNREACHABLE=1
run_script
check test "$RC" -eq 0
check grep -qx 'pgrep -u 4242 -x systemd' "$STATE/calls"
setup manager
export UNREACHABLE=1 PGREP_RC=0
run_script
failure
setup link
export UNREACHABLE=1
ln -s /missing "$STATE/home/.config/systemd/user/timers.target.wants/distill-insights.timer"
run_script
failure
setup missing
export UNREACHABLE=1
rm "$STATE/bin/pgrep"
run_script
failure
setup running
echo disabled >"$STATE/enabled"
echo inactive >"$STATE/timer"
run_script
check test "$RC" -eq 0
check test "$(cat "$STATE/service")" = inactive
check grep -qx 'systemctl --user stop distill-insights.service' "$STATE/calls"
check grep -qx 'systemctl --user daemon-reload' "$STATE/calls"
setup stuck
export STUCK=1
run_script
failure
# .chezmoiremove deletes the unit files before this run_once_after script, so
# disable fails with "Unit file ... does not exist" while nothing is registered.
setup unit_files_removed
export NOFILE=1
echo inactive >"$STATE/timer"
echo inactive >"$STATE/service"
run_script
check test "$RC" -eq 0
setup repeat
run_script
check test "$RC" -eq 0
run_script
check test "$RC" -eq 0
setup mac_error
export PRINT_ERROR=1
run_script darwin
failure
setup retry
export UNREACHABLE=1 PGREP_RC=0
run_script
failure
export UNREACHABLE=0
run_script
check test "$RC" -eq 0
check test "$(cat "$STATE/enabled")" = disabled
check test "$(cat "$STATE/timer")" = inactive
setup mac
run_script darwin
check test "$RC" -eq 0
check test ! -e "$STATE/home/.claude/.distill-insights-plist.sha256"
check grep -qx 'launchctl bootout gui/4242/com.berlysia.distill-insights' "$STATE/calls"
run_script darwin
check test "$RC" -eq 0
setup pgrep_error
export UNREACHABLE=1 PGREP_RC=2
run_script
failure
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
