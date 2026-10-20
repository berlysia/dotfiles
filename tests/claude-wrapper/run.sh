#!/usr/bin/env bash
# Tests for the claude() wrapper in home/dot_shell_common/functions.sh: gateway-only
# --plugin-dir / --mcp-config injection and ANTHROPIC_AUTH_TOKEN hand-over.
# Each case runs in a child shell (bash and zsh) whose HOME is a throwaway directory;
# the calling shell's HOME is never changed.
set -uo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
FUNCTIONS_SH="$REPO_ROOT/home/dot_shell_common/functions.sh"
STUB_PATH="$TEST_DIR/stubs"
TMP_BASE=$(mktemp -d -t claude-wrapper-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
SYSTEM_PATH="$(dirname "$(command -v zsh)"):$(dirname "$(command -v bash)"):/usr/bin:/bin"

PASS=0
FAIL=0
assert_eq() { # expected actual label
  if [[ "$1" == "$2" ]]; then PASS=$((PASS + 1)); printf 'PASS %s\n' "$3"
  else FAIL=$((FAIL + 1)); printf 'FAIL %s\n--- expected\n%s\n--- actual\n%s\n' "$3" "$1" "$2"; fi
}

# new_home <name>: a fresh HOME with an empty ~/.config/claude-local; prints its path.
new_home() {
  local h="$TMP_BASE/$1"
  mkdir -p "$h/.config/claude-local"
  printf '%s' "$h"
}

# run_claude <shell> <home> <gateway: none|key|both> : runs `claude a b` in a child shell.
run_claude() {
  local sh="$1" h="$2" mode="$3"
  local -a envs=(HOME="$h" PATH="$STUB_PATH:$SYSTEM_PATH")
  case "$mode" in
    key) envs+=(LLM_GATEWAY_API_KEY=secret) ;;
    both) envs+=(LLM_GATEWAY_API_KEY=secret ANTHROPIC_BASE_URL=http://gateway.invalid) ;;
  esac
  env -i "${envs[@]}" "$sh" -c ". '$FUNCTIONS_SH' >/dev/null 2>&1; claude a b" 2>&1
}

lines() { printf '%s\n' "$@"; }

for sh in bash zsh; do
  P=".config/claude-local/plugins"

  h=$(new_home "$sh-nogw"); mkdir -p "$h/$P/alpha"
  assert_eq "$(lines arg=a arg=b token=unset)" "$(run_claude "$sh" "$h" none)" "$sh: no gateway vars, plugin present -> args unchanged"

  assert_eq "$(lines arg=a arg=b token=unset)" "$(run_claude "$sh" "$h" key)" "$sh: key only -> args unchanged, no token"

  h=$(new_home "$sh-noplug")
  assert_eq "$(lines arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: gateway, no mcp json, no plugins dir"

  h=$(new_home "$sh-mcp-noplug"); echo '{}' >"$h/.config/claude-local/gateway-mcp.json"
  mcp="arg=--mcp-config=$h/.config/claude-local/gateway-mcp.json"
  assert_eq "$(lines "$mcp" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: gateway + mcp json, plugins missing"

  mkdir -p "$h/$P"
  assert_eq "$(lines "$mcp" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: gateway + mcp json, plugins empty"

  touch "$h/$P/.DS_Store"
  assert_eq "$(lines "$mcp" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: gateway + mcp json, only .DS_Store"

  mkdir -p "$h/$P/beta" "$h/$P/alpha"
  assert_eq "$(lines "arg=--plugin-dir=$h/$P/alpha" "arg=--plugin-dir=$h/$P/beta" "$mcp" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: beta+alpha -> sorted plugin dirs, mcp, args"

  h=$(new_home "$sh-alpha-only"); mkdir -p "$h/$P/alpha"
  assert_eq "$(lines "arg=--plugin-dir=$h/$P/alpha" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: alpha only, no mcp json"

  h=$(new_home "$sh-space"); mkdir -p "$h/$P/g h"
  assert_eq "$(lines "arg=--plugin-dir=$h/$P/g h" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: name with space is one argument"

  h=$(new_home "$sh-link"); mkdir -p "$h/$P" "$TMP_BASE/$sh-elsewhere/target"
  ln -s "$TMP_BASE/$sh-elsewhere/target" "$h/$P/link"
  assert_eq "$(lines "arg=--plugin-dir=$h/$P/link" arg=a arg=b token=set)" "$(run_claude "$sh" "$h" both)" "$sh: symlink to directory is passed via link path"
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
