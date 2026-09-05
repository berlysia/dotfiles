#!/usr/bin/env bash
# shellcheck shell=bash
# Invariants for the hook-dependency install mechanism.
#
# These guard the defect class that let a dependency addition silently fail to
# reach ~/.claude/node_modules: chezmoi applies every entry in ASCII order of
# its target path, so a script's name decides which files it can already see.
# See docs/decisions/0014-hook-deps-install-phase.md.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/home/.chezmoiscripts"
INSTALLER_NAME="00-install-hook-deps"
VERIFIER_NAME="zz-verify-hook-deps"

TMP_ROOT="$(mktemp -d -t hook-deps-inv-XXXXXX)"
trap 'rm -rf "${TMP_ROOT}"' EXIT

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo -e "${GREEN}✓${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}
fail() {
  echo -e "${RED}✗${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

# Effective run_after_ execution order: chezmoi strips the run_after_ prefix and
# sorts the remaining target names. Derived from the live directory so a rename
# or a newly added script is caught rather than assumed.
run_after_order() {
  local f base
  for f in "${SCRIPTS_DIR}/"run_after_*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    base="${base#run_after_}"
    base="${base%.tmpl}"
    base="${base%.sh}"
    printf '%s\n' "$base"
  done | LC_ALL=C sort
}

# --- assertion A: installer runs first, verifier runs last ---
order_first="$(run_after_order | head -1)"
order_last="$(run_after_order | tail -1)"

if [ "$order_first" = "$INSTALLER_NAME" ]; then
  pass "A1: ${INSTALLER_NAME} sorts first among run_after_ scripts"
else
  fail "A1: expected ${INSTALLER_NAME} first, got ${order_first}"
fi

if [ "$order_last" = "$VERIFIER_NAME" ]; then
  pass "A2: ${VERIFIER_NAME} sorts last among run_after_ scripts"
else
  fail "A2: expected ${VERIFIER_NAME} last, got ${order_last}"
fi

# --- assertion B: a run_after_ script sees the package.json deployed by the
#     same apply (the property the old 7c placement did not have) ---
b_src="${TMP_ROOT}/b/src"
b_home="${TMP_ROOT}/b/home"
mkdir -p "${b_src}/home/.chezmoiscripts" "${b_src}/home/dot_claude" "${b_home}"
printf 'home\n' > "${b_src}/.chezmoiroot"
printf 'v1\n' > "${b_src}/home/dot_claude/package.json"
cat > "${b_src}/home/.chezmoiscripts/run_after_00-probe.sh" <<'PROBE'
#!/bin/bash
cat "$HOME/.claude/package.json" >> "$HOME/seen.log"
PROBE

# HOME must be overridden as well as --destination: the probe script resolves
# its own paths through $HOME, so without this it would read the real
# ~/.claude/package.json and write into the real home directory.
HOME="$b_home" chezmoi apply --source "$b_src" --destination "$b_home" --no-tty >/dev/null 2>&1
printf 'v2\n' > "${b_src}/home/dot_claude/package.json"
HOME="$b_home" chezmoi apply --source "$b_src" --destination "$b_home" --no-tty >/dev/null 2>&1

b_second="$(tail -1 "${b_home}/seen.log" 2>/dev/null || true)"
if [ "$b_second" = "v2" ]; then
  pass "B: run_after_ probe read the package.json deployed by the same apply"
else
  fail "B: run_after_ probe read '${b_second}', expected 'v2'"
fi

# --- assertion C: the verifier stats the marker and nothing else ---
c_home="${TMP_ROOT}/c/home"
c_stub="${TMP_ROOT}/c/stub"
mkdir -p "${c_home}/.claude" "${c_stub}"
c_log="${TMP_ROOT}/c/invoked.log"
: > "$c_log"

for stub_cmd in mise bun; do
  cat > "${c_stub}/${stub_cmd}" <<STUB
#!/bin/sh
echo "${stub_cmd}" >> "${c_log}"
exit 0
STUB
  chmod +x "${c_stub}/${stub_cmd}"
done

c_rendered="${TMP_ROOT}/c/verifier.sh"
chezmoi execute-template --source "${REPO_ROOT}/home" \
  < "${SCRIPTS_DIR}/run_after_${VERIFIER_NAME}.sh.tmpl" > "$c_rendered"

printf 'reason=synthetic\n' > "${c_home}/.claude/.hook-deps-install-failed"
PATH="${c_stub}:${PATH}" HOME="$c_home" bash "$c_rendered" >/dev/null 2>&1 || true

if [ ! -s "$c_log" ]; then
  pass "C: verifier invoked neither mise nor bun"
else
  fail "C: verifier invoked $(tr '\n' ' ' < "$c_log")"
fi

# --- assertion D: marker present means non-zero exit plus a recovery command ---
d_home="${TMP_ROOT}/d/home"
mkdir -p "${d_home}/.claude"
d_rendered="${TMP_ROOT}/d/verifier.sh"
chezmoi execute-template --source "${REPO_ROOT}/home" \
  < "${SCRIPTS_DIR}/run_after_${VERIFIER_NAME}.sh.tmpl" > "$d_rendered"

HOME="$d_home" bash "$d_rendered" >/dev/null 2>&1 && d_clean_rc=0 || d_clean_rc=$?
if [ "$d_clean_rc" -eq 0 ]; then
  pass "D1: verifier exits 0 when no marker is present"
else
  fail "D1: verifier exited ${d_clean_rc} with no marker present"
fi

printf 'reason=bun-install-failed\n' > "${d_home}/.claude/.hook-deps-install-failed"
d_err="${TMP_ROOT}/d/stderr.txt"
HOME="$d_home" bash "$d_rendered" 2> "$d_err" >/dev/null && d_fail_rc=0 || d_fail_rc=$?
if [ "$d_fail_rc" -ne 0 ] && grep -q 'cd ~/.claude && bun install' "$d_err"; then
  pass "D2: verifier exits non-zero and prints the recovery command"
else
  fail "D2: rc=${d_fail_rc}, stderr lacked the recovery command"
fi

# --- assertion E: installer branches and marker hygiene ---
mkdir -p "${TMP_ROOT}/e"
e_rendered="${TMP_ROOT}/e/installer.sh"
chezmoi execute-template --source "${REPO_ROOT}/home" \
  < "${SCRIPTS_DIR}/run_after_${INSTALLER_NAME}.sh.tmpl" > "$e_rendered"

# no package.json: skip without touching anything
e_home="${TMP_ROOT}/e/home-nopkg"
mkdir -p "${e_home}/.claude"
HOME="$e_home" bash "$e_rendered" >/dev/null 2>&1 && e_nopkg_rc=0 || e_nopkg_rc=$?
if [ "$e_nopkg_rc" -eq 0 ] && [ ! -f "${e_home}/.claude/.hook-deps-install-failed" ]; then
  pass "E1: installer skips and writes no marker when package.json is absent"
else
  fail "E1: rc=${e_nopkg_rc}, marker presence unexpected"
fi

# failing bun: marker written with fixed fields, mode 600, no stderr copied
e_home2="${TMP_ROOT}/e/home-fail"
e_stub2="${TMP_ROOT}/e/stub-fail"
mkdir -p "${e_home2}/.claude" "${e_stub2}"
printf '{"dependencies":{}}\n' > "${e_home2}/.claude/package.json"
cat > "${e_stub2}/bun" <<'STUB'
#!/bin/sh
echo "SECRET_TOKEN_SHOULD_NOT_BE_COPIED" >&2
exit 1
STUB
chmod +x "${e_stub2}/bun"
e_marker="${e_home2}/.claude/.hook-deps-install-failed"
# Pre-create the marker world-readable: rename-into-place must replace the mode,
# whereas redirecting into the existing file would keep 644.
: > "$e_marker"
chmod 644 "$e_marker"
PATH="${e_stub2}:/usr/bin:/bin" HOME="$e_home2" bash "$e_rendered" >/dev/null 2>&1 &&
  e_fail_rc=0 || e_fail_rc=$?
e_mode="$(stat -c '%a' "$e_marker" 2>/dev/null || stat -f '%Lp' "$e_marker" 2>/dev/null || echo none)"
if [ "$e_fail_rc" -eq 0 ] &&
  [ -f "$e_marker" ] &&
  [ "$e_mode" = "600" ] &&
  grep -q '^reason=bun-install-failed$' "$e_marker" &&
  ! grep -q 'SECRET_TOKEN_SHOULD_NOT_BE_COPIED' "$e_marker"; then
  pass "E2: install failure exits 0, replaces the marker at 600, copies no stderr"
else
  fail "E2: rc=${e_fail_rc}, mode=${e_mode}, marker content unexpected"
fi

# recovery: a later successful install clears the marker
cat > "${e_stub2}/bun" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "${e_stub2}/bun"
PATH="${e_stub2}:/usr/bin:/bin" HOME="$e_home2" bash "$e_rendered" >/dev/null 2>&1 &&
  e_ok_rc=0 || e_ok_rc=$?
if [ "$e_ok_rc" -eq 0 ] && [ ! -f "$e_marker" ]; then
  pass "E3: a successful install removes the marker"
else
  fail "E3: rc=${e_ok_rc}, marker survived a successful install"
fi

# --- assertion H: no bun means skip with no marker (accepted non-goal) ---
h_home="${TMP_ROOT}/h/home"
mkdir -p "${h_home}/.claude"
printf '{"dependencies":{}}\n' > "${h_home}/.claude/package.json"
# /usr/bin:/bin carries coreutils but neither bun nor mise.
PATH="/usr/bin:/bin" HOME="$h_home" bash "$e_rendered" >/dev/null 2>&1 &&
  h_rc=0 || h_rc=$?
if [ "$h_rc" -eq 0 ] && [ ! -f "${h_home}/.claude/.hook-deps-install-failed" ]; then
  pass "H: no bun on PATH means skip with no marker (accepted non-goal)"
else
  fail "H: rc=${h_rc}, marker presence unexpected"
fi

# --- assertion I: an unwritable marker path makes the installer fail now ---
# This is the only branch where the installer breaks its own "always exit 0"
# rule, because the deferral channel it would otherwise use is the thing that
# failed. Every other branch has an assertion; this one needs one too.
if [ "$(id -u)" -eq 0 ]; then
  pass "I: skipped (root bypasses the read-only directory this test needs)"
else
  i_home="${TMP_ROOT}/i/home"
  i_stub="${TMP_ROOT}/i/stub"
  mkdir -p "${i_home}/.claude" "${i_stub}"
  printf '{"dependencies":{}}\n' > "${i_home}/.claude/package.json"
  cat > "${i_stub}/bun" <<'STUB'
#!/bin/sh
exit 1
STUB
  chmod +x "${i_stub}/bun"
  chmod 500 "${i_home}/.claude"
  PATH="${i_stub}:/usr/bin:/bin" HOME="$i_home" bash "$e_rendered" >/dev/null 2>&1 &&
    i_rc=0 || i_rc=$?
  # Restore write permission so the EXIT trap can clean TMP_ROOT up.
  chmod 700 "${i_home}/.claude"
  if [ "$i_rc" -eq 1 ]; then
    pass "I: installer exits 1 when it cannot record the failure"
  else
    fail "I: rc=${i_rc}, expected 1"
  fi
fi

# --- assertion F: no hook-deps installer may live in the ASCII-ordered phase ---
# Heuristic, not a proof: it matches the two known shapes (the deleted 7c and
# the promoted installer). A future offender written with a different variable
# name, or with no variable at all, would slip past. It exists to catch the
# specific regression of reintroducing 7c, not to decide the general question.
f_offenders=""
for f in "${SCRIPTS_DIR}/"*; do
  base="$(basename "$f")"
  case "$base" in
  run_before_* | run_after_*) continue ;;
  esac
  if grep -q 'CLAUDE_DIR="\$HOME/.claude"' "$f" 2>/dev/null &&
    grep -q 'bun install' "$f" 2>/dev/null; then
    f_offenders="${f_offenders} ${base}"
  fi
done
if [ -z "$f_offenders" ]; then
  pass "F: no ASCII-phase script installs into ~/.claude"
else
  fail "F: ASCII-phase script(s) install into ~/.claude:${f_offenders}"
fi

# --- assertion G: the deployed bunfig carries the root quarantine settings ---
g_rendered="$(chezmoi execute-template --source "${REPO_ROOT}/home" \
  < "${REPO_ROOT}/home/dot_claude/private_bunfig.toml.tmpl")"
g_excludes="$(grep '^minimumReleaseAgeExcludes' "${REPO_ROOT}/bunfig.toml" || true)"

if [ -z "$g_excludes" ]; then
  # Guard against failing open: an empty pattern makes `grep -qF` match
  # anything, which would let this assertion pass while the property is gone.
  fail "G: root bunfig.toml has no minimumReleaseAgeExcludes line to propagate"
elif printf '%s\n' "$g_rendered" | grep -qF 'minimumReleaseAge = 604800' &&
  printf '%s\n' "$g_rendered" | grep -qF "$g_excludes"; then
  pass "G: deployed bunfig carries the root minimumReleaseAge settings"
else
  fail "G: deployed bunfig lost the root minimumReleaseAge settings"
fi

echo ""
echo "hook-deps invariants: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
[ "$FAIL_COUNT" -eq 0 ]
