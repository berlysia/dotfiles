# shellcheck shell=bash
# Assertion helpers for agent-vm tests (bash 3.2 compatible).
# Each test runs in its own subshell; results are appended to $RESULTS_FILE.
: "${RESULTS_FILE:?RESULTS_FILE must be exported by tests/agent-vm/run.sh}"
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
assert_status() { # expected_status label -- command...
  local expected=$1 label=$2 status=0
  shift 3
  "$@" >/dev/null 2>&1 </dev/null || status=$?
  assert_eq "$expected" "$status" "$label"
}
