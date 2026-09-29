#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
BOOTSTRAP="$REPO_ROOT/agent-vm/bootstrap.sh"
TMP_BASE=$(mktemp -d -t agent-vm-bootstrap-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
# A fixed PATH (only the two stubs bootstrap.sh actually calls, plus system dirs): a claude/chezmoi
# installed in the developer's own ~/.local/bin or mise shims must not leak into the fake VM, or the
# "claude is missing" cases cannot be exercised. The full tests/agent-vm/stubs/ dir is not used directly:
# it also holds claude/codex stubs (for run.sh / run-shell.sh) that would make `command -v claude` succeed
# here unconditionally and mask the very case this suite tests.
BOOTSTRAP_STUB_DIR="$TMP_BASE/bootstrap-stubs"; mkdir -p "$BOOTSTRAP_STUB_DIR"
ln -s "$TEST_DIR/stubs/curl" "$BOOTSTRAP_STUB_DIR/curl"
ln -s "$TEST_DIR/stubs/chezmoi" "$BOOTSTRAP_STUB_DIR/chezmoi"
ln -s "$TEST_DIR/stubs/dpkg" "$BOOTSTRAP_STUB_DIR/dpkg"
ln -s "$TEST_DIR/stubs/sudo" "$BOOTSTRAP_STUB_DIR/sudo"
export PATH="$BOOTSTRAP_STUB_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

setup_vm_env() { # fake VM layout under TMP_ROOT; secrets dir on tmpfs (/dev/shm on Linux CI)
  export HOME="$TMP_ROOT/home" AGENT_VM_MARKER="$TMP_ROOT/etc-agent-vm"
  export AGENT_VM_OUTBOX_ROOT="$TMP_ROOT/outbox" AGENT_VM_SECRETS_DIR=/dev/shm
  mkdir -p "$HOME" "$AGENT_VM_OUTBOX_ROOT"; printf '1\n' >"$AGENT_VM_MARKER"
  SRC="$TMP_ROOT/src"; mkdir -p "$SRC/home" "$SRC/node_modules/x"
  printf 'home\n' >"$SRC/.chezmoiroot"; printf 'a\n' >"$SRC/home/dot_a"; printf 'junk\n' >"$SRC/node_modules/x/f"
  mkdir -p "$TMP_ROOT/bin"; printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/claude"; chmod +x "$TMP_ROOT/bin/claude"
  export PATH="$TMP_ROOT/bin:$PATH"
  # Every VM tool present by default; tests remove the one they exercise.
  mkdir -p "$HOME/.local/bin"
  local tool
  printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/mise"; chmod +x "$HOME/.local/bin/mise"
  for tool in starship bat fd; do printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/$tool"; chmod +x "$TMP_ROOT/bin/$tool"; done
}

test_unknown_contract_exits_3_with_guidance() {
  setup_vm_env
  local status=0 err; err=$(bash "$BOOTSTRAP" 2 v1:h "$SRC" 2>&1) || status=$?
  assert_eq 3 "$status" "contract mismatch exits 3"
  assert_contains "$err" "chezmoi apply" "tells the user to update the launcher on the host"
}
test_refuses_outside_an_agent_vm_machine() {
  setup_vm_env; rm "$AGENT_VM_MARKER"
  assert_status 1 "no marker -> refuse" -- bash "$BOOTSTRAP" 1 v1:h "$SRC"
}
test_refuses_when_secrets_dir_is_not_tmpfs() {
  setup_vm_env; export AGENT_VM_SECRETS_DIR="$TMP_ROOT/disk"; mkdir -p "$AGENT_VM_SECRETS_DIR"
  # The fixture must itself be on a non-tmpfs filesystem; on systems with a tmpfs /tmp this cannot be tested.
  if [[ "$(stat -f -c %T "$AGENT_VM_SECRETS_DIR")" == tmpfs ]]; then record "PASS non-tmpfs refusal (skipped: fixture is on tmpfs)"; return 0; fi
  assert_status 1 "non-tmpfs secrets dir -> refuse" -- bash "$BOOTSTRAP" 1 v1:h "$SRC"
}
test_syncs_source_applies_and_records_hash() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local cz="$HOME/.local/share/chezmoi"
  assert_eq "a" "$(cat "$cz/home/dot_a")" "source synced"
  assert_status 1 "node_modules not synced" -- test -e "$cz/node_modules"
  assert_contains "$(cat "$STUB_LOG")" "chezmoi init --force --no-tty -W $cz --apply" "chezmoi applied non-interactively"
  assert_eq "v1:abc" "$(cat "$HOME/.local/state/agent-vm/applied-hash")" "applied hash recorded"
}
test_resync_deletes_stale_files_but_keeps_git_dir() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local cz="$HOME/.local/share/chezmoi"
  mkdir -p "$cz/.git"; printf 'ref\n' >"$cz/.git/HEAD"; printf 'old\n' >"$cz/home/dot_stale"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_status 1 "stale file removed" -- test -e "$cz/home/dot_stale"
  assert_eq "ref" "$(cat "$cz/.git/HEAD")" ".git created by chezmoi init survives"
}
test_outbox_links_move_existing_logs() {
  setup_vm_env
  mkdir -p "$HOME/.claude/projects/-r"; printf 'x\n' >"$HOME/.claude/projects/-r/s.jsonl"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_eq "$AGENT_VM_OUTBOX_ROOT/claude-projects" "$(readlink "$HOME/.claude/projects")" "claude projects linked to outbox"
  assert_eq "$AGENT_VM_OUTBOX_ROOT/codex-sessions" "$(readlink "$HOME/.codex/sessions")" "codex sessions linked to outbox"
  assert_eq "x" "$(cat "$AGENT_VM_OUTBOX_ROOT/claude-projects/-r/s.jsonl")" "existing log moved into the outbox"
}
test_failed_apply_does_not_record_hash() {
  setup_vm_env
  local status=0
  STUB_CHEZMOI_EXIT=1 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  assert_eq 1 "$status" "apply failure propagates"
  assert_status 1 "no applied hash on failure" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_installs_claude_only_when_missing() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "claude.ai/install.sh" "no install when claude exists"
  rm "$TMP_ROOT/bin/claude"
  bash "$BOOTSTRAP" 1 v1:def "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "curl -fsSL https://claude.ai/install.sh" "installer fetched when claude is missing"
  assert_contains "$(cat "$STUB_LOG")" "installer-ran" "installer script executed"
}
test_finds_claude_in_local_bin_without_profile() {
  setup_vm_env
  rm "$TMP_ROOT/bin/claude"
  mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\nexit 0\n' >"$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "claude.ai/install.sh" "claude under ~/.local/bin found without a login shell"
}
test_planted_local_bin_does_not_shadow_system_commands() {
  setup_vm_env
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\necho planted-rsync >>"$STUB_LOG"\nexit 0\n' >"$HOME/.local/bin/rsync"; chmod +x "$HOME/.local/bin/rsync"
  printf '#!/bin/sh\necho planted-curl >>"$STUB_LOG"\nexit 0\n' >"$HOME/.local/bin/curl"; chmod +x "$HOME/.local/bin/curl"
  rm "$TMP_ROOT/bin/claude" # force the installer path so curl is actually invoked
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "planted-rsync" "system rsync used, not the planted one"
  assert_not_contains "$(cat "$STUB_LOG")" "planted-curl" "curl earlier on PATH used, not the planted one"
  assert_eq "a" "$(cat "$HOME/.local/share/chezmoi/home/dot_a")" "real rsync synced the source"
}
test_failed_claude_install_does_not_record_hash() {
  setup_vm_env
  rm "$TMP_ROOT/bin/claude"
  local status=0
  STUB_CURL_EXIT=22 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS install failure aborts bootstrap"; else record "FAIL install failure aborts bootstrap"; fi
  assert_status 1 "no applied hash after a failed install" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}

test_vm_tools_skipped_when_present() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "dpkg -s jq" "checks apt packages"
  assert_not_contains "$(cat "$STUB_LOG")" "apt-get" "no apt when every package is present"
  assert_not_contains "$(cat "$STUB_LOG")" "mise.run" "no mise installer when mise is present"
}
test_missing_apt_packages_installed_noninteractively_before_apply() {
  setup_vm_env
  STUB_DPKG_MISSING="jq ripgrep" bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "sudo apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update" "refreshes package lists, waiting for a held dpkg lock"
  assert_contains "$log" "sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 install -y --no-install-recommends jq ripgrep" "installs only the missing packages, without prompts or recommends"
  assert_eq "sudo" "$(grep -m1 -oE '^(sudo|chezmoi)' <<<"$log")" "packages come before chezmoi apply"
}
test_mise_installed_before_apply_when_missing() {
  setup_vm_env; rm "$HOME/.local/bin/mise"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "https://mise.run" "fetches the mise installer"
  assert_contains "$log" " -o " "downloads to a file instead of piping into sh"
  assert_contains "$log" "--max-time" "downloads are time-bounded"
  assert_contains "$log" "--proto =https" "downloads refuse non-https redirects"
  assert_contains "$log" "installer-ran" "runs the downloaded installer"
}
test_installer_download_failure_leaves_no_temp_file() {
  setup_vm_env; rm "$HOME/.local/bin/mise"
  export TMPDIR="$TMP_ROOT/tmp"; mkdir -p "$TMPDIR"
  local status=0
  STUB_CURL_EXIT=22 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS download failure aborts bootstrap"; else record "FAIL download failure aborts bootstrap"; fi
  assert_eq "" "$(ls -A "$TMPDIR")" "no installer temp file left behind"
  assert_status 1 "no applied hash after a failed download" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
test_dangling_bat_link_is_replaced() {
  setup_vm_env; rm "$TMP_ROOT/bin/bat"
  printf '#!/bin/sh\nexit 0\n' >"$TMP_ROOT/bin/batcat"; chmod +x "$TMP_ROOT/bin/batcat"
  ln -s /nonexistent/batcat "$HOME/.local/bin/bat" # left by an earlier failed run
  assert_status 0 "bootstrap recovers from a dangling bat link" -- bash "$BOOTSTRAP" 1 v1:abc "$SRC"
  assert_eq "$TMP_ROOT/bin/batcat" "$(readlink "$HOME/.local/bin/bat")" "bat points at batcat"
}
test_missing_debian_binary_fails_with_its_name() {
  # Needs a runner without fd / fdfind in the system dirs of the fixed PATH; skip visibly where they exist.
  if command -v fdfind >/dev/null 2>&1 || [[ -x /usr/bin/fd ]]; then record "PASS missing fdfind case skipped (fd-find is installed on this runner)"; return 0; fi
  setup_vm_env; rm "$TMP_ROOT/bin/fd" # and no fdfind anywhere on the fixed PATH
  local err status=0; err=$(bash "$BOOTSTRAP" 1 v1:abc "$SRC" 2>&1) || status=$?
  assert_eq 1 "$status" "missing fdfind fails the bootstrap"
  assert_contains "$err" "fdfind is missing" "names the missing command"
}
test_failed_tool_install_does_not_record_hash() {
  setup_vm_env
  local status=0
  STUB_DPKG_MISSING=jq STUB_SUDO_EXIT=100 bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1 || status=$?
  if [[ "$status" -ne 0 ]]; then record "PASS tool install failure aborts bootstrap"; else record "FAIL tool install failure aborts bootstrap"; fi
  assert_status 1 "no applied hash after a failed tool install" -- test -e "$HOME/.local/state/agent-vm/applied-hash"
}
# bootstrap mirrors part of the host apt script (spec K18). The package names come from what bootstrap actually
# checks (the dpkg stub's log), not from its source text.
test_vm_apt_packages_are_a_subset_of_the_host_list() {
  setup_vm_env
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  local vm host pkg missing=""
  vm=$(sed -n 's/^dpkg -s //p' "$STUB_LOG")
  assert_contains "$vm" "jq" "bootstrap checks its apt packages"
  host=$(awk '/^  linux:/{l=1;next} /^  [a-z_]+:/{l=0} l && /^    apt:/{a=1;next} l && /^    [a-z_]+:/{a=0} l && a && /^      - /{sub(/^ *- */,""); gsub(/"/,""); print}' "$REPO_ROOT/home/.chezmoidata/packages.yaml")
  for pkg in $vm; do grep -qxF "$pkg" <<<"$host" || missing="$missing $pkg"; done
  assert_eq "" "$missing" "VM apt packages are a subset of the host list"
}
test_vm_installers_come_from_the_host_sources() {
  # A text check on purpose: both files must name the same installer origin.
  local host_script="$REPO_ROOT/home/.chezmoiscripts/run_onchange_install-packages-1-linux.sh.tmpl"
  local url; for url in https://mise.run https://starship.rs/install.sh; do
    assert_contains "$(cat "$host_script")" "$url" "host script installs from $url"
    assert_contains "$(cat "$BOOTSTRAP")" "$url" "bootstrap installs from $url"
  done
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
