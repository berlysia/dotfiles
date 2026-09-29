#!/bin/bash
# Entry point for distill-insights, shared by the daily scheduler (launchd on
# macOS, the systemd user timer on Linux) and `/insight-digest force`. It runs
# outside `chezmoi apply` because the LLM stage would delay every apply.
#
# Kept here so that every caller gets them:
#   - a kernel file lock (flock on Linux, lockf on macOS). distill-insights.ts
#     reads state.json once and writes it back at the end, so two concurrent
#     runs lose each other's counts and append duplicate records. The kernel
#     releases the lock when the holder dies, so there is no stale lock to
#     reclaim.
#   - environment hardening. The scheduler env is minimal, but a manual run
#     inherits the interactive shell, and a trusted mise [env] can re-inject
#     variables, so the unset runs again after `mise env`.
#   - the failure marker read by getDistillHealthNotice() in
#     ~/.claude/hooks/lib/insight-digest.ts. distill-insights.ts exits 0 when
#     only the LLM stage fails, so its exit status alone would hide an
#     authentication failure. The marker is one line, "<ISO8601> <reason>",
#     and <reason> is limited to the record_failure calls below; the reader
#     accepts only that vocabulary.
#
# PATH is intentionally NOT hardened: claude lives in ~/.local/bin and bun in
# the mise shims, both user-owned, the same trust boundary as this script and
# distill-insights.ts, which the job executes anyway.
#
# Usage: run-distill-insights.sh [--skip-if-ran-within-hours N] [distill-insights.ts flags]
#   The schedulers pass --skip-if-ran-within-hours so that login and wake
#   triggers do not run it more than about once a day.

set -uo pipefail
umask 077

LOGS_DIR="$HOME/.claude/logs/insights"
LOG_FILE="$LOGS_DIR/distill-run.log"
LOCK_FILE="$LOGS_DIR/.distill.lock"
FAILED_MARKER="$LOGS_DIR/last-run-failed"
STAGE_A_STAMP="$HOME/.claude/.last-distill-insights"
SCRIPT="$HOME/.claude/scripts/distill-insights.ts"
LOG_MAX_LINES=2000

harden_env() {
    # Defense against ANTHROPIC API redirection / proxy hijack / runtime injection.
    unset ANTHROPIC_BASE_URL ANTHROPIC_API_URL \
          ANTHROPIC_AUTH_TOKEN ANTHROPIC_CUSTOM_HEADERS \
          HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY \
          https_proxy http_proxy all_proxy no_proxy \
          NODE_OPTIONS NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED \
          BUN_OPTIONS LD_PRELOAD DYLD_INSERT_LIBRARIES \
          2>/dev/null || true
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$2] $1" | tee -a "$LOG_FILE" >&2
}

record_failure() {
    printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" > "$FAILED_MARKER"
    log "$1 (log: $LOG_FILE)" "ERROR"
}

trim_log() {
    if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt "$LOG_MAX_LINES" ]; then
        tail -n "$LOG_MAX_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
    fi
}

skip_within_hours=""
forced=""
ts_args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --skip-if-ran-within-hours)
            skip_within_hours="${2:-}"
            if ! [[ "$skip_within_hours" =~ ^[0-9]+$ ]]; then
                echo "usage: --skip-if-ran-within-hours needs a whole number of hours" >&2
                exit 2
            fi
            shift 2
            ;;
        *)
            [ "$1" = "--force" ] && forced=1
            ts_args+=("$1")
            shift
            ;;
    esac
done

# Resolved before `cd "$HOME"` so that the lockf re-run below finds this file
# even when it was started through a relative path.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

mkdir -p "$LOGS_DIR"
chmod 700 "$LOGS_DIR"
cd "$HOME" || exit 1

# Skipping is normal for a scheduled run that overlaps another. A manual
# --force run exits 75 instead, so the caller can tell that nothing ran.
lock_busy() {
    log "another distill-insights run holds $LOCK_FILE; skipping" "INFO"
    if [ -n "$forced" ]; then
        exit 75
    fi
    exit 0
}

if [ -z "${DISTILL_INSIGHTS_LOCK_HELD:-}" ]; then
    if command -v flock &>/dev/null; then
        exec 9>>"$LOCK_FILE"
        flock -n 9 || lock_busy
    elif command -v lockf &>/dev/null; then
        # Re-run this script under lockf; the child skips this block. BASH_ENV
        # and ENV are dropped so the child bash sources nothing before the
        # hardening below.
        reexec_args=()
        [ -n "$skip_within_hours" ] && reexec_args+=(--skip-if-ran-within-hours "$skip_within_hours")
        env -u BASH_ENV -u ENV DISTILL_INSIGHTS_LOCK_HELD=1 \
            lockf -s -t 0 "$LOCK_FILE" /bin/bash "$SELF" \
            ${reexec_args[@]+"${reexec_args[@]}"} ${ts_args[@]+"${ts_args[@]}"}
        status=$?
        # distill-insights.ts exits only 0 or 1, so 75 here always means lockf
        # found the lock held.
        [ "$status" -eq 75 ] && lock_busy
        exit "$status"
    else
        record_failure "lock tool not found"
        exit 1
    fi
fi
# The lock is held from here on; keep the flag away from bun and claude.
unset DISTILL_INSIGHTS_LOCK_HELD

trap 'trim_log' EXIT
trap 'record_failure "terminated by signal"; exit 143' TERM INT HUP

if [ -n "$skip_within_hours" ] && [ -n "$(find "$STAGE_A_STAMP" -mmin -$((skip_within_hours * 60)) 2>/dev/null)" ]; then
    log "ran within ${skip_within_hours}h; skipping" "INFO"
    exit 0
fi

harden_env
if command -v mise &>/dev/null; then
    if mise_env=$(mise env --shell bash 2>/dev/null); then
        eval "$mise_env"
    fi
fi
harden_env

BUN=""
if command -v bun &>/dev/null; then
    BUN=$(command -v bun)
elif [ -x "$HOME/.local/share/mise/shims/bun" ]; then
    BUN="$HOME/.local/share/mise/shims/bun"
fi
if [ -z "$BUN" ]; then
    record_failure "bun not found"
    exit 1
fi
if [ ! -f "$SCRIPT" ]; then
    record_failure "script not found"
    exit 1
fi

log "Distilling insights (args: ${ts_args[*]:-})" "INFO"
run_output=$(mktemp "$LOGS_DIR/.run.XXXXXX")
trap 'trim_log; rm -f "$run_output"' EXIT
"$BUN" "$SCRIPT" ${ts_args[@]+"${ts_args[@]}"} 2>&1 | tee -a "$LOG_FILE" "$run_output"
status=${PIPESTATUS[0]}
# Anchored to the line distill-insights.ts writes itself, so echoed log
# content elsewhere in the output cannot fake an outcome.
outcome=$(grep -o '^\[distill-insights\] stage_b outcome=[a-z_]*' "$run_output" | tail -n 1 | cut -d= -f2)

if [ "$status" -ne 0 ]; then
    record_failure "distill-insights.ts exited $status"
    exit "$status"
fi
# A clean exit resolves every non-LLM failure. An LLM failure is resolved only
# by a successful LLM stage: a gate skip or a Stage A only run proves nothing.
if [ -f "$FAILED_MARKER" ] && ! grep -q ' stage_b outcome=' "$FAILED_MARKER"; then
    rm -f "$FAILED_MARKER"
fi
case "$outcome" in
    ok)
        rm -f "$FAILED_MARKER"
        ;;
    llm_error|parse_error)
        record_failure "stage_b outcome=$outcome"
        exit 1
        ;;
esac
