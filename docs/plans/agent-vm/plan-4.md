<!-- spec-ref: spec.md -->

# Plan 4: シェル統合・導入ガイド・設計記録

spec の K10（既定で VM 経由、opt-out は host 側のみ、`AGENT_VM=off`）の「打鍵はそのまま」の入口と、host で起動すべき場合の素通し、導入ガイド（K8 の 1Password 承認設定、R4 の失効手順、R8 の運用ルール、K14 の `env adopt` の前提、V1–V17 の実機確認手順）、ADR、Session Artifact Retention に従った設計文書の保存を行う。

共通制約は plan-1 と同じ（bash 3.2、本番コードにテスト専用分岐を置かない、stub でテスト）。シェル関数は bash と zsh の両方で読まれるので POSIX sh の構文だけを使う。

実装順: **plan-2 の実装後に着手する**。着手時に `grep -c 'core.fsmonitor=' home/dot_local/bin/executable_agent-vm` が 1 以上であることを確かめ、0 なら plan-4 には入らない（plan-2 T4 の防御フラグ付き `resolve_repo_root` がまだ無いため）。T1 は plan-2 T4 で防御フラグ（`-c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks`）を入れた `resolve_repo_root` を前提にする（VM が書ける `.git` に対して、その前に git を実行しないため）。

「host で起動する」判断の原則: **repo が無いと確かめられたときだけ** host で起動する。git が失敗したことは repo が無い証拠にしない（VM が `.git` を壊すと git は失敗するので、それを「repo の外」と扱うと隔離が外れる）。

## Files

```
# 新規作成
home/dot_shell_common/agent_vm.sh
tests/agent-vm/run-shell.sh
tests/agent-vm/stubs/claude
tests/agent-vm/stubs/codex
tests/agent-vm/stubs/orb
tests/agent-vm/stubs/agent-vm
docs/agent-vm.md
docs/decisions/0017-agent-vm-orbstack.md
docs/plans/agent-vm/research.md
docs/plans/agent-vm/spec.md
docs/plans/agent-vm/plan-1.md
docs/plans/agent-vm/plan-2.md
docs/plans/agent-vm/plan-3.md
docs/plans/agent-vm/plan-4.md

# 編集
home/dot_shell_common/darwin.sh
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
.github/workflows/ci-agent-vm.yml
```

## Tasks

### T1: repo の外と exclude 対象では host で起動する（K10）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`run_tool` の先頭）、テスト: `tests/agent-vm/run.sh`、stub: `tests/agent-vm/stubs/claude`
- 参照: `home/dot_local/bin/executable_agent-vm` の `resolve_repo_root` と `is_excluded`（plan-1 で実装済み）
- 参照: spec K10（「cwd が git repo 内・`AGENT_VM` が off でない・exclude に該当しない」の 3 条件で VM 経由。それ以外は host）

- [ ] **Step 1: 失敗するテスト**

`tests/agent-vm/stubs/claude`（stub の共通形。引数を `$STUB_LOG` に `claude …` と記録して 0 で終わる）を追加し、`run.sh` に:

```bash
test_outside_a_repo_claude_runs_on_the_host() {
  mkdir -p "$TMP_ROOT/plain"
  local out; out=$(cd "$TMP_ROOT/plain" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude -p hi 2>&1)
  assert_contains "$(cat "$STUB_LOG")" "claude -p hi" "host claude executed with the same args"
  assert_not_contains "$(cat "$STUB_LOG")" "orb " "no VM involved"
  assert_contains "$out" "on the host" "says where it runs"
}
test_excluded_repo_runs_on_the_host() {
  local repo; repo=$(make_flow_repo)
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf '%s\n' "$(cd -P "$repo" && pwd -P)" >"$AGENT_VM_CONFIG_DIR/config"
  (cd "$repo" && bash "$LAUNCHER" codex </dev/null 2>/dev/null) || true
  assert_contains "$(cat "$STUB_LOG")" "codex" "host codex (stub) executed"
  assert_not_contains "$(cat "$STUB_LOG")" "orb " "excluded repo does not touch OrbStack"
}
test_broken_git_dir_fails_closed_instead_of_running_on_the_host() {
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  printf 'not a git dir\n' >"$repo/.git/HEAD"; printf '[broken\n' >"$repo/.git/config"
  local status=0 out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "broken repo -> refuse"
  assert_contains "$out" "not inside a usable git repository" "refused by the repository check itself"
  assert_contains "$out" "AGENT_VM=off" "hint printed"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_git_file_worktree_marker_counts_as_a_repo() {
  local wt; wt=$(make_dotfiles_fixture)
  mkdir -p "$TMP_ROOT/wt"; printf 'gitdir: /nonexistent\n' >"$TMP_ROOT/wt/.git"
  local status=0 out; out=$(cd "$TMP_ROOT/wt" && STUB_CHEZMOI_STDOUT="$wt/home" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "a .git file with a broken target is not 'outside a repo'"
  assert_contains "$out" "not inside a usable git repository" "refused by the repository check itself"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_known_repo_with_deleted_git_dir_is_refused() {
  local repo; repo=$(make_flow_repo)
  local real; real=$(cd -P "$repo" && pwd -P)
  write_machine_meta "$(derive_machine_name "$real")" "$real"
  rm -rf "$repo/.git"
  local status=0 out; out=$(cd "$repo" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "a previously used repo whose .git vanished -> refuse"
  assert_contains "$out" ".git is missing" "names the reason"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_unreadable_record_fails_closed_outside_a_repo() {
  mkdir -p "$TMP_ROOT/plain" "$AGENT_VM_STATE_DIR/machines"
  printf 'garbage\n' >"$AGENT_VM_STATE_DIR/machines/agent-bad-000000"
  local status=0; (cd "$TMP_ROOT/plain" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash "$LAUNCHER" claude </dev/null >/dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "an unreadable record blocks host passthrough"
  assert_not_contains "$(cat "$STUB_LOG")" "claude" "host claude never executed"
}
test_rm_works_for_a_known_repo_without_git() {
  local repo; repo=$(make_flow_repo)
  local real m; real=$(cd -P "$repo" && pwd -P); m=$(derive_machine_name "$real")
  write_machine_meta "$m" "$real"
  rm -rf "$repo/.git"
  printf 'y\n' | (cd "$TMP_ROOT" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" cmd_rm "$real") >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $m" "machine of the .git-less repo deleted"
  assert_status 1 "record removed" -- test -e "$AGENT_VM_STATE_DIR/machines/$m"
}
test_op_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_OP_EXIT=1 bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired on an op inject failure"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c 'failed unexpectedly')" "reported once, not per subshell"
}
test_secret_handoff_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  mkdir -p "$AGENT_VM_CONFIG_DIR"; printf 'A=op://v/a/x\n' >"$AGENT_VM_CONFIG_DIR/env.1password"
  # the in-VM write script contains "agent-vm.env"; only that orb call fails
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_OP_STDOUT="A=x" STUB_ORB_FAIL_ON="agent-vm.env" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired when handing secrets to the VM fails"
}
test_empty_chezmoi_source_path_fails_closed() {
  local repo; repo=$(make_flow_repo)
  local status=0 out; out=$(cd "$repo" && GIT_CEILING_DIRECTORIES="$TMP_ROOT" STUB_CHEZMOI_STDOUT="" bash "$LAUNCHER" claude </dev/null 2>&1) || status=$?
  assert_eq 1 "$status" "empty source path -> refuse"
  assert_contains "$out" "cannot resolve chezmoi source path" "does not fall back to git in the cwd"
}
test_shell_outside_a_repo_is_refused() {
  mkdir -p "$TMP_ROOT/plain"
  assert_status 1 "agent-vm shell needs a repo" -- bash -c "cd '$TMP_ROOT/plain' && GIT_CEILING_DIRECTORIES='$TMP_ROOT' bash '$LAUNCHER' shell"
}
test_unexpected_failure_prints_the_host_hint() {
  # health check and `orb list` succeed; only `orb create` fails, i.e. strictly after check_health
  local wt repo; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_FAIL_ON="create" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired"
  assert_contains "$out" "AGENT_VM=off" "hint on an unexpected failure"
}
test_bootstrap_failure_prints_the_host_hint() {
  local wt repo m; wt=$(make_dotfiles_fixture); repo=$(make_flow_repo)
  m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")
  local out; out=$(cd "$repo" && STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT="v1:old" STUB_ORB_FAIL_ON="bootstrap.sh" bash "$LAUNCHER" claude </dev/null 2>&1) || true
  assert_contains "$out" "failed unexpectedly" "ERR trap fired on a bootstrap failure"
}
```

`tests/agent-vm/stubs/codex` も `claude` と同形で追加する（開発機に本物の codex があっても、テストが対話セッションを起動しないように）。`tests/agent-vm/stubs/orb` には、引数全体に `STUB_ORB_FAIL_ON` の文字列を含む呼び出しだけを終了コード 9 で失敗させる 1 行を、既存の `list` 分岐の前に足す:

```bash
if [[ -n "${STUB_ORB_FAIL_ON:-}" && "$*" == *"$STUB_ORB_FAIL_ON"* ]]; then exit 9; fi
```

- [ ] **Step 2: 失敗を確認** — 期待: 13 件のテストがすべて FAIL を含む（現状は repo 外で `die`、exclude を見ない、`.git` の有無と記録を確かめない、想定外の失敗で案内を出さない、source path が空でも git を実行する、`.git` の無い repo の machine を `rm` できない）。

- [ ] **Step 3: 最小実装**（`run_tool` の `shift` の直後に追加）

```bash
has_git_marker() { # 0 when this dir or an ancestor has .git (dir or file); a filesystem walk, no git call
  local dir
  dir=$(pwd -P)
  while :; do
    if [[ -e "$dir/.git" || -L "$dir/.git" ]]; then return 0; fi
    if [[ "$dir" == / ]]; then return 1; fi
    case ":${GIT_CEILING_DIRECTORIES:-}:" in *":$(dirname "$dir"):"*) return 1 ;; esac
    dir=$(dirname "$dir")
  done
}

# Records live in $AGENT_VM_STATE_DIR/machines, which no machine mounts (only staging/<m> and outbox/<m> are),
# so a VM cannot erase its own record to re-enable host passthrough.
known_repo_containing_cwd() { # -> repo_path whose record contains cwd; exit 2 when a record is unreadable
  local here f repo
  here=$(pwd -P)
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    # An unreadable record could be the one for this directory: do not treat it as absent.
    repo=$(read_meta_field "$(basename "$f")" repo_path) || { printf '%s\n' "$f"; return 2; }
    if [[ "$here" == "$repo" || "$here" == "$repo"/* ]]; then printf '%s\n' "$repo"; return 0; fi
  done
  return 1
}

host_reason() { # -> why the tool should run on the host; empty when it should run in the VM
  local repo known
  # Only a proven absence of any .git allows the host: git failing is not evidence (a VM can break .git),
  # and a missing .git in a directory the VM used before is not evidence either (the VM can delete it).
  if ! has_git_marker; then
    local status=0
    known=$(known_repo_containing_cwd) || status=$?
    case "$status" in
      0) die ".git is missing in $known, which ran in an agent-vm machine before; refusing to run on the host. Check the repository, then: agent-vm rm $known (or AGENT_VM=off to override)" ;;
      2) die "cannot read agent-vm record $known; refusing to run on the host. Remove or fix it (agent-vm list shows records), or use AGENT_VM=off to override" ;;
    esac
    echo "not inside a git repository"
    return 0
  fi
  repo=$(resolve_repo_root 2>/dev/null) || return 0 # run_tool's own resolve then fails closed
  if is_excluded "$repo"; then echo "listed in $AGENT_VM_CONFIG_DIR/config"; fi
  return 0
}
```

`.git` があるのに git が失敗する repo では `host_reason` は空を返し、続く `prepare_machine` の `resolve_repo_root` が `die`（fail closed）する。その `die` の文言に `FAIL_CLOSED_HINT` を足す（plan-2 T4 で防御フラグ付きに置き換えた行の `die` 引数を `"not inside a usable git repository. $FAIL_CLOSED_HINT"` にする）。

停止メッセージが勧める `agent-vm rm <repo>` が `.git` の消えた repo でも使えるよう、plan-1 の `cmd_rm` の repo 解決を「git で解決できなければ、引数の realpath と一致する記録を探す」形にする:

```bash
cmd_rm() { # [repo]
  local path repo m answer f
  path=$(cd "${1:-.}" && pwd -P) || die "no such directory: ${1:-.}"
  # An exact host-side record wins: it also works when .git is gone (see host_reason), and it cannot be
  # shadowed by an unrelated git repository in an ancestor directory.
  repo=""
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    if [[ "$(read_meta_field "$(basename "$f")" repo_path 2>/dev/null || true)" == "$path" ]]; then repo=$path; fi
  done
  if [[ -z "$repo" ]]; then
    repo=$(cd "$path" && resolve_repo_root 2>/dev/null) || die "$path is neither a git repository nor a recorded agent-vm repository"
  fi
  m=$(derive_machine_name "$repo")
  printf 'delete machine %s for %s? [y/N] ' "$m" "$repo"
  read -r answer
  if [[ "$answer" != y && "$answer" != Y ]]; then return 0; fi
  orb delete -f "$m" </dev/null
  forget_machine "$m"
}
```

VM が書ける `.git` に触れる git 呼び出しを防御フラグ付きの `resolve_repo_root` だけにするため、`prepare_machine` の順序を `resolve_repo_root` → `resolve_working_tree` に入れ替え、`resolve_working_tree` は chezmoi が空の source path を返したら git を呼ばずに `die` する（空の `-C ""` は cwd、つまり VM が書ける repo に対する git 実行になるため）。あわせて `resolve_working_tree` の git にも同じ防御フラグを付ける:

```bash
resolve_working_tree() {
  local src
  src=$(chezmoi source-path 2>/dev/null </dev/null) || src=""
  [[ -n "$src" ]] || die "cannot resolve chezmoi source path. $FAIL_CLOSED_HINT"
  git -c core.fsmonitor= -c core.hooksPath=/dev/null --no-optional-locks -C "$src" rev-parse --show-toplevel 2>/dev/null \
    || die "chezmoi source is not a git checkout. $FAIL_CLOSED_HINT"
}
```

想定外の失敗（`set -e` による中断）でも案内が出るよう、`main` の直前で ERR trap を張る。ライブラリとして source されたとき（テスト）は張らない:

```bash
on_unexpected_error() {
  # set -E makes command substitutions inherit the trap; report once, from the top-level shell only.
  if [[ "$BASH_SUBSHELL" -eq 0 ]]; then
    printf 'agent-vm: failed unexpectedly (see the error above). %s\n' "$FAIL_CLOSED_HINT" >&2
  fi
}

if [[ -z "${AGENT_VM_LIB:-}" ]]; then
  set -E
  trap on_unexpected_error ERR
  main "$@"
fi
```

（既存の最終行 `if [[ -z "${AGENT_VM_LIB:-}" ]]; then main "$@"; fi` を置き換える。`die` は明示的な `exit` なので ERR trap は発火せず、案内が二重に出ることはない。）

```bash
  if [[ "$tool" == claude || "$tool" == codex ]]; then
    local reason
    reason=$(host_reason) || exit 1 # a die inside host_reason (known repo, .git gone) must stop here
    if [[ -n "$reason" ]]; then
      step "running $tool on the host ($reason)"
      exec "$tool" "$@"
    fi
  fi
```

`resolve_repo_root` は失敗時に `die`（exit）するが、`$(...)` の subshell 内なので呼び出し側は終了しない。`agent-vm shell` は素通しの対象外なので、repo の外では従来どおり `die` する。exclude に載せた repo は host で動くので、plan-2 の git 面検査とログ取り込みも走らない（隔離そのものを外す選択なので、ガイドにそう書く）。

- [ ] **Step 4: 通過を確認** — `bash tests/agent-vm/run.sh` が `0 failed`。
- [ ] **Step 5: コミット** — `feat(agent-vm): run claude/codex on the host outside repositories and for excluded repos`

### T2: `claude` / `codex` の打鍵を agent-vm に回すシェル関数（K10）

**Files:**

- 新規: `home/dot_shell_common/agent_vm.sh`、`tests/agent-vm/run-shell.sh`、stub: `tests/agent-vm/stubs/agent-vm`
- 編集: `home/dot_shell_common/darwin.sh`（末尾に source 1 行）、`.github/workflows/ci-agent-vm.yml`
- 参照: `home/dot_shell_common/init.sh:57`（darwin.sh は darwin でのみ `$SHELL_COMMON/darwin.sh` として読まれる）

- [ ] **Step 1: 失敗するテスト**

`tests/agent-vm/stubs/agent-vm`（引数を `agent-vm …` と記録して 0 で終わる）と `tests/agent-vm/run-shell.sh`:

```bash
#!/usr/bin/env bash
# Runs the shell-function checks under bash and, when installed, zsh.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
FUNCS="$REPO_ROOT/home/dot_shell_common/agent_vm.sh"
TMP_BASE=$(mktemp -d -t agent-vm-shell-XXXXXX)
trap 'rm -rf "$TMP_BASE"' EXIT
export PATH="$TEST_DIR/stubs:$PATH" RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
# shellcheck source=tests/agent-vm/lib.sh
. "$TEST_DIR/lib.sh"

check_shell() { # shell
  local sh=$1 log="$TMP_BASE/$sh.log"
  : >"$log"
  STUB_LOG="$log" "$sh" -c ". '$FUNCS'; claude -p hi; codex; AGENT_VM=off claude --version"
  assert_contains "$(cat "$log")" "agent-vm claude -p hi" "$sh: claude goes through agent-vm"
  assert_contains "$(cat "$log")" "agent-vm codex" "$sh: codex goes through agent-vm"
  assert_contains "$(cat "$log")" "claude --version" "$sh: AGENT_VM=off runs host claude"
  assert_not_contains "$(cat "$log")" "agent-vm claude --version" "$sh: AGENT_VM=off bypasses agent-vm"
}
check_without_launcher() { # shell: without agent-vm on PATH the functions are not defined
  local sh=$1 log="$TMP_BASE/$sh-nolauncher.log" bin="$TMP_BASE/bin-$sh"
  mkdir -p "$bin"; cp "$TEST_DIR/stubs/claude" "$bin/claude"
  : >"$log"
  STUB_LOG="$log" PATH="$bin:/usr/bin:/bin" "$sh" -c ". '$FUNCS'; claude -p hi"
  assert_eq "claude -p hi" "$(cat "$log")" "$sh: no launcher -> plain claude"
}

check_shell bash
check_without_launcher bash
if command -v zsh >/dev/null 2>&1; then
  check_shell zsh
  check_without_launcher zsh
else
  record "PASS zsh checks skipped (zsh not installed)"
fi

failed=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
grep '^FAIL' "$RESULTS_FILE" || true
printf '%d run, %d failed\n' "$(wc -l <"$RESULTS_FILE" | tr -d ' ')" "$failed"
[[ "$failed" -eq 0 ]]
```

- [ ] **Step 2: 失敗を確認** — 期待: `agent_vm.sh` が無いので非 0 終了。

- [ ] **Step 3: 最小実装**

`home/dot_shell_common/agent_vm.sh`:

```sh
# shellcheck shell=sh
# claude / codex run inside this repository's OrbStack machine through agent-vm (docs/agent-vm.md).
# `AGENT_VM=off claude` runs the host binary for one command. Repositories that should always run on
# the host are listed in ~/.config/agent-vm/config (never in the repository, which the VM can write).
if command -v agent-vm >/dev/null 2>&1; then
  claude() {
    if [ "${AGENT_VM:-}" = off ]; then command claude "$@"; else agent-vm claude "$@"; fi
  }
  codex() {
    if [ "${AGENT_VM:-}" = off ]; then command codex "$@"; else agent-vm codex "$@"; fi
  }
fi
```

`home/dot_shell_common/darwin.sh` の末尾に追加（launcher は darwin にのみ deploy されるが、関数の定義条件は launcher の有無で判定するので Linux で読まれても何もしない）:

```sh
# agent-vm: route claude / codex into the per-repository OrbStack machine
[ -f "$SHELL_COMMON/agent_vm.sh" ] && . "$SHELL_COMMON/agent_vm.sh"
```

`.github/workflows/ci-agent-vm.yml` の push / pull_request 両方の paths に `home/dot_shell_common/agent_vm.sh` と `home/dot_shell_common/darwin.sh` を追加し、job に `- name: Run shell function tests` / `run: bash tests/agent-vm/run-shell.sh`（全 OS）を追加する。

- [ ] **Step 4: 通過を確認** — `bash tests/agent-vm/run-shell.sh` が `0 failed`（ubuntu と macOS の CI で。macOS には zsh が標準で入る）。既存の `home/dot_shell_common/test_suite.sh --pre-apply` が通ること（shell 互換性テストが darwin.sh の追加行で壊れないこと）。
- [ ] **Step 5: コミット** — `feat(agent-vm): route claude and codex through agent-vm in interactive shells`

### T3: 導入ガイドと ADR（K8・R4・R8・K14・V1–V17）

**Files:**

- 新規: `docs/agent-vm.md`、`docs/decisions/0017-agent-vm-orbstack.md`
- 参照: `docs/decisions/0016-hook-telemetry-wrapper.md`（ADR の見出し構成: Status / Context / Decision（却下した代替案つき）/ Consequences）
- 参照: `home/dot_claude/rules/code-quality.md`（「Recoverable State Must Announce Itself」: 復旧手順はガイドにも書くが、主経路は launcher が出す `recover:` 行）

- [ ] **Step 1: 内容の確認基準を先に決める** — `docs/agent-vm.md` は次の節をこの順で持ち、各節に下記の具体的内容を含むこと（レビューはこの一覧との突き合わせで行う）:
  1. **何をするか** — `claude` / `codex` を repo ごとの OrbStack isolated machine で動かすこと、host の原本が VM から書き換えられないこと、1Password と SSH 署名は mac 側に残ること（3〜5 行）
  2. **最初の準備** — `chezmoi apply`（OrbStack cask の導入）、`chezmoi init`（`agent_vm` キーを config に入れるため。入れなくても動作は同じだが警告が消える）、OrbStack の初回起動、1Password の SSH agent 設定で「承認をアプリごとに毎回求める」側を選ぶこと（K8・R3）
  3. **普段の使い方** — repo で `claude` / `codex` と打つだけ、初回は machine 作成の待ちがあること、`agent-vm prewarm`、VM ごとに初回だけ Claude / Codex のログインが要ること（URL を mac のブラウザで開きコードを貼る）
  4. **秘密の渡し方** — `~/.config/agent-vm/env.1password`（全 repo 共通）と `agent-vm env edit`（repo 別）、`op://` 参照だけを書くこと、repo 内の `.env` は解決しないことと理由
  5. **host で動かしたいとき** — `AGENT_VM=off claude`、`~/.config/agent-vm/config` の書式（K10）。exclude に載せた repo では隔離も git 面検査もログ取り込みも行われないこと。起動が終了コード 1 で止まったときも `AGENT_VM=off` で host に切り替えられること（6 節への参照）
  6. **終了時の表示と復旧** — 終了コードの一覧: 1（起動を止めた: OrbStack 不調、`.git` が壊れている、以前 VM で使った repo の `.git` が消えている、repo の外での `agent-vm shell`。host に切り替えないのは意図どおりで、host で動かすなら `AGENT_VM=off` を付けて自分で選ぶ）、3 / 4 / 5 の意味、`agent-vm restore-git`（何を戻し何を消すか: exec 系の設定は外すだけ、untracked は `*.agent-vm-quarantine` に改名）、`agent-vm sync [--inspect]`。agent-vm 自体が想定外のエラーで止まったとき（OrbStack 不調を含む）は、その場は `AGENT_VM=off` で host 起動でき、`agent-vm rm` で machine を作り直せること。`.git` が壊れた repo では host に切り替わらず止まる理由
  7. **気をつけること** — VM セッション中はその repo で host の git を使わない（R8）、`env adopt` は同じプロジェクトかを確かめない（K14）、mac のクリップボード画像は貼れない
  8. **片付け** — `agent-vm list` / `gc` / `rm`、認証を取り消す手順（claude.ai と ChatGPT のセッション管理から取り消し、`agent-vm rm`）（R4）
  9. **mac 実機での確認項目** — spec の V1–V17 を、それぞれ「やること → 期待する結果」の 1 行で

  `docs/decisions/0017-agent-vm-orbstack.md` は Status（accepted、日付）、Context（オーダーと、通常 machine では `/Users` 全体 rw と `mac` コマンドがある事実）、Decision（K1〜K16 の骨子と、却下した代替案: 通常 machine + bubblewrap、Docker container、共有 staging、repo の `.env` 解決、auth の共有、長期 token 注入、mkdir+pid の lock）、Consequences（R1〜R9 と未検証の V 項目、`docs/plans/agent-vm/` への参照）を持つ。

- [ ] **Step 2: 書く** — 上の基準どおりに 2 ファイルを書く。日本語で、本 repo の文章規範（`japanese-tech-writing` skill）に従う。
- [ ] **Step 3: 確認** — 基準の 9 節と ADR の 4 見出しがすべてあること、`npm run format:check` が通ること、文中のコマンド名・ファイルパス・終了コードが実装（plan-1〜3）と一致すること（`grep` で突き合わせる）。
- [ ] **Step 4: コミット** — `docs(agent-vm): add the setup guide and ADR-0017`

### T4: 設計文書の保存（Session Artifact Retention）

**Files:**

- 新規: `docs/plans/agent-vm/{research,spec,plan-1,plan-2,plan-3,plan-4}.md`
- 参照: `home/dot_claude/rules/workflow.md` の「Session Artifact Retention」（`.tmp/sessions/` は 7 日で GC されるので、実装計画は `docs/plans/` に移す）
- 参照: `docs/plans/hook-telemetry/`（保存済み計画の既存の置き方）

- [ ] **Step 1: 確認基準** — 6 ファイルが `.tmp/sessions/848edd10/` の最終版と同一内容であること（auto-review marker と Reviewer Outputs を含めてそのままコピーする。承認の記録として残すため）。
- [ ] **Step 2: コピー** — `cp` で 6 ファイルを複製する。複製前に（公開 repo に入る文書へ秘密の所在を載せないため、code-quality の秘密に関する規則に従い）`grep -n 'op://' .tmp/sessions/848edd10/*.md` を実行し、出てくるのが説明用の例（`op://v/a/x` など）だけで、実在の vault や item を指す参照が無いことを確かめる。
- [ ] **Step 3: 確認** — `diff` で差分 0。`npm run format:check` が失敗する場合は、`docs/plans/` 内の既存ファイルと同じ扱い（format 対象外なら `.oxfmtignore` の既存設定に従う）であることを確かめ、内容は書き換えない。
- [ ] **Step 4: コミット** — `docs(plans): keep the agent-vm research, spec and plans`

## ISO 25010 具体テストケース

### 使用性（運用操作性）

- **入力**: 対話シェルで `claude -p hi`（launcher あり） → **期待**: `agent-vm claude -p hi` が呼ばれる（bash / zsh、T2）
- **入力**: `AGENT_VM=off claude --version` → **期待**: host の `claude --version`、agent-vm は呼ばれない（T2）
- **入力**: git repo の外で `claude -p hi` → **期待**: host の claude が同じ引数で起動し、「on the host」と表示（T1）
- **入力**: exclude に載った repo で `codex` → **期待**: host の codex が起動し、OrbStack に触れない（T1）
- **入力**: staging 中に `orb` が想定外に失敗（終了コード 9） → **期待**: `AGENT_VM=off` の案内を表示（T1）

### セキュリティ（完全性）

- **入力**: `.git/HEAD` と `.git/config` を壊した repo で `claude` → **期待**: 終了コード 1、host の claude は起動しない（T1）
- **入力**: 壊れた `.git` ファイル（worktree 形式）のあるディレクトリで `claude` → **期待**: 終了コード 1、host の claude は起動しない（T1）
- **入力**: 以前 VM で使った repo の `.git` を削除して `claude` → **期待**: 終了コード 1、「.git is missing」を表示、host の claude は起動しない（T1）
- **入力**: chezmoi が空の source path を返す → **期待**: 終了コード 1、cwd に対して git を実行しない（T1）

### 移植性（設置性）

- **入力**: launcher の無い環境（Linux）で `agent_vm.sh` を読む → **期待**: 関数は定義されず、`claude` は通常のコマンド（T2）
- **入力**: macOS runner の zsh と bash → **期待**: 同じ結果（T2）

### 機能適合性

- **入力**: repo の外で `agent-vm shell` → **期待**: 終了コード 1（T1）

対象外: ガイドの内容の正しさは T3 の確認基準との突き合わせで確認する（自動テストではない）。V1–V17 は mac 実機での確認。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: exclude のテストが stub の無い `codex` を stdin 付きで exec し、実物の codex がある開発機では対話セッションが起動して止まる。exclude 対象では plan-2 の検査と取り込みも走らない点が未記載。CI の paths に darwin.sh が無い。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 4 タスクとも K10 と保存規則に対応。CONTEXT.md への語彙追加と README からの参照は必須ではない（判断を記録すべき）。

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: `host_reason` は「repo の外」と「VM が `.git` を壊して git が失敗」を区別できず、後者で host に素通しして隔離を丸ごと外す。`resolve_repo_root` の防御フラグは plan-2 で入るので、plan-4 は plan-2 の後に実装する必要がある。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 終了コードとサブコマンド名はガイドと実装が一致。ADR 番号 0017 は空き。関数定義を別ファイルに置く点を spec の図は反映していない（軽微）。

### resilience-analyzer

- verdict: needs-work
- 主指摘: fail closed と再帰しないことは確認。ただし staging・mount・bootstrap の途中で想定外に失敗すると生の bash エラーだけが出て `AGENT_VM=off` の案内が無く、ガイドにもこの場合の復旧が無い。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: 想定外失敗のテストは `check_health` の既存の `die` で止まり ERR trap に届かない（→ `orb create` だけを失敗させる stub 指定に変更、bootstrap 失敗のテストも追加）。chezmoi の source path が空だと `resolve_working_tree` が cwd（壊れた repo）に防御フラグなしで git を実行する（→ 空なら git を呼ばず die、防御フラグを付け、`resolve_repo_root` を先に実行）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分は Round 1 の指摘に直結。`op://` の確認に理由を 1 行添えるとよい（反映済み）。

### security-vulnerability-analyzer

- verdict: blocker
- 主指摘: ファイルシステムの走査だけだと、VM が `.git` を丸ごと消せば次回から host に素通しになる（→ host 側の記録 `machines/<m>` にある repo の中なら、`.git` が無くても止める）。

### data-contract-evolution-evaluator

- verdict: needs-work
- 主指摘: ガイドの終了コード一覧に、起動を止める終了コード 1 の場合を載せるべき。5 節からも参照すべき（反映済み）。

### resilience-analyzer

- verdict: needs-work
- 主指摘: die が ERR trap を二重に発火しないことは実測で確認。想定外失敗のテストが 1 箇所だけで、bootstrap での失敗は未検証（→ テスト追加）。

<!-- auto-review: verdict=blocker; hash=dd74aa33ee752ea1efb137236efa4aa426622d285b6e6f27cf5a98e408b86f79; design-hash=e33bddf5a44b099a1cf8ff4528cd2c7f54cc6783180d6f04f6b1f607a7fed28c; round=1; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:45:25.244Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-09-28T16:45:25.277Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: blocker（前提の読み違いを含む、一部採用）
- 主指摘: 現在の launcher に plan-2 の防御フラグが無いことを blocker とした → plan-4 は「plan-2 の実装後に着手」と明記済みで、現時点の未実装は想定どおり。着手時に `grep -c 'core.fsmonitor='` で前提を機械的に確かめる手順を追加。ERR trap・bootstrap 失敗・host_reason の die の経路は正しい。2 つのテストに `GIT_CEILING_DIRECTORIES` が無い（→ 追加）。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分はすべて Round 2 の指摘に 1 対 1 で対応。stub の FAIL_ON はテスト側にだけある。

### security-vulnerability-analyzer

- verdict: pass（Round 2 の blocker は解消、残り 2 件は反映済み）
- 主指摘: host 側の記録で `.git` 削除時の素通しを止める修正は正しい。記録ディレクトリが VM に mount されないことの明記（→ コメントで明記）と、読めない記録を「無い」とみなすと素通しになる点（→ 読めない記録があれば止める、テスト追加）。

### data-contract-evolution-evaluator

- verdict: blocker（反映済み）
- 主指摘: 終了コード 1 の記載は解消。停止メッセージが勧める `agent-vm rm <repo>` は `resolve_repo_root` を使うため `.git` の消えた repo では失敗する（→ git で解決できなければ記録と照合する形に `cmd_rm` を変更、テスト追加）。

### resilience-analyzer

- verdict: needs-work（反映済み）
- 主指摘: 想定外失敗の検証が 2 箇所だけ（→ `op inject` 失敗時にも案内が出るテストを追加）。`envf=$(…)` は代入形なので set -e で止まることを確認。

<!-- auto-review: verdict=blocker; hash=73c508b8031f91e30463418cd75d911edccf2109447dd8a3358f1210316d8226; design-hash=366989a8ed5d88bcb3c3ec55159b2cfce21f9c403631ae4c8fc1115bacb2a1e9; round=2; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:50:06.377Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=7; excluded=0; at=2026-09-28T16:50:06.393Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass（minor 1 件、反映済み）
- 主指摘: 記録の読み取り失敗・`cmd_rm` の代替解決・`op inject` 失敗時の ERR trap はいずれも正しい。コマンド置換の中の失敗では ERR trap が subshell と外側で 2 回発火しうる → 最上位の shell（`BASH_SUBSHELL` が 0）でだけ表示し、1 回だけであることをテストで確認。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 追加分はすべて Round 3 の指摘に 1 対 1 で対応。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: `cmd_rm` の代替解決は realpath の完全一致で、machine 名は引数から導出するので記録内容から注入できない。確認プロンプトも残る。

### data-contract-evolution-evaluator

- verdict: pass（minor 1 件、反映済み）
- 主指摘: `.git` の無い repo でも `agent-vm rm` が効くことを確認。git を先に試すと祖先の別 repo が一致して別 machine を消す確認が出うる → 記録との完全一致を先に調べる順に変更。

### resilience-analyzer

- verdict: pass（minor 1 件、反映済み）
- 主指摘: `cmd_rm` の復旧経路は正しい。秘密を VM に書き込む `orb` 呼び出しの失敗が未検証 → テスト追加。

<!-- auto-review: verdict=needs-work; hash=d86d995844a420e4c05e14f919a71efe256c156922036955be4c4fb435ffe1f5; design-hash=e6a9d97f24c08a40841b1f3351d80cb4154f873f440f864c64b9b30387c0b679; round=3; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T16:53:46.493Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=6; excluded=1; at=2026-09-28T16:53:46.510Z -->

<!-- auto-review: verdict=pass; hash=7e8a24f02f917fa2b1b4b3bffb30d7e1e07efdd890f8760ef8ac9686033780c0; design-hash=940d3f438d9d0cfd83f716994a5af83b279760c6249309828707b0342c321097; round=4; parent-spec-hash=34a1ddc3b9669296fa9387fc587f25c25cffe7efcb918cbc6fc5ab05da33a858; at=2026-09-28T17:03:38.378Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-09-28T17:03:38.395Z -->
