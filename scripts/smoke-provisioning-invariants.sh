#!/usr/bin/env bash
# shellcheck shell=bash
# Invariants for the provisioning scripts that run after chezmoi deploys files.
#
# These guard the defect class that let a dependency addition (ADR-0014) and a
# mise pin change (ADR-0017) silently fail to take effect: chezmoi applies
# every entry in ASCII order of its target path, so a script's name decides
# which files it can already see.
# See docs/decisions/0014-hook-deps-install-phase.md and
# docs/decisions/0017-provisioning-after-deploy.md.
# It also covers the .install-state contract between the textlint installer
# (writer) and the textlint-global wrapper (reader), in assertion L.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="${REPO_ROOT}/home/.chezmoiscripts"
TOOLCHAIN_NAME="00-install-mise-tools"
INSTALLER_NAME="10-install-hook-deps"
ROOT_DEPS_NAME="10-install-root-deps"
APM_SKILLS_NAME="10-install-apm-skills"
VERIFIER_NAME="zz-verify-provisioning"

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

# render_script TEMPLATE OUTPUT
# Renders one script template. A missing template, or one chezmoi fails to
# render (for example a misspelled partial name), is recorded as a failure and
# replaced by a stub that exits 97. The remaining assertions then still run and
# report, instead of `set -e` aborting the whole file.
render_script() {
  local template="$1" output="$2" data="${3:-}"
  local -a data_args=()
  [ -n "$data" ] && data_args=(--override-data "$data")
  if [ ! -f "$template" ]; then
    fail "render: $(basename "$template") does not exist"
    printf '#!/bin/sh\nexit 97\n' > "$output"
  elif ! chezmoi execute-template --source "${REPO_ROOT}/home" ${data_args[@]+"${data_args[@]}"} < "$template" > "$output" 2> "${output}.err"; then
    fail "render: $(basename "$template") failed to render: $(head -1 "${output}.err")"
    printf '#!/bin/sh\nexit 97\n' > "$output"
  fi
}

# Effective run_after_ execution order: chezmoi strips every attribute
# (run_, onchange_/once_, after_) and sorts the remaining target names, so
# run_onchange_after_ and run_once_after_ scripts share one ordering with
# run_after_. Derived from the live directory so a rename or a newly added
# script is caught rather than assumed.
run_after_order() {
  local f base
  for f in "${SCRIPTS_DIR}/"run_after_* "${SCRIPTS_DIR}/"run_onchange_after_* "${SCRIPTS_DIR}/"run_once_after_*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    base="${base#run_}"
    base="${base#onchange_}"
    base="${base#once_}"
    base="${base#after_}"
    base="${base%.tmpl}"
    base="${base%.sh}"
    base="${base%.ps1}"
    printf '%s\n' "$base"
  done | LC_ALL=C sort
}

# --- assertion A: toolchain first, dependency trees next, verifier last ---
# The names are the only ordering primitive inside run_after_. 00- is the
# toolchain band (binaries later scripts run), 10- the dependency-tree band
# (packages later scripts load), zz- the final verdict. chezmoi does not
# enforce this; these assertions do. See ADR-0017.
order_first="$(run_after_order | head -1)"
# The 10- entries that directly follow the toolchain, space-separated. awk reads
# to the end instead of exiting at the first non-10- entry, so the producer is
# never cut off by SIGPIPE under pipefail.
order_band="$(run_after_order | awk 'NR > 1 && !stop { if (/^10-/) printf "%s ", $0; else stop = 1 }')"
order_last="$(run_after_order | tail -1)"

if [ "$order_first" = "$TOOLCHAIN_NAME" ]; then
  pass "A1: ${TOOLCHAIN_NAME} sorts first among run_after_ scripts"
else
  fail "A1: expected ${TOOLCHAIN_NAME} first, got ${order_first}"
fi

# Membership, not positions: the band may hold other dependency-tree installers
# (10-install-textlint-deps), and they do not depend on each other.
a3_missing=""
for a3_name in "$INSTALLER_NAME" "$ROOT_DEPS_NAME" "$APM_SKILLS_NAME"; do
  case " ${order_band}" in
  *" ${a3_name} "*) ;;
  *) a3_missing="${a3_missing} ${a3_name}" ;;
  esac
done
if [ -z "$a3_missing" ]; then
  pass "A3: the 10- band follows the toolchain and holds the dependency installers"
else
  fail "A3: 10- band after the toolchain is '${order_band}', missing:${a3_missing}"
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

# --- assertion C: the verifier stats the markers and nothing else ---
c_home="${TMP_ROOT}/c/home"
c_stub="${TMP_ROOT}/c/stub"
mkdir -p "${c_home}/.claude" "${c_stub}"
c_log="${TMP_ROOT}/c/invoked.log"
: > "$c_log"

for stub_cmd in mise bun apm; do
  cat > "${c_stub}/${stub_cmd}" <<STUB
#!/bin/sh
echo "${stub_cmd}" >> "${c_log}"
exit 0
STUB
  chmod +x "${c_stub}/${stub_cmd}"
done

c_rendered="${TMP_ROOT}/c/verifier.sh"
render_script "${SCRIPTS_DIR}/run_after_${VERIFIER_NAME}.sh.tmpl" "$c_rendered"

printf 'reason=synthetic\n' > "${c_home}/.claude/.hook-deps-install-failed"
printf 'reason=synthetic\n' > "${c_home}/.claude/.root-deps-install-failed"
printf 'reason=synthetic\n' > "${c_home}/.claude/.apm-skills-install-failed"
PATH="${c_stub}:${PATH}" HOME="$c_home" bash "$c_rendered" >/dev/null 2>&1 || true

if [ ! -s "$c_log" ]; then
  pass "C: verifier invoked none of mise, bun, apm"
else
  fail "C: verifier invoked $(tr '\n' ' ' < "$c_log")"
fi

# --- assertion D: each marker means non-zero exit plus its recovery command ---
mkdir -p "${TMP_ROOT}/d"
d_rendered="${TMP_ROOT}/d/verifier.sh"
render_script "${SCRIPTS_DIR}/run_after_${VERIFIER_NAME}.sh.tmpl" "$d_rendered"

d_home="${TMP_ROOT}/d/home-clean"
mkdir -p "${d_home}/.claude"
HOME="$d_home" bash "$d_rendered" >/dev/null 2>&1 && d_clean_rc=0 || d_clean_rc=$?
if [ "$d_clean_rc" -eq 0 ]; then
  pass "D1: verifier exits 0 when no marker is present"
else
  fail "D1: verifier exited ${d_clean_rc} with no marker present"
fi

d2_home="${TMP_ROOT}/d/home-hook"
mkdir -p "${d2_home}/.claude"
printf 'reason=bun-install-failed\n' > "${d2_home}/.claude/.hook-deps-install-failed"
d2_err="${TMP_ROOT}/d/stderr-hook.txt"
HOME="$d2_home" bash "$d_rendered" 2> "$d2_err" >/dev/null && d2_rc=0 || d2_rc=$?
if [ "$d2_rc" -ne 0 ] && grep -q 'cd ~/.claude && bun install' "$d2_err" &&
  ! grep -q '\[root-deps\]' "$d2_err"; then
  pass "D2: hook-deps marker alone exits non-zero with only its recovery command"
else
  fail "D2: rc=${d2_rc}, stderr did not match the hook-deps report"
fi

d3_home="${TMP_ROOT}/d/home-root"
mkdir -p "${d3_home}/.claude"
printf 'reason=bun-install-frozen-lockfile-failed\n' > "${d3_home}/.claude/.root-deps-install-failed"
d3_err="${TMP_ROOT}/d/stderr-root.txt"
HOME="$d3_home" bash "$d_rendered" 2> "$d3_err" >/dev/null && d3_rc=0 || d3_rc=$?
if [ "$d3_rc" -ne 0 ] && grep -q 'bun install --frozen-lockfile' "$d3_err" &&
  ! grep -q '\[hook-deps\]' "$d3_err"; then
  pass "D3: root-deps marker alone exits non-zero with only its recovery command"
else
  fail "D3: rc=${d3_rc}, stderr did not match the root-deps report"
fi

d4_home="${TMP_ROOT}/d/home-both"
mkdir -p "${d4_home}/.claude"
printf 'reason=bun-install-failed\n' > "${d4_home}/.claude/.hook-deps-install-failed"
printf 'reason=bun-install-frozen-lockfile-failed\n' > "${d4_home}/.claude/.root-deps-install-failed"
d4_err="${TMP_ROOT}/d/stderr-both.txt"
HOME="$d4_home" bash "$d_rendered" 2> "$d4_err" >/dev/null && d4_rc=0 || d4_rc=$?
if [ "$d4_rc" -ne 0 ] && grep -q 'cd ~/.claude && bun install' "$d4_err" &&
  grep -q 'bun install --frozen-lockfile' "$d4_err"; then
  pass "D4: both markers are reported in one run"
else
  fail "D4: rc=${d4_rc}, stderr lacked one of the two reports"
fi

d5_home="${TMP_ROOT}/d/home-apm"
mkdir -p "${d5_home}/.claude"
printf 'reason=apm-install-failed\n' > "${d5_home}/.claude/.apm-skills-install-failed"
d5_err="${TMP_ROOT}/d/stderr-apm.txt"
HOME="$d5_home" bash "$d_rendered" 2> "$d5_err" >/dev/null && d5_rc=0 || d5_rc=$?
if [ "$d5_rc" -ne 0 ] && grep -q 'mise install github:microsoft/apm && apm install -g' "$d5_err" &&
  ! grep -q '\[hook-deps\]' "$d5_err" && ! grep -q '\[root-deps\]' "$d5_err"; then
  pass "D5: apm-skills marker alone exits non-zero with only its recovery command"
else
  fail "D5: rc=${d5_rc}, stderr did not match the apm-skills report"
fi

# --- assertion E: installer branches and marker hygiene ---
mkdir -p "${TMP_ROOT}/e"
e_rendered="${TMP_ROOT}/e/installer.sh"
render_script "${SCRIPTS_DIR}/run_after_${INSTALLER_NAME}.sh.tmpl" "$e_rendered"

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

# --- assertion K: toolchain installer exit codes ---
k_dir="${TMP_ROOT}/k"
k_stub="${k_dir}/stub"
mkdir -p "${k_dir}/home" "$k_stub"
k_rendered="${k_dir}/toolchain.sh"
render_script "${SCRIPTS_DIR}/run_after_${TOOLCHAIN_NAME}.sh.tmpl" "$k_rendered"

# K1: a failing `mise install` is a warning, so later run_after_ scripts run
cat > "${k_stub}/mise" <<'STUB'
#!/bin/sh
[ "$1" = "install" ] && exit 1
exit 0
STUB
chmod +x "${k_stub}/mise"
PATH="${k_stub}:/usr/bin:/bin" HOME="${k_dir}/home" bash "$k_rendered" >/dev/null 2>&1 &&
  k1_rc=0 || k1_rc=$?
if [ "$k1_rc" -eq 0 ]; then
  pass "K1: a failed mise install exits 0"
else
  fail "K1: rc=${k1_rc}, expected 0"
fi

# K2: no mise on PATH means bootstrap is incomplete, which fails the apply
PATH="/usr/bin:/bin" HOME="${k_dir}/home" bash "$k_rendered" >/dev/null 2>&1 &&
  k2_rc=0 || k2_rc=$?
if [ "$k2_rc" -eq 1 ]; then
  pass "K2: missing mise exits 1"
else
  fail "K2: rc=${k2_rc}, expected 1"
fi

# --- assertion J: root-deps installer branches and marker hygiene ---
j_dir="${TMP_ROOT}/j"
mkdir -p "$j_dir"
j_rendered="${j_dir}/root-deps.sh"
render_script "${SCRIPTS_DIR}/run_after_${ROOT_DEPS_NAME}.sh.tmpl" "$j_rendered"

# J1: failing bun: exit 0, marker replaced at 600, fixed fields, no stderr copied
j_home="${j_dir}/home-fail"
j_stub="${j_dir}/stub-fail"
mkdir -p "${j_home}/.claude" "$j_stub"
cat > "${j_stub}/bun" <<'STUB'
#!/bin/sh
echo "SECRET_TOKEN_SHOULD_NOT_BE_COPIED" >&2
exit 1
STUB
chmod +x "${j_stub}/bun"
j_marker="${j_home}/.claude/.root-deps-install-failed"
: > "$j_marker"
chmod 644 "$j_marker"
PATH="${j_stub}:/usr/bin:/bin" HOME="$j_home" bash "$j_rendered" >/dev/null 2>&1 &&
  j1_rc=0 || j1_rc=$?
j_mode="$(stat -c '%a' "$j_marker" 2>/dev/null || stat -f '%Lp' "$j_marker" 2>/dev/null || echo none)"
if [ "$j1_rc" -eq 0 ] &&
  [ "$j_mode" = "600" ] &&
  grep -q '^reason=bun-install-frozen-lockfile-failed$' "$j_marker" &&
  ! grep -q 'SECRET_TOKEN_SHOULD_NOT_BE_COPIED' "$j_marker"; then
  pass "J1: root-deps failure exits 0, replaces the marker at 600, copies no stderr"
else
  fail "J1: rc=${j1_rc}, mode=${j_mode}, marker content unexpected"
fi

# J2: a later successful install clears the marker
cat > "${j_stub}/bun" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "${j_stub}/bun"
PATH="${j_stub}:/usr/bin:/bin" HOME="$j_home" bash "$j_rendered" >/dev/null 2>&1 &&
  j2_rc=0 || j2_rc=$?
if [ "$j2_rc" -eq 0 ] && [ ! -f "$j_marker" ]; then
  pass "J2: a successful root-deps install removes the marker"
else
  fail "J2: rc=${j2_rc}, marker survived a successful install"
fi

# J3: no bun on PATH means skip with no marker
j3_home="${j_dir}/home-nobun"
mkdir -p "${j3_home}/.claude"
PATH="/usr/bin:/bin" HOME="$j3_home" bash "$j_rendered" >/dev/null 2>&1 &&
  j3_rc=0 || j3_rc=$?
if [ "$j3_rc" -eq 0 ] && [ ! -f "${j3_home}/.claude/.root-deps-install-failed" ]; then
  pass "J3: no bun on PATH means root-deps skips with no marker"
else
  fail "J3: rc=${j3_rc}, marker presence unexpected"
fi

# J4: an unwritable marker path makes the installer fail now
if [ "$(id -u)" -eq 0 ]; then
  pass "J4: skipped (root bypasses the read-only directory this test needs)"
else
  j4_home="${j_dir}/home-ro"
  j4_stub="${j_dir}/stub-ro"
  mkdir -p "${j4_home}/.claude" "$j4_stub"
  cat > "${j4_stub}/bun" <<'STUB'
#!/bin/sh
exit 1
STUB
  chmod +x "${j4_stub}/bun"
  chmod 500 "${j4_home}/.claude"
  PATH="${j4_stub}:/usr/bin:/bin" HOME="$j4_home" bash "$j_rendered" >/dev/null 2>&1 &&
    j4_rc=0 || j4_rc=$?
  chmod 700 "${j4_home}/.claude"
  if [ "$j4_rc" -eq 1 ]; then
    pass "J4: root-deps installer exits 1 when it cannot record the failure"
  else
    fail "J4: rc=${j4_rc}, expected 1"
  fi
fi

# J5: a directory at the marker path must not pass as a recorded failure
# (the guard lives in the shared partial, so one check covers both installers)
j5_home="${j_dir}/home-dir"
j5_stub="${j_dir}/stub-dir"
mkdir -p "${j5_home}/.claude/.root-deps-install-failed" "$j5_stub"
cat > "${j5_stub}/bun" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "${j5_stub}/bun"
PATH="${j5_stub}:/usr/bin:/bin" HOME="$j5_home" bash "$j_rendered" >/dev/null 2>&1 &&
  j5_rc=0 || j5_rc=$?
j5_entries="$(find "${j5_home}/.claude/.root-deps-install-failed" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
if [ "$j5_rc" -eq 1 ] && [ "$j5_entries" = "0" ]; then
  pass "J5: a directory at the marker path makes root-deps exit 1 without writing into it"
else
  fail "J5: rc=${j5_rc}, entries inside the directory=${j5_entries}"
fi

# --- assertion M: APM skill installer branches, state gate and marker hygiene ---
m_dir="${TMP_ROOT}/m"
m_stub="${m_dir}/stub"
mkdir -p "$m_stub"
m_rendered="${m_dir}/apm-skills.sh"
m_vm_rendered="${m_dir}/apm-skills-vm.sh"
render_script "${SCRIPTS_DIR}/run_after_${APM_SKILLS_NAME}.sh.tmpl" "$m_rendered"
render_script "${SCRIPTS_DIR}/run_after_${APM_SKILLS_NAME}.sh.tmpl" "$m_vm_rendered" '{"agent_vm":true}'

# The stub apm: `--version` prints a real-looking line (or nothing with
# APM_STUB_NO_VERSION=1); `install` logs the call, writes a secret-looking line
# to stderr, fails with APM_STUB_FAIL=1, and otherwise creates the lockfile
# unless APM_STUB_NO_LOCK=1.
cat > "${m_stub}/apm" <<'STUB'
#!/bin/sh
case "$1" in
--version)
  [ "${APM_STUB_NO_VERSION:-0}" = 1 ] && exit 0
  echo "[!] A new version of APM is available: 9.9.10 (current: ${APM_STUB_VERSION:-9.9.9})"
  echo "Agent Package Manager (APM) CLI version ${APM_STUB_VERSION:-9.9.9} (stub)"
  exit 0
  ;;
install)
  echo install >> "$HOME/apm-install.log"
  echo "SECRET_TOKEN_SHOULD_NOT_BE_COPIED" >&2
  [ "${APM_STUB_FAIL:-0}" = 1 ] && exit 1
  [ "${APM_STUB_NO_LOCK:-0}" = 1 ] || : > "$HOME/.apm/apm.lock.yaml"
  exit 0
  ;;
esac
exit 0
STUB
chmod +x "${m_stub}/apm"

# m_home NAME: a fresh HOME with ~/.apm/apm.yml and ~/.claude
m_home() {
  local h="${m_dir}/$1"
  mkdir -p "${h}/.apm" "${h}/.claude"
  printf 'name: probe\n' > "${h}/.apm/apm.yml"
  printf '%s' "$h"
}
# m_run HOME SCRIPT [VAR=VALUE...]: runs the installer with the stub first on PATH.
# bash is resolved from the caller's PATH, not the trimmed one. Callers that do
# not check the exit code append `|| true`: the smoke runs under `set -e`, and
# the exit-97 stub that stands in for a missing template must not abort it.
M_BASH="$(command -v bash)"
m_run() {
  local h="$1" script="$2"
  shift 2
  env "$@" PATH="${m_stub}:/usr/bin:/bin" HOME="$h" "$M_BASH" "$script" >/dev/null 2>&1
}
m_installs() {
  local n
  n="$(grep -c '^install$' "$1/apm-install.log" 2>/dev/null)" || true
  printf '%s\n' "${n:-0}"
}
# M10-M12 need a PATH with neither apm nor mise on it
for m_cmd in apm mise; do
  if (PATH="/usr/bin:/bin" && command -v "$m_cmd" >/dev/null 2>&1); then
    fail "M: /usr/bin:/bin already provides ${m_cmd}; M10/M11 cannot simulate its absence"
  fi
done
m_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || echo none; }
m_sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# M1: failing install: exit 0, marker at 600 with fixed fields, no stderr copied, no state
m1="$(m_home m1)"
m_run "$m1" "$m_rendered" APM_STUB_FAIL=1 && m1_rc=0 || m1_rc=$?
m1_marker="${m1}/.claude/.apm-skills-install-failed"
if [ "$m1_rc" -eq 0 ] && [ "$(m_mode "$m1_marker")" = "600" ] &&
  grep -q '^reason=apm-install-failed$' "$m1_marker" &&
  ! grep -q 'SECRET_TOKEN_SHOULD_NOT_BE_COPIED' "$m1_marker" &&
  [ ! -e "${m1}/.apm/.install-state" ]; then
  pass "M1: install failure exits 0, writes the marker at 600, copies no stderr, leaves no state"
else
  fail "M1: rc=${m1_rc}, marker or state unexpected"
fi

# M2: a later success writes the state and clears the marker
m_run "$m1" "$m_rendered" && m2_rc=0 || m2_rc=$?
if [ "$m2_rc" -eq 0 ] && [ ! -e "$m1_marker" ] &&
  [ "$(cat "${m1}/.apm/.install-state" 2>/dev/null)" = "$(m_sha256 < "${m1}/.apm/apm.yml") 9.9.9" ] &&
  [ "$(m_mode "${m1}/.apm/.install-state")" = "600" ]; then
  pass "M2: a successful install writes '<apm.yml sha256> <version>' at 600 and clears the marker"
else
  fail "M2: rc=${m2_rc}, state='$(cat "${m1}/.apm/.install-state" 2>/dev/null)'"
fi

# M3: same apm.yml and version: no install (the update notice line must not matter)
m3_before="$(m_installs "$m1")"
m_run "$m1" "$m_rendered" && m3_rc=0 || m3_rc=$?
if [ "$m3_rc" -eq 0 ] && [ "$(m_installs "$m1")" = "$m3_before" ]; then
  pass "M3: an unchanged apm.yml and apm version skip apm install"
else
  fail "M3: rc=${m3_rc}, installs ${m3_before} -> $(m_installs "$m1")"
fi

# M4: a changed apm.yml installs again
printf 'name: probe\nversion: 2\n' > "${m1}/.apm/apm.yml"
m4_before="$(m_installs "$m1")"
m_run "$m1" "$m_rendered" || true
if [ "$(m_installs "$m1")" -gt "$m4_before" ]; then
  pass "M4: a changed apm.yml runs apm install"
else
  fail "M4: apm install was skipped after apm.yml changed"
fi

# M5: a changed apm version installs again
m5_before="$(m_installs "$m1")"
m_run "$m1" "$m_rendered" APM_STUB_VERSION=9.9.10 || true
if [ "$(m_installs "$m1")" -gt "$m5_before" ]; then
  pass "M5: a changed apm version runs apm install"
else
  fail "M5: apm install was skipped after the apm version changed"
fi

# M6: a missing lockfile installs again
rm -f "${m1}/.apm/apm.lock.yaml"
m6_before="$(m_installs "$m1")"
m_run "$m1" "$m_rendered" APM_STUB_VERSION=9.9.10 || true
if [ "$(m_installs "$m1")" -gt "$m6_before" ]; then
  pass "M6: a missing apm.lock.yaml runs apm install"
else
  fail "M6: apm install was skipped without a lockfile"
fi

# M7: state matches but a marker is present: install again, and success clears it
printf 'reason=apm-install-failed\n' > "${m1}/.claude/.apm-skills-install-failed"
m7_before="$(m_installs "$m1")"
m_run "$m1" "$m_rendered" APM_STUB_VERSION=9.9.10 || true
if [ "$(m_installs "$m1")" -gt "$m7_before" ] && [ ! -e "${m1}/.claude/.apm-skills-install-failed" ]; then
  pass "M7: a present marker forces apm install even when the state matches, and success clears it"
else
  fail "M7: marker present but install skipped or marker kept"
fi

# M8: exit 0 without a lockfile counts as a failure
m8="$(m_home m8)"
m_run "$m8" "$m_rendered" APM_STUB_NO_LOCK=1 && m8_rc=0 || m8_rc=$?
if [ "$m8_rc" -eq 0 ] && grep -q '^reason=apm-install-failed$' "${m8}/.claude/.apm-skills-install-failed" &&
  [ ! -e "${m8}/.apm/.install-state" ]; then
  pass "M8: apm install exiting 0 without a lockfile is recorded as a failure"
else
  fail "M8: rc=${m8_rc}, marker or state unexpected"
fi

# M9: no version line: install runs, no state is written, and the reason is logged
m9="$(m_home m9)"
m9_out="$(env APM_STUB_NO_VERSION=1 PATH="${m_stub}:/usr/bin:/bin" HOME="$m9" "$M_BASH" "$m_rendered" 2>&1)" || true
if [ "$(m_installs "$m9")" = "1" ] && [ ! -e "${m9}/.apm/.install-state" ] &&
  [ ! -e "${m9}/.claude/.apm-skills-install-failed" ] &&
  printf '%s\n' "$m9_out" | grep -q 'Could not read the apm version'; then
  pass "M9: without a version line apm install runs, no state is written, and a WARNING says why"
else
  fail "M9: installs=$(m_installs "$m9"), state or marker unexpected"
fi

# M10: apm not on PATH (host): exit 0 with an apm-not-found marker
m10="$(m_home m10)"
PATH="/usr/bin:/bin" HOME="$m10" "$M_BASH" "$m_rendered" >/dev/null 2>&1 && m10_rc=0 || m10_rc=$?
if [ "$m10_rc" -eq 0 ] && grep -q '^reason=apm-not-found$' "${m10}/.claude/.apm-skills-install-failed"; then
  pass "M10: no apm on PATH writes an apm-not-found marker on hosts"
else
  fail "M10: rc=${m10_rc}, marker missing or wrong"
fi

# M11: inside agent-vm, neither an install failure nor a missing apm writes a marker
m11="$(m_home m11)"
m_run "$m11" "$m_vm_rendered" APM_STUB_FAIL=1 && m11a_rc=0 || m11a_rc=$?
PATH="/usr/bin:/bin" HOME="$m11" "$M_BASH" "$m_vm_rendered" >/dev/null 2>&1 && m11b_rc=0 || m11b_rc=$?
if [ "$m11a_rc" -eq 0 ] && [ "$m11b_rc" -eq 0 ] && [ ! -e "${m11}/.claude/.apm-skills-install-failed" ] &&
  [ ! -e "${m11}/.apm/.install-state" ]; then
  pass "M11: agent-vm keeps APM failures as warnings (no marker, no state, exit 0)"
else
  fail "M11: rc=${m11a_rc}/${m11b_rc}, marker or state present"
fi

# M13: the legacy migration removes only bare names from the list, then the list
m13="$(m_home m13)"
mkdir -p "${m13}/.claude/skills/legacy-one" "${m13}/.claude/skills/keep" "${m13}/victim"
printf 'legacy-one\n..\n../victim\nkeep/nested\n' > "${m13}/.claude/.external-skills-installed"
m_run "$m13" "$m_rendered" || true
if [ ! -e "${m13}/.claude/skills/legacy-one" ] && [ -d "${m13}/.claude/skills/keep" ] &&
  [ -d "${m13}/victim" ] && [ -d "${m13}/.claude/skills" ] &&
  [ ! -e "${m13}/.claude/.external-skills-installed" ]; then
  pass "M13: legacy migration removes listed bare names only and deletes the list"
else
  fail "M13: legacy migration touched something outside the listed bare names"
fi

# M12: an unwritable marker path makes the host installer fail now
if [ "$(id -u)" -eq 0 ]; then
  pass "M12: skipped (root bypasses the read-only directory this test needs)"
else
  m12="$(m_home m12)"
  chmod 500 "${m12}/.claude"
  m_run "$m12" "$m_rendered" APM_STUB_FAIL=1 && m12_rc=0 || m12_rc=$?
  chmod 700 "${m12}/.claude"
  if [ "$m12_rc" -eq 1 ]; then
    pass "M12: installer exits 1 when it cannot record the failure"
  else
    fail "M12: rc=${m12_rc}, expected 1"
  fi
fi

# --- assertion L: textlint installer/wrapper .install-state contract ---
# The installer copies package.json to .install-state on a successful install;
# the wrapper treats any mismatch, absence or read error as stale, warns, and
# still runs textlint. The wrapper is started with /bin/bash and a PATH that
# holds no sha256sum (an empty directory, or one with only cmp), because the
# runner's /usr/bin has coreutils and so cannot reproduce "no sha256sum".
WRAPPER="${REPO_ROOT}/home/dot_local/bin/executable_textlint-global"
l_dir="${TMP_ROOT}/l"
mkdir -p "${l_dir}/path-empty" "${l_dir}/path-cmp"
l_path_empty="${l_dir}/path-empty"
l_path_cmp="${l_dir}/path-cmp"
ln -s "$(command -v cmp)" "${l_path_cmp}/cmp"
l_installer="${l_dir}/installer.sh"
render_script "${SCRIPTS_DIR}/run_after_10-install-textlint-deps.sh.tmpl" "$l_installer"

# The single recovery command the wrapper and the installer print. The tilde is
# printed literally so the user's own shell expands it.
l_recover='chezmoi apply ~/.config/textlint ~/.chezmoiscripts/10-install-textlint-deps.sh'

# make_textlint_stub TEXTLINT_HOME LOG
# A textlint that only records that it ran; builtins only, so it works under an
# empty PATH.
make_textlint_stub() {
  local stub_home="$1" stub_log="$2"
  mkdir -p "${stub_home}/node_modules/.bin"
  cat > "${stub_home}/node_modules/.bin/textlint" <<STUB
#!/bin/sh
echo ran >> "${stub_log}"
exit 0
STUB
  chmod +x "${stub_home}/node_modules/.bin/textlint"
}

# L1: neither sha256sum nor cmp on PATH must not stop textlint from running
l1_home="${l_dir}/l1/textlint"
l1_log="${l_dir}/l1/ran.log"
mkdir -p "$l1_home"
printf '{"name":"l1"}\n' > "${l1_home}/package.json"
: > "$l1_log"
make_textlint_stub "$l1_home" "$l1_log"
printf 'x\n' > "${l_dir}/l1/input.md"
PATH="$l_path_empty" TEXTLINT_HOME="$l1_home" /bin/bash "$WRAPPER" "${l_dir}/l1/input.md" \
  >/dev/null 2> "${l_dir}/l1/stderr.txt" && l1_rc=0 || l1_rc=$?
l1_ran="$(grep -c '^ran$' "$l1_log" || true)"
# Without cmp the wrapper cannot tell stale from fresh, so it must say so
# instead of claiming the runtime is old, and must not offer a Recover line
# (a Recover line is always a command that can be run as printed).
if [ "$l1_rc" -eq 0 ] && [ "$l1_ran" = "1" ] &&
  grep -qF 'cmp is not on PATH' "${l_dir}/l1/stderr.txt" &&
  grep -qF 'Fix: put cmp' "${l_dir}/l1/stderr.txt" &&
  ! grep -qF 'older than its package.json' "${l_dir}/l1/stderr.txt" &&
  ! grep -qF 'Recover with:' "${l_dir}/l1/stderr.txt"; then
  pass "L1: without cmp the wrapper runs textlint and reports an unknown state, not a stale one"
else
  fail "L1: rc=${l1_rc}, textlint runs=${l1_ran}, expected rc=0, 1 run, 'cmp is not on PATH' + 'Fix: put cmp', no 'older than' and no 'Recover with:'"
fi

# L2: install succeeds, then the wrapper sees a fresh runtime (no WARNING)
l2_home="${l_dir}/l2/home"
l2_textlint="${l2_home}/.config/textlint"
l2_bun="${l_dir}/l2/bun-stub"
l2_log="${l_dir}/l2/ran.log"
mkdir -p "$l2_textlint" "$l2_bun"
printf '{"name":"l2"}\n' > "${l2_textlint}/package.json"
printf '#!/bin/sh\nexit 0\n' > "${l2_bun}/bun"
chmod +x "${l2_bun}/bun"
: > "$l2_log"
make_textlint_stub "$l2_textlint" "$l2_log"
printf 'x\n' > "${l_dir}/l2/input.md"
PATH="${l2_bun}:/usr/bin:/bin" HOME="$l2_home" bash "$l_installer" >/dev/null 2>&1 || true
l2_copied=false
if cmp -s "${l2_textlint}/package.json" "${l2_textlint}/.install-state"; then
  l2_copied=true
fi
PATH="$l_path_cmp" TEXTLINT_HOME="$l2_textlint" /bin/bash "$WRAPPER" "${l_dir}/l2/input.md" \
  >/dev/null 2> "${l_dir}/l2/stderr.txt" && l2_rc=0 || l2_rc=$?
l2_ran="$(grep -c '^ran$' "$l2_log" || true)"
if [ "$l2_copied" = true ] && [ "$l2_rc" -eq 0 ] &&
  ! grep -qF 'WARNING' "${l_dir}/l2/stderr.txt" && [ "$l2_ran" = "1" ]; then
  pass "L2: after a successful install the wrapper does not warn"
else
  fail "L2: state copied=${l2_copied}, rc=${l2_rc}, textlint runs=${l2_ran}, expected a copy, rc=0, no WARNING, 1 run"
fi

# L3: package.json changed after the install means WARNING plus the recovery
# command, and textlint still runs
printf '{"name":"l2","changed":true}\n' > "${l2_textlint}/package.json"
: > "$l2_log"
PATH="$l_path_cmp" TEXTLINT_HOME="$l2_textlint" /bin/bash "$WRAPPER" "${l_dir}/l2/input.md" \
  >/dev/null 2> "${l_dir}/l2/stderr-stale.txt" && l3_rc=0 || l3_rc=$?
l3_ran="$(grep -c '^ran$' "$l2_log" || true)"
if [ "$l3_rc" -eq 0 ] &&
  grep -qF 'WARNING runtime at' "${l_dir}/l2/stderr-stale.txt" &&
  grep -qF "Recover with: ${l_recover}" "${l_dir}/l2/stderr-stale.txt" &&
  [ "$l3_ran" = "1" ]; then
  pass "L3: a stale runtime warns with the recovery command and still runs textlint"
else
  fail "L3: rc=${l3_rc}, textlint runs=${l3_ran}, expected rc=0, WARNING, Recover with, 1 run"
fi

# L4: a failed install keeps the previous state byte for byte and leaves no tmp
l4_home="${l_dir}/l4/home"
l4_textlint="${l4_home}/.config/textlint"
l4_bun="${l_dir}/l4/bun-stub"
mkdir -p "$l4_textlint" "$l4_bun"
printf '{"name":"l4"}\n' > "${l4_textlint}/package.json"
printf 'sentinel-prior-install\n' > "${l4_textlint}/.install-state"
printf 'sentinel-prior-install\n' > "${l_dir}/l4/state-before"
printf '#!/bin/sh\nexit 1\n' > "${l4_bun}/bun"
chmod +x "${l4_bun}/bun"
PATH="${l4_bun}:/usr/bin:/bin" HOME="$l4_home" bash "$l_installer" >"${l_dir}/l4/installer.out" 2>&1 &&
  l4_rc=0 || l4_rc=$?
if [ "$l4_rc" -eq 0 ] &&
  cmp -s "${l4_textlint}/.install-state" "${l_dir}/l4/state-before" &&
  [ -z "$(find "$l4_textlint" -name '.install-state.tmp.*')" ] &&
  grep -qF "Recover with: ${l_recover}" "${l_dir}/l4/installer.out"; then
  pass "L4: a failed install leaves the previous state untouched, no tmp file, and prints the recovery command"
else
  fail "L4: rc=${l4_rc}, state changed, a .install-state.tmp.* file was left, or the installer output lacks 'Recover with: ${l_recover}'"
fi

# L5: a legacy hash-format state reads as stale (new wrapper, old state)
l5_home="${l_dir}/l5/textlint"
l5_log="${l_dir}/l5/ran.log"
mkdir -p "$l5_home"
printf '{"name":"l5"}\n' > "${l5_home}/package.json"
printf '0000000000000000000000000000000000000000000000000000000000000000\n' > "${l5_home}/.install-state"
: > "$l5_log"
make_textlint_stub "$l5_home" "$l5_log"
printf 'x\n' > "${l_dir}/l5/input.md"
PATH="$l_path_cmp" TEXTLINT_HOME="$l5_home" /bin/bash "$WRAPPER" "${l_dir}/l5/input.md" \
  >/dev/null 2> "${l_dir}/l5/stderr.txt" && l5_rc=0 || l5_rc=$?
l5_ran="$(grep -c '^ran$' "$l5_log" || true)"
if [ "$l5_rc" -eq 0 ] &&
  grep -qF 'WARNING runtime at' "${l_dir}/l5/stderr.txt" &&
  [ "$l5_ran" = "1" ]; then
  pass "L5: a legacy hash-format state warns as stale and textlint still runs"
else
  fail "L5: rc=${l5_rc}, textlint runs=${l5_ran}, expected rc=0, WARNING, 1 run"
fi

# L6: running the printed Recover line with chezmoi clears the warning
# Recover is the procedure for the default location (installer writes
# $HOME/.config/textlint only), so TEXTLINT_HOME is set to
# $HOME/.config/textlint of an isolated HOME here.
l6_dir="${l_dir}/l6"
l6_src="${l6_dir}/src"
l6_home="${l6_dir}/home"
l6_textlint="${l6_home}/.config/textlint"
l6_bun="${l6_dir}/bun-stub"
l6_chezmoi="${l6_dir}/chezmoi-only"
l6_log="${l6_dir}/ran.log"
mkdir -p "${l6_src}/home/.chezmoiscripts" "${l6_src}/home/dot_config/textlint" \
  "${l6_home}/.config" "$l6_bun" "$l6_chezmoi"
printf 'home\n' > "${l6_src}/.chezmoiroot"
cp "${SCRIPTS_DIR}/run_after_10-install-textlint-deps.sh.tmpl" \
  "${l6_src}/home/.chezmoiscripts/run_after_10-install-textlint-deps.sh.tmpl"
printf '{"name":"l6"}\n' > "${l6_src}/home/dot_config/textlint/package.json"
printf '#!/bin/sh\nexit 0\n' > "${l6_bun}/bun"
chmod +x "${l6_bun}/bun"
# chezmoi alone, so a developer's mise or bun on PATH cannot reach the installer.
ln -s "$(command -v chezmoi)" "${l6_chezmoi}/chezmoi"
l6_path="${l6_bun}:${l6_chezmoi}:/usr/bin:/bin"
: > "$l6_log"
printf 'x\n' > "${l6_dir}/input.md"

# (a) deploy package.json only (the installer is not a target, so no state).
# ~/.config exists in a real HOME; chezmoi does not create the parent of a target.
# Absolute path: a tilde here would expand to the real HOME in this shell.
HOME="$l6_home" PATH="$l6_path" chezmoi apply --source "$l6_src" --destination "$l6_home" \
  --no-tty "$l6_textlint" > "${l6_dir}/apply-a.out" 2>&1 || true
# (b) stale wrapper output and the Recover line it prints
make_textlint_stub "$l6_textlint" "$l6_log"
PATH="$l_path_cmp" TEXTLINT_HOME="$l6_textlint" /bin/bash "$WRAPPER" "${l6_dir}/input.md" \
  >/dev/null 2> "${l6_dir}/stderr-b.txt" || true
l6_b_warned=false
if grep -qF 'WARNING runtime at' "${l6_dir}/stderr-b.txt"; then
  l6_b_warned=true
fi
l6_recover="$(sed -n 's/^Recover with: //p' "${l6_dir}/stderr-b.txt" | head -1)"
# (c) run the extracted line once in a child bash so the tilde expands there
l6_first_word="${l6_recover%% *}"
l6_rest="${l6_recover#* }"
if [ "$l6_b_warned" != true ]; then
  fail "L6: the wrapper did not warn before Recover ran (stderr: $(head -2 "${l6_dir}/stderr-b.txt" | tr '\n' ' '); deploy (a): $(head -5 "${l6_dir}/apply-a.out" | tr '\n' ' '))"
elif [ "$l6_first_word" != "chezmoi" ] || [ "${l6_rest%% *}" != "apply" ]; then
  fail "L6: (i) the extracted Recover is not a chezmoi command: '${l6_recover}'"
else
  l6_cmd="${l6_recover} --source ${l6_src} --destination ${l6_home} --no-tty"
  HOME="$l6_home" PATH="$l6_path" bash -c 'eval "$1"' _ "$l6_cmd" \
    > "${l6_dir}/apply-c.out" 2>&1 || true
  # (d) the wrapper again
  : > "$l6_log"
  PATH="$l_path_cmp" TEXTLINT_HOME="$l6_textlint" /bin/bash "$WRAPPER" "${l6_dir}/input.md" \
    >/dev/null 2> "${l6_dir}/stderr-d.txt" && l6_rc=0 || l6_rc=$?
  l6_ran="$(grep -c '^ran$' "$l6_log" || true)"
  if ! cmp -s "${l6_textlint}/package.json" "${l6_textlint}/.install-state"; then
    fail "L6: (ii) state not written after running Recover; chezmoi output: $(tr '\n' ' ' < "${l6_dir}/apply-c.out")"
  elif [ "$l6_rc" -eq 0 ] && ! grep -qF 'WARNING' "${l6_dir}/stderr-d.txt" && [ "$l6_ran" = "1" ]; then
    pass "L6: running the printed Recover line writes the state and clears the warning"
  else
    fail "L6: rc=${l6_rc}, textlint runs=${l6_ran}, expected rc=0, no WARNING and 1 run after Recover"
  fi
fi

# L7: a missing binary exits 2 and prints the same Recover line as L3 and L4
l7_home="${l_dir}/l7/textlint"
mkdir -p "$l7_home"
printf '{"name":"l7"}\n' > "${l7_home}/package.json"
PATH="$l_path_cmp" TEXTLINT_HOME="$l7_home" /bin/bash "$WRAPPER" "${l_dir}/l5/input.md" \
  >/dev/null 2> "${l_dir}/l7/stderr.txt" && l7_rc=0 || l7_rc=$?
if [ "$l7_rc" -eq 2 ] && grep -qF "Recover with: ${l_recover}" "${l_dir}/l7/stderr.txt"; then
  pass "L7: a missing binary exits 2 with the same recovery command"
else
  fail "L7: rc=${l7_rc}, expected rc=2 and 'Recover with: ${l_recover}'"
fi

# --- assertion F: no mise or bun toolchain use in the ASCII-ordered phase ---
# Scripts outside run_before_/run_after_ run before ~/.claude/ and
# ~/.config/mise/config.toml are written, so a `mise install`, `mise env`,
# `mise activate` or `bun install` there works from the previous apply's
# inputs. Heuristic, not a proof: it matches those tokens on a line that is not
# a log/echo/printf message. Windows .ps1 scripts are out of scope (ADR-0017).
f_offenders=""
for f in "${SCRIPTS_DIR}/"*.sh.tmpl; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  case "$base" in
  run_before_* | run_after_* | run_onchange_before_* | run_onchange_after_* | run_once_before_* | run_once_after_*) continue ;;
  esac
  # Collected into a variable rather than piped into `grep -q`: an early exit
  # of the second grep would SIGPIPE the first, and pipefail would turn a hit
  # into a miss.
  f_hits="$(grep -E '(^|[^[:alnum:]_])(mise (install|env|activate)|bun install)([^[:alnum:]_]|$)' "$f" |
    grep -vE '^[[:space:]]*(log|echo|printf)[[:space:]]' || true)"
  if [ -n "$f_hits" ]; then
    f_offenders="${f_offenders} ${base}"
  fi
done
if [ -z "$f_offenders" ]; then
  pass "F: no ASCII-phase script uses mise or bun"
else
  fail "F: ASCII-phase script(s) use mise or bun:${f_offenders}"
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
echo "provisioning invariants: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"
[ "$FAIL_COUNT" -eq 0 ]
