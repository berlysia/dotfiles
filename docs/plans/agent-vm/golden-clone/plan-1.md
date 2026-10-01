<!-- spec-ref: spec.md -->

# Plan: golden machine の clone による新規作成（launcher・golden-seal・テスト）

spec.md の K1〜K12 を実装する。文書（ADR-0020、`docs/agent-vm.md`）と mac 実機での検証項目は plan-2.md で扱う。行番号は master `85a60fe` のもの。

## Files

```
# 新規作成
agent-vm/golden-seal.sh

# 編集
home/dot_local/bin/executable_agent-vm
agent-vm/bootstrap.sh
tests/agent-vm/stubs/orb
tests/agent-vm/run.sh
tests/agent-vm/run-bootstrap.sh
```

## 前提と申し送り

- launcher は bash 3.2 で動く（macOS の `/bin/bash`）。連想配列、`${var,,}`、`exec {fd}>` は使わない。`<( )`、`comm`、`read -a` は使える
- shellcheck は全 severity で CI が落とす（`scripts/lint-shell.sh`、`.shellcheckrc` は `quote-safe-variables` などを有効にしている）。新しいコードは変数をすべて引用符で囲み、意図した word splitting には理由つきの disable を付ける
- `agent-vm/golden-seal.sh` は `build_staging` が `git ls-files` で staging に入れるので、新規作成したら `git add` するまで golden に届かない（`home/dot_local/bin/executable_agent-vm:154`）。T4 の commit で追加する
- テストはすべて `tests/agent-vm/` の既存ハーネスに足す。テスト関数は `test_` で始めれば自動で拾われる（`tests/agent-vm/run.sh:1399-1409`）。各テストは自分のサブシェルで動き、`TMP_ROOT`、`STUB_LOG`、`AGENT_VM_STATE_DIR` は毎回新しい。fresh な bash で set -e の効き方を確かめるには、既存の `errexit_run`（`tests/agent-vm/run.sh:1112-1115`）を使う
- 関数の一時的な差し替え（`maybe_bootstrap() { ...; }` など）は、テストのサブシェルの中だけで効く。既存のテストも `session_exec` をこの方法で差し替えている（`tests/agent-vm/run.sh:332-342`）
- fd の割り当て（spec K3）: fd 9 は repo の lock（`acquire_lock`、`:102-117`）、fd 8 は browser store の lock（`acquire_store_lock`、`:180-191`）、fd 7 は新しく足す golden の lock。取得の順序は fd 9 → fd 7 で、fd 8 は golden の lock を解放した後の `ensure_browsers` の中でしか取らない
- 定数のキー集合 `cpu disk_bytes forward_ssh_agent http_port https_port isolate_network isolated memory_mib mounts username` は、OrbStack 2.2.3 の `orb config show` で実測したもの（research.md「OrbStack の事実」9）
- mount の形は 1 つの関数 `vm_mounts` で組み立てる。golden は repo を除いた 3 つ（staging、outbox、browsers）、repo 用の machine は repo を先頭に足した 4 つ。golden の作成（`--mount` の列）、clone 先の `config set`、両方の検査の期待値が、すべてこの関数から出る
- `orb_q` を使う範囲: 新しく足す関数の `orb` 呼び出しはすべて `orb_q` を使い、既存のものでは golden の lock を持つ区間で走る `maybe_bootstrap` の 2 か所（`:344`・`:347`）を置き換える。次の既存の呼び出しはそのまま残す
  - `check_health` の `orb status`（`:91`）: `run_with_timeout` が `exec` するので関数を呼べない。lock を取る前に走る
  - 既存の `ensure_machine` の `orb list` / `orb create`（`:278`・`:288-294`）: T6 で `ensure_machine` ごと置き換える
  - `inject_secrets`（`:868`）: stdin で秘密を渡す。`orb_q` の `</dev/null` と両立しない
  - `ensure_codex_auth` の 2 か所（`:890`・`:893`）と `session_exec`（`:900`）: tty が要る（`:890` は非対話だが、同じ関数の対話呼び出しと揃える）。どれも lock を解放した後に走る
  - `cmd_gc`・`cmd_rm` の `orb delete`（`:1332`・`:1354`）: どの lock も持たずに走る
- `build_staging` の中で lock の fd を閉じるのは rsync（`:154`）と find（`:167`）だけにする（`8>&- 7>&-` を足す）。`dir_hash` の `xargs shasum` も fd を受け継ぐが、終われば閉じる短命なプロセスなので lock を残さない
- 関数の置き場所: `orb_q` と `orb_machine_state` は `check_health` の直後、`golden_dir`・`acquire_golden_lock`・`release_golden_lock` は `release_lock`（`:117`）の直後に置く（lock の順序規約のコメントが隣り合うように）。それ以外の golden 関連の関数は、`maybe_bootstrap` の直前（`ensure_browsers` の後）に置く
- 範囲外として記録するもの: repo の root が `$AGENT_VM_STATE_DIR` の祖先（例: `~` そのものが repo）の場合、repo の mount を通じて VM から state dir を書き換えられる。ADR-0018 の時点からある性質で、golden はその影響を広げる。spec の判断の外にあるので、plan-2 で ADR-0020 の Consequences と別の課題として記録する

## Tasks

### T0: 本番相当の golden で R3・認証の痕跡の不在・browser 系 MCP の維持を確かめる（実機、コード変更なし）

spec R3（claude の識別子の作り直し）、K6 の補助検査の対象が bootstrap 直後の golden に存在しないこと、空の browsers を mount した golden で browser 系 MCP が残ること（spec K6）を、実装の前に確かめる。結果が K7 と T4 の分岐を決める。

**Files:**

- 記録: `.tmp/sessions/e97e04f7/research.md`（「T0 の結果」節を追記）
- 参照: `agent-vm/bootstrap.sh:132-139`（`claude_keep`）、`:232-238`（claude の導入）、`home/dot_local/bin/executable_agent-vm:145-169`（`build_staging`）、`:340-348`（`maybe_bootstrap`）

- [ ] **Step 1: 使い捨ての golden を作る**

`mktemp -d` で作ったディレクトリを state dir にし（パスはリテラルで書く）、launcher を `AGENT_VM_LIB=1` で source する。`build_staging vmtest-gold <wt>` の後、staging・outbox・空の browsers の 3 つを mount して `orb create`（cloud-init 付き）し、`maybe_bootstrap` を実行する。所要は約 8 分（research の実測 249s + 252s）。

- [ ] **Step 2: 認証の痕跡が無く、browser 系 MCP が残っていることを確かめる**

```bash
orb -m vmtest-gold bash -c 'cd ~; for f in .claude/.credentials.json .codex/auth.json .config/gh/hosts.yml .git-credentials .netrc .docker/config.json .bash_history .zsh_history .claude/history.jsonl .aws .config/gcloud; do [ -e "$f" ] && echo "PRESENT $f"; done; ls .ssh/id_* 2>/dev/null; [ -f .npmrc ] && grep -c _authToken .npmrc; jq -r "has(\"oauthAccount\")" .claude.json; jq -c ".mcpServers | keys" .claude.json'
```

期待: `PRESENT` の行が 1 つも出ない。`.ssh/id_*` も出ない。`.npmrc` が無いか `_authToken` が 0 件。`oauthAccount` は `false`。最後の行に `playwright` と `chrome-devtools` が含まれる。

分岐: 認証の痕跡の項目が出た場合、その項目は bootstrap が正当に作るものなので T4 の検査対象から外し、理由を research.md に書く。browser 系 MCP が無い場合は、spec K6 の前提（空の browsers の mount で残る）が崩れているので、実装を止めて spec を見直す。

- [ ] **Step 3: R3（claude が欠けた識別子を作り直すか）を確かめる**

```bash
orb -m vmtest-gold bash -lc 'jq -r "[.userID, .machineID] | @tsv" ~/.claude.json; cp ~/.claude.json /tmp/cj.bak; jq "del(.userID, .machineID)" /tmp/cj.bak > ~/.claude.json; claude --version; claude -p hi </dev/null || true; jq -r "[.userID // \"MISSING\", .machineID // \"MISSING\"] | @tsv" ~/.claude.json'
```

判定は次の 3 通り。
- 最後の行が 2 つとも新しい値（最初の行と違い、`MISSING` でもない）: claude は作り直す。T4 で `userID` / `machineID` を消す
- `MISSING` が残り、`claude --version` が 0 で終わる: 認証前の起動では作り直されない。消さずに共有する（K7 の「作り直さない場合」の分岐）。T4 からこの手順を除き、ADR-0020 に記録する（plan-2）
- `claude --version` が 0 以外で終わる: 欠けた値で起動に失敗するので、消さない。分岐は 2 つ目と同じ

- [ ] **Step 4: 片付けと記録**

`orb delete -f vmtest-gold` を実行する。Step 2・3 の出力と判定を research.md の「T0 の結果」節に書く。

### T1: orb の stub が `config show` に別の応答を返せるようにする

**Files:**

- 編集: `tests/agent-vm/stubs/orb`（`STUB_ORB_FAIL_ON` の行の直後）
- 参照: `tests/agent-vm/stubs/orb` の `orb list` 専用の応答（同じ形にする）

- [ ] **Step 1: 失敗するテストを書く**（`tests/agent-vm/run.sh`、`test_main_dispatches_commands` の前に追加）

```bash
test_stub_serves_config_show_from_a_file() {
  printf 'machine.a.mounts: /x:/y\n' >"$TMP_ROOT/show"
  assert_eq "machine.a.mounts: /x:/y" "$(STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" STUB_ORB_STDOUT=other orb config show)" "config show from file"
  assert_eq "other" "$(STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" STUB_ORB_STDOUT=other orb list)" "other subcommands unchanged"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E 'config show from file|run,'`
期待: `FAIL config show from file (expected: machine.a.mounts: /x:/y / actual: other)`

- [ ] **Step 3: 最小実装**

```bash
# `orb config show` reads its canned output from a file so a test can script several machines' settings at once
if [[ "${1:-}" == config && "${2:-}" == show && -n "${STUB_ORB_CONFIG_SHOW_FILE:-}" ]]; then cat "$STUB_ORB_CONFIG_SHOW_FILE"; exit 0; fi
```

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`

- [ ] **Step 5: コミット**

```bash
git add tests/agent-vm/stubs/orb tests/agent-vm/run.sh
git commit -m "test(agent-vm): let the orb stub answer config show from a file"
```

### T2: orb の wrapper、mount の形、mount path の検査、設定の検査（K3・K4）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（置き場所は「前提と申し送り」に従う。`maybe_bootstrap` の `:344`・`:347` を `orb_q` に置き換え、`build_staging` の `:154`・`:167` に `8>&- 7>&-` を足す）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:56`（改行を拒む既存の検査）、`:278-280`（`orb list` の失敗を die にし、パイプを使わずに awk で探す既存の書き方）

- [ ] **Step 1: 失敗するテストを書く**（`test_create_uses_isolation_flags_and_mounts` の前に追加）

```bash
write_config_show() { # file machine mounts [extra_line]: the 10 keys OrbStack 2.2.3 prints per machine
  local k
  {
    for k in cpu disk_bytes forward_ssh_agent http_port https_port isolate_network isolated memory_mib mounts username; do
      case "$k" in
        isolated | isolate_network | forward_ssh_agent) printf 'machine.%s.%s: true\n' "$2" "$k" ;;
        mounts) printf 'machine.%s.mounts: %s\n' "$2" "$3" ;;
        username) printf 'machine.%s.username: u\n' "$2" ;;
        *) printf 'machine.%s.%s: 0\n' "$2" "$k" ;;
      esac
    done
    if [[ -n "${4:-}" ]]; then printf '%s\n' "$4"; fi
  } >>"$1"
}
test_mount_paths_with_separators_are_refused() {
  local status
  status=0; (check_mount_paths /ok "/a,b") 2>/dev/null || status=$?
  assert_eq 1 "$status" "comma refused"
  status=0; (check_mount_paths "/a:b") 2>/dev/null || status=$?
  assert_eq 1 "$status" "colon refused"
  status=0; (check_mount_paths "$(printf '/a\nb')") 2>/dev/null || status=$?
  assert_eq 1 "$status" "newline refused"
  assert_status 0 "plain paths pass" -- check_mount_paths /a/b "/with space/c"
  local err; err=$( (check_mount_paths "/a,b") 2>&1 || true)
  assert_contains "$err" "/a,b" "message names the path"
  assert_contains "$err" "AGENT_VM=off" "message gives the host fallback"
}
test_vm_mounts_browsers_destination_is_what_bootstrap_checks() {
  # bootstrap's claude_keep decides on the presence of BROWSERS_ROOT; the golden keeps the browser MCP entries for
  # its clones only if the launcher mounts the browsers dir exactly there (spec K6).
  local dest; dest=$(vm_mounts "$GOLDEN_MACHINE" | tr ',' '\n' | awk -F: '/browsers/ { print $2 }')
  assert_contains "$(grep -E '^BROWSERS_ROOT=' "$REPO_ROOT/agent-vm/bootstrap.sh")" ":-$dest}" "bootstrap's default BROWSERS_ROOT is the launcher's browsers destination"
}
test_vm_mounts_give_the_golden_and_repo_shapes_from_one_place() {
  local st="$AGENT_VM_STATE_DIR"
  assert_eq "/r:/r,$st/staging/agent-x-000000:/opt/agent-vm/src,$st/outbox/agent-x-000000:/opt/agent-vm/outbox,$st/browsers/agent-x-000000:/opt/agent-vm/browsers" \
    "$(vm_mounts agent-x-000000 /r)" "repo machine: repo, staging, outbox, browsers"
  assert_eq "$st/staging/$GOLDEN_MACHINE:/opt/agent-vm/src,$st/outbox/$GOLDEN_MACHINE:/opt/agent-vm/outbox,$st/browsers/$GOLDEN_MACHINE:/opt/agent-vm/browsers" \
    "$(vm_mounts "$GOLDEN_MACHINE")" "golden: the same shape without the repo"
}
test_machine_config_must_match_exactly() {
  local f="$TMP_ROOT/show"
  write_config_show "$f" agent-x-000000 "/r:/r"
  write_config_show "$f" agent-x-0000001 "/other:/other" # a machine whose name extends ours must not leak in
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 0 "exact settings pass" -- verify_machine_config agent-x-000000 "/r:/r"
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 1 "different mounts fail" -- verify_machine_config agent-x-000000 "/r:/r,/x:/y"
  local g="$TMP_ROOT/show-unknown"
  write_config_show "$g" agent-x-000000 "/r:/r" "machine.agent-x-000000.share_home: true"
  STUB_ORB_CONFIG_SHOW_FILE="$g" assert_status 1 "unknown key fails" -- verify_machine_config agent-x-000000 "/r:/r"
  local err; err=$(STUB_ORB_CONFIG_SHOW_FILE="$g" verify_machine_config agent-x-000000 "/r:/r" 2>&1 || true)
  assert_contains "$err" "share_home" "unknown key named"
  local h="$TMP_ROOT/show-net"
  write_config_show "$h" agent-x-000000 "/r:/r"
  sed -i.bak 's/isolate_network: true/isolate_network: false/' "$h"
  STUB_ORB_CONFIG_SHOW_FILE="$h" assert_status 1 "network isolation off fails" -- verify_machine_config agent-x-000000 "/r:/r"
  local k="$TMP_ROOT/show-missing"
  write_config_show "$k" agent-x-000000 "/r:/r"
  grep -v forward_ssh_agent "$k" >"$k.2"
  STUB_ORB_CONFIG_SHOW_FILE="$k.2" assert_status 1 "missing key fails" -- verify_machine_config agent-x-000000 "/r:/r"
  err=$(STUB_ORB_CONFIG_SHOW_FILE="$k.2" verify_machine_config agent-x-000000 "/r:/r" 2>&1 || true)
  assert_contains "$err" "forward_ssh_agent" "missing key named"
}
test_empty_config_key_counts_as_unknown() {
  local f="$TMP_ROOT/show"
  write_config_show "$f" agent-x-000000 "/r:/r" "machine.agent-x-000000.: x"
  STUB_ORB_CONFIG_SHOW_FILE="$f" assert_status 1 "empty key fails" -- verify_machine_config agent-x-000000 "/r:/r"
}
test_machine_state_reads_listing_rows() {
  assert_eq "stopped" "$(STUB_ORB_LIST_STDOUT="$(printf 'a running ubuntu\nagent-x-000000 stopped ubuntu')" orb_machine_state agent-x-000000)" "state column"
  assert_eq "present" "$(STUB_ORB_LIST_STDOUT="agent-x-000000" orb_machine_state agent-x-000000)" "a row with only the name still counts as existing"
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="agent-x-0000001 running" orb_machine_state agent-x-000000)" "absent"
}
test_failed_machine_listing_is_an_error_not_absence() {
  export STUB_ORB_FAIL_ON="list"
  local out
  # shellcheck disable=SC2016 # snippet text; expands inside errexit_run's fresh bash
  out=$(errexit_run 'vm=$(orb_machine_state agent-x-000000); echo "state=$vm"')
  assert_not_contains "$out" "reached" "a failed orb list stops the caller"
  assert_not_contains "$out" "state=" "the caller did not continue"
}
test_orb_q_closes_every_lock_fd() {
  orb() { ls /dev/fd >"$TMP_ROOT/fds"; } # replaces the stub for this subshell only
  exec 7>"$TMP_ROOT/l7" 8>"$TMP_ROOT/l8" 9>"$TMP_ROOT/l9"
  orb list # positive control: a direct call does see the lock fds, so the listing below can detect a leak
  assert_contains " $(tr '\n' ' ' <"$TMP_ROOT/fds")" " 7 " "control: a direct call inherits fd 7"
  orb_q list
  exec 7>&- 8>&- 9>&-
  local fds; fds=" $(tr '\n' ' ' <"$TMP_ROOT/fds")"
  assert_not_contains "$fds" " 7 " "fd 7 not inherited"
  assert_not_contains "$fds" " 8 " "fd 8 not inherited"
  assert_not_contains "$fds" " 9 " "fd 9 not inherited"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E '^FAIL|run,'`
期待: 上のテストが FAIL または `(test aborted)`（関数が未定義のため）

- [ ] **Step 3: 最小実装**

`check_health` の直後に置く。

```bash
# Non-interactive orb call: no lock fd may reach orb (fd 9 repo, fd 8 browser store, fd 7 golden), or a lingering
# orb process keeps the lock held after the launcher exits (spec K3).
orb_q() { orb "$@" </dev/null 9>&- 8>&- 7>&-; }

# machine -> its state (running|stopped; "present" for a row without one), or "" when it does not exist.
# A failed `orb list` dies instead of reading as "absent", which would send a launch into clone-and-discard.
# Callers take the result with a plain assignment (x=$(orb_machine_state m)) so the die stops them too.
orb_machine_state() {
  local machines
  machines=$(orb_q list) || die "could not list OrbStack machines. $FAIL_CLOSED_HINT"
  awk -v n="$1" '$1 == n { print ($2 == "" ? "present" : $2); exit }' <<<"$machines"
}
```

golden 関連の関数の先頭（`maybe_bootstrap` の直前）に置く。

```bash
GOLDEN_MACHINE=agent-vm-golden
# Every per-machine key OrbStack 2.2.3 prints in `orb config show`. An unknown or missing key fails the check:
# a new kind of mount or sharing must be looked at before machines are started with it (spec K4).
MACHINE_CONFIG_KEYS="cpu disk_bytes forward_ssh_agent http_port https_port isolate_network isolated memory_mib mounts username"

check_mount_paths() { # path...: OrbStack's mount list is "SRC:DEST,SRC:DEST", so these characters cannot be represented
  local p
  for p in "$@"; do
    case "$p" in
      *,* | *:* | *$'\n'*) die "cannot mount $p: it contains ',' ':' or a newline, which OrbStack's mount list cannot hold. $FAIL_CLOSED_HINT" ;;
    esac
  done
}

# The one place that knows the mount shape. A repo machine gets its repo first; the golden gets the same shape
# without it, including an empty browsers mount so bootstrap keeps the browser MCP entries for the clones (spec K6).
vm_mounts() { # machine [repo_root] -> OrbStack's comma-separated mount list
  local st=$AGENT_VM_STATE_DIR repo=""
  if [[ -n "${2:-}" ]]; then repo="$2:$2,"; fi
  printf '%s%s:/opt/agent-vm/src,%s:/opt/agent-vm/outbox,%s:/opt/agent-vm/browsers\n' \
    "$repo" "$st/staging/$1" "$st/outbox/$1" "$st/browsers/$1"
}

# Reads the machine's settings from the host-side OrbStack config (the VM cannot change them, and a stopped
# machine cannot race us) and compares every key: exact key set, isolation flags on, mounts exactly as expected.
verify_machine_config() { # machine expected_mounts -> 0, or 1 with the reason on stderr
  local show lines got want unknown missing key val
  show=$(orb_q config show) || { step "could not read the OrbStack settings"; return 1; }
  lines=$(printf '%s\n' "$show" | awk -v p="machine.$1." 'index($0, p) == 1 { r = substr($0, length(p) + 1); k = r; sub(/:.*/, "", k); v = r; sub(/^[^:]*: ?/, "", v); print k "\t" v }')
  # An empty key (a line like "machine.<m>.: x") stays in the set and so counts as unknown.
  got=$(printf '%s\n' "$lines" | cut -f1 | LC_ALL=C sort)
  # shellcheck disable=SC2086 # word splitting of the key list is intended
  want=$(printf '%s\n' $MACHINE_CONFIG_KEYS | LC_ALL=C sort)
  if [[ "$got" != "$want" ]]; then
    unknown=$(LC_ALL=C comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | tr '\n' ' ')
    missing=$(LC_ALL=C comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$got") | tr '\n' ' ')
    step "$1 has unexpected OrbStack settings (unknown: ${unknown:-none}; missing: ${missing:-none})"
    return 1
  fi
  for key in isolated isolate_network forward_ssh_agent; do
    val=$(printf '%s\n' "$lines" | awk -F'\t' -v k="$key" '$1 == k { print $2 }')
    if [[ "$val" != true ]]; then step "$1 has $key=$val (expected true)"; return 1; fi
  done
  val=$(printf '%s\n' "$lines" | awk -F'\t' '$1 == "mounts" { print $2 }')
  if [[ "$val" != "$2" ]]; then step "$1 mounts '$val' (expected '$2')"; return 1; fi
}
```

あわせて、`maybe_bootstrap` の 2 つの `orb` 呼び出し（`:344`・`:347`）を `orb_q` に置き換え（`</dev/null 9>&-` は wrapper が付ける）、`build_staging` の `:154`・`:167` の `9>&-` を `9>&- 8>&- 7>&-` にする。

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`（既存の `test_bootstrap_*` も通る。stub が記録する argv は変わらない）

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): check mount paths and every machine setting before a machine starts"
```

### T3: golden の lock と meta（K3・K11）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（`golden_dir`・`acquire_golden_lock`・`release_golden_lock` は `release_lock`（`:117`）の直後、meta の関数は golden 関連の関数の並びに置く）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:102-117`（`acquire_lock`）、`:180-191`（`acquire_store_lock`。`exec` の失敗を中括弧で受ける書き方）、`:470`（`sha_of_file`）

- [ ] **Step 1: 失敗するテストを書く**（既存の `try_lock` の定義の後に追加）

```bash
try_golden_lock() { # -> exit status of a fresh process trying the golden lock for 1s
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_golden_lock 1" </dev/null >/dev/null 2>&1
}
test_golden_lock_is_exclusive_and_independent_of_other_locks() {
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_golden_lock 1 && sleep 3" </dev/null &
  sleep 1
  local status=0; try_golden_lock || status=$?
  assert_eq 1 "$status" "second golden lock refused"
  status=0; try_lock agent-g-000000 || status=$?
  assert_eq 0 "$status" "repo lock unaffected"
  status=0; bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_store_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 0 "$status" "browser store lock unaffected"
  wait
}
test_golden_lock_lives_outside_machine_records() {
  acquire_golden_lock 1
  release_golden_lock
  assert_status 0 "lock file under golden/" -- test -f "$AGENT_VM_STATE_DIR/golden/lock"
  assert_eq "" "$(machine_rows)" "golden is not a machine record"
}
test_golden_meta_round_trip_and_format_guard() {
  write_golden_meta abc sealed v1:h
  assert_eq sealed "$(golden_meta_field state)" "state read back"
  assert_eq v1:h "$(golden_meta_field staging_hash)" "staging hash read back"
  assert_eq abc "$(golden_meta_field cloud_init_hash)" "cloud-init hash read back"
  assert_eq 1 "$(golden_meta_field contract)" "contract recorded"
  assert_eq "" "$(find "$AGENT_VM_STATE_DIR/golden" -name 'meta.*')" "no temp file left"
  printf 'format=2\nstate=sealed\n' >"$AGENT_VM_STATE_DIR/golden/meta"
  local status=0; golden_meta_field state >/dev/null || status=$?
  assert_eq 2 "$status" "unknown format is not read"
  rm "$AGENT_VM_STATE_DIR/golden/meta"
  status=0; golden_meta_field state >/dev/null || status=$?
  assert_eq 1 "$status" "absent record"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E '^FAIL|run,'`
期待: 上の 3 テストが FAIL（`acquire_golden_lock` などが未定義）

- [ ] **Step 3: 最小実装**

`release_lock` の直後に置く。

```bash
golden_dir() { printf '%s/golden\n' "$AGENT_VM_STATE_DIR"; }

# Same flock scheme as acquire_lock, on fd 7 (fd 9 is the repo lock, fd 8 the browser store lock). Order: fd 9, then
# fd 7; fd 8 is taken only after fd 7 is released. `agent-vm golden refresh|rm` take only fd 7 (spec K3).
acquire_golden_lock() { # max_wait_seconds; holds fd 7 until release_golden_lock or process exit
  local waited=0
  mkdir -p "$(golden_dir)" || return 1
  # A failed redirection on a bare `exec` would end the shell; braces turn it into an ordinary failure.
  { exec 7>"$(golden_dir)/lock"; } 2>/dev/null || return 1
  until perl -MFcntl=:flock -e 'open(my $f, ">&=", 7) or die "fdopen: $!"; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
    waited=$((waited + 1))
    if [[ "$waited" -ge "$1" ]]; then exec 7>&-; return 1; fi
    step "another session is building the golden machine (${waited}s)"
    sleep 1
  done
}
release_golden_lock() { exec 7>&-; }
```

golden 関連の関数の並びに置く。

```bash
# golden/meta: format=1, cloud_init_hash, contract, state (sealed|updating), staging_hash. Not read with
# read_meta_field: machines/<m> records are a different schema under the same format number.
golden_meta_field() { # key -> value; exit 1 when the record or the key is absent, 2 when its format is unknown
  local f
  f="$(golden_dir)/meta"
  if [[ ! -f "$f" ]]; then return 1; fi
  awk -F= -v k="$1" 'NR == 1 { if ($0 != "format=1") { bad = 1; exit } next }
    $1 == k { sub(/^[^=]*=/, ""); print; found = 1; exit }
    END { exit bad ? 2 : (found ? 0 : 1) }' "$f"
}

write_golden_meta() { # cloud_init_hash state staging_hash: written whole through a temp file, never in place
  local d tmp
  d=$(golden_dir)
  mkdir -p "$d"
  tmp=$(mktemp "$d/meta.XXXXXX") || die "could not write the golden machine record"
  printf 'format=1\ncloud_init_hash=%s\ncontract=%s\nstate=%s\nstaging_hash=%s\n' "$1" "$BOOTSTRAP_CONTRACT" "$2" "$3" >"$tmp"
  mv "$tmp" "$d/meta"
}
```

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add the golden machine lock and its record"
```

### T4: golden-seal.sh と、golden と bootstrap の結合の固定（K6・K7・K12）

T0 の結果で分岐する箇所は 2 つある。(a) R3 で「作り直す」と分かった場合だけ、`userID` / `machineID` を消す手順とそのテストを入れる。(b) T0 Step 2 で bootstrap が作ると分かった項目は、検査対象から外す。

**Files:**

- 新規: `agent-vm/golden-seal.sh`
- 編集: `agent-vm/bootstrap.sh:132`（`claude_keep` の前にコメント）、`:266`（`applied-hash` の記録の前にコメント）
- テスト: `tests/agent-vm/run-bootstrap.sh`
- 参照: `agent-vm/bootstrap.sh:34-43`（環境変数による差し替えと `fail`）、`:113-125`（同じディレクトリの一時ファイルを経由した書き換え）、`tests/agent-vm/run-bootstrap.sh:32-47`（`setup_vm_env`。sudo は stub、`AGENT_VM_BROWSERS_ROOT` の既定は `$TMP_ROOT/no-browsers`）、`:296-301`（`place_generated_configs`）、`:313-318`（`test_claude_keeps_browser_mcp_but_codex_does_not`）

- [ ] **Step 1: 失敗するテストを書く**（`tests/agent-vm/run-bootstrap.sh`、`place_generated_configs` の後に追加）

```bash
SEAL="$REPO_ROOT/agent-vm/golden-seal.sh"
setup_seal_env() {
  setup_vm_env
  export AGENT_VM_MACHINE_ID_FILE="$TMP_ROOT/machine-id" AGENT_VM_RANDOM_SEED_FILE="$TMP_ROOT/random-seed"
  printf 'abc\n' >"$AGENT_VM_MACHINE_ID_FILE"; printf 'seed' >"$AGENT_VM_RANDOM_SEED_FILE"
  printf '{"userID":"u1","machineID":"m1","mcpServers":{}}\n' >"$HOME/.claude.json"
}
test_seal_leaves_no_applied_hash_so_every_clone_bootstraps() {
  setup_seal_env
  bash "$BOOTSTRAP" 1 v1:sealme "$SRC" >/dev/null 2>&1
  # Path-agnostic on purpose: if bootstrap ever records the hash elsewhere, this fails instead of passing silently.
  assert_contains "$(grep -rl 'v1:sealme' "$HOME/.local/state" 2>/dev/null || true)" "/" "precondition: bootstrap recorded the hash"
  bash "$SEAL" >/dev/null 2>&1
  assert_eq "" "$(grep -rl 'v1:sealme' "$HOME/.local/state" 2>/dev/null || true)" "no record of the applied hash after seal"
  # What the clone then does: the launcher finds no matching hash and runs bootstrap, which records it again.
  : >"$STUB_LOG"
  bash "$BOOTSTRAP" 1 v1:sealme "$SRC" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "chezmoi init --force --no-tty" "the next bootstrap applies again"
  assert_contains "$(grep -rl 'v1:sealme' "$HOME/.local/state" 2>/dev/null || true)" "/" "and records the hash again"
}
test_golden_with_an_empty_browsers_mount_keeps_browser_mcp_through_seal() {
  # The golden mounts an empty browsers dir so that claude_keep keeps these entries; clones cannot regain them,
  # because update-claude-json does not run again there (spec K6). This pins that contract.
  setup_seal_env; place_generated_configs
  jq 'del(.oauthAccount)' "$HOME/.claude.json" >"$TMP_ROOT/c.json"; mv "$TMP_ROOT/c.json" "$HOME/.claude.json" # a golden never logs in
  mkdir -p "$TMP_ROOT/golden-browsers"; export AGENT_VM_BROWSERS_ROOT="$TMP_ROOT/golden-browsers"
  bash "$BOOTSTRAP" 1 v1:abc "$SRC" >/dev/null 2>&1
  bash "$SEAL" >/dev/null 2>&1
  assert_eq '["chrome-devtools","context7","excalidraw","playwright","readability"]' "$(jq -c '.mcpServers | keys' "$HOME/.claude.json")" \
    "an empty browsers mount keeps the browser MCP servers, also after the seal"
}
test_seal_empties_machine_id_and_drops_random_seed() {
  setup_seal_env
  bash "$SEAL" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "sudo truncate -s 0 $AGENT_VM_MACHINE_ID_FILE" "machine-id emptied"
  assert_contains "$(cat "$STUB_LOG")" "sudo rm -f $AGENT_VM_RANDOM_SEED_FILE" "random seed removed"
}
test_seal_refuses_a_golden_with_credentials() {
  local f
  for f in .claude/.credentials.json .codex/auth.json .config/gh/hosts.yml .git-credentials .netrc .ssh/id_ed25519 .zsh_history; do
    setup_seal_env
    mkdir -p "$(dirname "$HOME/$f")"; printf 'x\n' >"$HOME/$f"
    local status=0 err; err=$(bash "$SEAL" 2>&1) || status=$?
    assert_eq 1 "$status" "refused with $f"
    assert_contains "$err" "$f" "names $f"
    assert_contains "$err" "agent-vm golden rm" "recovery for $f"
    rm -rf "${TMP_ROOT:?}/home"
  done
}
test_seal_refuses_a_dangling_credential_link() {
  setup_seal_env
  mkdir -p "$HOME/.codex"; ln -s /nonexistent "$HOME/.codex/auth.json"
  assert_status 1 "dangling link refused" -- bash "$SEAL"
}
test_seal_refuses_a_logged_in_claude_json() {
  setup_seal_env
  printf '{"oauthAccount":{"emailAddress":"x"}}\n' >"$HOME/.claude.json"
  assert_status 1 "oauthAccount refused" -- bash "$SEAL"
}
test_seal_refuses_an_npm_token() {
  setup_seal_env
  printf '//registry.npmjs.org/:_authToken=x\n' >"$HOME/.npmrc"
  assert_status 1 "npm token refused" -- bash "$SEAL"
}
test_seal_fails_when_the_applied_hash_cannot_be_removed() {
  setup_seal_env
  mkdir -p "$HOME/.local/state/agent-vm/applied-hash/x" # a directory: rm -f cannot remove it
  assert_status 1 "seal fails instead of leaving the hash" -- bash "$SEAL"
}
test_seal_refuses_outside_an_agent_vm_machine() {
  setup_seal_env; rm "$AGENT_VM_MARKER"
  assert_status 1 "no marker -> refuse" -- bash "$SEAL"
}
```

T0 Step 3 で「作り直す」と分かった場合だけ、次のテストも足す。

```bash
test_seal_drops_claude_identifiers_and_keeps_the_rest() {
  setup_seal_env
  bash "$SEAL" >/dev/null 2>&1
  assert_eq "null null {}" "$(jq -r '"\(.userID) \(.machineID) \(.mcpServers)"' "$HOME/.claude.json")" "identifiers dropped, settings kept"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `bash tests/agent-vm/run-bootstrap.sh 2>&1 | grep -E '^FAIL|run,'`（Linux。実 chezmoi が要る。macOS では `stat -c` などの違いで既存のテストが落ちるので、CI の ubuntu で確かめる）
期待: 追加したテストが FAIL（`golden-seal.sh` が無いので bash が 127 で終わる）。`test_golden_with_an_empty_browsers_mount_keeps_browser_mcp_through_seal` も seal が無いので FAIL する

- [ ] **Step 3: 最小実装**（`agent-vm/golden-seal.sh`）

```bash
#!/usr/bin/env bash
# agent-vm golden seal: runs inside the golden machine after its bootstrap, right before it is stopped and cloned.
# Called by the host launcher (home/dot_local/bin/executable_agent-vm, ensure_golden) with no arguments.
# Design: docs/decisions/0020-agent-vm-golden-clone.md (spec K6, K7, K12).
set -euo pipefail

MARKER="${AGENT_VM_MARKER:-/etc/agent-vm}"
MACHINE_ID_FILE="${AGENT_VM_MACHINE_ID_FILE:-/etc/machine-id}"
RANDOM_SEED_FILE="${AGENT_VM_RANDOM_SEED_FILE:-/var/lib/systemd/random-seed}"
# bootstrap.sh's record of what it applied (agent-vm/bootstrap.sh, last lines). Removing it makes every clone run
# bootstrap once, which re-renders the templates that use .chezmoi.hostname with the clone's own name (spec K2).
APPLIED_HASH="$HOME/.local/state/agent-vm/applied-hash"

fail() { printf 'agent-vm golden seal: %s\n' "$1" >&2; exit 1; }

[[ -f "$MARKER" ]] || fail "not an agent-vm machine ($MARKER missing)"

# The golden never receives secrets by construction (no repo mount, no secret injection, no login); this only
# detects someone having worked inside it. The list is representative, not exhaustive (spec K6).
recover="every clone would inherit it; recover on the host: agent-vm golden rm"
for f in .claude/.credentials.json .codex/auth.json .config/gh/hosts.yml .git-credentials .netrc \
  .docker/config.json .bash_history .zsh_history .claude/history.jsonl .aws .config/gcloud; do
  # -L as well: a dangling symlink fails -e but still points a clone at something.
  [[ ! -e "$HOME/$f" && ! -L "$HOME/$f" ]] || fail "~/$f exists in the golden machine; $recover"
done
for f in "$HOME"/.ssh/id_*; do
  [[ ! -e "$f" && ! -L "$f" ]] || fail "~/.ssh/$(basename "$f") exists in the golden machine; $recover"
done
if [[ -f "$HOME/.npmrc" ]] && grep -q '_authToken' "$HOME/.npmrc"; then
  fail "~/.npmrc holds an npm token in the golden machine; $recover"
fi
if [[ -f "$HOME/.claude.json" ]] && [[ "$(jq -r 'has("oauthAccount")' "$HOME/.claude.json")" != false ]]; then
  fail "~/.claude.json has a logged-in account in the golden machine; $recover"
fi

# Identifiers a fresh machine would have to itself: systemd creates a new machine-id at first boot when the file
# is empty (measured on OrbStack: each clone gets its own, kept across restarts), and a new random seed.
sudo truncate -s 0 "$MACHINE_ID_FILE"
sudo rm -f "$RANDOM_SEED_FILE"

rm -f "$APPLIED_HASH" 2>/dev/null || fail "could not remove $APPLIED_HASH"
[[ ! -e "$APPLIED_HASH" ]] || fail "could not remove $APPLIED_HASH"
```

T0 Step 3 で「作り直す」と分かった場合だけ、identifier の節の後に次を足す（同じディレクトリの一時ファイルを経由して書き換え、失敗したら元のファイルを変えない。`agent-vm/bootstrap.sh:113-125` と同じ方針）。

```bash
if [[ -f "$HOME/.claude.json" ]]; then
  tmp=$(mktemp "$HOME/.claude.json.XXXXXX") || fail "cannot create a temp file next to ~/.claude.json"
  jq 'del(.userID, .machineID)' "$HOME/.claude.json" >"$tmp" || { rm -f "$tmp"; fail "could not drop the claude identifiers"; }
  [[ -s "$tmp" ]] || { rm -f "$tmp"; fail "dropping the claude identifiers produced nothing"; }
  chmod --reference="$HOME/.claude.json" "$tmp"
  mv "$tmp" "$HOME/.claude.json"
fi
```

`agent-vm/bootstrap.sh` に 2 つのコメントを足す。`claude_keep`（`:132`）の直前:

```bash
# The golden machine is the source every repo machine is cloned from, and it mounts an empty browsers dir so this
# returns the same list there as on a machine with the browser mount: entries dropped on the golden would not come
# back on the clones (update-claude-json does not run again there). Keep the decision a pure function of the mount,
# and keep BROWSERS_ROOT's default equal to the browsers destination in the launcher's vm_mounts (both are pinned
# by tests in tests/agent-vm/).
```

`applied-hash` の記録（`:266`）の直前:

```bash
# agent-vm/golden-seal.sh removes this file by the same path so that every clone bootstraps once; keep them in sync
# (tests/agent-vm/run-bootstrap.sh test_seal_leaves_no_applied_hash_so_every_clone_bootstraps catches a mismatch).
```

- [ ] **Step 4: 通過を確認する**

実行: `bash tests/agent-vm/run-bootstrap.sh 2>&1 | tail -1`（Linux）と `shellcheck agent-vm/golden-seal.sh agent-vm/bootstrap.sh`
期待: `N run, 0 failed`、shellcheck の指摘なし

- [ ] **Step 5: コミット**（新規ファイルは git に入れないと staging に載らない）

```bash
git add agent-vm/golden-seal.sh agent-vm/bootstrap.sh tests/agent-vm/run-bootstrap.sh
git commit -m "feat(agent-vm): seal the golden machine before it is cloned"
```

### T5: ensure_golden（K2・K6・K8・K11）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`（golden 関連の関数の並び、`maybe_bootstrap` の直前）
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:145-169`（`build_staging` は `out=$(...)` で受ける。`:915-916` と同じ形）、`:340-348`（`maybe_bootstrap`）、`:1052-1063`（`forget_machine` の、chmod してから消す手順）

- [ ] **Step 1: 失敗するテストを書く**

```bash
make_golden_fixture() { # -> dotfiles working tree that also tracks agent-vm/cloud-init.yaml
  local wt; wt=$(make_dotfiles_fixture)
  mkdir -p "$wt/agent-vm"; printf '#cloud-config\n' >"$wt/agent-vm/cloud-init.yaml"
  git -C "$wt" add agent-vm && git -C "$wt" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q -m ci
  printf '%s\n' "$wt"
}
golden_dirs_as_bootstrapped() { # what create_golden and the VM's link_outbox leave on the host side
  mkdir -p "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects" "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/codex-sessions" \
    "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
}
sealed_golden_fixture() { # wt -> a golden whose record matches the current staging; prints the config-show file
  local out gen hash show="$TMP_ROOT/show"
  out=$(build_staging "$GOLDEN_MACHINE" "$1"); read -r gen hash <<<"$out"
  write_golden_meta "$(sha_of_file "$1/agent-vm/cloud-init.yaml")" sealed "$hash"
  golden_dirs_as_bootstrapped
  write_config_show "$show" "$GOLDEN_MACHINE" "$(vm_mounts "$GOLDEN_MACHINE")"
  printf '%s\n' "$show"
}
test_first_golden_is_created_without_a_repo_and_sealed() {
  local wt; wt=$(make_golden_fixture)
  maybe_bootstrap() { golden_dirs_as_bootstrapped; } # the VM side would create these
  write_config_show "$TMP_ROOT/show" "$GOLDEN_MACHINE" "$(vm_mounts "$GOLDEN_MACHINE")"
  STUB_ORB_CONFIG_SHOW_FILE="$TMP_ROOT/show" ensure_golden "$wt" 0 2>/dev/null
  local log st="$AGENT_VM_STATE_DIR"; log=$(cat "$STUB_LOG")
  assert_contains "$log" "orb create --isolated --isolate-network --forward-ssh-agent -c $wt/agent-vm/cloud-init.yaml --mount $st/staging/$GOLDEN_MACHINE:/opt/agent-vm/src --mount $st/outbox/$GOLDEN_MACHINE:/opt/agent-vm/outbox --mount $st/browsers/$GOLDEN_MACHINE:/opt/agent-vm/browsers ubuntu $GOLDEN_MACHINE" \
    "golden created with only its own three mounts"
  assert_contains "$log" "agent-vm/golden-seal.sh" "sealed"
  assert_contains "$log" "orb stop $GOLDEN_MACHINE" "stopped after sealing"
  assert_eq sealed "$(golden_meta_field state)" "recorded as sealed"
  assert_status 1 "the golden gets no browser record" -- test -e "$st/browser-records/$GOLDEN_MACHINE.mount"
  local gen; gen=$(ls "$st/staging/$GOLDEN_MACHINE")
  assert_eq "$(dir_hash "$st/staging/$GOLDEN_MACHINE/$gen")" "$(golden_meta_field staging_hash)" "staging hash recorded"
}
test_unchanged_stopped_golden_is_not_started() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  local log; log=$(cat "$STUB_LOG")
  assert_not_contains "$log" "orb start" "golden not started"
  assert_not_contains "$log" "golden-seal.sh" "not resealed"
  assert_contains "$log" "orb config show" "host-side check still runs"
}
test_forced_refresh_updates_an_unchanged_golden() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 1 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb start $GOLDEN_MACHINE" "started"
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed"
  assert_eq sealed "$(golden_meta_field state)" "sealed again"
}
test_running_golden_is_resealed_not_cloned_as_is() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE running ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start" "already running"
}
test_changed_dotfiles_update_through_the_updating_state() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta "$(sha_of_file "$wt/agent-vm/cloud-init.yaml")" sealed v1:old; : >"$STUB_LOG"
  seal_golden() { assert_eq updating "$(golden_meta_field state)" "updating while sealing"; }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_eq sealed "$(golden_meta_field state)" "sealed after the update"
  if [[ "$(golden_meta_field staging_hash)" != v1:old ]]; then record "PASS new staging hash recorded"; else record "FAIL new staging hash recorded"; fi
}
test_interrupted_update_is_retried_not_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta "$(sha_of_file "$wt/agent-vm/cloud-init.yaml")" sealed v1:old; : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="golden-seal.sh" ensure_golden "$wt" 0) 2>/dev/null || true
  assert_eq updating "$(golden_meta_field state)" "left as updating"
  : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "retried as an update"
  assert_eq sealed "$(golden_meta_field state)" "sealed on retry"
}
test_golden_is_rebuilt_when_cloud_init_changes() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_golden_meta other sealed "$(golden_meta_field staging_hash)"; : >"$STUB_LOG"
  printf 'old\n' >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/leftover.jsonl"
  mkdir -p "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk/sub"; : >"$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk/sub/f"
  chmod 000 "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk"
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  local err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1)
  assert_contains "$err" "cloud-init.yaml changed" "reason shown"
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "old golden deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "new golden created"
  assert_status 1 "old outbox content removed with the old golden" -- test -e "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/leftover.jsonl"
  assert_status 1 "old browsers content removed even without permissions" -- test -e "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/junk"
}
test_golden_record_of_unknown_format_is_rebuilt_with_its_own_reason() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  printf 'format=2\nstate=sealed\n' >"$AGENT_VM_STATE_DIR/golden/meta"; : >"$STUB_LOG"
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  local err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1)
  assert_contains "$err" "unknown format" "format reason distinguished from a missing record"
}
test_golden_removed_outside_agent_vm_is_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  STUB_ORB_LIST_STDOUT="other running ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing to delete"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "recreated"
}
test_golden_without_a_record_is_rebuilt() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  rm "$AGENT_VM_STATE_DIR/golden/meta"; : >"$STUB_LOG"
  maybe_bootstrap() { golden_dirs_as_bootstrapped; }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "unrecorded golden deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb create" "recreated"
}
test_golden_outbox_with_any_extra_entry_fails_with_recovery() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  ln -s /etc "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/x"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "extra entry refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_golden_outbox_name_with_a_newline_cannot_pass() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  # A name with a newline is one entry however it would print in a line-based listing.
  : >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/$(printf 'a\nb')"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "extra entry with a newline refused"
  assert_contains "$err" "holds 3 entries" "counted as one more entry"
}
test_missing_golden_outbox_fails_with_recovery() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  rm -rf "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_unreadable_golden_outbox_fails_with_recovery() {
  # root reads mode-000 directories anyway, so the failure cannot be produced this way
  if [[ "$(id -u)" -eq 0 ]]; then record "PASS unreadable outbox refused (skipped: running as root)"; return 0; fi
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  : >"$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects/hidden"; chmod 000 "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  chmod 755 "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE/claude-projects"
  assert_eq 1 "$status" "an outbox the host cannot read in full is refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_golden_browsers_must_stay_empty() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  : >"$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE/current"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_golden "$wt" 0 2>&1) || status=$?
  assert_eq 1 "$status" "a golden with something in its browsers dir is refused"
  assert_contains "$err" "agent-vm golden rm" "recovery shown"
}
test_staging_hash_ignores_location_and_mtime() {
  local wt h1 h2 out; wt=$(make_dotfiles_fixture)
  out=$(build_staging agent-s-000003 "$wt"); h1=${out#* }
  cp -R "$wt" "$TMP_ROOT/df-copy"; touch -t 200001010000 "$TMP_ROOT/df-copy/home/dot_a"
  out=$(build_staging agent-s-000004 "$TMP_ROOT/df-copy"); h2=${out#* }
  assert_eq "$h1" "$h2" "same content, same hash"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E '^FAIL|run,'`
期待: `test_staging_hash_ignores_location_and_mtime` 以外の追加テストが FAIL（`ensure_golden` などが未定義）。`test_staging_hash_ignores_location_and_mtime` は既存の `dir_hash` の性質を固定するテストなので、最初から通る

- [ ] **Step 3: 最小実装**

```bash
# A tree a VM could write into, removed only after its machine was deleted. chmod first like forget_machine:
# the VM may have dropped permissions on directories inside it. Unlike forget_machine, which reports and goes on
# (it cleans up after a machine the user removed), this dies: a leftover here would fail the golden checks or be
# mounted into a new clone, so the launch must not continue past it.
remove_vm_tree() { # dir
  if [[ ! -e "$1" && ! -L "$1" ]]; then return 0; fi
  chmod -R u+rwX "$1" 2>/dev/null || true
  rm -rf "$1" || die "could not remove $1; remove it by hand, then retry"
}

discard_golden() { # record first, so an interrupted removal still reads as "rebuild" next time; the lock file stays
  local vm d
  rm -f "$(golden_dir)/meta"
  vm=$(orb_machine_state "$GOLDEN_MACHINE")
  if [[ -n "$vm" ]]; then
    orb_q delete -f "$GOLDEN_MACHINE" || die "could not delete $GOLDEN_MACHINE. recover: orb delete -f $GOLDEN_MACHINE"
  fi
  for d in staging outbox browsers; do remove_vm_tree "$AGENT_VM_STATE_DIR/$d/$GOLDEN_MACHINE"; done
}

create_golden() { # working_tree: the only `orb create` left; repo machines are clones of this one (spec K1)
  local mounts part
  local -a parts args=()
  # Also reached from `agent-vm golden refresh`, which does not pass through ensure_machine's check.
  check_mount_paths "$AGENT_VM_STATE_DIR/staging/$GOLDEN_MACHINE" "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE" "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
  mkdir -p "$AGENT_VM_STATE_DIR/staging/$GOLDEN_MACHINE" "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE" "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
  mounts=$(vm_mounts "$GOLDEN_MACHINE")
  IFS=, read -r -a parts <<<"$mounts"
  for part in "${parts[@]}"; do args+=(--mount "$part"); done
  orb_q create --isolated --isolate-network --forward-ssh-agent -c "$1/agent-vm/cloud-init.yaml" "${args[@]}" ubuntu "$GOLDEN_MACHINE"
}

seal_golden() { # generation
  orb_q -m "$GOLDEN_MACHINE" bash "/opt/agent-vm/src/$1/agent-vm/golden-seal.sh" \
    || die "sealing the golden machine failed (see above). recover: agent-vm golden rm"
}

count_entries() { find "$1" -mindepth 1 -print0 | tr -dc '\0' | wc -c | tr -d ' '; } # dir -> entries below it, NUL-counted

verify_golden() { # host-side checks, run on every use even when the update is skipped (spec K6)
  local ob="$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE" br="$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE" d n
  verify_machine_config "$GOLDEN_MACHINE" "$(vm_mounts "$GOLDEN_MACHINE")" || die "the golden machine failed its check (see above). recover: agent-vm golden rm"
  # Exactly two real, empty directories in the outbox; counted NUL-separated, so a name holding a newline or a
  # separator cannot pass for the expected listing.
  [[ -d "$ob" && ! -L "$ob" ]] || die "the golden machine's outbox is missing. recover: agent-vm golden rm"
  for d in claude-projects codex-sessions; do
    [[ -d "$ob/$d" && ! -L "$ob/$d" ]] || die "the golden machine's outbox lacks $d/. recover: agent-vm golden rm"
  done
  # find fails on a subtree the VM made unreadable; that is a failed check too, with the same recovery.
  n=$(count_entries "$ob") || die "the golden machine's outbox could not be read in full. recover: agent-vm golden rm"
  [[ "$n" == 2 ]] || die "the golden machine's outbox holds $n entries, expected only claude-projects/ and codex-sessions/. recover: agent-vm golden rm"
  # The golden never gets a browser (it has no browser record); its browsers mount exists only for bootstrap.
  [[ -d "$br" && ! -L "$br" ]] || die "the golden machine's browsers dir is missing. recover: agent-vm golden rm"
  n=$(count_entries "$br") || die "the golden machine's browsers dir could not be read in full. recover: agent-vm golden rm"
  [[ "$n" == 0 ]] || die "the golden machine's browsers dir holds $n entries, expected none. recover: agent-vm golden rm"
}

update_golden() { # cloud_init_hash generation staging_hash vm_state: bootstrap, seal, stop, check, record
  if [[ "$4" != running ]]; then orb_q start "$GOLDEN_MACHINE"; fi
  maybe_bootstrap "$GOLDEN_MACHINE" "$2" "$3"
  seal_golden "$2"
  orb_q stop "$GOLDEN_MACHINE"
  verify_golden
  write_golden_meta "$1" sealed "$3"
}

ensure_golden() { # working_tree force(0|1); the caller holds the golden lock (fd 7)
  local ci vm state="" rc=0 reason="" out gen hash
  ci=$(sha_of_file "$1/agent-vm/cloud-init.yaml")
  vm=$(orb_machine_state "$GOLDEN_MACHINE")
  state=$(golden_meta_field state) || rc=$?
  if [[ -z "$vm" ]]; then
    if [[ -f "$(golden_dir)/meta" ]]; then reason="it was removed outside agent-vm"; else reason=new; fi
  elif [[ "$rc" -eq 2 ]]; then reason="its record has an unknown format (written by a newer agent-vm?)"
  elif [[ "$rc" -ne 0 ]]; then reason="it has no complete record"
  elif [[ "$state" != sealed && "$state" != updating ]]; then reason="its record has an unknown state"
  elif [[ "$(golden_meta_field cloud_init_hash)" != "$ci" ]]; then reason="agent-vm/cloud-init.yaml changed"
  elif [[ "$(golden_meta_field contract)" != "$BOOTSTRAP_CONTRACT" ]]; then reason="the bootstrap contract changed"
  fi
  if [[ -n "$reason" ]]; then
    if [[ "$reason" == new ]]; then
      step "creating the golden machine $GOLDEN_MACHINE (first run only; later machines are cloned from it)"
    else
      step "rebuilding the golden machine: $reason"
    fi
    discard_golden
    create_golden "$1"
    out=$(build_staging "$GOLDEN_MACHINE" "$1")
    read -r gen hash <<<"$out"
    update_golden "$ci" "$gen" "$hash" running # orb create leaves it running
    return 0
  fi
  out=$(build_staging "$GOLDEN_MACHINE" "$1")
  read -r gen hash <<<"$out"
  if [[ "$2" -eq 0 && "$state" == sealed && "$(golden_meta_field staging_hash)" == "$hash" && "$vm" == stopped ]]; then
    verify_golden
    return 0
  fi
  step "updating the golden machine"
  write_golden_meta "$ci" updating "$(golden_meta_field staging_hash || true)"
  update_golden "$ci" "$gen" "$hash" "$vm"
}
```

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): keep a sealed golden machine up to date"
```

### T6: 新しい repo 用 machine を golden の clone で作る（K1・K4・K5）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:274-295`（`ensure_machine` を置き換え、`discard_clone`・`orb_version` を足す）、`:1052-1063`（`forget_machine` に sentinel を足す）
- テスト: `tests/agent-vm/run.sh`（`test_create_uses_isolation_flags_and_mounts` `:252-263` を削除。既存テストの前提を直す箇所は Step 3 の末尾）
- 参照: `home/dot_local/bin/executable_agent-vm:902-921`（`prepare_machine` が repo の lock を持ったまま `ensure_machine`、`ensure_browsers`、`maybe_bootstrap` の順に呼ぶ）、`:297-338`（`ensure_browsers` は `browser-records/<m>.mount` の印を見る）

- [ ] **Step 1: 失敗するテストを書く**

```bash
clone_ready_fixture() { # wt machine repo -> config-show file holding a sealed golden and a correctly mounted clone
  local show; show=$(sealed_golden_fixture "$1")
  write_config_show "$show" "$2" "$(vm_mounts "$2" "$3")"
  printf '%s\n' "$show"
}
log_line_of() { grep -n -F -- "$1" "$STUB_LOG" | head -1 | cut -d: -f1 || true; } # needle -> first line number, "" when absent
test_new_machine_is_cloned_mounted_checked_then_started() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path); : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  local c s t
  c=$(log_line_of "orb clone $GOLDEN_MACHINE agent-c-000000")
  s=$(log_line_of "orb config set machine.agent-c-000000.mounts $(vm_mounts agent-c-000000 /repo/path)")
  t=$(log_line_of "orb start agent-c-000000")
  if [[ -n "$c" && -n "$s" && -n "$t" && "$c" -lt "$s" && "$s" -lt "$t" ]]; then record "PASS clone, then mounts, then start"; else record "FAIL clone, then mounts, then start ($c $s $t)"; fi
  assert_not_contains "$(cat "$STUB_LOG")" "orb create" "no direct create for a repo machine"
  assert_status 1 "sentinel removed" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  assert_status 0 "browsers mount source exists" -- test -d "$AGENT_VM_STATE_DIR/browsers/agent-c-000000"
}
test_no_orb_call_inherits_a_lock_fd_during_creation() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  orb() { # wraps the stub for this subshell only
    local fd
    for fd in 7 8 9; do if [[ -e "/dev/fd/$fd" ]]; then printf 'leak %s %s\n' "$fd" "$*" >>"$TMP_ROOT/leaks"; fi; done
    command orb "$@"
  }
  exec 9>"$TMP_ROOT/repo.lock" # as prepare_machine holds it
  orb version >/dev/null # positive control: a direct call is seen holding fd 9
  assert_contains "$(cat "$TMP_ROOT/leaks" 2>/dev/null || true)" "leak 9" "control: the wrapper detects an inherited fd"
  rm -f "$TMP_ROOT/leaks"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  exec 9>&-
  assert_eq "" "$(cat "$TMP_ROOT/leaks" 2>/dev/null || true)" "no orb call saw fd 7, 8 or 9"
}
test_clone_with_unswapped_mounts_is_deleted_not_started() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  write_config_show "$show" agent-c-000000 "$(vm_mounts "$GOLDEN_MACHINE")" # the set did not take effect
  : >"$STUB_LOG"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>&1) || status=$?
  assert_eq 1 "$status" "refused"
  assert_contains "$err" "OrbStack" "message names OrbStack (and its version when available)"
  assert_contains "$err" "AGENT_VM=off" "message gives the host fallback"
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "clone deleted"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "never started"
  assert_status 1 "sentinel cleared once deleted" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_each_failure_after_the_clone_deletes_it_and_never_starts_it() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  # A failing `config show` is not used here: the golden check reads it first, so the launch stops before cloning.
  : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="config set" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "config set failure deletes the clone"
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "config set failure never starts it"
  local net="$TMP_ROOT/show-net"; cp "$show" "$net"
  sed -i.bak "s/machine.agent-c-000000.isolate_network: true/machine.agent-c-000000.isolate_network: false/" "$net"; : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$net" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_not_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "clone without network isolation never starts"
  : >"$STUB_LOG"
  (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="start agent-c-000000" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || true
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f agent-c-000000" "failed start deletes the clone"
}
test_failed_clone_deletes_nothing() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  local status=0; (STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="clone" ensure_machine agent-c-000000 /repo/path "$wt") 2>/dev/null || status=$?
  assert_eq 1 "$status" "stops"
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "a failed clone never deletes by name"
  assert_status 0 "sentinel kept, so a machine the clone may have left is recreated next time" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_unfinished_clone_is_recreated_with_fresh_browser_state() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  mkdir -p "$AGENT_VM_STATE_DIR/creating" "$AGENT_VM_STATE_DIR/browser-records" "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  printf 'mcp-0.0.1\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.id"; : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$(printf '%s\n%s' "$GOLDEN_MACHINE stopped ubuntu" "agent-c-000000 stopped ubuntu")" STUB_ORB_CONFIG_SHOW_FILE="$show" \
    ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  local d c; d=$(log_line_of "orb delete -f agent-c-000000"); c=$(log_line_of "orb clone $GOLDEN_MACHINE agent-c-000000")
  if [[ -n "$d" && -n "$c" && "$d" -lt "$c" ]]; then record "PASS deleted, then cloned again"; else record "FAIL deleted, then cloned again ($d $c)"; fi
  assert_status 1 "the old browser generation is gone" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  assert_status 1 "the old browser id is gone" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.id"
  assert_status 0 "the mount marker is written again" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-c-000000.mount"
}
test_leftover_sentinel_without_a_machine_is_harmless() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  mkdir -p "$AGENT_VM_STATE_DIR/creating" "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"; : >"$STUB_LOG"
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing deleted"
  assert_contains "$(cat "$STUB_LOG")" "orb start agent-c-000000" "created normally"
  assert_status 1 "a browser copy left by the earlier attempt is cleared" -- test -e "$AGENT_VM_STATE_DIR/browsers/agent-c-000000/gen-old"
  assert_status 1 "sentinel cleared" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_failed_delete_keeps_the_sentinel_and_says_how_to_recover() {
  local wt; wt=$(make_golden_fixture)
  mkdir -p "$AGENT_VM_STATE_DIR/creating"; : >"$AGENT_VM_STATE_DIR/creating/agent-c-000000"
  local status=0 err; err=$(STUB_ORB_LIST_STDOUT="agent-c-000000 stopped ubuntu" STUB_ORB_FAIL_ON="delete -f agent-c-000000" ensure_machine agent-c-000000 /repo/path "$wt" 2>&1) || status=$?
  assert_eq 1 "$status" "stops"
  assert_contains "$err" "recover: orb delete -f agent-c-000000" "recovery shown"
  assert_status 0 "sentinel kept for the next launch" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-c-000000"
}
test_repo_path_with_a_comma_is_refused_before_cloning() {
  local wt; wt=$(make_golden_fixture)
  local status=0; (ensure_machine agent-c-000000 "/a,b" "$wt") 2>/dev/null || status=$?
  assert_eq 1 "$status" "refused"
  assert_not_contains "$(cat "$STUB_LOG")" "orb clone" "no clone"
}
test_golden_lock_is_released_before_the_clone_starts() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-c-000000 /repo/path)
  orb() { # wraps the stub for this subshell only
    if [[ "$1" == start && "${2:-}" == agent-c-000000 ]]; then
      if try_golden_lock; then record "PASS golden lock free at start"; else record "FAIL golden lock free at start"; fi
    fi
    command orb "$@"
  }
  STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" ensure_machine agent-c-000000 /repo/path "$wt" 2>/dev/null
}
test_forget_machine_removes_the_sentinel() {
  mkdir -p "$AGENT_VM_STATE_DIR/creating"; : >"$AGENT_VM_STATE_DIR/creating/agent-z-000000"
  forget_machine agent-z-000000
  assert_status 1 "sentinel gone" -- test -e "$AGENT_VM_STATE_DIR/creating/agent-z-000000"
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E '^FAIL|run,'`
期待: 追加したテストが FAIL（今の `ensure_machine` は `orb create` を呼ぶ）

- [ ] **Step 3: 最小実装**（`ensure_machine` を置き換え、`discard_clone` と `orb_version` を足す）

```bash
# A clone this launcher created, deleted by name only after the clone itself succeeded. The repo's own records
# (machines/<m>, snapshots, ingested) and its staging/outbox stay; the browser copy and its records belonged to the
# deleted machine, and the next creation writes the marker again (spec K5).
discard_clone() { # machine
  orb_q delete -f "$1" || die "could not delete the unfinished machine $1. recover: orb delete -f $1 (the next launch also retries)"
  remove_vm_tree "$AGENT_VM_STATE_DIR/browsers/$1"
  rm -f "$AGENT_VM_STATE_DIR/browser-records/$1".* "$AGENT_VM_STATE_DIR/creating/$1"
}

orb_version() { orb_q version 2>/dev/null | sed -n 's/^Version: //p'; } # for messages only

# Mount-root assumption: an isolated machine sees only the mounted subtree, so the guest can
# change entries inside staging/<m> but cannot replace staging/<m> itself (spec K2).
# A clone starts with the golden's mounts; it is started only after its mounts are swapped and every setting
# checked (spec K4). creating/<m> marks a clone that is not yet started: any launch that finds it, including after
# a crash or kill, deletes the machine and clones again (spec K5).
ensure_machine() { # machine repo_root working_tree; the caller holds the repo lock (fd 9)
  local st=$AGENT_VM_STATE_DIR sentinel="$AGENT_VM_STATE_DIR/creating/$1" mounts vm
  vm=$(orb_machine_state "$1")
  if [[ -n "$vm" ]]; then
    if [[ ! -e "$sentinel" ]]; then return 0; fi
    step "removing $1, whose creation did not finish"
    discard_clone "$1"
  elif [[ -e "$sentinel" ]]; then
    # An earlier creation stopped with no machine left (its clone failed, or discard_clone died after the delete):
    # clear the browser copy it may have left, so the new clone does not mount it.
    remove_vm_tree "$st/browsers/$1"
    rm -f "$st/browser-records/$1".*
  fi
  check_mount_paths "$2" "$st/staging/$1" "$st/outbox/$1" "$st/browsers/$1"
  mounts=$(vm_mounts "$1" "$2")
  mkdir -p "$st/staging/$1" "$st/outbox/$1" "$st/browsers/$1" "$st/browser-records" "$st/creating"
  acquire_golden_lock 900 || die "waited 900s for another session building the golden machine. Stop that agent-vm, then retry"
  ensure_golden "$3" 0
  : >"$sentinel"
  # Same marker as the create path wrote: ensure_browsers publishes only into machines made with the browsers mount.
  : >"$st/browser-records/$1.mount"
  rm -f "$st/browser-records/$1.id"
  step "creating isolated machine $1 from the golden machine"
  # A failed clone is not deleted by name here (that could remove a machine that already existed), and the sentinel
  # stays: if the clone left a machine behind, the next launch finds machine + sentinel and recreates it; if it left
  # nothing, the next launch simply writes the sentinel again.
  orb_q clone "$GOLDEN_MACHINE" "$1" || die "could not clone the golden machine into $1 (the next launch retries)"
  orb_q config set "machine.$1.mounts" "$mounts" || { discard_clone "$1"; die "could not set the mounts of $1"; }
  verify_machine_config "$1" "$mounts" \
    || { discard_clone "$1"; die "refusing to start $1: its OrbStack settings are not the expected ones (see above). OrbStack $(orb_version) may have changed how clones keep settings. $FAIL_CLOSED_HINT"; }
  release_golden_lock
  orb_q start "$1" || { discard_clone "$1"; die "could not start $1"; }
  rm -f "$sentinel"
}
```

`forget_machine` の `rm -rf` の対象に `"$AGENT_VM_STATE_DIR/creating/$1"` を足す。

既存のテストを直す（`grep -nE 'run_tool|bash "\$LAUNCHER" (claude|codex|shell)|ensure_machine' tests/agent-vm/run.sh` で洗い出した結果）。

- 削除: `test_create_uses_isolation_flags_and_mounts`（`:252-263`）。T5 の `test_first_golden_is_created_without_a_repo_and_sealed` と、上の clone のテストが置き換える
- セッションの前後を確かめるテスト 5 本（`test_session_runs_without_holding_the_lock` `:332`、`test_session_logs_are_ingested_after_the_session` `:671`、`test_git_surface_change_during_session_sets_exit_code` `:679`、`test_tool_failure_status_wins` `:687`、`test_finish_reports_lock_timeout_with_recover_hint` `:695`）: machine の作成ではなくセッションの前後の処理を見るテストなので、`m=$(derive_machine_name "$(cd -P "$repo" && pwd -P)")` を足し（`:695` には既にある）、`run_tool` の呼び出しに `STUB_ORB_LIST_STDOUT="$m running"` を付けて既存の machine の扱いにする（`:149` の書き方と同じ）
- `test_unexpected_failure_prints_the_host_hint`（`:175`）: fixture を `make_golden_fixture` に替える。golden の `orb create` が失敗して ERR trap が働く経路になる
- browser の印のテスト 3 本を、clone の経路に合わせて書き直す（`test_existing_machine_gets_no_marker` `:1254` と `test_failed_orb_list_writes_no_marker_and_stops` `:1259` は変更不要。前者は名前だけの行を `orb_machine_state` が `present` と読むので return し、後者は `orb list` の失敗で印を書く前に止まる）

```bash
test_new_machine_gets_browser_mount_and_marker() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-n-000000 "$TMP_ROOT")
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$wt" >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "$AGENT_VM_STATE_DIR/browsers/agent-n-000000:/opt/agent-vm/browsers" "browser mount set on the clone"
  assert_status 0 "mount marker written" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
test_new_machine_drops_a_stale_id_record() {
  local wt show; wt=$(make_golden_fixture); show=$(clone_ready_fixture "$wt" agent-n-000000 "$TMP_ROOT")
  mkdir -p "$AGENT_VM_STATE_DIR/browser-records"; printf 'mcp-0.0.75\n' >"$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show"
  ensure_machine agent-n-000000 "$TMP_ROOT" "$wt" >/dev/null 2>&1
  assert_status 1 "stale id removed on create" -- test -e "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.id"
}
test_marker_survives_a_failed_clone() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt")
  export STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" STUB_ORB_FAIL_ON="clone $GOLDEN_MACHINE agent-n-000000"
  (ensure_machine agent-n-000000 "$TMP_ROOT" "$wt") >/dev/null 2>&1 || true
  assert_contains "$(cat "$STUB_LOG")" "orb clone" "clone was attempted"
  assert_status 0 "marker written before the clone" -- test -f "$AGENT_VM_STATE_DIR/browser-records/agent-n-000000.mount"
}
```

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`。既存の `test_existing_machine_is_not_recreated`、`test_prewarm_stops_before_secrets_and_session`、`test_ensure_browsers_*` は変更なしで通る

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): create repo machines as clones of the golden machine"
```

### T7: `agent-vm golden refresh|rm`（K8）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:19-36`（help）、`:1028-1050`（`main`）、`cmd_golden` を `cmd_prewarm`（`:1023-1026`）の後に追加
- テスト: `tests/agent-vm/run.sh`
- 参照: `home/dot_local/bin/executable_agent-vm:1337-1356`（`cmd_rm` の確認の取り方）、`:94-100`（`resolve_working_tree`）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_golden_rm_removes_record_machine_and_host_state_but_keeps_the_lock() {
  local wt; wt=$(make_golden_fixture); sealed_golden_fixture "$wt" >/dev/null
  acquire_golden_lock 1; release_golden_lock; : >"$STUB_LOG"
  printf 'y\n' | STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" cmd_golden rm >/dev/null 2>&1
  assert_contains "$(cat "$STUB_LOG")" "orb delete -f $GOLDEN_MACHINE" "golden deleted"
  assert_status 1 "record removed" -- test -e "$AGENT_VM_STATE_DIR/golden/meta"
  assert_status 1 "staging removed" -- test -e "$AGENT_VM_STATE_DIR/staging/$GOLDEN_MACHINE"
  assert_status 1 "outbox removed" -- test -e "$AGENT_VM_STATE_DIR/outbox/$GOLDEN_MACHINE"
  assert_status 1 "browsers removed" -- test -e "$AGENT_VM_STATE_DIR/browsers/$GOLDEN_MACHINE"
  assert_status 0 "lock file kept" -- test -f "$AGENT_VM_STATE_DIR/golden/lock"
}
test_golden_rm_asks_first() {
  local wt; wt=$(make_golden_fixture); sealed_golden_fixture "$wt" >/dev/null; : >"$STUB_LOG"
  printf 'n\n' | STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" cmd_golden rm >/dev/null 2>&1
  assert_not_contains "$(cat "$STUB_LOG")" "orb delete" "nothing deleted without a yes"
}
test_golden_refresh_forces_an_update() {
  local wt show; wt=$(make_golden_fixture); show=$(sealed_golden_fixture "$wt"); : >"$STUB_LOG"
  STUB_CHEZMOI_STDOUT="$wt/home" STUB_ORB_LIST_STDOUT="$GOLDEN_MACHINE stopped ubuntu" STUB_ORB_CONFIG_SHOW_FILE="$show" cmd_golden refresh 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "golden-seal.sh" "resealed although unchanged"
}
test_main_dispatches_golden() {
  cmd_golden() { echo "golden $*"; }
  assert_eq "golden refresh" "$(main golden refresh)" "golden refresh"
  assert_eq "golden rm" "$(main golden rm)" "golden rm"
  assert_contains "$(main --help)" "agent-vm golden refresh|rm" "help lists golden"
}
test_golden_name_is_never_a_repo_machine_name() {
  mkdir -p "$TMP_ROOT/vm"
  if [[ "$(derive_machine_name "$TMP_ROOT/vm")" != "$GOLDEN_MACHINE" ]]; then record "PASS repo 'vm' does not map to the golden"; else record "FAIL repo 'vm' maps to the golden"; fi
  case "$GOLDEN_MACHINE" in
    agent-*-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) record "FAIL golden name has the repo machine shape" ;;
    *) record "PASS golden name is outside the repo machine shape" ;;
  esac
}
```

- [ ] **Step 2: 失敗を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | grep -E '^FAIL|run,'`
期待: `cmd_golden` に依存するテストが FAIL

- [ ] **Step 3: 最小実装**

```bash
cmd_golden() { # refresh|rm; both hold the golden lock (fd 7), never a repo lock (spec K3)
  local wt answer
  case "${1:-}" in
    refresh)
      check_health
      wt=$(resolve_working_tree)
      acquire_golden_lock 900 || die "waited 900s for another session building the golden machine. Stop that agent-vm, then retry"
      ensure_golden "$wt" 1
      release_golden_lock
      step "golden machine $GOLDEN_MACHINE is ready"
      ;;
    rm)
      check_health
      # Asks first like cmd_rm / cmd_gc: deleting costs a rebuild of several minutes on the next new machine.
      printf 'delete the golden machine %s? the next new machine rebuilds it (several minutes) [y/N] ' "$GOLDEN_MACHINE"
      read -r answer
      if [[ "$answer" != y && "$answer" != Y ]]; then return 0; fi
      acquire_golden_lock 900 || die "waited 900s for another session building the golden machine. Stop that agent-vm, then retry"
      discard_golden
      release_golden_lock
      ;;
    *) show_help >&2; return 1 ;;
  esac
}
```

help に `  agent-vm golden refresh|rm        Update the golden machine now / delete it` を、`main` に `golden) shift; cmd_golden "$@" ;;` を足す。

- [ ] **Step 4: 通過を確認する**

実行: `/bin/bash tests/agent-vm/run.sh 2>&1 | tail -1`
期待: `N run, 0 failed`

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add golden refresh and golden rm"
```

### T8: 全 suite と静的検査

**Files:**

- 確認のみ: `tests/agent-vm/run.sh`、`tests/agent-vm/run-shell.sh`、`tests/agent-vm/run-bootstrap.sh`、`tests/agent-vm/run-templates.sh`、`scripts/lint-shell.sh`
- 参照: `.github/workflows/ci-agent-vm.yml`（run.sh と run-shell.sh は macOS と Linux、run-bootstrap.sh と run-templates.sh は Linux だけ）、`.github/workflows/ci-shellcheck.yml`

- [ ] **Step 1: ローカル（macOS）で走らせる**

実行: `/bin/bash tests/agent-vm/run.sh && /bin/bash tests/agent-vm/run-shell.sh && ./scripts/lint-shell.sh`
期待: 2 つの suite が `0 failed`、lint-shell.sh が指摘なしで終わる（全 severity）

- [ ] **Step 2: Linux の suite を CI で確かめる**

push して、`ci-agent-vm` の ubuntu と macOS の両方の job と、`Shell Lint (shellcheck)` が成功することを確かめる（`gh run watch`）。

## ISO 25010 具体テストケース

### セキュリティ（機密性・完全性）

- **入力**: repo path `/w/a,b` → **期待**: `orb clone` を呼ばずに exit 1。文言に `/a,b` と `AGENT_VM=off` が入る（`test_repo_path_with_a_comma_is_refused_before_cloning`、`test_mount_paths_with_separators_are_refused`）
- **入力**: clone 先の `mounts` が golden の 3 つのまま（`config set` が効かなかった） → **期待**: `orb delete -f <m>` が記録され、`orb start <m>` は記録されない（`test_clone_with_unswapped_mounts_is_deleted_not_started`）
- **入力**: `orb config show` に未知のキー `share_home` が 1 行増える → **期待**: 検査が 1 を返し、文言に `share_home` が入る（`test_machine_config_must_match_exactly`）
- **入力**: `isolate_network: false` → **期待**: 検査が 1 を返す。clone 先なら start されない
- **入力**: `orb clone` が失敗する → **期待**: `orb delete` は 1 度も記録されず、sentinel は残る（`test_failed_clone_deletes_nothing`）
- **入力**: `orb list` が失敗する → **期待**: 呼び出し元が止まり、先へ進まない（`test_failed_machine_listing_is_an_error_not_absence`、既存の `test_failed_orb_list_writes_no_marker_and_stops`）
- **入力**: golden の outbox の `claude-projects/` に symlink `x -> /etc` → **期待**: exit 1、文言に `agent-vm golden rm`（`test_golden_outbox_with_any_extra_entry_fails_with_recovery`）
- **入力**: golden の browsers に何かが 1 つある → **期待**: exit 1、文言に `agent-vm golden rm`（`test_golden_browsers_must_stay_empty`）
- **入力**: golden の `~/.codex/auth.json` が存在する（dangling symlink を含む） → **期待**: golden-seal.sh が exit 1、文言に `.codex/auth.json` と `agent-vm golden rm`（`test_seal_refuses_a_golden_with_credentials`、`test_seal_refuses_a_dangling_credential_link`）
- **入力**: machine の作成の間の `orb` 呼び出し → **期待**: どれも fd 7・8・9 を受け継がない（`test_no_orb_call_inherits_a_lock_fd_during_creation`）

### 機能適合性（機能の正確性）

- **入力**: 空の browsers の root がある状態で bootstrap し、続けて golden-seal.sh を走らせる → **期待**: `~/.claude.json` の mcpServers の key が `["chrome-devtools","context7","excalidraw","playwright","readability"]`（`test_golden_with_an_empty_browsers_mount_keeps_browser_mcp_through_seal`）
- **入力**: 新しい machine を clone で作る → **期待**: `browsers/<m>` が mount され、`browser-records/<m>.mount` が書かれる（`test_new_machine_gets_browser_mount_and_marker`）。golden には `browser-records` が作られない（`test_first_golden_is_created_without_a_repo_and_sealed`）

### 性能効率性（時間効率性）

- **入力**: meta が `state=sealed` で staging hash が一致し、golden が停止中 → **期待**: `orb start` も `golden-seal.sh` も記録されず、`orb config show` だけが記録される（`test_unchanged_stopped_golden_is_not_started`）。実機の所要時間は plan-2 で測る

### 信頼性（回復性）

- **入力**: 前回の作成の sentinel が残り、machine も残っている → **期待**: `orb delete -f <m>` の後に `orb clone` が記録され、前の browser の世代と id は消え、mount の印は書き直される（`test_unfinished_clone_is_recreated_with_fresh_browser_state`）
- **入力**: sentinel が残り、`orb delete` が失敗する → **期待**: exit 1、文言に `recover: orb delete -f <m>`、sentinel は残る（`test_failed_delete_keeps_the_sentinel_and_says_how_to_recover`）
- **入力**: golden の更新中に `golden-seal.sh` が失敗する → **期待**: meta は `state=updating`。次の実行は `orb create` を記録せず、最後は `state=sealed`（`test_interrupted_update_is_retried_not_rebuilt`）
- **入力**: meta の `cloud_init_hash` が現在の値と違い、golden の browsers に権限を落としたディレクトリが残っている → **期待**: 文言に `cloud-init.yaml changed`、`orb delete -f agent-vm-golden` の後に `orb create`、古い outbox と browsers の中身は消える（`test_golden_is_rebuilt_when_cloud_init_changes`）
- **入力**: golden の lock を持つ別プロセスがいる → **期待**: 2 つ目の取得は 1 秒で失敗し、repo の lock と browser store の lock は取れる（`test_golden_lock_is_exclusive_and_independent_of_other_locks`）

### 保守性（試験性）

- **入力**: bootstrap.sh を走らせてから golden-seal.sh を走らせる → **期待**: `$HOME/.local/state` 以下のどのファイルにも applied hash の値が残らない（`test_seal_leaves_no_applied_hash_so_every_clone_bootstraps`）
- **入力**: 同じ内容の dotfiles を別の場所に、mtime を変えてコピーする → **期待**: staging hash が一致する（`test_staging_hash_ignores_location_and_mtime`）
- **入力**: golden と repo 用の machine の mount → **期待**: どちらも `vm_mounts` の 1 か所から出る（`test_vm_mounts_give_the_golden_and_repo_shapes_from_one_place`）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 既存の `test_session_runs_without_holding_the_lock` が新しい作成経路（cloud-init.yaml の無い fixture）で abort する。`test_unexpected_failure_prints_the_host_hint` は記載と違う理由で通る。`verify_golden` は outbox が無いと回復手順なしで落ちる。`comm` に `LC_ALL=C` が無い。`log_line_of` が needle の不在で abort する。R1 の die 文言に OrbStack の版が無い

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: 範囲の逸脱は無い。テストが欠けている箇所が 3 つある（seal が applied-hash を消せない分岐、作り直し時の host 側の掃除、machine が無く sentinel だけ残る場合）。R5 の文書化が抜けている。golden rm の確認プロンプトの根拠を書く

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: orb_q の適用範囲（残す呼び出しとその理由）が書かれていない。関数の置き場所を分ける（orb_q は check_health の近く、golden lock は release_lock の直後）。dir_hash の短命な子への fd 継承は許容する旨を書く。bootstrap.sh 側にも、applied-hash のパスを seal が複製していることをコメントで書く

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: repo_root が state dir を含む（例: ~ が repo）と、VM から golden の meta と staging を書き換えられる。delete と list がどちらも失敗したとき、discard_clone が sentinel を消して fail-open になる。outbox の検査が改行入りの名前で偽装できる。tab を含む path、空キーの行。clone・config set・start の各失敗で start が記録されないことのテストが欠けている

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: `orb list` の一時的な失敗や名前の衝突で、clone の失敗が既存の machine の `orb delete` に化けうる（K9 違反）。format 不明と record 欠損で文言を分ける。作り直すときに古い staging・outbox を消す。golden-seal.sh を追加すると既存の machine が一度 re-bootstrap されることを記録する

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: needs-work
- 主指摘: `test_failed_machine_listing_is_an_error_not_absence` は `||` の左のサブシェルで set -e が効かないので常に落ちる（bash 3.2 で実測）。改行の偽装テストは名前に `/` を含むので fixture の作成で abort する。`printf '%s\n' $MACHINE_CONFIG_KEYS` に SC2086。seal の `rm -f` の失敗が fail の文言を出さない

### scope-justification-reviewer
- verdict: pass
- 主指摘: round 1 の指摘はすべて解消した。die の文言に OrbStack の版が入ることをテストで確かめるとよい

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: orb_q の適用範囲は実コードと一致する。T2・T3・T5 の Files の「関数群の後に追加」が、前提で決めた配置と食い違う（文書上の不整合）

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: round 1 の指摘は解消した。clone が途中で失敗して machine が残った場合、sentinel を消すと未検査の machine が次回「既存」として使われる。clone の失敗では sentinel を残すべき

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: clone の失敗で sentinel を消すのは fail-open の穴になりうる（「clone の失敗は何も作らない」は未検証の前提）。golden の record が欠けたとき、同名の利用者作成 machine を消すことを ADR に書く

<!-- auto-review: verdict=needs-work; hash=7410d1b0de8455986cc15736cb9b5a67fa48f8807d5bf45225dce2c5b1e55b77; design-hash=7a6b37aa0bd8253ab8dfadc3e83a31ef30b4257556579ccddbc4237795ff2ecb; round=1; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:43:10.379Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: pass
- 主指摘: round 2 の 4 件はすべて解消した。別プロセスでの一覧失敗テスト、改行入りの名前のテスト、SC2086、seal の文言は成立する。clone の失敗で sentinel を残す変更の後も、既存の sentinel のテストはそのまま通る

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: clone の失敗で sentinel を残し、名前で消さない処置で、既存の machine を誤って消す経路が無くなった。両方の分岐がテストで固定されている

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=7968d3eaf96e914ec9ea3d20ad4f0b2bade77f169e29ce3294507307eaf9e7b6; design-hash=347ce74d49719636b60fb8aaa3d0e9a514c3d10e1e508bf117203f7481f5e4db; round=2; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:52:46.032Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: HEAD のコードと stub で机上で追い、各 task のコードとテストは成立する。low の指摘: `count_entries` の失敗が回復手順なしの ERR になる、`golden refresh` の経路では golden の path が `check_mount_paths` を通らない、fd のテストに陽性対照が無い（いずれも反映済み）

### scope-justification-reviewer
- verdict: pass
- 主指摘: spec の K1〜K12 は plan-1 か plan-2 に割り当てられている。「1 ファイル変えると hash が変わる」は既存の `test_hash_reflects_uncommitted_edits` が固定する。seal の後に bootstrap が再び走ることまでテストで確かめる（反映済み）。clone の失敗で名前を消さないことと golden rm の確認を ADR に書く（plan-2 に反映済み）

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: `golden refresh` の経路で golden の path を `check_mount_paths` に通す。bootstrap の `BROWSERS_ROOT` の既定値と `vm_mounts` の browsers の宛先が一致することをテストで固定する（コメントにテスト名を書かない）。sentinel があって machine が無い場合も、古い browsers と印を片付ける

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: `chmod -R` は macOS でも GNU でも symlink を辿らない。P2: 権限を落とした入れ子のディレクトリまで消せることをテストで固定する、`count_entries` の失敗に回復手順を出す、fd のテストに陽性対照を入れる（いずれも反映済み）

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: golden の host 側状態、meta の遷移、既存の machine との互換は成立する。golden の作成直後の検査が恒常的に落ちると、起動のたびに作り直しを試みる（ADR の Consequences に記録する）。machines の meta は `prepare_machine` が先に書くので、sentinel だけの孤児は実際にはほぼ生じない

<!-- auto-review: verdict=pass; hash=1aa7bcedfdccf28e4e4ac2a1e4ef03bfa4d82e8d3a56c54edd840b2a8644ce31; design-hash=37cfdfa5af6ee7c4db90cc15e02d71fa8f50f7733bae15832db9cb0777f4cc36; round=3; parent-spec-hash=0ec071c55ebe2b34b3d91c54eb27f21f1348b7cc9648df2dd9a0f97828b8421c; at=2026-10-01T14:56:27.715Z; reviewers=logic-validator+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=34; excluded=0; at=2026-10-01T14:58:20.017Z -->

## Reviewer Outputs (Round 5)

### logic-validator
- verdict: pass
- 主指摘: 追加分（fd テストの陽性対照、BROWSERS_ROOT の既定値の grep、読めない outbox のテスト、入れ子の 000 ディレクトリの削除、seal の後の再 bootstrap）は机上で成立する。軽微: 削除に失敗すると 000 のディレクトリが tmp に残りうるが、テストの正否には影響しない

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: round 4 の 3 指摘は解消した。sentinel が残り machine が無い場合も、browsers と印を片付けてから clone し直す。軽微: `discard_clone` の中の die が、呼び出し元の元のエラー文より先に出る（回復性には影響しない）

### scope-justification-reviewer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=bc45451034bf2dd4995fafec603c277c569a95b4a89e80005b3578ff3327fa39; design-hash=2bc5bbd601aee39514e5e33719acaa97a9e570ee244e45bda6c21b93b3f31179; round=4; parent-spec-hash=d192e68e8b7ad4531624f3058511e027074b8bbd145fe3ef3d4ecaa901fedf6d; at=2026-10-01T15:37:08.680Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->

<!-- auto-review: verdict=pass; hash=905c800fa48a5b2c18fb1741ecffc09132f1780c8da395706b6b0341b915ee7c; design-hash=2bc5bbd601aee39514e5e33719acaa97a9e570ee244e45bda6c21b93b3f31179; round=5; parent-spec-hash=d192e68e8b7ad4531624f3058511e027074b8bbd145fe3ef3d4ecaa901fedf6d; at=2026-10-01T15:38:33.171Z; reviewers=logic-validator+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=22; excluded=0; at=2026-10-01T15:38:33.198Z -->
