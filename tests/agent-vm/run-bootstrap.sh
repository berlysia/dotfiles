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
