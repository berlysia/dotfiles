# shellcheck shell=sh
# rm -> gomi (trash) for both AI and human interactive shells.
# The alias condition is defined here only: gomi is found on PATH. `command -v` is a builtin,
# so this costs nothing. Running `gomi --version` would also catch a mise shim left behind
# without its install, but it costs ~100ms on every interactive start (measured in plan-1
# T11); mise rewrites shims on install/uninstall, so that window is accepted.
if command -v gomi >/dev/null 2>&1; then alias rm=gomi; fi

# Daily background prune of trash older than 30 days (spec: "コマンドの揃え" requirements 1-3).
# gomi 1.6.5 asks for confirmation on --prune and silently cancels (exit 0) when stdin is closed,
# so unattended runs need -f. -f only removes items whose DeletionDate is over 30 days old
# (measured in plan-1 T3 G2), i.e. things trashed 30+ days ago.
# Accepted limits: without `timeout` (macOS before T10) a hung gomi can leave a prune process
# behind, and the alias check above has no upper bound; a prune killed by SIGKILL leaves a
# lock for one day; sending TERM to the prune sh lets gomi live until the 600 s timeout.
# Each is recovered by the next once-a-day attempt. Failures only go to prune.log, never to
# the terminal (no warning mechanism in Phase 1).
_GOMI_PRUNE_ARGS=-f
_gomi_prune_bg() {
  _dir="${XDG_STATE_HOME:-$HOME/.local/state}/gomi-prune"
  case "$_dir" in /*) ;; *) return 0 ;; esac          # relative XDG_STATE_HOME: never start
  mkdir -p "$_dir" 2>/dev/null && chmod 700 "$_dir" 2>/dev/null || return 0
  # 1) a fresh stamp means we already tried today (success or not)
  [ -n "$(find "$_dir/stamp" -mmin -1440 2>/dev/null)" ] && return 0
  # 2) a lock older than a day is a crashed prune's leftover
  [ -n "$(find "$_dir/lock" -maxdepth 0 -mmin +1440 2>/dev/null)" ] && rmdir "$_dir/lock" 2>/dev/null
  # 3-6) lock -> stamp -> prune -> unlock, detached and silent
  # shellcheck disable=SC2016,SC2086,SC2248 # SC2016: the sh -c body is single-quoted on purpose; _GOMI_PRUNE_ARGS is a flag list, split on purpose
  ( nohup sh -c '
      dir=$1; shift
      mkdir "$dir/lock" 2>/dev/null || exit 0
      trap "rmdir \"$dir/lock\" 2>/dev/null" EXIT
      trap "exit 1" INT TERM
      : >"$dir/stamp"
      if command -v timeout >/dev/null 2>&1; then timeout 600 gomi "$@"; else gomi "$@"; fi
      rc=$?
      if [ "$rc" -ne 0 ] && [ ! -L "$dir/prune.log" ]; then
        printf "%s exit=%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" >>"$dir/prune.log"
        if [ "$(( $(wc -l <"$dir/prune.log") ))" -gt 100 ]; then # $(( )) strips BSD wc padding
          tail -n 50 "$dir/prune.log" >"$dir/prune.log.tmp" && mv "$dir/prune.log.tmp" "$dir/prune.log"
        fi
      fi
    ' _ "$_dir" --prune=30d ${_GOMI_PRUNE_ARGS:-} </dev/null >/dev/null 2>&1 & )
  unset _dir
}
if alias rm >/dev/null 2>&1; then _gomi_prune_bg; fi
unset -f _gomi_prune_bg
unset _GOMI_PRUNE_ARGS
