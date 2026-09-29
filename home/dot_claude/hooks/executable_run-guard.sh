#!/bin/sh
# Fail-closed launcher for guard hooks (PreToolUse).
#
# Claude Code lets a tool call through when a command hook cannot start,
# crashes, or times out. For hooks whose job is to block dangerous operations
# that means "guard silently off", which is how the 2026-09-24 home wipe could
# happen while bun was missing. This launcher turns every such failure into
# exit 2, which blocks the call and shows the reason to Claude. The timeout is
# enforced here in plain sh, so it holds even when coreutils is not on PATH.
#
# Usage: run-guard.sh <hook.ts>   (stdin: the hook input JSON)
# Exit:  0 or 2 only.

impl="$1"
timeout_s="${RUN_GUARD_TIMEOUT:-20}"

block() {
  printf 'run-guard: %s; blocking this tool call (guard hook: %s). Fix: %s\n' "$1" "$impl" "$2" >&2
  exit 2
}

# Dying from a signal would exit with neither 0 nor 2 and let the call through.
trap 'exit 2' HUP INT QUIT PIPE TERM

case "$timeout_s" in
  '' | *[!0-9]*) block "RUN_GUARD_TIMEOUT is not a whole number of seconds ('$timeout_s')" "unset it or set it to a positive integer." ;;
esac
[ "$timeout_s" -gt 0 ] || block "RUN_GUARD_TIMEOUT must be at least 1 ('$timeout_s')" "unset it or set it to a positive integer."
command -v sleep >/dev/null 2>&1 || block "sleep not found" "restore /bin and /usr/bin on PATH."

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

work=$(mktemp -d "${TMPDIR:-/tmp}/run-guard.XXXXXX") ||
  block "cannot create a temp dir" "make ${TMPDIR:-/tmp} writable."
trap 'rm -f "$work/out" "$work/err" "$work/done"; rmdir "$work"' EXIT

# STOP first so the process cannot fork while its children are listed.
# Without pgrep only the process itself is killed; its output goes to files,
# so a surviving descendant cannot keep this wrapper waiting.
kill_tree() {
  kill -STOP "$1" 2>/dev/null
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -KILL "$1" 2>/dev/null
}

sleep_pid=""
runner_pid=""
trap '[ -n "$runner_pid" ] && kill_tree "$runner_pid"; [ -n "$sleep_pid" ] && kill "$sleep_pid" 2>/dev/null; exit 2' HUP INT QUIT PIPE TERM

# Only this shell kills, and only its own unreaped children, so the pids it
# signals cannot have been reused. The runner marks completion with a file;
# its absence when the timer ends means the hook ran out of time.
sleep "$timeout_s" >/dev/null 2>&1 &
sleep_pid=$!

# stdin goes through fd 3 because sh gives a background job /dev/null as stdin.
# stdout and stderr go to files, not pipes: a descendant that escapes the kill
# could otherwise hold a pipe open past the timeout.
# stdout is buffered so that a crashing hook cannot emit half a decision.
exec 3<&0
(
  "$bun_bin" "$impl" >"$work/out" 2>"$work/err"
  rc=$?
  : >"$work/done"
  kill "$sleep_pid" 2>/dev/null
  exit "$rc"
) <&3 3<&- &
runner_pid=$!
exec 3<&-

wait "$sleep_pid" 2>/dev/null
sleep_pid=""
[ -e "$work/done" ] || kill_tree "$runner_pid"
wait "$runner_pid" 2>/dev/null
rc=$?
# Reaped pids may be reused; keep the signal trap away from them.
runner_pid=""

cat "$work/err" >&2 || block "cannot replay the hook's stderr" "check that ${TMPDIR:-/tmp} is readable."
[ -e "$work/done" ] || block "guard hook timed out after ${timeout_s}s" "check what makes the hook hang (see its stderr above)."
case "$rc" in
  0 | 2)
    cat "$work/out" || block "cannot replay the hook's output" "check that ${TMPDIR:-/tmp} is readable."
    exit "$rc"
    ;;
  *) block "guard hook exited abnormally (exit code $rc)" "read the hook error above; a missing dependency usually means running bun install in ~/.claude." ;;
esac
