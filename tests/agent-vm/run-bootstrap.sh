#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
BOOTSTRAP="$REPO_ROOT/agent-vm/bootstrap.sh"
TMP_BASE=$(mktemp -d -t agent-vm-bootstrap-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
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
