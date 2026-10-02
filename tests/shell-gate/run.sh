#!/usr/bin/env bash
# Invariant tests for the AI/human shell split (spec K9). Runs against a throwaway HOME
# rendered with chezmoi --destination; never touches the real HOME.
# Windows (windows.sh: ssh/ssh-add functions) is outside CI, so those two functions are
# deliberately not in the assert 2 allowlist.
# shellcheck disable=SC2317,SC2016 # test_* are invoked dynamically; probe strings are single-quoted on purpose
set -uo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
TMP_BASE=$(mktemp -d -t shell-gate-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/shell-gate/lib.sh
. "$TEST_DIR/lib.sh"

FIX_HOME="$TMP_BASE/home"
build_fixture_home "$REPO_ROOT" "$FIX_HOME" "$TMP_BASE" || { echo "fixture build failed" >&2; exit 1; }
SHELL_DIRS="$(dirname "$(command -v zsh)"):$(dirname "$(command -v bash)")"
STUB_PATH="$TEST_DIR/stubs"
EMPTY_PATH="$TMP_BASE/empty"; mkdir -p "$EMPTY_PATH"
EXTRA_ENV=""
AI_VALUES="true,true,true,true,cat,cat,cat,0"
AI_VARS='$EDITOR,$VISUAL,$GIT_EDITOR,$GIT_SEQUENCE_EDITOR,$PAGER,$GIT_PAGER,$MANPAGER,$GIT_TERMINAL_PROMPT'
REAL_RC_MTIME=$(stat -c %Y "$HOME/.zshrc" 2>/dev/null || stat -f %m "$HOME/.zshrc" 2>/dev/null || echo none)

gomi_on_shell_dirs() { local d; for d in ${SHELL_DIRS//:/ } /usr/bin /bin; do [ -x "$d/gomi" ] && return 0; done; return 1; }

test_assert1_ai_aliases_only_rm() {
  assert_eq "rm=gomi" "$(run_clean notty "$STUB_PATH" zsh -i -c alias | normalize_aliases)" "A1 zsh AI aliases == {rm=gomi}"
  assert_eq "rm=gomi" "$(run_clean notty "$STUB_PATH" bash -l -i -c alias | normalize_aliases)" "A1 login bash AI aliases == {rm=gomi}"
  if gomi_on_shell_dirs; then record "SKIP A1 no-gomi case (real gomi on shell PATH)"
  else assert_eq "" "$(run_clean notty "$EMPTY_PATH" zsh -i -c alias | normalize_aliases)" "A1 zsh AI aliases empty without gomi"; fi
}
test_assert2_function_shadowing() {
  local allow=" npx yarn pnpm pnpx rush rushx bun npm claude mise codex " f bad="" sh
  for sh in zsh bash; do
    bad=""
    for f in $(shadowing_functions "$sh" notty); do
      case "$allow" in *" $f "*) ;; *) bad="$bad $f" ;; esac
    done
    assert_eq "" "$bad" "A2 $sh AI shadowing functions within allowlist"
  done
}
test_assert3_ai_env() {
  assert_eq "$AI_VALUES" "$(run_clean notty "$STUB_PATH" zsh -c "echo $AI_VARS")" "A3 zsh AI env values"
  assert_eq "$AI_VALUES" "$(run_clean notty "$STUB_PATH" bash -l -c "echo $AI_VARS")" "A3 login bash AI env values"
  local sh h i v hv
  for sh in zsh bash; do
    if [ "$sh" = zsh ]; then h=$(run_clean tty "$STUB_PATH" zsh -i -c "echo @@$AI_VARS@@" | marked)
    else h=$(run_clean tty "$STUB_PATH" bash -l -i -c "echo @@$AI_VARS@@" | marked); fi
    # guard against a vacuous pass when the tty run produced nothing
    assert_contains "$h" "," "A3 $sh human probe produced output"
    i=1
    # split on commas only: MANPAGER may be "col -bx" (contains a space)
    while IFS= read -r v; do
      hv=$(printf '%s\n' "$h" | cut -d, -f"$i")
      assert_eq "differs" "$( [ "$hv" = "$v" ] && echo same || echo differs )" "A3 $sh human var #$i is not the AI value"
      i=$((i+1))
    done <<EOF
$(printf '%s\n' "$AI_VALUES" | tr , '\n')
EOF
  done
}
test_assert4_codex_keys() { # compares KEY=value pairs, not just keys
  local a c
  a=$( (sed -n "s/^export \([A-Z_][A-Z_]*\)=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1=\2/p" "$REPO_ROOT/home/dot_shell_common/ai.env.sh"; echo AI_AGENT=1) | sort -u)
  c=$(sed -n '/^\[shell_environment_policy\.set\]/,/^\[/p' "$REPO_ROOT/home/dot_codex/.config.toml" \
      | sed -n "s/^\([A-Z_][A-Z_]*\) *= *['\"]\([^'\"]*\)['\"].*/\1=\2/p" | grep -v '^PATH=' | sort -u)
  assert_eq "$a" "$c" "A4 codex set == ai.env exports + AI_AGENT=1 (keys and values)"
}
test_assert5_human_aliases() {
  local z b out
  # leading newline: the human rc prints a title escape without a newline, which would glue onto the first alias line
  z=$(run_clean tty "$STUB_PATH" zsh -i -c 'printf "\n"; alias' | normalize_aliases)
  b=$(run_clean tty "$STUB_PATH" bash -l -i -c 'printf "\n"; alias' | normalize_aliases)
  for out in "$z" "$b"; do
    assert_contains "$out" "..=cd .." "A5 human has .."
    assert_contains "$out" "...=cd ../.." "A5 human has ..."
    assert_contains "$out" "rm=gomi" "A5 human has rm=gomi"
    if [ "$(uname -s)" = Linux ]; then assert_contains "$out" "ls=ls --color=auto" "A5 human has Linux color alias"; fi
  done
}
test_assert6_nonlogin_bash() {
  local v
  v=$(run_clean notty "$STUB_PATH" bash -i -c 'echo EDITOR=$EDITOR; alias .. >/dev/null 2>&1 && echo HAS_DOTDOT')
  assert_contains "$v" "EDITOR=true" "A6 non-login AI bash EDITOR=true"
  assert_not_contains "$v" "HAS_DOTDOT" "A6 non-login AI bash has no .."
  v=$(run_clean tty "$STUB_PATH" bash -i -c 'echo EDITOR=$EDITOR; alias .. >/dev/null 2>&1 && echo HAS_DOTDOT')
  assert_not_contains "$v" "EDITOR=true" "A6 non-login human bash EDITOR not AI"
  assert_contains "$v" "HAS_DOTDOT" "A6 non-login human bash has .."
}
test_assert7_no_title_escape() {
  local esc; esc=$(printf '\033]0;')
  assert_not_contains "$(run_clean notty "$STUB_PATH" zsh -i -c true)" "$esc" "A7 zsh AI output has no ]0;"
  assert_not_contains "$(run_clean notty "$STUB_PATH" bash -l -i -c true)" "$esc" "A7 login bash AI output has no ]0;"
}
test_assert8_missing_is_human() {
  local copy="$TMP_BASE/home8" v
  cp -R "$FIX_HOME" "$copy" && rm -f "$copy/.shell_common/is_human.sh"
  v=$(FIX_HOME=$copy run_clean notty "$STUB_PATH" zsh -i -c 'echo EDITOR=$EDITOR; alias .. >/dev/null 2>&1 && echo HAS_DOTDOT')
  assert_not_contains "$v" "EDITOR=true" "A8 zsh falls to human (env)"
  assert_contains "$v" "HAS_DOTDOT" "A8 zsh falls to human (alias)"
  v=$(FIX_HOME=$copy run_clean notty "$STUB_PATH" bash -l -i -c 'echo EDITOR=$EDITOR; alias .. >/dev/null 2>&1 && echo HAS_DOTDOT')
  assert_not_contains "$v" "EDITOR=true" "A8 login bash falls to human (env)"
  assert_contains "$v" "HAS_DOTDOT" "A8 login bash falls to human (alias)"
  v=$(FIX_HOME=$copy run_clean notty "$STUB_PATH" bash -i -c 'alias .. >/dev/null 2>&1 && echo HAS_DOTDOT')
  assert_contains "$v" "HAS_DOTDOT" "A8 non-login bash falls to human"
}
test_assert9_path_same() {
  assert_eq "$(run_clean notty "$STUB_PATH" zsh -i -c 'echo $PATH')" \
    "$(run_clean tty "$STUB_PATH" zsh -i -c 'echo @@$PATH@@' | marked)" "A9 PATH identical (zsh AI vs human)"
}
test_env_var_selects_ai_on_tty() {
  assert_eq "true" "$(EXTRA_ENV="CLAUDECODE=1" run_clean tty "$STUB_PATH" zsh -i -c 'echo @@$EDITOR@@' | marked)" "CLAUDECODE=1 on a TTY selects AI"
  assert_eq "true" "$(EXTRA_ENV="AI_AGENT=1" run_clean tty "$STUB_PATH" zsh -i -c 'echo @@$EDITOR@@' | marked)" "AI_AGENT=1 on a TTY selects AI"
}
test_init_pid_guard() {
  local v
  # login bash: init.sh ran in this process, so .bashrc skips ai.env.sh (PID matches)
  v=$(run_clean notty "$STUB_PATH" bash -l -i -c '[ "$_SHELL_COMMON_INIT_PID" = "$$" ] && echo SAME')
  assert_contains "$v" "SAME" "login bash: init.sh PID equals \$\$"
  # the marker must not be exported (spec: export しない)
  v=$(run_clean notty "$STUB_PATH" bash -l -i -c 'env | grep -c "^_SHELL_COMMON_INIT_PID=" || true')
  assert_eq "0" "$v" "_SHELL_COMMON_INIT_PID is not exported"
  # child non-login bash with EDITOR unset must still get ai-env (PID differs, variable not exported)
  v=$(run_clean notty "$STUB_PATH" bash -l -i -c 'echo parent=$EDITOR; env -u EDITOR bash -i -c "echo child=\$EDITOR" 2>/dev/null')
  assert_contains "$v" "parent=true" "control: parent login bash is on the AI branch"
  assert_contains "$v" "child=true" "child non-login bash gets ai-env"
}
test_info_tty_helper_smoke() { # macOS BSD script: confirm the tty helper works at all
  assert_eq "ok" "$(run_clean tty "$STUB_PATH" sh -c 'echo @@ok@@' | marked)" "tty helper prints through script"
}
test_real_home_untouched() {
  local now; now=$(stat -c %Y "$HOME/.zshrc" 2>/dev/null || stat -f %m "$HOME/.zshrc" 2>/dev/null || echo none)
  assert_eq "$REAL_RC_MTIME" "$now" "real ~/.zshrc untouched by the test"
}

wait_for_file() { local i=0; while [ "$i" -lt 50 ]; do [ -e "$1" ] && return 0; sleep 0.1; i=$((i+1)); done; return 1; }
wait_for_gone() { local i=0; while [ "$i" -lt 50 ]; do [ -e "$1" ] || return 0; sleep 0.1; i=$((i+1)); done; return 1; }
test_prune_once_per_day() {
  sleep 1 # let detached prunes started by earlier tests finish before resetting state
  rm -rf "$FIX_HOME/.local/state/gomi-prune" "$TMP_BASE/prune.calls"
  run_clean notty "$STUB_PATH" zsh -i -c true >/dev/null
  wait_for_file "$TMP_BASE/prune.calls"; wait_for_gone "$FIX_HOME/.local/state/gomi-prune/lock"
  run_clean notty "$STUB_PATH" zsh -i -c true >/dev/null; sleep 0.5; wait_for_gone "$FIX_HOME/.local/state/gomi-prune/lock"
  assert_eq "1" "$(wc -l <"$TMP_BASE/prune.calls" | tr -d ' ')" "prune called once for two starts"
  assert_eq "yes" "$([ -e "$FIX_HOME/.local/state/gomi-prune/stamp" ] && echo yes)" "stamp created"
  assert_eq "no" "$([ -d "$FIX_HOME/.local/state/gomi-prune/lock" ] && echo yes || echo no)" "lock released"
  assert_eq "--prune=30d -f" "$(head -1 "$TMP_BASE/prune.calls")" "prune is called with --prune=30d -f"
}
test_prune_relative_state_never_starts() {
  rm -f "$TMP_BASE/prune.calls"
  EXTRA_ENV="XDG_STATE_HOME=relative/state" run_clean notty "$STUB_PATH" zsh -i -c true >/dev/null; sleep 0.5
  assert_eq "no" "$([ -e "$TMP_BASE/prune.calls" ] && echo yes || echo no)" "relative XDG_STATE_HOME: no prune"
}
test_prune_log_symlink_not_followed() {
  local d="$FIX_HOME/.local/state/gomi-prune" target="$TMP_BASE/victim"
  sleep 1 # let detached prunes started by earlier tests finish before resetting state
  rm -rf "$d"; mkdir -p "$d"; : >"$target"; ln -s "$target" "$d/prune.log"
  mkdir -p "$TMP_BASE/failgomi"
  printf '#!/bin/sh\ncase "$1" in --version) exit 0;; esac\n: >"%s"\nexit 3\n' "$TMP_BASE/failgomi.ran" >"$TMP_BASE/failgomi/gomi"
  chmod +x "$TMP_BASE/failgomi/gomi"
  rm -f "$TMP_BASE/failgomi.ran"
  run_clean notty "$TMP_BASE/failgomi" zsh -i -c true >/dev/null
  wait_for_file "$TMP_BASE/failgomi.ran"; wait_for_gone "$FIX_HOME/.local/state/gomi-prune/lock"
  assert_eq "yes" "$([ -e "$TMP_BASE/failgomi.ran" ] && echo yes || echo no)" "failing prune actually ran"
  assert_eq "0" "$(wc -c <"$target" | tr -d ' ')" "failing prune does not write through a prune.log symlink"
}

test_histfile_under_zsh_dir() {
  assert_eq "$FIX_HOME/.zsh/.zsh_history" "$(run_clean tty "$STUB_PATH" zsh -i -c 'print -r -- @@$HISTFILE@@' | marked)" "HISTFILE is \$HOME/.zsh/.zsh_history"
}
test_zdotdir_inherited() { # shells that inherited ZDOTDIR=$HOME/.zsh must still reach ~/.zshrc with ZDOTDIR dropped (T14)
  local ze="ZDOTDIR=$FIX_HOME/.zsh"
  assert_eq "rm=gomi" "$(EXTRA_ENV="$ze" run_clean notty "$STUB_PATH" zsh -i -c alias | normalize_aliases)" "ZDOTDIR inherited: AI aliases == {rm=gomi}"
  assert_eq "unset" "$(EXTRA_ENV="$ze" run_clean notty "$STUB_PATH" zsh -i -c 'print -r -- @@${ZDOTDIR-unset}@@' | marked)" "ZDOTDIR inherited: ZDOTDIR is unset after startup"
}
test_zdotdir_inherited_human() {
  local ze="ZDOTDIR=$FIX_HOME/.zsh" out
  out=$(EXTRA_ENV="$ze" run_clean tty "$STUB_PATH" zsh -i -c 'printf "\n"; alias' | normalize_aliases)
  assert_contains "$out" "..=cd .." "ZDOTDIR inherited: human has .."
}
test_zdotdir_loop_guard() { # pre-migration ~/.zshenv exports ZDOTDIR and sources the shim again; the guard must stop the loop
  local copy="$TMP_BASE/home_loop" out rc
  cp -R "$FIX_HOME" "$copy"
  printf 'export ZDOTDIR=$HOME/.zsh\n[ -f "$ZDOTDIR/.zshenv" ] && source "$ZDOTDIR/.zshenv"\n' >"$copy/.zshenv"
  out=$(env -i HOME="$copy" PATH="$SHELL_DIRS:/usr/bin:/bin" TERM=xterm ZDOTDIR="$copy/.zsh" timeout 10 zsh -c 'echo ok' </dev/null 2>/dev/null); rc=$?
  assert_eq "ok" "$out" "loop guard: shell with pre-migration ~/.zshenv terminates and runs the command"
  assert_eq "0" "$rc" "loop guard: exit 0"
}
test_zdotdir_shim_silent() { # the shim must not print to stderr even when the marker directory is missing
  local err
  # tools.sh calls `mise list` through the mise() wrapper in functions.sh; a no-op stub keeps that unrelated noise out of stderr
  mkdir -p "$TMP_BASE/misestub"; printf '#!/bin/sh\nexit 0\n' >"$TMP_BASE/misestub/mise"; chmod +x "$TMP_BASE/misestub/mise"
  # shellcheck disable=SC2086 # WATCHDOG is intentionally word-split
  err=$(env -i HOME="$FIX_HOME" PATH="$TMP_BASE/misestub:$SHELL_DIRS:/usr/bin:/bin" TERM=xterm ZDOTDIR="$FIX_HOME/.zsh" XDG_STATE_HOME="$FIX_HOME/nonexistent/state" $WATCHDOG zsh -c true 2>&1 >/dev/null </dev/null)
  assert_eq "" "$err" "shim: empty stderr when marker directory is missing"
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  ( "$t" ) </dev/null || record "FAIL $t crashed"
done

cat "$RESULTS_FILE"
echo "INFO uname=$(uname -s)"
echo "INFO timeout=$(command -v timeout gtimeout | tr '\n' ' ')"
echo "INFO man-backspaces=$(env MANPAGER=cat man ls 2>/dev/null | grep -c "$(printf '\b')")"
echo "INFO fixture zsh -l PATH duplicates=$(run_clean notty "$STUB_PATH" zsh -l -c 'printf %s "$PATH" | tr : "\n" | sort | uniq -d' | wc -l | tr -d ' ')"
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
printf '%d run, %d failed\n' "$(grep -c -E '^(PASS|FAIL)' "$RESULTS_FILE")" "$failed"
[ "$failed" -eq 0 ]
