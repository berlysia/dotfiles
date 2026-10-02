# shellcheck shell=bash
# shellcheck disable=SC2154,SC2016 # SC2016: probes are single-quoted on purpose; FIX_HOME, SHELL_DIRS, TMP_BASE, STUB_PATH are set by run.sh
# Assertion helpers and clean-environment runners for shell-gate tests (bash 3.2 compatible).
# Each test runs in its own subshell; results are appended to $RESULTS_FILE.
: "${RESULTS_FILE:?RESULTS_FILE must be exported by tests/shell-gate/run.sh}"
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

WATCHDOG=""
if command -v timeout >/dev/null 2>&1; then WATCHDOG="timeout 20"
elif command -v gtimeout >/dev/null 2>&1; then WATCHDOG="gtimeout 20"; fi

# Throwaway HOME with only the shell targets, rendered with pinned data
build_fixture_home() { # repo dest_home statedir
  local repo=$1 home=$2 state=$3
  mkdir -p "$home"
  # Debian/Ubuntu /etc/bash.bashrc prints a sudo hint on stdout for interactive bash unless this exists
  : >"$home/.sudo_as_admin_successful"
  (cd "$state" && HOME="$home" chezmoi apply --no-tty \
    --source "$repo/home" --destination "$home" \
    --config "$repo/tests/shell-gate/fixtures/chezmoi.toml" \
    --persistent-state "$state/state.boltdb" \
    --exclude=scripts,externals \
    "$home/.shell_common" "$home/.zshenv" "$home/.zshrc" "$home/.zsh" "$home/.bashrc" "$home/.bash_profile")
}

# Clean env runner. $1=tty|notty, $2=path for PATH head (stub dir or empty dir), rest=argv.
# Prints stdout only (stderr is dropped: bash -i without a TTY prints job-control noise).
# In tty mode the human rc prints a title escape (ESC]0;...BEL) with no newline, so probes
# that need a value print it between @@ markers and callers read it with `marked`.
run_clean() {
  local mode=$1 head=$2; shift 2
  # shellcheck disable=SC2086 # EXTRA_ENV / WATCHDOG are intentionally word-split
  set -- env -i HOME="$FIX_HOME" XDG_STATE_HOME="$FIX_HOME/.local/state" \
    PATH="$head:$SHELL_DIRS:/usr/bin:/bin" TERM=xterm LANG=C.UTF-8 \
    GOMI_STUB_LOG="$TMP_BASE/prune.calls" ${EXTRA_ENV:-} "$@"
  if [ "$mode" = tty ]; then
    local cmd; cmd=$(printf '%q ' "$@")
    if script --version >/dev/null 2>&1; then # util-linux
      $WATCHDOG script -qec "$cmd 2>/dev/null" /dev/null </dev/null
    else # BSD
      $WATCHDOG script -q /dev/null sh -c "$cmd 2>/dev/null" </dev/null
    fi | tr -d '\r'
  else
    $WATCHDOG "$@" </dev/null 2>/dev/null
  fi
}

# Extract the text printed between @@ markers (last occurrence)
marked() { sed -n 's/.*@@\(.*\)@@.*/\1/p' | tail -1; }

# zsh prints name=value, bash prints alias name='value'; normalize both to name=value
normalize_aliases() {
  # run-help / which-command are zsh's own default aliases (present in every interactive zsh)
  grep -E "^(alias )?[^ =]+=" | sed -e 's/^alias //' -e "s/^\([^=]*\)='\(.*\)'$/\1=\2/" \
    | grep -vE '^(run-help=man|which-command=whence)$' | sort
}

# Shell-function names that shadow a command on the clean PATH (evaluated inside the clean env)
shadowing_functions() { # shell(zsh|bash) mode
  local list
  if [ "$1" = zsh ]; then list='for f in ${(k)functions}; do whence -p "$f" >/dev/null && echo "$f"; done'
  else list='for f in $(compgen -A function); do type -P "$f" >/dev/null && echo "$f"; done'; fi
  if [ "$1" = zsh ]; then run_clean "$2" "$STUB_PATH" zsh -i -c "$list"
  else run_clean "$2" "$STUB_PATH" bash -l -i -c "$list"; fi
}
