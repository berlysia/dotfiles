#!/bin/sh
# Fail-closed launcher for guard hooks (PreToolUse).
#
# Claude Code lets a tool call through when a command hook cannot start,
# crashes, or times out. For hooks whose job is to block dangerous operations
# that means "guard silently off", which is how the 2026-09-24 home wipe could
# happen while bun was missing. This launcher turns every such failure into
# exit 2, which blocks the call and shows the reason to Claude.
#
# Usage: run-guard.sh <hook.ts>   (stdin: the hook input JSON)
# Exit:  0 or 2 only.

impl="$1"
timeout_s="${RUN_GUARD_TIMEOUT:-20}"

block() {
  printf 'run-guard: %s; blocking this tool call (guard hook: %s). Fix: %s\n' "$1" "$impl" "$2" >&2
  exit 2
}

bun_bin=$(command -v bun 2>/dev/null)
if [ -z "$bun_bin" ]; then
  for candidate in "$HOME/.local/share/mise/shims/bun" "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then
      bun_bin="$candidate"
      break
    fi
  done
fi
[ -n "$bun_bin" ] || block "bun not found" "make bun available (install it or enable mise) from a separate terminal, then retry."
[ -f "$impl" ] || block "hook file not found" "run chezmoi apply to deploy the hooks."

timeout_cmd=""
if command -v timeout >/dev/null 2>&1; then
  timeout_cmd="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_cmd="gtimeout"
fi

# stdout is buffered so that a crashing hook cannot emit half a decision.
if [ -n "$timeout_cmd" ]; then
  out=$("$timeout_cmd" "$timeout_s" "$bun_bin" "$impl")
  rc=$?
else
  out=$("$bun_bin" "$impl")
  rc=$?
fi

case "$rc" in
  0 | 2)
    [ -n "$out" ] && printf '%s\n' "$out"
    exit "$rc"
    ;;
  124) block "guard hook timed out after ${timeout_s}s" "check what makes the hook hang (see its stderr above)." ;;
  *) block "guard hook exited abnormally (exit code $rc)" "read the hook error above; a missing dependency usually means running bun install in ~/.claude." ;;
esac
