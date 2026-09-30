<!-- spec-ref: spec.md -->

# Plan: APM skill installer を ADR-0017 の 10- 帯へ移す (Execution layer)

spec の Architecture §1、K1・K2・K9・K10（ADR-0017 と ADR-0018 K22 の追記）を実装する。mise の分割と Renovate は plan-2。

state の形式は spec Architecture §1 の手順 3（`<apm.yml の sha256> <X.Y.Z>`、Round 4 で確定）に従う。spec K1 本文の「`apm --version` 全出力の sha256」はこれに置き換わった古い記述である。

振る舞いの変化（意図したもの）: 旧 script は `apm install -g` が失敗すると `exit 1` で apply をその場で止めた。新 installer は exit 0 で続行し、host では verifier が最後に非ゼロにする。削除した旧 script の chezmoi の scriptState（実行済みハッシュの記録）は残るが、対応する script が無いので参照されず無害。`apm install -g` の出力は既存 installer と同じく apply のログにそのまま流れ、marker には写らない。

## Files

```
# 新規作成
home/.chezmoiscripts/run_after_10-install-apm-skills.sh.tmpl

# 削除
home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl

# 編集
home/.chezmoiscripts/run_after_zz-verify-provisioning.sh.tmpl
home/.chezmoiignore
docs/decisions/0017-provisioning-after-deploy.md
docs/decisions/0018-agent-vm-orbstack.md
docs/agent-vm.md

# 新規作成（セッション成果物の保存。ADR の Amended by が参照する）
docs/plans/dependency-update-paths/research.md
docs/plans/dependency-update-paths/spec.md
docs/plans/dependency-update-paths/plan-1.md

# テスト
scripts/smoke-provisioning-invariants.sh
tests/agent-vm/run-templates.sh
tests/agent-vm/fixtures/vm-managed.txt
```

## Tasks

### T1: smoke テストに APM installer の assertion を足す（Red）

**Files:**

- テスト: `scripts/smoke-provisioning-invariants.sh`
- 参照: `scripts/smoke-provisioning-invariants.sh:22-25`（名前定数）、`:47-56`（`render_script`）、`:97-110`（A3）、`:144-222`（C / D）、`:354-450`（J の書き方）

- [ ] **Step 1: 名前定数と `render_script` の第 3 引数を足す**

`VERIFIER_NAME="zz-verify-provisioning"` の直前に次を足す。

```bash
APM_SKILLS_NAME="10-install-apm-skills"
```

`render_script` を、任意の第 3 引数（chezmoi の override data の JSON）を受ける形にする。

```bash
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
```

`${data_args[@]+"${data_args[@]}"}` は、空配列でも bash 3.2 の `set -u` で落ちない書き方（`run_after_sync-skills.sh.tmpl:45` と同じ）。

- [ ] **Step 2: A3 の membership に APM installer を足す**

`for a3_name in "$INSTALLER_NAME" "$ROOT_DEPS_NAME"; do` を次に置き換える。pass のメッセージも合わせる。

```bash
for a3_name in "$INSTALLER_NAME" "$ROOT_DEPS_NAME" "$APM_SKILLS_NAME"; do
```

```bash
  pass "A3: the 10- band follows the toolchain and holds the dependency installers"
```

- [ ] **Step 3: C に apm の stub と marker を足す**

`for stub_cmd in mise bun; do` を `for stub_cmd in mise bun apm; do` にし、`printf 'reason=synthetic\n' > "${c_home}/.claude/.root-deps-install-failed"` の次に次の行を足す。pass のメッセージを `"C: verifier invoked none of mise, bun, apm"` にする。

```bash
printf 'reason=synthetic\n' > "${c_home}/.claude/.apm-skills-install-failed"
```

- [ ] **Step 4: D5 を足す（D4 の直後）**

```bash
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
```

- [ ] **Step 5: assertion M を足す（J5 の直後、L の前）**

```bash
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
```

- [ ] **Step 6: 失敗を確認**

実行: `bash scripts/smoke-provisioning-invariants.sh 2>&1 | grep -E '✗|provisioning invariants'`
期待: smoke が最後まで走り、次が FAIL になる。`render: run_after_10-install-apm-skills.sh.tmpl does not exist`（2 行、host 用と VM 用）、A3（`missing: 10-install-apm-skills`）、D5（verifier がまだ apm marker を報告しない）、M1-M13（exit 97 の代替 script のため。root で実行した場合の M12 は skip で pass）。C は verifier が apm を呼ばないので pass のまま。最終行は `provisioning invariants: N passed, M failed`（非 root で M = 2 + 1 + 1 + 13 = 17）。

### T2: installer と verifier を実装する（Green）

**Files:**

- 新規: `home/.chezmoiscripts/run_after_10-install-apm-skills.sh.tmpl`
- 削除: `home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl`
- 編集: `home/.chezmoiscripts/run_after_zz-verify-provisioning.sh.tmpl:39-47`
- 参照: `home/.chezmoiscripts/run_after_10-install-root-deps.sh.tmpl:1-71`（header・marker・mise env の型）、`home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl:20-39`（移す legacy 移行処理）

- [ ] **Step 1: 旧 script を `git rm` し、新 installer を書く**

`git rm home/.chezmoiscripts/run_onchange_after_install-claude-skills-11.sh.tmpl` のあと、次の内容で新規作成する。

```bash
{{ if ne .chezmoi.os "windows" -}}
#!/bin/bash
# Installs the external skills declared in ~/.apm/apm.yml (APM, user scope)
# into ~/.claude/skills and ~/.agents/skills.
#
# Placement (do not move or rename without updating
# scripts/smoke-provisioning-invariants.sh and tests/agent-vm/):
#   The 10- band runs after 00-install-mise-tools, so the apm used here is the
#   one pinned by the ~/.config/mise/config.toml that this same apply deployed,
#   and before run_after_sync-skills, which reads ~/.apm/apm.lock.yaml to keep
#   APM-owned skills out of its --delete pass.
#   See docs/decisions/0017-provisioning-after-deploy.md.
#
# Runs on every apply but skips `apm install -g` (seconds, resolves refs over
# the network) while ~/.apm/.install-state matches. The state is one line,
#   "<sha256 of ~/.apm/apm.yml> <apm version>",
# written only after an install that exited 0 and left ~/.apm/apm.lock.yaml,
# and removed on failure. The install also re-runs while the failure marker
# exists, since a successful install is the only thing that clears it. The
# former run_onchange_ script recorded its hash on the exit 0 it returned when
# apm was not on PATH and then never ran again: the defect class ADR-0017 K2
# names.
#
# `apm install` follows the SHAs in apm.lock.yaml, so re-running it never pulls
# newer skill content; that takes `apm update` by hand.
#
# Marker reasons: apm-not-found, apm-install-failed (an install that exited
# non-zero, or exited 0 without leaving apm.lock.yaml).
#
# Exit code: 0 even when the install fails, so the remaining run_after_ scripts
# still run. On hosts the failure (including apm missing from PATH, which
# unlike a missing bun breaks nothing else visibly) is recorded in MARKER_FILE
# and run_after_zz-verify-provisioning turns it into a non-zero apply at the
# end.
#   The one exception is being unable to write MARKER_FILE, which is reported
#   immediately because the deferral channel itself failed.
# Inside agent-vm failures stay warnings: 5 of 9 skills cannot be fetched there
# (ADR-0018 R21), apm then exits 1, and a marker would stop every bootstrap at
# the verifier.

set -uo pipefail

log() {
    local level="${2:-INFO}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $1"
}

APM_DIR="$HOME/.apm"
STATE_FILE="$APM_DIR/.install-state"
LOCK_FILE="$APM_DIR/apm.lock.yaml"
MARKER_FILE="$HOME/.claude/.apm-skills-install-failed"
RECOVER_COMMAND="mise install github:microsoft/apm && apm install -g"
IN_AGENT_VM={{ if dig "agent_vm" false . }}1{{ else }}0{{ end }}

{{ template "record-provisioning-failure.sh" . }}

# report_failure REASON
report_failure() {
    local reason="$1"
    if [ "$IN_AGENT_VM" = "1" ]; then
        log "APM skills were not installed (${reason}); only a warning inside agent-vm (ADR-0018 R21)" "WARNING"
        return 0
    fi
    if record_provisioning_failure "$MARKER_FILE" "$reason" "$RECOVER_COMMAND"; then
        log "Recorded the failure at $MARKER_FILE" "INFO"
    else
        log "Could not record the failure at $MARKER_FILE. Failing now." "ERROR"
        log "Recover with: $RECOVER_COMMAND" "ERROR"
        exit 1
    fi
}

sha256_stdin() {
    if command -v sha256sum &> /dev/null; then
        sha256sum | cut -d' ' -f1
    else
        shasum -a 256 | cut -d' ' -f1
    fi
}

# run_after_ scripts execute in a non-interactive shell that does not read the
# user rc, so apm is reachable only through mise.
if command -v mise &> /dev/null; then
    if mise_env=$(mise env --shell bash 2>/dev/null); then
        eval "$mise_env"
    fi
fi

if [ ! -f "$APM_DIR/apm.yml" ]; then
    # A deploy problem, not something apm can fix.
    log "~/.apm/apm.yml not found; nothing to install." "WARNING"
    exit 0
fi

if ! command -v apm &> /dev/null; then
    log "apm not found on PATH (00-install-mise-tools logged why)." "ERROR"
    report_failure "apm-not-found"
    exit 0
fi

# Only the "version X.Y.Z" part: `apm --version` also prints an update notice
# when a newer release exists, which must not change the key. A failing
# `apm --version`, or one without that part, leaves the key empty: the install
# then runs every time and no state is written.
state_key=""
apm_version=""
if apm_version_out="$(apm --version 2>/dev/null)"; then
    apm_version="$(printf '%s\n' "$apm_version_out" | grep -oE 'version [0-9][0-9A-Za-z.+-]*' | head -1)"
fi
if [ -n "$apm_version" ]; then
    state_key="$(sha256_stdin < "$APM_DIR/apm.yml") ${apm_version#version }"
else
    log "Could not read the apm version; installing without recording state" "WARNING"
fi

if [ -n "$state_key" ] && [ -f "$LOCK_FILE" ] && [ ! -e "$MARKER_FILE" ] &&
    [ "$(cat "$STATE_FILE" 2>/dev/null)" = "$state_key" ]; then
    log "APM skills are in sync (apm.yml and apm version unchanged)" "SUCCESS"
    exit 0
fi

# Migration: remove pre-existing skill directories that APM cannot overwrite
if [ ! -f "$LOCK_FILE" ]; then
    log "First APM run detected. Removing legacy skill directories..." "INFO"
    if [ -f "$HOME/.claude/.external-skills-installed" ]; then
        while IFS= read -r skill_name; do
            # A bare directory name only: never ".", "..", or anything with a
            # slash, so a stray line cannot delete outside ~/.claude/skills.
            case "$skill_name" in
            "" | . | .. | */*) continue ;;
            esac
            skill_dir="$HOME/.claude/skills/$skill_name"
            if [ -d "$skill_dir" ]; then
                rm -rf "$skill_dir"
                log "Removed legacy: $skill_name" "INFO"
            fi
        done < "$HOME/.claude/.external-skills-installed"
        rm -f "$HOME/.claude/.external-skills-installed"
    fi
fi

log "Installing APM skills (apm install -g)..."
apm install -g 2>&1
install_rc=$?

if [ "$install_rc" -eq 0 ] && [ -f "$LOCK_FILE" ]; then
    log "APM skills are installed" "SUCCESS"
    if [ -n "$state_key" ]; then
        state_tmp=""
        if state_tmp="$(mktemp "${STATE_FILE}.tmp.XXXXXX" 2>/dev/null)" &&
            printf '%s\n' "$state_key" > "$state_tmp" &&
            chmod 600 "$state_tmp" &&
            mv -f "$state_tmp" "$STATE_FILE"; then
            :
        else
            [ -n "$state_tmp" ] && rm -f "$state_tmp"
            log "Could not write $STATE_FILE; the next apply installs again" "WARNING"
        fi
    fi
    if [ -e "$MARKER_FILE" ] && ! rm -f "$MARKER_FILE"; then
        log "Could not clear stale $MARKER_FILE; remove it by hand" "ERROR"
    fi
else
    if [ "$install_rc" -eq 0 ]; then
        log "apm install -g exited 0 but left no $LOCK_FILE" "ERROR"
    else
        log "apm install -g failed (see output above)" "ERROR"
    fi
    if [ -e "$STATE_FILE" ] && ! rm -f "$STATE_FILE"; then
        log "Could not remove $STATE_FILE" "ERROR"
    fi
    report_failure "apm-install-failed"
fi

exit 0
{{ end -}}
```

- [ ] **Step 2: verifier に 3 つ目の marker を足す**

`run_after_zz-verify-provisioning.sh.tmpl` の root-deps の `report_marker` の直後（`exit "$failed"` の前）に足す。

```bash
report_marker "$HOME/.claude/.apm-skills-install-failed" "apm-skills" \
    "APM skills were not installed; ~/.claude/skills and ~/.agents/skills may not match ~/.apm/apm.yml." \
    "mise install github:microsoft/apm && apm install -g"
```

- [ ] **Step 3: 通過を確認**

実行: `bash scripts/smoke-provisioning-invariants.sh 2>&1 | tail -3`
期待: `provisioning invariants: 44 passed, 0 failed`（2026-10-01 に実測した既存 30 + D5 1 + M 13。判定は `0 failed` で行い、件数は参考）

### T3: VM の allowlist・fixture・順序テストを新しい名前に合わせる

**Files:**

- 編集: `home/.chezmoiignore:91`
- テスト: `tests/agent-vm/fixtures/vm-managed.txt:48`、`tests/agent-vm/run-templates.sh:102-105`
- 参照: `tests/agent-vm/run-templates.sh:77-80`（`test_vm_manages_exactly_the_allowlist`）

- [ ] **Step 1: 失敗を確認**

実行: `bash tests/agent-vm/run-templates.sh 2>&1 | tail -4`
期待: `FAIL` に `test_skills_install_runs_after_mise_tools_and_before_sync`（`install-claude-skills-11.sh` が無い）と `VM manages exactly the reviewed allowlist` が出る。

- [ ] **Step 2: 3 か所を置き換える**

- `home/.chezmoiignore:91`: `!.chezmoiscripts/install-claude-skills-11.sh` → `!.chezmoiscripts/10-install-apm-skills.sh`
- `tests/agent-vm/fixtures/vm-managed.txt:48`: `.chezmoiscripts/install-claude-skills-11.sh` → `.chezmoiscripts/10-install-apm-skills.sh`
- `tests/agent-vm/run-templates.sh` の `test_skills_install_runs_after_mise_tools_and_before_sync`:

```bash
test_skills_install_runs_after_mise_tools_and_before_sync() {
  local order; order=$(after_band_targets | grep -xE '00-install-mise-tools\.sh|10-install-apm-skills\.sh|sync-skills\.sh' | paste -sd' ' -)
  assert_eq "00-install-mise-tools.sh 10-install-apm-skills.sh sync-skills.sh" "$order" "apm is installed before skills, skills before sync"
}
```

- [ ] **Step 3: 通過を確認**

実行: `bash tests/agent-vm/run-templates.sh 2>&1 | tail -2`
期待: `23 run, 0 failed`

### T4: 実機で apply して挙動を確かめる

**Files:**

- 参照: `~/.apm/apm.lock.yaml`（現在ある）、`~/.apm/.install-state`（まだ無い）

- [ ] **Step 1: 1 回目の apply**

実行: `chezmoi apply > <scratchpad>/apply-1.log 2>&1; echo "rc=$?"` のあと `grep -E 'APM|apm-skills|Recorded' <scratchpad>/apply-1.log`（`<scratchpad>` はセッションの scratchpad の絶対パス）
期待: `rc=0`。ログに `Installing APM skills (apm install -g)...` と `APM skills are installed` がある。`~/.apm/.install-state` が `<64 桁の hex> 0.31.0` の 1 行、mode 600。`~/.claude/.apm-skills-install-failed` が無い。

- [ ] **Step 2: 2 回目の apply**

実行: `chezmoi apply > <scratchpad>/apply-2.log 2>&1; echo "rc=$?"` のあと `grep -E 'APM skills|apm install' <scratchpad>/apply-2.log`
期待: `rc=0`。`APM skills are in sync (apm.yml and apm version unchanged)` だけが出て、`Installing APM skills` の行が無い。

### T5: ADR と docs に追記する

**Files:**

- 編集: `docs/decisions/0017-provisioning-after-deploy.md`（`## References` の直前）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md`（`## References` の直前）
- 編集: `docs/agent-vm.md:93`
- 参照: `docs/decisions/0014-hook-deps-install-phase.md:61-63`（`## Amended by` の書式）

- [ ] **Step 1: ADR-0017 に `## Amended by` 節を足す**

```markdown
## Amended by

- `docs/plans/dependency-update-paths/spec.md` (2026-10-01) — APM の skill installer（旧 `run_onchange_after_install-claude-skills-11`）を `run_after_10-install-apm-skills` として 10- 帯に加えた。K2 の「ハッシュで gate せず毎回実行する」に対し、成功した install の後にだけ書く `~/.apm/.install-state` で `apm install -g` を省く installer を名前付きの例外として認める。失敗時は state を消し、marker がある間は省かないので、一度の失敗が恒久的な skip に変わることはない。verifier が見る marker は `.hook-deps-install-failed`・`.root-deps-install-failed`・`.apm-skills-install-failed` の 3 つになった。K4 の installer と異なり、apm が PATH に無いことも marker にする（bun と違い、apm の不在は他の場所で目に見える失敗を起こさない）。K1-K8 の決定は supersede しない
```

- [ ] **Step 2: ADR-0018 に `## Amended by` 節を足す**

```markdown
## Amended by

- `docs/plans/dependency-update-paths/spec.md` (2026-10-01) — K22 の script は `run_after_10-install-apm-skills`（ADR-0017 の 10- 帯）になった。K22 本文の「ターゲット名と内容は変わらない」はこの改名で上書きされる。VM では APM の失敗を marker にせず WARNING に留める。R21 の状態では apm 0.31 が exit 1 を返し、verifier が毎回の bootstrap を止めるためである
```

- [ ] **Step 3: `docs/agent-vm.md:93` の R21 の段落の末尾に 1 文足す**

```markdown
VM では APM の失敗は WARNING に留まり apply は止まらない。成功したかどうかは VM の中に `~/.apm/.install-state` があるかで判別できる。
```

- [ ] **Step 4: ADR が参照するセッション成果物を docs/plans に置く**

```bash
mkdir -p docs/plans/dependency-update-paths
cp .tmp/sessions/d500139b/research.md .tmp/sessions/d500139b/spec.md .tmp/sessions/d500139b/plan-1.md docs/plans/dependency-update-paths/
```

写した `docs/plans/dependency-update-paths/spec.md` の K1 のうち「`apm --version` 全出力の sha256」を「`apm --version` の出力から取り出した `X.Y.Z`（Architecture §1 手順 3）」に直す（セッション側の spec.md は承認済みの hash を保つため直さない）。plan-2 T7 が plan-2.md を足し、spec.md などを最終版で上書きする。

- [ ] **Step 5: コミット**

```bash
git add docs/plans/dependency-update-paths/ \
  home/.chezmoiscripts/run_after_10-install-apm-skills.sh.tmpl \
  home/.chezmoiscripts/run_after_zz-verify-provisioning.sh.tmpl \
  home/.chezmoiignore scripts/smoke-provisioning-invariants.sh \
  tests/agent-vm/run-templates.sh tests/agent-vm/fixtures/vm-managed.txt \
  docs/decisions/0017-provisioning-after-deploy.md docs/decisions/0018-agent-vm-orbstack.md docs/agent-vm.md
git commit  # fix(chezmoi): move the APM skill installer into the run_after_ 10- band（本文は Contextual Commits、/commit の規約に従う）
```

旧 script の削除は T2 Step 1 の `git rm` でステージ済み。

## ISO 25010 具体テストケース

### 信頼性（障害許容性・回復性）

- **入力**: host で stub の `apm install` が exit 1 → **期待**: installer exit 0、`~/.claude/.apm-skills-install-failed` が mode 600 で `reason=apm-install-failed`、stderr の文字列を含まない、`.install-state` が無い（M1）
- **入力**: M1 の直後に成功する apm で再実行 → **期待**: `.install-state` = `<apm.yml の sha256> 9.9.9`（mode 600）、marker が消える（M2）
- **入力**: state 一致 + marker あり → **期待**: `apm install` が呼ばれ、成功で marker が消える（M7）
- **入力**: `apm install` が exit 0 だが lockfile を作らない → **期待**: `reason=apm-install-failed` の marker、state なし（M8）
- **入力**: PATH に apm が無い（host）→ **期待**: exit 0、`reason=apm-not-found` の marker（M10）
- **入力**: marker のディレクトリが書き込み不可（mode 500）+ install 失敗 → **期待**: exit 1（M12）
- **入力**: lockfile なし、`.external-skills-installed` に `legacy-one` / `..` / `../victim` / `keep/nested` → **期待**: `skills/legacy-one` だけ消え、`skills/keep`・`~/victim`・`skills/` は残り、一覧ファイルが消える（M13）
- **入力**: marker ファイルあり → **期待**: verifier が非ゼロ終了し、stderr に `mise install github:microsoft/apm && apm install -g`、他の label が出ない（D5）

### 機能適合性（機能正確性）

- **入力**: 同じ apm.yml・同じ版で 2 回目（`--version` に更新通知行が混ざる）→ **期待**: `apm install` の呼び出し回数が増えない（M3）
- **入力**: apm.yml の内容変更 / 版を 9.9.10 に / lockfile 削除 → **期待**: それぞれ `apm install` が 1 回増える（M4 / M5 / M6）
- **入力**: `--version` が何も出さない → **期待**: install は走り、state は書かれない（M9）
- **入力**: 本マシンで apply 2 回 → **期待**: 1 回目は install、2 回目は `APM skills are in sync` のみ（T4）

### 保守性（試験性）

- **入力**: `agent_vm: true` でレンダリングした installer に install 失敗 / apm 不在 → **期待**: どちらも exit 0、marker も state も無い（M11）
- **入力**: `run-templates.sh` → **期待**: VM の managed 集合が fixture と一致し、順序が `00-install-mise-tools.sh 10-install-apm-skills.sh sync-skills.sh`（T3）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: Red 段階で `m_run` を裸で呼ぶと stub の exit 97 で `set -e` が smoke 全体を止める。`render_script` のコードが注記（bash 3.2 安全な展開）と食い違う。Step 6 の期待値が矛盾（A3・C も Red で落ちる）。`m_installs` が 0 を 2 回出す。spec は `apm --version` の非ゼロ終了も key 空としている。`env ... bash` の PATH 依存。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: spec の対象は全タスクに対応しスコープの逸脱なし。`render_script` の注記とコード、Step 6 の期待値の矛盾。spec K1 の state 形式の記述が §1 手順 3 と食い違う。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: ADR 追記が参照する `docs/plans/dependency-update-paths/spec.md` が plan-1 のコミット時点で存在しない。T4 の apply の exit code がパイプで観測できない。ADR-0018 K22 本文の「内容は変わらない」を Amended by で上書きする旨を明記。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: legacy 移行ループが `~/.claude/.external-skills-installed` の行を検証せず `rm -rf` に渡す（`..` 等）。state に明示の `chmod 600` を。`apm install` の出力がログに出ることを明記。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 版を読めないと毎回 install が走るのに何も知らせない（WARNING を）。旧 script の exit 1 から exit 0 + marker への変化と、chezmoi の scriptState の残骸を明記。marker の reason の列挙を header に。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: M1-M12 を机上で追い、Red/Green とも意図どおり。軽微: M2 の sha256sum に fallback を、legacy ループのテスト追加、docs に写す spec の K1 を直すこと（→ 反映）。

### scope-justification-reviewer
- verdict: pass
- 主指摘: 追加分（名前検証・chmod・WARNING・docs コピー）はすべて spec の範囲内。軽微: Red の FAIL 件数を明示、docs コピーは plan-2 で上書きされる旨を残すこと（→ 反映）。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: Round 1 の 4 件は解消。軽微: コピーする docs の鮮度、件数の根拠（既存 30 は 2026-10-01 に実測済み）。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 名前検証・chmod 600・ログの扱いで解消。mise env の cwd は既存 installer と揃え、強化するなら全 installer まとめて。

### data-contract-evolution-evaluator
- verdict: needs-work（軽微）
- 主指摘: legacy 移行処理のテストが無い、M9 が新しい WARNING を確認していない（→ M13 追加、M9 で出力を grep するよう反映）。

<!-- auto-review: verdict=needs-work; hash=59bff8826e164d6633b5d008d560992368bbb5e63797c4e38b423987ac85d654; design-hash=c1b27beae7d5cb5ed969cc3350f6460e851e3ebff319148d655a286d4bc94f00; round=1; parent-spec-hash=e73c41e644ef3811bdeef6738da09c72f771eecf99e46e4b5d8f2cd3c4682e6b; at=2026-09-30T18:56:00.974Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: `set -euo pipefail` の下で M9 の出力取得と M13 を追い、不具合なし。軽微: M13 が M12 の前に置かれている（番号順のみの問題）。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: Round 2 の 2 件は解消。任意: lockfile がある host で古い一覧ファイルを移行しないことを固定する assertion。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=a5bfe90fb27bbd52581e4d4d48867aafed6636e0d6725724531b2fceda916402; design-hash=6510a8d1658f2237d054c9b06d989d819e039845a5be369c66bd75cbc191179e; round=2; parent-spec-hash=e73c41e644ef3811bdeef6738da09c72f771eecf99e46e4b5d8f2cd3c4682e6b; at=2026-09-30T18:59:44.826Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=47f8d6a91d3c7bfe02008b47adaa565b83ab97afa9e81fb3b5d5e19711d6e0ea; design-hash=6510a8d1658f2237d054c9b06d989d819e039845a5be369c66bd75cbc191179e; round=3; parent-spec-hash=e73c41e644ef3811bdeef6738da09c72f771eecf99e46e4b5d8f2cd3c4682e6b; at=2026-09-30T19:00:27.347Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-09-30T19:00:27.377Z -->
