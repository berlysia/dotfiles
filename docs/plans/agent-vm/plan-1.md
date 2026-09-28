<!-- spec-ref: spec.md -->

# Plan 1: agent-vm launcher の中核（host 側）

spec の K1・K2・K3・K6・K7（Codex 認証確認）・K10（health / fail closed / タイトル）・K11（workingTree 解決）・K14・K15 を実装する。ログ取り込み（K9）と git 面検査（K13）は plan-2、VM 側（cloud-init / bootstrap / chezmoi フラグ / mise）は plan-3、シェル統合と導入ガイドは plan-4 で扱う。

実装上の共通制約:
- macOS 標準の bash 3.2 で動くこと（連想配列・`mapfile`・`${var,,}` を使わない）。`timeout`・`flock`・`sha256sum`・`realpath`・`mv -T` は macOS 標準に無いので、perl・`shasum -a 256`・`cd -P && pwd -P`・perl の `rename` で代替する（spec K1/K2/K3/K10）。
- `set -euo pipefail` 下で、関数の最終文に `[[ … ]] && …` を置かない（偽のとき関数が 1 を返して呼び出し側が落ちるため）。条件付き処理は `if` で書く。
- machine の lock を保持している間に起動する外部コマンドは、パイプ全体を `{ …; } 9>&-` で囲むか各コマンドに `9>&-` を付け、fd 9 を継承させない（spec K1）。
- 本番コードにテスト専用の分岐や `eval` を置かない。テストは launcher を `AGENT_VM_LIB=1` で source し、差し替えたい関数（`session_exec` 等）を source 後に再定義する。状態・設定ディレクトリは `AGENT_VM_STATE_DIR` / `AGENT_VM_CONFIG_DIR` で上書きできる（既定 `~/.local/share/agent-vm` / `~/.config/agent-vm`）。
- テストは `orb` / `op` / `chezmoi` を stub に置き換えて Linux と macOS（`/bin/bash` 3.2）で実行する（spec R1）。
- テストの置き場は `tests/agent-vm/`。既存の `tests/smoke/` は `home/.chezmoiscripts/*.sh.tmpl` を render して実行する runner 専用の規約（`scripts/smoke-chezmoi-scripts.sh`）で、`scripts/test-*.sh` は codex config 用の単体スクリプトなので、bin スクリプトを stub 付きで関数単位に検証する本テストはどちらの形にも合わない。

## Files

```
# 新規作成
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
tests/agent-vm/lib.sh
tests/agent-vm/stubs/orb
tests/agent-vm/stubs/op
tests/agent-vm/stubs/chezmoi
.github/workflows/ci-agent-vm.yml

# 編集
home/.chezmoiignore
package.json
.github/workflows/status-check.yml
```

## Tasks

### T1: テスト基盤と launcher の骨格

**Files:**

- 新規: `tests/agent-vm/lib.sh`, `tests/agent-vm/run.sh`, `tests/agent-vm/stubs/{orb,op,chezmoi}`, `home/dot_local/bin/executable_agent-vm`
- 参照: `scripts/smoke-chezmoi-scripts.sh:1-45`（mktemp -d の一時 root と trap による後始末、PASS/FAIL 集計の既存形）
- 参照: `home/dot_local/bin/executable_git-worktree-create:1-30`（`set -euo pipefail`・`show_help` の既存形）

- [ ] **Step 1: 失敗するテストを書く**

`tests/agent-vm/lib.sh`（各テストは subshell で走るので、結果はファイルに追記して親で集計する）:

```bash
# shellcheck shell=bash
# Assertion helpers for agent-vm tests (bash 3.2 compatible).
# Each test runs in its own subshell; results are appended to $RESULTS_FILE.
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
assert_status() { # expected_status label -- command...
  local expected=$1 label=$2 status=0
  shift 3
  "$@" >/dev/null 2>&1 </dev/null || status=$?
  assert_eq "$expected" "$status" "$label"
}
```

`tests/agent-vm/stubs/orb`（`op`・`chezmoi` も同形。応答は `STUB_<NAME>_STDOUT` / `STUB_<NAME>_EXIT` / `STUB_<NAME>_SLEEP`、stdin の取り込みは `STUB_CAPTURE_STDIN=1` のときだけ行い、未指定の呼び出しが CI の開いたままの stdin で待ち続けないようにする）:

```bash
#!/usr/bin/env bash
# Test stub: records argv (and stdin when asked), replies with configured output.
{ printf 'orb'; printf ' %q' "$@"; printf '\n'; } >>"$STUB_LOG"
if [[ "${STUB_CAPTURE_STDIN:-}" == 1 ]]; then cat >>"$STUB_LOG.stdin"; fi
if [[ -n "${STUB_ORB_SLEEP:-}" ]]; then sleep "$STUB_ORB_SLEEP"; fi
# `orb list` has its own canned output so a test can script "machine exists" and "applied hash" independently
if [[ "${1:-}" == list && -n "${STUB_ORB_LIST_STDOUT:-}" ]]; then printf '%s\n' "$STUB_ORB_LIST_STDOUT"; exit 0; fi
if [[ -n "${STUB_ORB_STDOUT:-}" ]]; then printf '%s\n' "$STUB_ORB_STDOUT"; fi
exit "${STUB_ORB_EXIT:-0}"
```

`tests/agent-vm/run.sh`（以降のタスクは `test_*` 関数を足す。各テストは新しい state/config/log を持つ subshell で走る）:

```bash
#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
LAUNCHER="$REPO_ROOT/home/dot_local/bin/executable_agent-vm"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"
TMP_BASE=$(mktemp -d -t agent-vm-test-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"

test_help_exits_zero() {
  assert_status 0 "help exits 0" -- bash "$LAUNCHER" --help
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do
  (
    TMP_ROOT="$TMP_BASE/$t"; mkdir -p "$TMP_ROOT"
    export TMP_ROOT STUB_LOG="$TMP_ROOT/stub.log"
    export AGENT_VM_STATE_DIR="$TMP_ROOT/state" AGENT_VM_CONFIG_DIR="$TMP_ROOT/config"
    : >"$STUB_LOG"
    AGENT_VM_LIB=1 . "$LAUNCHER"
    "$t"
  ) </dev/null || record "FAIL $t (test aborted)"
done
failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
```

- [ ] **Step 2: 失敗を確認** — 実行: `bash tests/agent-vm/run.sh` / 期待: launcher が無いので `FAIL test_help_exits_zero (test aborted)` を含み非 0 終了。

- [ ] **Step 3: 最小実装**

```bash
#!/usr/bin/env bash
# agent-vm: run Claude Code / Codex inside a per-repo OrbStack isolated machine.
# Design record: docs/decisions (added in plan-4).
set -euo pipefail

AGENT_VM_STATE_DIR="${AGENT_VM_STATE_DIR:-$HOME/.local/share/agent-vm}"
AGENT_VM_CONFIG_DIR="${AGENT_VM_CONFIG_DIR:-$HOME/.config/agent-vm}"

die() { printf 'agent-vm: %s\n' "$1" >&2; exit "${2:-1}"; }
step() { printf 'agent-vm: %s\n' "$1" >&2; }

show_help() {
  cat <<'EOF'
agent-vm - run claude/codex in a per-repo OrbStack isolated machine

Usage:
  agent-vm claude|codex [args...]   Launch the tool in this repo's machine
  agent-vm shell                    Open a shell in this repo's machine
  agent-vm prewarm                  Create and provision the machine now
  agent-vm env edit                 Edit this repo's host-only 1Password env file
  agent-vm env adopt <machine>      Take over the env file of a moved repo
  agent-vm list | gc | rm [repo]    Manage machines
EOF
}

main() {
  case "${1:-}" in
    -h | --help | help | "") show_help ;;
    *) die "unknown command: $1" ;;
  esac
}

if [[ -z "${AGENT_VM_LIB:-}" ]]; then main "$@"; fi
```

stub 3 つと run.sh に実行ビットを付ける。

- [ ] **Step 4: 通過を確認** — 期待: `1 run, 0 failed`、終了コード 0。
- [ ] **Step 5: コミット** — `test(agent-vm): add launcher skeleton and stub-based test harness`

### T2: repo root 解決と machine 名導出（K1）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_git-worktree-create`（worktree は `.git/worktree/<branch>` 配下。common dir はメイン repo の `.git`）

- [ ] **Step 1: 失敗するテスト**

```bash
test_machine_name_is_stable_and_sanitized() {
  local repo="$TMP_ROOT/My_Repo.Name-With-A-Very-Long-Tail"
  mkdir -p "$repo"
  local name; name=$(derive_machine_name "$repo")
  # lowercased, [^a-z0-9-] -> '-', first 20 chars ("my-repo-name-with-a-"), trailing '-' trimmed, then '-' + 6 hex
  case "$name" in
    agent-my-repo-name-with-a-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "PASS machine name pattern" ;;
    *) record "FAIL machine name pattern ($name)" ;;
  esac
  assert_eq "$name" "$(derive_machine_name "$repo")" "machine name stable"
}
test_machine_name_falls_back_for_symbol_only_basename() {
  case "$(derive_machine_name "$TMP_ROOT/___")" in
    agent-repo-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "PASS fallback base" ;;
    *) record "FAIL fallback base" ;;
  esac
}
test_worktree_resolves_to_main_repo_root() {
  local repo="$TMP_ROOT/wt-main"
  mkdir -p "$repo" && git -C "$repo" init -q
  git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  git -C "$repo" worktree add -q "$repo/.git/worktree/feat" -b feat
  assert_eq "$(cd -P "$repo" && pwd -P)" "$(cd "$repo/.git/worktree/feat" && resolve_repo_root)" "worktree -> main root"
}
test_outside_git_repo_fails() {
  mkdir -p "$TMP_ROOT/plain"
  assert_status 1 "non-repo fails" -- bash -c "cd '$TMP_ROOT/plain' && GIT_CEILING_DIRECTORIES='$TMP_ROOT' AGENT_VM_LIB=1 . '$LAUNCHER' && resolve_repo_root"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 4 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
resolve_repo_root() {
  local common
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "not inside a git repository"
  (cd -P "$(dirname "$common")" && pwd -P)
}

derive_machine_name() { # repo_root
  local base hash
  base=$(basename "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-' | cut -c1-20 | sed 's/-*$//')
  if [[ -z "$base" ]]; then base=repo; fi
  hash=$(printf '%s' "$1" | shasum -a 256 | cut -c1-6)
  printf 'agent-%s-%s\n' "$base" "$hash"
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): resolve repo root and derive machine names`

### T3: machine メタデータと exclude 判定（K1・K10）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/.chezmoiignore:24`（設定を host 側に置く既存の gating。K10 の exclude も host 側 `~/.config/agent-vm/config`）

- [ ] **Step 1: 失敗するテスト**

```bash
test_meta_roundtrip_with_equals_in_path() {
  write_machine_meta agent-x-000000 "/tmp/a=b/repo"
  assert_eq "/tmp/a=b/repo" "$(read_meta_field agent-x-000000 repo_path)" "repo_path keeps '='"
  assert_eq "1" "$(read_meta_field agent-x-000000 format)" "format=1"
}
test_meta_rejects_newline_path() {
  # die exits, so run it in a child process like the other fail-closed tests
  assert_status 1 "newline path rejected" -- bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; write_machine_meta agent-x-000000 \"\$(printf '/tmp/a\\nb')\""
}
test_exclude_prefix_on_directory_boundary() {
  mkdir -p "$AGENT_VM_CONFIG_DIR" "$TMP_ROOT/ex/repo" "$TMP_ROOT/ex/repo2"
  printf '# comment\n%s  # trailing comment\n' "$TMP_ROOT/ex/repo" >"$AGENT_VM_CONFIG_DIR/config"
  assert_status 0 "exact match excluded" -- is_excluded "$(cd -P "$TMP_ROOT/ex/repo" && pwd -P)"
  assert_status 1 "sibling with same prefix not excluded" -- is_excluded "$(cd -P "$TMP_ROOT/ex/repo2" && pwd -P)"
}
test_exclude_missing_config_means_not_excluded() {
  assert_status 1 "no config" -- is_excluded "$TMP_ROOT/any"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 4 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
meta_path() { printf '%s/machines/%s\n' "$AGENT_VM_STATE_DIR" "$1"; }

write_machine_meta() { # machine repo_path
  case "$2" in *$'\n'*) die "repository path contains a newline; refusing to launch" ;; esac
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=%s\n' "$2" >"$(meta_path "$1")"
}

read_meta_field() { # machine key -> value after the first '=' (unknown keys are ignored)
  local line
  if [[ ! -f "$(meta_path "$1")" ]]; then return 1; fi
  while IFS= read -r line; do
    if [[ "${line%%=*}" == "$2" ]]; then printf '%s\n' "${line#*=}"; return 0; fi
  done <"$(meta_path "$1")"
  return 1
}

is_excluded() { # repo_root; config: one absolute path per line, '#' starts a comment
  local cfg="$AGENT_VM_CONFIG_DIR/config" line entry
  if [[ ! -f "$cfg" ]]; then return 1; fi
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
    if [[ -z "$line" ]]; then continue; fi
    entry=$(cd -P "$line" 2>/dev/null && pwd -P) || continue
    if [[ "$1" == "$entry" || "$1" == "$entry"/* ]]; then return 0; fi
  done <"$cfg"
  return 1
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): record machine metadata and honor host-side excludes`

### T4: health check と workingTree 解決（K10・K11、fail closed）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/.chezmoiscripts/run_onchange_install-packages-7b-node-modules.sh.tmpl`（`.chezmoi.workingTree` = repo root の既存利用）

- [ ] **Step 1: 失敗するテスト**

```bash
test_health_fails_closed_when_orb_hangs() {
  local out status=0 start end
  start=$(date +%s)
  out=$(STUB_ORB_SLEEP=5 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; check_health" 2>&1) || status=$?
  end=$(date +%s)
  assert_eq 1 "$status" "hung orb fails"
  assert_contains "$out" "AGENT_VM=off" "guidance printed"
  if [[ $((end - start)) -le 4 ]]; then record "PASS gives up within ~3s"; else record "FAIL gives up within ~3s ($((end - start))s)"; fi
}
test_health_fails_when_orb_missing() {
  local out status=0
  out=$(PATH="/usr/bin:/bin" bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; check_health" 2>&1) || status=$?
  assert_eq 1 "$status" "missing orb fails"
  assert_contains "$out" "AGENT_VM=off" "guidance printed"
}
test_working_tree_resolved_from_chezmoi_source_path() {
  local wt="$TMP_ROOT/dotfiles"; mkdir -p "$wt/home" && git -C "$wt" init -q
  assert_eq "$(cd -P "$wt" && pwd -P)" "$(cd -P "$(STUB_CHEZMOI_STDOUT="$wt/home" resolve_working_tree)" && pwd -P)" "workingTree = git toplevel of source-path"
}
test_working_tree_failure_fails_closed() {
  assert_status 1 "chezmoi failure fails closed" -- env STUB_CHEZMOI_EXIT=1 bash -c "AGENT_VM_LIB=1 . '$LAUNCHER'; resolve_working_tree"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 4 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
FAIL_CLOSED_HINT="to run on the host instead: AGENT_VM=off claude"

run_with_timeout() { # seconds cmd... (macOS has no timeout(1); perl alarm is standard)
  perl -e 'alarm shift; exec @ARGV or exit 127' "$@"
}

check_health() {
  command -v orb >/dev/null 2>&1 || die "OrbStack (orb) not found. $FAIL_CLOSED_HINT"
  run_with_timeout 3 orb status >/dev/null 2>&1 </dev/null 9>&- || die "OrbStack is not responding. $FAIL_CLOSED_HINT"
}

resolve_working_tree() {
  local src
  src=$(chezmoi source-path 2>/dev/null </dev/null) || die "cannot resolve chezmoi source path. $FAIL_CLOSED_HINT"
  git -C "$src" rev-parse --show-toplevel 2>/dev/null || die "chezmoi source is not a git checkout. $FAIL_CLOSED_HINT"
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): fail closed when OrbStack or chezmoi source is unavailable`

### T5: machine 単位の flock（K1、V14 の Linux / macOS CI 側）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: flock(2)「Locks created by flock() are associated with an open file description … released … when all such file descriptors have been closed」（本セッションで `man 2 flock` を確認済み）

- [ ] **Step 1: 失敗するテスト**

```bash
try_lock() { # machine -> exit status of a fresh process trying the lock for 1s
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1
}
test_second_acquirer_is_refused_while_held() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock agent-l-000000 1 && sleep 3" </dev/null &
  sleep 1
  local status=0; try_lock agent-l-000000 || status=$?
  assert_eq 1 "$status" "busy lock refused"
  wait
}
test_lock_released_when_holder_is_killed() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock agent-k-000000 1 && sleep 30" </dev/null &
  local pid=$!
  sleep 1; kill -9 "$pid"; wait "$pid" 2>/dev/null || true
  local status=0; try_lock agent-k-000000 || status=$?
  assert_eq 0 "$status" "lock free after kill -9"
}
test_release_allows_reacquire() {
  acquire_lock agent-r-000000 1
  release_lock
  local status=0; try_lock agent-r-000000 || status=$?
  assert_eq 0 "$status" "reacquire after release"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 3 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
acquire_lock() { # machine max_wait_seconds; holds fd 9 until release_lock or process exit
  local waited=0
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  exec 9>"$AGENT_VM_STATE_DIR/machines/$1.lock"
  until perl -MFcntl=:flock -e 'open(my $f, ">&=", 9) or die "fdopen: $!"; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
    waited=$((waited + 1))
    if [[ "$waited" -ge "$2" ]]; then
      exec 9>&-
      return 1
    fi
    step "another session for this repo is preparing (${waited}s)"
    sleep 1
  done
}

release_lock() { exec 9>&-; }
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。kill -9 のテストは V14 の CI 側検証（ubuntu と macOS `/bin/bash` 3.2、T11）を兼ねる。
- [ ] **Step 5: コミット** — `feat(agent-vm): serialize per-machine setup with an inherited-fd flock`

### T6: staging の世代生成と内容 hash（K2・K3）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl`（workingTree の `.skills/` を読む = staging root は repo root）
- 参照: rename(2)（宛先が symlink ならその entry を置き換え、辿らない。宛先が空でないディレクトリなら失敗）

- [ ] **Step 1: 失敗するテスト**

```bash
make_dotfiles_fixture() { # -> path of a git repo with tracked + untracked files
  local wt="$TMP_ROOT/df"; mkdir -p "$wt/home" "$wt/.skills/s"
  git -C "$wt" init -q
  printf 'a\n' >"$wt/home/dot_a"; printf 's\n' >"$wt/.skills/s/SKILL.md"
  git -C "$wt" add . && git -C "$wt" -c user.email=t@t -c user.name=t commit -q -m init
  printf 'secret\n' >"$wt/.env.local" # untracked, must not be staged
  printf '%s\n' "$wt"
}
test_generation_contains_tracked_files_only() {
  local wt gen hash; wt=$(make_dotfiles_fixture)
  read -r gen hash <<<"$(build_staging agent-s-000000 "$wt")"
  local st="$AGENT_VM_STATE_DIR/staging/agent-s-000000/$gen"
  assert_eq "a" "$(cat "$st/home/dot_a")" "tracked file copied"
  assert_eq "s" "$(cat "$st/.skills/s/SKILL.md")" "repo-root .skills copied"
  assert_status 1 "untracked secret not copied" -- test -e "$st/.env.local"
  assert_contains "$hash" "v1:" "hash is versioned"
}
test_vm_planted_entries_are_removed_without_following_symlinks() {
  local wt gen hash; wt=$(make_dotfiles_fixture)
  local st="$AGENT_VM_STATE_DIR/staging/agent-s-000001" outside="$TMP_ROOT/outside"
  mkdir -p "$st" "$outside"; printf 'keep\n' >"$outside/victim"
  ln -s "$outside" "$st/evil-link"; printf 'x\n' >"$st/injected"
  read -r gen hash <<<"$(build_staging agent-s-000001 "$wt")"
  assert_eq "$gen" "$(ls "$st")" "only the new generation remains"
  assert_eq "keep" "$(cat "$outside/victim")" "symlink target untouched"
}
test_hash_reflects_uncommitted_edits() {
  local wt g1 h1 g2 h2; wt=$(make_dotfiles_fixture)
  read -r g1 h1 <<<"$(build_staging agent-s-000002 "$wt")"
  printf 'edited\n' >"$wt/home/dot_a"
  read -r g2 h2 <<<"$(build_staging agent-s-000002 "$wt")"
  if [[ "$h1" != "$h2" ]]; then record "PASS uncommitted edit changes hash"; else record "FAIL uncommitted edit changes hash"; fi
  if [[ "$g1" != "$g2" ]]; then record "PASS new generation name"; else record "FAIL new generation name"; fi
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 3 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
dir_hash() { # dir -> v1:<sha256 of sorted "sha256  ./path" lines>
  local digest
  digest=$(cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -c1-64)
  printf 'v1:%s\n' "$digest"
}

build_staging() { # machine working_tree -> prints "<generation> <hash>"
  local build gen hash st="$AGENT_VM_STATE_DIR/staging/$1"
  mkdir -p "$AGENT_VM_STATE_DIR/build" "$st"
  # Build where the VM cannot see it; the host never writes file contents inside the mounted tree.
  # build/ and staging/ share $AGENT_VM_STATE_DIR so rename(2) stays on one filesystem; if an override
  # ever splits them, rename fails with EXDEV and we die (fail closed) rather than copy into the mount.
  build=$(mktemp -d "$AGENT_VM_STATE_DIR/build/$1.XXXXXX")
  { git -C "$2" ls-files -z | rsync -a --from0 --files-from=- "$2/" "$build/"; } 9>&-
  hash=$(dir_hash "$build")
  gen="gen-${build##*.}"
  # rename(2) replaces a planted symlink entry instead of following it, and fails on a planted non-empty dir.
  perl -e 'rename($ARGV[0], $ARGV[1]) or die "rename: $!\n"' "$build" "$st/$gen" || die "could not publish staging generation"
  # rm does not follow symlinks, so VM-planted links are unlinked, never traversed.
  find "$st" -mindepth 1 -maxdepth 1 ! -name "$gen" -exec rm -rf {} + 9>&-
  printf '%s %s\n' "$gen" "$hash"
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): publish staging generations by rename from a hidden build dir`

### T7: machine の作成と bootstrap の要否判定（K1・K3）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: https://docs.orbstack.dev/machines/isolated（`--isolated` / `--isolate-network` / `--forward-ssh-agent` / `--mount SOURCE[:DEST]`、research F1/F2）
- 参照: https://docs.orbstack.dev/machines/cloud-init（`-c/--user-data`、research R4）

- [ ] **Step 1: 失敗するテスト**

```bash
test_create_uses_isolation_flags_and_mounts() {
  ensure_machine agent-c-000000 /repo/path /wt
  local log; log=$(cat "$STUB_LOG")
  assert_contains "$log" "orb create" "create called"
  assert_contains "$log" "--isolated" "isolated"
  assert_contains "$log" "--isolate-network" "network isolated"
  assert_contains "$log" "--forward-ssh-agent" "agent forwarded"
  assert_contains "$log" "-c /wt/agent-vm/cloud-init.yaml" "cloud-init from working tree"
  assert_contains "$log" "--mount /repo/path:/repo/path" "repo mounted at same path"
  assert_contains "$log" "--mount $AGENT_VM_STATE_DIR/staging/agent-c-000000:/opt/agent-vm/src" "staging mount"
  assert_contains "$log" "--mount $AGENT_VM_STATE_DIR/outbox/agent-c-000000:/opt/agent-vm/outbox" "outbox mount"
}
test_existing_machine_is_not_recreated() {
  STUB_ORB_LIST_STDOUT="agent-e-000000  running  ubuntu" ensure_machine agent-e-000000 /r /wt
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no create for existing"
}
test_bootstrap_skipped_when_hash_matches() {
  STUB_ORB_STDOUT="v1:abc" maybe_bootstrap agent-b-000000 gen-x "v1:abc"
  assert_not_contains "$(cat "$STUB_LOG")" "bootstrap.sh" "skip on match"
}
test_bootstrap_runs_with_generation_and_hash() {
  STUB_ORB_STDOUT="v1:old" maybe_bootstrap agent-b-000000 gen-abc "v1:new"
  assert_contains "$(cat "$STUB_LOG")" "bash /opt/agent-vm/src/gen-abc/agent-vm/bootstrap.sh 1 v1:new /opt/agent-vm/src/gen-abc" "bootstrap contract v1"
}
test_applied_hash_is_read_from_vm_home_not_cwd() {
  STUB_ORB_STDOUT="v1:abc" maybe_bootstrap agent-b-000000 gen-x "v1:abc"
  assert_contains "$(cat "$STUB_LOG")" '$HOME/.local/state/agent-vm/applied-hash' "absolute HOME path"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 5 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
# Mount-root assumption: an isolated machine sees only the mounted subtree, so the guest can
# change entries inside staging/<m> but cannot replace staging/<m> itself (spec K2).
ensure_machine() { # machine repo_root working_tree
  if orb list </dev/null 9>&- | awk '{print $1}' | grep -qx "$1"; then return 0; fi
  mkdir -p "$AGENT_VM_STATE_DIR/staging/$1" "$AGENT_VM_STATE_DIR/outbox/$1"
  step "creating isolated machine $1 (first run only)"
  orb create --isolated --isolate-network --forward-ssh-agent \
    -c "$3/agent-vm/cloud-init.yaml" \
    --mount "$2:$2" \
    --mount "$AGENT_VM_STATE_DIR/staging/$1:/opt/agent-vm/src" \
    --mount "$AGENT_VM_STATE_DIR/outbox/$1:/opt/agent-vm/outbox" \
    ubuntu "$1" </dev/null 9>&-
}

maybe_bootstrap() { # machine generation staging_hash
  local applied src="/opt/agent-vm/src/$2"
  # The command's cwd inside the machine is not guaranteed to be $HOME, so read by absolute path.
  applied=$(orb -m "$1" sh -c 'cat "$HOME/.local/state/agent-vm/applied-hash"' 2>/dev/null </dev/null 9>&-) || applied=""
  if [[ "$applied" == "$3" ]]; then return 0; fi
  step "applying dotfiles in $1"
  orb -m "$1" bash "$src/agent-vm/bootstrap.sh" "$BOOTSTRAP_CONTRACT" "$3" "$src" </dev/null 9>&-
}
```

launcher の先頭付近に `BOOTSTRAP_CONTRACT=1` を定義する。

bootstrap.sh の契約（plan-3 で実装）: 引数 `<contract version> <hash> <src dir>`。bootstrap.sh は staging（= 作業中の working tree）から、launcher は最後に `chezmoi apply` した版から動くため、同じ作業中に両者の呼び出し形を変えるとずれうる。bootstrap.sh は自分の知らない contract version を受けたら「launcher と bootstrap の契約版が一致しない。host で `chezmoi apply` を実行して launcher を更新する」旨を表示して終了コード 3 で終わる。成功時は src dir を VM ローカルの chezmoi source へ同期して apply し、`<hash>` を改行 1 つ付きで `$HOME/.local/state/agent-vm/applied-hash` に書く（`$(...)` で読むと改行は落ちるので比較は一致する）。

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): create isolated machines and bootstrap on hash change`

### T8: 秘密の注入（K6）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_shell_common/functions.sh:58-`（`ope` の `op inject` 利用形）

- [ ] **Step 1: 失敗するテスト**

```bash
test_only_host_owned_env_files_are_resolved() {
  local repo="$TMP_ROOT/sec-repo"; mkdir -p "$repo" "$AGENT_VM_CONFIG_DIR/repos"
  printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  printf 'B=op://v/b/x\n' >"$AGENT_VM_CONFIG_DIR/repos/agent-p-000000.env.1password"
  printf 'EVIL=op://v/other/x\n' >"$repo/.env"
  local files; files=$(cd "$repo" && env_files_for agent-p-000000)
  assert_contains "$files" "$AGENT_VM_CONFIG_DIR/env.1password" "global file"
  assert_contains "$files" "agent-p-000000.env.1password" "per-repo host file"
  assert_not_contains "$files" "$repo/.env" "repo .env never resolved"
}
test_secret_values_never_appear_in_argv() {
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  STUB_CAPTURE_STDIN=1 STUB_OP_STDOUT="A=s3cr3t-value" STUB_ORB_STDOUT="/dev/shm/agent-vm.env.abc123" inject_secrets agent-p-000000 >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "s3cr3t-value" "secret not in any argv"
  assert_contains "$(cat "$STUB_LOG.stdin")" "s3cr3t-value" "secret delivered on stdin"
  assert_contains "$(cat "$STUB_LOG")" "-mmin +1" "stale env files swept before write"
}
test_no_env_files_means_no_op_call() {
  inject_secrets agent-n-000000 >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "op inject" "op not called"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 3 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
env_files_for() { # machine -> host-owned op:// reference files that exist
  local f
  for f in "$AGENT_VM_CONFIG_DIR/env.1password" "$AGENT_VM_CONFIG_DIR/repos/$1.env.1password"; do
    if [[ -f "$f" ]]; then printf '%s\n' "$f"; fi
  done
  return 0
}

inject_secrets() { # machine -> prints the in-VM env file path (empty when nothing to inject)
  local files resolved="" f
  files=$(env_files_for "$1")
  if [[ -z "$files" ]]; then return 0; fi
  # Resolve on the host first so the biometric prompt finishes before any file exists in the VM.
  while IFS= read -r f; do
    resolved+="$(op inject -i "$f" </dev/null 9>&-)"$'\n'
  done <<<"$files"
  printf '%s' "$resolved" | orb -m "$1" sh -c '
    d=${XDG_RUNTIME_DIR:-/dev/shm}
    find "$d" -maxdepth 1 -name "agent-vm.env.*" -mmin +1 -delete 2>/dev/null
    umask 077; f=$(mktemp "$d/agent-vm.env.XXXXXX"); cat >"$f"; echo "$f"' 9>&-
}
```

`printf` は bash 組み込みなので値はプロセス引数に出ない。stub の argv ログに `-mmin +1` が現れるのは `sh -c` のスクリプト文字列に含まれるため。

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): inject host-resolved secrets via stdin into VM tmpfs`

### T9: 起動フロー（Codex 認証確認・タイトル・prewarm）（K7・K10・K15）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: spec Architecture の手順 0〜9（本タスクは 0〜3・6〜8 を結線。4・5・9 は plan-2 で `run_tool` の同じ位置に挿入する）

- [ ] **Step 1: 失敗するテスト**

```bash
make_flow_repo() { local repo="$TMP_ROOT/flow-repo"; mkdir -p "$repo" && git -C "$repo" init -q; printf '%s\n' "$repo"; }

test_launch_script_without_args_succeeds() {
  local cmd; cmd=$(build_launch_script claude /repo/path "")
  assert_contains "$cmd" 'exec claude' "no-arg launch builds"
  assert_not_contains "$cmd" '. ' "no env sourcing when no env file"
}
test_launch_script_sources_and_deletes_env_file() {
  local cmd; cmd=$(build_launch_script claude "/repo/with space" /dev/shm/agent-vm.env.x --resume 'a;b')
  assert_contains "$cmd" 'cd /repo/with\ space' "cwd quoted"
  assert_contains "$cmd" '. /dev/shm/agent-vm.env.x' "env sourced"
  assert_contains "$cmd" 'rm -f /dev/shm/agent-vm.env.x' "env deleted"
  assert_contains "$cmd" 'exec claude --resume a\;b' "args quoted"
}
test_codex_login_runs_only_when_auth_missing() {
  STUB_ORB_EXIT=1 ensure_codex_auth agent-a-000000 || true
  assert_contains "$(cat "$STUB_LOG")" "codex login --device-auth" "device auth when missing"
  : >"$STUB_LOG"
  ensure_codex_auth agent-a-000000
  assert_not_contains "$(cat "$STUB_LOG")" "login" "no login when present"
}
test_session_runs_without_holding_the_lock() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  notice_orphan_env() { :; } # implemented in T10
  session_exec() { # replaces the real orb session in this subshell only
    if bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_lock '$1' 1" </dev/null >/dev/null 2>&1; then
      record "PASS lock free during session"
    else
      record "FAIL lock free during session"
    fi
  }
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" run_tool claude) 2>/dev/null
}
test_prewarm_stops_before_secrets_and_session() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  session_exec() { record "FAIL prewarm must not start a session"; }
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  (cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" cmd_prewarm) 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "existing machine reused"
  assert_contains "$(cat "$STUB_LOG")" "bootstrap.sh" "prewarm bootstraps"
  assert_not_contains "$(cat "$STUB_LOG")" "op inject" "prewarm injects no secrets"
}
test_main_dispatches_commands() {
  run_tool() { printf 'run_tool %s\n' "$*"; }
  cmd_list() { echo list; }; cmd_gc() { echo gc; }; cmd_rm() { echo "rm $*"; }
  cmd_prewarm() { echo prewarm; }; cmd_env_edit() { echo env-edit; }; cmd_env_adopt() { echo "env-adopt $*"; }
  assert_eq "run_tool claude -p x" "$(main claude -p x)" "claude"
  assert_eq "run_tool codex" "$(main codex)" "codex"
  assert_eq "run_tool bash" "$(main shell)" "shell"
  assert_eq "prewarm" "$(main prewarm)" "prewarm"
  assert_eq "list" "$(main list)" "list"
  assert_eq "gc" "$(main gc)" "gc"
  assert_eq "rm /r" "$(main rm /r)" "rm"
  assert_eq "env-edit" "$(main env edit)" "env edit"
  assert_eq "env-adopt agent-old-000000" "$(main env adopt agent-old-000000)" "env adopt"
  assert_status 1 "unknown env subcommand" -- main env frobnicate
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 6 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
build_launch_script() { # tool repo_root env_file args...
  local tool=$1 repo=$2 envf=$3 script
  shift 3
  script="cd $(printf '%q' "$repo")"
  if [[ -n "$envf" ]]; then
    script+="; set -a; . $(printf '%q' "$envf"); set +a; rm -f $(printf '%q' "$envf")"
  fi
  script+="; exec $tool"
  if [[ $# -gt 0 ]]; then script+="$(printf ' %q' "$@")"; fi
  printf '%s\n' "$script"
}

ensure_codex_auth() { # machine
  if orb -m "$1" sh -c 'test -f "$HOME/.codex/auth.json"' </dev/null 9>&-; then return 0; fi
  step "Codex is not logged in on $1; starting device authorization (once per repo)"
  orb -m "$1" bash -lc 'codex login --device-auth'
}

set_title() {
  if [[ -t 1 ]]; then printf '\033]0;%s\007' "$1"; fi
}

session_exec() { orb -m "$1" bash -lc "$2"; } # machine script

prepare_machine() { # tool -> sets MACHINE and REPO; leaves the machine bootstrapped
  local wt gen hash out
  check_health
  wt=$(resolve_working_tree)
  REPO=$(resolve_repo_root)
  MACHINE=$(derive_machine_name "$REPO")
  write_machine_meta "$MACHINE" "$REPO"
  acquire_lock "$MACHINE" 60 || die "timed out waiting for another session of this repo"
  # Assignment form so set -e aborts when build_staging dies (a here-string substitution is not checked).
  out=$(build_staging "$MACHINE" "$wt")
  read -r gen hash <<<"$out"
  ensure_machine "$MACHINE" "$REPO" "$wt"
  maybe_bootstrap "$MACHINE" "$gen" "$hash"
  release_lock
}

run_tool() { # tool args...
  local tool=$1 envf script status=0
  shift
  prepare_machine "$tool"
  notice_orphan_env "$MACHINE"
  if [[ "$tool" == codex ]]; then ensure_codex_auth "$MACHINE"; fi
  envf=$(inject_secrets "$MACHINE")
  script=$(build_launch_script "$tool" "$REPO" "$envf" "$@")
  set_title "[vm:$MACHINE] $REPO"
  session_exec "$MACHINE" "$script" || status=$?
  set_title "$REPO"
  return "$status"
}

cmd_prewarm() {
  prepare_machine prewarm
  step "machine $MACHINE is ready"
}
```

main の case を次に置き換える:

```bash
main() {
  case "${1:-}" in
    -h | --help | help | "") show_help ;;
    claude | codex) run_tool "$@" ;;
    shell) run_tool bash ;;
    prewarm) cmd_prewarm ;;
    list) cmd_list ;;
    gc) cmd_gc ;;
    rm) shift; cmd_rm "$@" ;;
    env)
      case "${2:-}" in
        edit) cmd_env_edit ;;
        adopt) cmd_env_adopt "${3:-}" ;;
        *) show_help >&2; return 1 ;;
      esac
      ;;
    *) die "unknown command: $1" ;;
  esac
}
```

`notice_orphan_env` / `cmd_list` / `cmd_gc` / `cmd_rm` / `cmd_env_edit` / `cmd_env_adopt` は T10 で実装する。T9 の時点で `run_tool` を通すテスト（`test_session_runs_without_holding_the_lock`）は冒頭で `notice_orphan_env() { :; }` を定義する。各テストは独立した subshell で走るので、この定義は T10 の本実装やほかのテストに影響しない。

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): launch claude/codex in the repo machine without holding the lock`

### T10: 管理サブコマンドと孤立 env の通知（K14・K6）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`、テスト: `tests/agent-vm/run.sh`
- 参照: spec K14（`gc` は repo 消失が契機、`rm` は明示削除、repo 別 env ファイルは削除せず孤立として通知し `env adopt` で引き継ぐ）

- [ ] **Step 1: 失敗するテスト**

```bash
test_list_marks_missing_repos_and_skips_lock_files() {
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  : >"$AGENT_VM_STATE_DIR/machines/agent-live-000000.lock"
  local out; out=$(cmd_list)
  assert_contains "$out" "agent-live-000000	present" "live listed"
  assert_contains "$out" "agent-gone-000000	missing" "gone repo marked missing"
  assert_not_contains "$out" ".lock" "lock files are not machines"
}
test_list_shows_orphaned_env_files() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  assert_contains "$(cmd_list)" "orphaned env: agent-gone-000000" "orphan env listed"
}
test_gc_deletes_missing_machines_but_keeps_env_files() {
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_STATE_DIR/staging/agent-gone-000000" "$AGENT_VM_CONFIG_DIR/repos"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  printf 'y\n' | cmd_gc >/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-gone-000000" "orb delete for missing"
  assert_not_contains "$(cat "$STUB_LOG")" "agent-live-000000" "live untouched"
  assert_status 1 "staging of gone removed" -- test -e "$AGENT_VM_STATE_DIR/staging/agent-gone-000000"
  assert_status 0 "host-authored env file kept" -- test -f "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}
test_gc_aborts_without_yes() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  printf 'n\n' | cmd_gc >/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "delete" "no deletion on 'n'"
}
test_launch_notices_orphan_env_when_own_is_missing() {
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  assert_contains "$(notice_orphan_env agent-new-000000 2>&1)" "agent-vm env adopt agent-gone-000000" "adopt hint"
  : >"$AGENT_VM_CONFIG_DIR/repos/agent-new-000000.env.1password"
  assert_eq "" "$(notice_orphan_env agent-new-000000 2>&1)" "silent when own env exists"
}
test_env_adopt_renames_orphan_to_current_machine() {
  local repo="$TMP_ROOT/adopt-repo"; mkdir -p "$repo" && git -C "$repo" init -q
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  write_machine_meta agent-gone-000000 "$TMP_ROOT/does-not-exist"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
  (cd "$repo" && cmd_env_adopt agent-gone-000000) 2>/dev/null
  assert_eq "A=op://v/a/x" "$(cat "$AGENT_VM_CONFIG_DIR/repos/$m.env.1password")" "adopted"
  assert_status 1 "old name gone" -- test -e "$AGENT_VM_CONFIG_DIR/repos/agent-gone-000000.env.1password"
}
test_env_adopt_refuses_non_orphan() {
  local repo="$TMP_ROOT/adopt-repo2"; mkdir -p "$repo" && git -C "$repo" init -q
  write_machine_meta agent-live-000000 "$TMP_ROOT"
  mkdir -p "$AGENT_VM_CONFIG_DIR/repos"; : >"$AGENT_VM_CONFIG_DIR/repos/agent-live-000000.env.1password"
  assert_status 1 "live repo env not adoptable" -- bash -c "cd '$repo' && AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_CONFIG_DIR='$AGENT_VM_CONFIG_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; cmd_env_adopt agent-live-000000"
}
test_env_edit_creates_private_file() {
  local repo="$TMP_ROOT/edit-repo"; mkdir -p "$repo" && git -C "$repo" init -q
  local m; m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  (cd "$repo" && EDITOR=true cmd_env_edit)
  local f="$AGENT_VM_CONFIG_DIR/repos/$m.env.1password"
  assert_status 0 "file created" -- test -f "$f"
  assert_eq "600" "$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$f")" "mode 600 from creation"
}
```

- [ ] **Step 2: 失敗を確認** — 期待: 8 件 FAIL。

- [ ] **Step 3: 最小実装**

```bash
forget_machine() { # machine: host-side state for one machine (host-authored env files are kept)
  rm -rf "$AGENT_VM_STATE_DIR/staging/$1" "$AGENT_VM_STATE_DIR/outbox/$1" \
    "$AGENT_VM_STATE_DIR/snapshots/$1" "$AGENT_VM_STATE_DIR/ingested/$1" \
    "$(meta_path "$1")" "$AGENT_VM_STATE_DIR/machines/$1.lock"
}

machine_state() { # machine -> present|missing (missing also when metadata is absent)
  local repo
  repo=$(read_meta_field "$1" repo_path) || { echo missing; return 0; }
  if [[ -d "$repo" ]]; then echo present; else echo missing; fi
}

orphaned_env_machines() { # machines whose env file exists but whose repo is gone
  local f m
  for f in "$AGENT_VM_CONFIG_DIR"/repos/*.env.1password; do
    [[ -f "$f" ]] || continue
    m=$(basename "$f" .env.1password)
    if [[ "$(machine_state "$m")" == missing ]]; then printf '%s\n' "$m"; fi
  done
  return 0
}

machine_rows() { # TSV only: machine, state, repo_path (consumed by cmd_list and cmd_gc)
  local f m
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    m=$(basename "$f")
    printf '%s\t%s\t%s\n' "$m" "$(machine_state "$m")" "$(read_meta_field "$m" repo_path || true)"
  done
  return 0
}

cmd_list() { # human-facing: machine rows followed by orphaned env notes
  machine_rows
  orphaned_env_machines | sed 's/^/orphaned env: /'
}

notice_orphan_env() { # machine
  local m
  if [[ -f "$AGENT_VM_CONFIG_DIR/repos/$1.env.1password" ]]; then return 0; fi
  for m in $(orphaned_env_machines); do
    step "an env file of a missing repo exists; if this repo was moved: agent-vm env adopt $m"
  done
  return 0
}

cmd_gc() {
  local targets answer m
  targets=$(machine_rows | awk -F'\t' '$2 == "missing" {print $1}')
  if [[ -z "$targets" ]]; then echo "nothing to collect"; return 0; fi
  printf 'machines whose repository no longer exists:\n%s\ndelete them? [y/N] ' "$targets"
  read -r answer
  if [[ "$answer" != y && "$answer" != Y ]]; then return 0; fi
  while IFS= read -r m; do
    orb delete -f "$m" </dev/null
    forget_machine "$m"
  done <<<"$targets"
}

cmd_rm() { # [repo]
  local repo m answer
  repo=$(cd "${1:-.}" && resolve_repo_root)
  m=$(derive_machine_name "$repo")
  printf 'delete machine %s for %s? [y/N] ' "$m" "$repo"
  read -r answer
  if [[ "$answer" != y && "$answer" != Y ]]; then return 0; fi
  orb delete -f "$m" </dev/null
  forget_machine "$m"
}

cmd_env_edit() {
  local f
  f="$AGENT_VM_CONFIG_DIR/repos/$(derive_machine_name "$(resolve_repo_root)").env.1password"
  mkdir -p "$(dirname "$f")"
  if [[ ! -f "$f" ]]; then (umask 077 && : >"$f"); fi
  "${EDITOR:-vi}" "$f"
}

cmd_env_adopt() { # old_machine
  local old=$1 new
  [[ -n "$old" ]] || die "usage: agent-vm env adopt <machine>"
  orphaned_env_machines | grep -qx "$old" || die "$old is not an orphaned env file (its repo still exists or it has no env file)"
  new=$(derive_machine_name "$(resolve_repo_root)")
  [[ ! -e "$AGENT_VM_CONFIG_DIR/repos/$new.env.1password" ]] || die "this repo already has an env file"
  mv "$AGENT_VM_CONFIG_DIR/repos/$old.env.1password" "$AGENT_VM_CONFIG_DIR/repos/$new.env.1password"
  step "adopted env file of $old for $new"
}
```

- [ ] **Step 4: 通過を確認** — 期待: `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): add list, gc, rm, env edit/adopt and orphaned env notices`

### T11: deploy 範囲と merge を止める CI（K11）

**Files:**

- 新規: `.github/workflows/ci-agent-vm.yml`
- 編集: `home/.chezmoiignore:28-32` 付近、`package.json` の `scripts`、`.github/workflows/status-check.yml`
- 参照: `home/.chezmoiignore:28-32`（`{{ if ne .chezmoi.os "windows" }}` による OS 別除外の既存形）
- 参照: `.github/workflows/status-check.yml`（`workflow_run.workflows` と `requiredWorkflows` の 2 箇所に同名を並べる既存規約）
- 参照: `.github/workflows/ci-smoke-chezmoi.yml:1-50`（paths トリガー、`permissions: contents: read`、SHA pin した `actions/checkout` の既存形）

- [ ] **Step 1: 失敗するテスト** — 検証コマンド:
  - `chezmoi execute-template < home/.chezmoiignore`（Linux）の出力に `dot_local/bin/executable_agent-vm` と `dot_config/agent-vm` が含まれること。変更前は含まれない（Red）。
  - `grep -c "agent-vm Launcher Tests" .github/workflows/status-check.yml` が 2 であること。変更前は 0（Red）。

- [ ] **Step 2: 最小実装**

`home/.chezmoiignore` に追加:

```
# agent-vm (OrbStack launcher) - macOS host only
{{ if ne .chezmoi.os "darwin" }}
dot_local/bin/executable_agent-vm
dot_config/agent-vm
{{ end }}
```

`.github/workflows/ci-agent-vm.yml`:

```yaml
name: agent-vm Launcher Tests

on:
  push:
    branches: [master, main]
    paths:
      - "home/dot_local/bin/executable_agent-vm"
      - "tests/agent-vm/**"
      - ".github/workflows/ci-agent-vm.yml"
  pull_request:
    branches: [master, main]
    paths:
      - "home/dot_local/bin/executable_agent-vm"
      - "tests/agent-vm/**"
      - ".github/workflows/ci-agent-vm.yml"
  workflow_dispatch:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    name: agent-vm tests (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      # /bin/bash is 3.2 on macOS: the launcher must run on the stock shell.
      - name: Run launcher tests
        run: /bin/bash tests/agent-vm/run.sh
```

`.github/workflows/status-check.yml` の `workflow_run.workflows` と `requiredWorkflows` の両方に `"agent-vm Launcher Tests"` を追加する（paths で走らなかった場合は既存ロジックどおり「Not run」で通過）。

`package.json` の scripts に `"test:agent-vm": "bash tests/agent-vm/run.sh"` を追加する（ローカル実行用。CI は上記 workflow が実行する）。

- [ ] **Step 3: 通過を確認** — 上記 2 つの検証コマンドが期待どおり。`npm run test:agent-vm` が `0 failed`。`npm run lint:shell` が新規ファイル（shebang 付き extensionless を含む）で警告 0。`npm run lint:actions` が新規 workflow で警告 0。
- [ ] **Step 4: コミット** — `ci(agent-vm): gate launcher to macOS and require its tests on ubuntu and macOS`

## ISO 25010 具体テストケース

### 使用性（運用操作性）

- **入力**: OrbStack が 5 秒応答しない（`STUB_ORB_SLEEP=5`） → **期待**: 4 秒以内に終了コード 1、stderr に `AGENT_VM=off` を含む（T4）
- **入力**: 引数なしの `agent-vm claude` → **期待**: 起動スクリプトが生成され `set -e` で落ちない（T9）
- **入力**: 1 つ目のセッション実行中に同じ machine の lock を取る → **期待**: 取得できる（T9）
- **入力**: `agent-vm prewarm` → **期待**: bootstrap まで走り、`op inject` もセッション開始も起きない（T9）
- **入力**: 移動した repo で起動し、旧 machine の env ファイルが孤立している → **期待**: `agent-vm env adopt <旧 machine>` を含む 1 行（T10）

### セキュリティ（機密性・完全性）

- **入力**: repo の `.env` に `EVIL=op://v/other/x` → **期待**: `env_files_for` の出力に repo の `.env` が無い（T8）
- **入力**: `op` が `A=s3cr3t-value` を返す → **期待**: argv ログに 0 回、stdin ログに 1 回（T8）
- **入力**: VM が staging に `evil-link -> <host dir>` と `injected` を置いた状態で再生成 → **期待**: staging 直下は新世代 1 つだけ、symlink 先のファイル内容は `keep` のまま（T6）
- **入力**: dotfiles に untracked の `.env.local` → **期待**: staging に存在しない（T6）
- **入力**: `env edit` で新規作成 → **期待**: 作成直後から mode 600（T10）
- **入力**: repo path に空白、引数に `a;b` → **期待**: 起動スクリプト内で `\ ` と `\;` にエスケープ（T9）

### 機能適合性（機能正確性）

- **入力**: `.git/worktree/feat` から起動 → **期待**: repo root はメイン repo（T2）
- **入力**: basename が `___` → **期待**: `agent-repo-<6hex>`（T2）
- **入力**: `repo_path` に `=` を含む → **期待**: 読み戻し値が完全一致（T3）
- **入力**: exclude に `/x/repo`、対象 `/x/repo2` → **期待**: 除外されない（T3）
- **入力**: 保持中プロセスを `kill -9` → **期待**: 次のプロセスが 1 秒以内に lock を取得できる（T5）
- **入力**: `machines/` に `.lock` ファイルが共存 → **期待**: `list` に出ない（T10）
- **入力**: `gc` で missing machine を削除 → **期待**: host の env ファイルは残る（T10）

### 移植性（設置性）

- **入力**: Linux で `.chezmoiignore` を render → **期待**: launcher と `dot_config/agent-vm` が除外リストに含まれる（T11）
- **入力**: macOS runner の `/bin/bash`（3.2）でテスト実行 → **期待**: `0 failed`（T11）
- **入力**: `PATH` に `orb` が無い → **期待**: 終了コード 1 と案内（T4）

対象外: 性能効率の warm 起動 3 秒は OrbStack 実機が要るため spec V4（mac 実機検証）で測る。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: `build_launch_script` は引数なしのとき末尾の `[[ ]] &&` が 1 を返し `set -e` で落ちる。T2 の期待パターンが実際の切り詰め結果と合わない。テスト間で config/state が漏れる。stub の stdin 取り込みが CI でハングしうる。パイプ前段が fd 9 を継承する。prewarm 分岐が未実装。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: prewarm 分岐と `main()` の振り分け（shell / 管理コマンド）が prose のみでテストが無い。

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 組み込み先の CI workflow が `status-check.yml` の必須集合に無く merge を止めない。chezmoiscripts 用 job への相乗りは目的が違う。`tests/agent-vm/` 配置の理由が無い。

### security-vulnerability-analyzer
- verdict: blocker
- 主指摘: テスト用 `eval` フックが本番 launcher に入る。VM が書ける staging に host が直接 rsync で書き込むと、symlink の差し替えで host 上の任意パスへ書かれうる。env edit のファイル作成時に一瞬 umask 既定の権限になる。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: repo の rename で `repos/<machine>.env.1password` が黙って孤立する（host で書いた状態なので通知が要る）。lock ファイルと共存する `cmd_list` のテストが無い。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: Round 1 は解消。T3 の改行パステストが `die` で subshell ごと終了し常に FAIL になる。here-string 内の置換は `set -e` で検査されず、`build_staging` の失敗が黙って進む。prewarm テストの stub 出力が `orb list` にも効き、`ensure_machine` の退行を拾えない。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 は解消。env adopt と専用 CI は spec K14 と前ラウンド指摘に直結。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 専用 workflow と status-check への登録で解消。macOS runner のコストは軽微な記録事項。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: 3 件とも解消。同一ファイルシステム前提と mount root 前提をコメントで固定するとよい。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: applied-hash を cwd 相対で読んでおり、cwd が `$HOME` でないと毎回 bootstrap が走る。launcher（apply 済み）と bootstrap.sh（作業中の staging）の呼び出し契約に版が無い。`cmd_list` の出力を `cmd_gc` が構文解析している。

<!-- auto-review: verdict=blocker; hash=fd6a5cc6c9316fb742cd428319e4e439ebf3e4f9e7675462c383bed025a4efc9; design-hash=7a1b6432d4fff14cd411238886eea351092729fc08b98315d3fb817b32c7a7e4; round=1; parent-spec-hash=c98de6a19afab57bbbc348d97a7663ccf98813c9c135654be37b827ae17ea23e; at=2026-09-28T14:20:56.352Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-09-28T14:20:56.370Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: Round 2 の 4 件はすべて解消。変更箇所に新規の問題なし。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 3 件とも解消。bootstrap.sh の終了コード 3 の案内が利用者に届くことは plan-3 でテストする。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=b853fea9ef4d4f06102441b2ec756ea2becfb75bd9a3205c17fbf8d9ef163b24; design-hash=07e44e575cd05679f0033ca22a93b7442e7074f394f499df31bd9bbe244bf451; round=2; parent-spec-hash=ffb1522f997e087e270f15193a72fc376dd4e2c3213cd5c5a0d677253ac8d43f; at=2026-09-28T14:30:58.028Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=11; excluded=0; at=2026-09-28T14:30:58.046Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: 親 spec の変更（K3 の hash 計算位置、K7 の認証確認と注入の順序、K14 の adopt の前提）と plan-1 は整合。変更不要。

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=6f277ea73c81f21daf103c75dfe52de9d65ba24344f53b398574ca82433a388a; design-hash=07e44e575cd05679f0033ca22a93b7442e7074f394f499df31bd9bbe244bf451; round=3; parent-spec-hash=ffb1522f997e087e270f15193a72fc376dd4e2c3213cd5c5a0d677253ac8d43f; at=2026-09-28T14:33:09.226Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-09-28T14:33:09.243Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 親 spec の K7 変更（Claude は VM ごとの初回ログイン、launcher は何もしない）と整合。plan-1 に Claude token の参照は無く、inject_secrets は汎用。変更不要。

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=6f277ea73c81f21daf103c75dfe52de9d65ba24344f53b398574ca82433a388a; design-hash=07e44e575cd05679f0033ca22a93b7442e7074f394f499df31bd9bbe244bf451; round=4; parent-spec-hash=38b06a1ecf916f3e230bbc5c3985ce0f516438f7b4a7950d29c58ab34ab06f8e; at=2026-09-28T14:43:59.887Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-09-28T14:43:59.906Z -->

## Reviewer Outputs (Round 6)

### logic-validator
- verdict: pass
- 主指摘: 親 spec の K16 と cloud-init の担当訂正は bootstrap / cloud-init の中身の話で、plan-1 の呼び出し契約と cloud-init のパス受け渡しは影響を受けない。変更不要。

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### scope-justification-reviewer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 5)
- 主指摘: Round 5 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=6f277ea73c81f21daf103c75dfe52de9d65ba24344f53b398574ca82433a388a; design-hash=07e44e575cd05679f0033ca22a93b7442e7074f394f499df31bd9bbe244bf451; round=5; parent-spec-hash=95a0fa3a0ffb18b339e4336bd35d1744ff2966373282db17c2b43f395f49a2b9; at=2026-09-28T16:04:32.662Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-09-28T16:04:32.680Z -->

<!-- auto-review: verdict=pass; hash=6f277ea73c81f21daf103c75dfe52de9d65ba24344f53b398574ca82433a388a; design-hash=07e44e575cd05679f0033ca22a93b7442e7074f394f499df31bd9bbe244bf451; round=6; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:21:24.408Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-09-28T16:21:24.425Z -->
