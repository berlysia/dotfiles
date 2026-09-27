#!/bin/sh
# Wall-clock timer around one hook command (see hooks/README.md "Hook telemetry").
# Usage: hook-timer.sh <event> <async 0|1> <command-string>   (stdin: hook input JSON)
# Exit: the child's exit code, untouched; 128+signo when the wrapper itself is
# signalled (TERM/INT/HUP). Recording is best-effort and detached.
event="$1"; is_async="$2"; cmd="$3"
log_dir="${CLAUDE_LOGS_DIR:-$HOME/.claude/logs}"

now_ms() {
  t=$(date +%s%N 2>/dev/null)
  case "$t" in
    '' | *[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null ;;
    *) printf '%s\n' "${t%??????}" ;;
  esac
}

# Without a scratch dir we cannot capture byte-exact streams; run untimed.
work=$(mktemp -d 2>/dev/null) || exec sh -c "$cmd"

record() { # $1 exit_code|null  $2 terminated-signal|""
  end=$(now_ms)
  rec_rc="$1"; rec_sig="$2"  # write_record below has its own positional args
  (
    umask 077
    # write_record may bail out early; the scratch dir (a raw copy of the
    # hook input) is removed on every path.
    write_record() {
    command -v jq >/dev/null 2>&1 || return 0
    out_b=$(wc -c <"$work/out" 2>/dev/null | tr -d ' ')
    err_b=$(wc -c <"$work/err" 2>/dev/null | tr -d ' ')
    mkdir -p "$log_dir" && log="$log_dir/hook-timing.jsonl" || return 0
    # Only three identifiers are projected from the hook input; tool_input,
    # tool_response and prompts never reach the log.
    jq -c -R -s \
      --arg event "$event" --arg is_async "$is_async" --arg cmd "$cmd" \
      --arg start "$start" --arg end "$end" --arg rc "$rec_rc" --arg sig "$rec_sig" \
      --arg out_b "${out_b:-}" --arg err_b "${err_b:-}" '
      (try fromjson catch {}) as $in
      | ($start | tonumber? // null) as $s | ($end | tonumber? // null) as $e
      | {ts: (if $s then ($s / 1000 | floor | todate) else (now | floor | todate) end),
         start_ms: $s,
         duration_ms: (if $s and $e then $e - $s else null end),
         event: $event, async: ($is_async == "1"),
         exit_code: ($rc | tonumber? // null),
         stdout_bytes: ($out_b | tonumber? // 0),
         stderr_bytes: ($err_b | tonumber? // null),
         command: $cmd,
         session_id: ($in | objects | .session_id // null),
         tool_name: ($in | objects | .tool_name // null),
         tool_use_id: ($in | objects | .tool_use_id // null),
         terminated: (if $sig == "" then null else $sig end)}' \
      <"$work/in" >>"$log" || return 0
    size=$(wc -c <"$log" | tr -d ' ')
    [ "$size" -gt 10000000 ] && mv -f "$log" "$log.1"
    }
    write_record
    rm -rf "$work"
  ) </dev/null >/dev/null 2>&1 &
}

on_signal() { # $1 signal name  $2 signal number
  # Forward the signal and give the child up to 1s to finish writing, then
  # SIGKILL it: otherwise a child that traps the signal would outlive the
  # wrapper once Claude Code escalates to SIGKILL, which only reaches us.
  if [ -n "$child" ]; then
    kill "-$1" "$child" 2>/dev/null
    i=0
    while kill -0 "$child" 2>/dev/null && [ "$i" -lt 10 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    kill -KILL "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  cat "$work/out" 2>/dev/null
  cat "$work/err" >&2 2>/dev/null
  record null "$1"
  exit $((128 + $2))
}
trap 'on_signal TERM 15' TERM
trap 'on_signal INT 2' INT
trap 'on_signal HUP 1' HUP

cat >"$work/in"
child=""
start=$(now_ms)
sh -c "$cmd" <"$work/in" >"$work/out" 2>"$work/err" &
child=$!
wait "$child"
rc=$?
child=""
cat "$work/out"
cat "$work/err" >&2
record "$rc" ""
exit "$rc"
