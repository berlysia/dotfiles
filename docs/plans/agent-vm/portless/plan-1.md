> **WIP・未承認**: #207 の Document Workflow の途中成果物。レビューは途中で、承認を受けていない。実装の根拠にしない（引き継ぎ先でレビューと承認をやり直す）。

<!-- spec-ref: spec.md -->

# Plan 1: portless の proxy のポートを launcher が割り当てる（#207）

spec の K1〜K10 をすべて実装する。1 本の plan にまとめる。launcher の変更は 3 関数と 1 つの lock で、docs と設定は 1〜数行ずつのためである。

前提と決めごと:

- launcher は bash 3.2 互換を保つ。CI の macOS は `/bin/bash tests/agent-vm/run.sh` で走らせる。連想配列、`mapfile`、`${var,,}` は使わない。
- テストは `tests/agent-vm/run.sh` に関数を足す。各テストは自分の `AGENT_VM_STATE_DIR` を持つサブシェルで走る（`run.sh` 末尾のループ）。
- この環境（Linux コンテナ）での基準: 変更前の `bash tests/agent-vm/run.sh` は「692 run, 7 failed」である。
  - 失敗は staging の hash と generation のテスト（`hash is versioned`、`uncommitted edit changes hash`、`new generation name`、`only the new generation remains`）で、今回触らない `build_staging` の環境依存である。
  - 判定は「失敗が 7 件から増えないこと、新しいテストが全部 PASS」とする。CI（ubuntu / macOS）は全件 PASS が条件である。
- 新しい定数と変数の名前:
  - `PROXY_PORT_MIN=17300`、`PROXY_PORT_MAX=17399`。
  - グローバル変数 `PROXY_PORT` は、`prepare_machine` が meta から設定する。`MACHINE` / `REPO` と同じ扱いにする。
- Document Workflow の hook（`reviewer-run-recorder`、`document-workflow-guard`）は、このクラウド環境には配備されていない。
  - そのため、レビューは general-purpose の Agent に、各 reviewer の定義（`home/dot_claude/agents/<name>.md`）を読ませて行う。結果は文書に手で記録する。
  - `reviewer-runs.log` と承認行は手で書かない。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
home/dot_config/mise/config.toml
home/dot_claude/CLAUDE.md
docs/agent-vm.md
docs/decisions/0018-agent-vm-orbstack.md

# 新規作成（ワークフロー成果物の保存）
docs/plans/agent-vm/portless/research.md
docs/plans/agent-vm/portless/spec.md
docs/plans/agent-vm/portless/plan-1.md
```

## Tasks

### T1: ポートの割り当てと meta の書き込み（K2、K3、K4）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:64-79`（`meta_path` の周辺に定数と関数を足し、`write_machine_meta` を置き換える）
- テスト: `tests/agent-vm/run.sh`（`test_meta_*` の直後に足す）
- 参照: `home/dot_local/bin/executable_agent-vm:126-141`（`acquire_lock` の perl flock。同じ形で fd 6 の lock を作る）
- 参照: `home/dot_local/bin/executable_agent-vm:430-437`（`write_golden_meta`。一時ファイルと `mv` で置き換える既存の形）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_proxy_port_first_machine_gets_the_lowest_slot() {
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq 17300 "$(read_meta_field agent-a-000000 proxy_port)" "first machine gets 17300"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "repo_path still written"
}
test_proxy_port_skips_ports_held_by_other_records() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=17300\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  printf 'format=1\nrepo_path=/tmp/c\nproxy_port=17302\n' >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq 17301 "$(read_meta_field agent-a-000000 proxy_port)" "lowest free slot between held ones"
}
test_proxy_port_is_kept_across_launches() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/a\nproxy_port=17350\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq 17350 "$(read_meta_field agent-a-000000 proxy_port)" "own port kept, not moved to the lowest slot"
}
test_proxy_port_duplicate_is_reassigned_for_the_launching_machine_only() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/a\nproxy_port=17300\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=17300\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq 17301 "$(read_meta_field agent-a-000000 proxy_port)" "launching machine moves off a shared port"
  assert_eq 17300 "$(read_meta_field agent-b-000000 proxy_port)" "the other record is untouched"
}
test_proxy_port_ignores_out_of_range_and_garbage_values() {
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  printf 'format=1\nrepo_path=/tmp/b\nproxy_port=80\n' >"$AGENT_VM_STATE_DIR/machines/agent-b-000000"
  printf 'format=1\nrepo_path=/tmp/c\nproxy_port=17300x\n' >"$AGENT_VM_STATE_DIR/machines/agent-c-000000"
  printf 'format=1\nrepo_path=/tmp/a\nproxy_port=17400\n' >"$AGENT_VM_STATE_DIR/machines/agent-a-000000"
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq 17300 "$(read_meta_field agent-a-000000 proxy_port)" "own out-of-range value replaced; others' garbage holds nothing"
}
test_proxy_port_exhausted_pool_writes_no_port_and_warns() {
  local p err
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  for ((p = 17300; p <= 17399; p++)); do
    printf 'format=1\nrepo_path=/tmp/%s\nproxy_port=%s\n' "$p" "$p" >"$AGENT_VM_STATE_DIR/machines/agent-p$p-000000"
  done
  err=$(write_machine_meta agent-a-000000 /tmp/a 2>&1 >/dev/null)
  assert_eq "" "$(read_meta_field agent-a-000000 proxy_port || true)" "no port recorded when the pool is full"
  assert_eq /tmp/a "$(read_meta_field agent-a-000000 repo_path)" "the record is still written"
  assert_contains "$err" "agent-vm gc" "the warning names the recovery"
}
test_proxy_port_lock_is_released_and_independent() {
  write_machine_meta agent-a-000000 /tmp/a
  local status=0
  bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; acquire_port_lock 1" </dev/null >/dev/null 2>&1 || status=$?
  assert_eq 0 "$status" "port lock is free after write_machine_meta returns"
  assert_status 0 "port lock file is outside machine records" -- test -f "$AGENT_VM_STATE_DIR/ports.lock"
  assert_eq "agent-a-000000" "$(machine_rows | cut -f1)" "ports.lock is not listed as a machine"
}
test_proxy_port_concurrent_writers_get_distinct_ports() {
  local i
  for i in 1 2 3 4 5 6; do
    bash -c "AGENT_VM_STATE_DIR='$AGENT_VM_STATE_DIR' AGENT_VM_LIB=1 . '$LAUNCHER'; write_machine_meta agent-m$i-000000 /tmp/m$i" </dev/null >/dev/null 2>&1 &
  done
  wait
  local ports; ports=$(for i in 1 2 3 4 5 6; do read_meta_field agent-m$i-000000 proxy_port; done | sort -u | wc -l | tr -d ' ')
  assert_eq 6 "$ports" "six concurrent launches record six distinct ports"
}
test_meta_is_replaced_not_written_in_place() {
  write_machine_meta agent-a-000000 /tmp/a
  assert_eq "" "$(find "$AGENT_VM_STATE_DIR/machines" -name 'agent-a-000000.*' ! -name '*.lock')" "no temp file left"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | grep -E 'proxy port|proxy_port|lowest|own port|pool|port lock|distinct|temp file left|run,'`
期待: 上のテストの assert が FAIL になる（`proxy_port` が書かれない、`acquire_port_lock` が無い）。

- [ ] **Step 3: 最小実装を書く**

`meta_path` の直後に定数と関数を足し、`write_machine_meta` を置き換える。

```bash
# portless proxy ports (docs/agent-vm.md, #207): one per machine, so OrbStack never sees two machines bind the same
# port. Above 1023 (no sudo in the VM), clear of portless's app range 4000-4999 and fallback 1355, of common dev
# server ports and of the ephemeral ranges.
PROXY_PORT_MIN=17300
PROXY_PORT_MAX=17399

acquire_port_lock() { # max_wait_seconds; holds fd 6 until release_port_lock (held only while records are read and written)
  local waited=0
  mkdir -p "$AGENT_VM_STATE_DIR" || return 1
  exec 6>"$AGENT_VM_STATE_DIR/ports.lock"
  until perl -MFcntl=:flock -e 'open(my $f, ">&=", 6) or die "fdopen: $!"; flock($f, LOCK_EX | LOCK_NB) or exit 1'; do
    if [[ "$waited" -ge "$1" ]]; then exec 6>&-; return 1; fi
    sleep 1
    waited=$((waited + 1))
  done
}
release_port_lock() { exec 6>&-; }

valid_proxy_port() { [[ "$1" =~ ^[0-9]+$ && "$1" -ge "$PROXY_PORT_MIN" && "$1" -le "$PROXY_PORT_MAX" ]]; }

pick_proxy_port() { # machine -> the port to record, or nothing when every slot is held (caller holds the port lock)
  local f p own="" taken=" "
  for f in "$AGENT_VM_STATE_DIR"/machines/*; do
    [[ -f "$f" && "$f" != *.lock ]] || continue
    p=$(read_meta_field "$(basename "$f")" proxy_port 2>/dev/null) || continue
    valid_proxy_port "$p" || continue
    if [[ "$(basename "$f")" == "$1" ]]; then own=$p; else taken+="$p "; fi
  done
  if [[ -n "$own" && "$taken" != *" $own "* ]]; then printf '%s\n' "$own"; return 0; fi
  for ((p = PROXY_PORT_MIN; p <= PROXY_PORT_MAX; p++)); do
    if [[ "$taken" != *" $p "* ]]; then printf '%s\n' "$p"; return 0; fi
  done
}

write_machine_meta() { # machine repo_path: also keeps or assigns the machine's portless proxy port
  local port tmp
  case "$2" in *$'\n'*) die "repository path contains a newline; refusing to launch" ;; esac
  mkdir -p "$AGENT_VM_STATE_DIR/machines"
  acquire_port_lock 30 || die "timed out waiting for another agent-vm assigning proxy ports"
  port=$(pick_proxy_port "$1")
  tmp=$(mktemp "$AGENT_VM_STATE_DIR/machines/.$1.XXXXXX") || { release_port_lock; die "could not write the machine record"; }
  printf 'format=1\nrepo_path=%s\n%s' "$2" "${port:+proxy_port=$port
}" >"$tmp"
  mv "$tmp" "$(meta_path "$1")"
  release_port_lock
  if [[ -z "$port" ]]; then
    step "no free portless proxy port in $PROXY_PORT_MIN-$PROXY_PORT_MAX; dev servers through portless will fail in this machine. free one with: agent-vm gc (or agent-vm rm <repo>)"
  fi
}
```

一時ファイルは `machines/.<m>.XXXXXX` に作る。`machine_rows` などの `machines/*` は、ドットで始まる名前に一致しない。そのため、書き込み途中のファイルが machine として列挙されることはない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -8`
期待:

- Step 1 のテストがすべて PASS になる。
- 既存の `newline path rejected` と `repo_path keeps '='` も PASS のままである。
- 末尾は「N run, 7 failed」で、失敗は基準の 4 種のまま。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): assign each machine its own portless proxy port"
```

### T2: VM への受け渡しと一覧（K5、K6）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm:1472-1484`（`build_launch_script`）、`:1500-1507`（`prepare_machine`）、`:1707-1714`（`machine_rows`）
- テスト: `tests/agent-vm/run.sh`（`test_launch_script_*` の近く）
- 参照: `home/dot_local/bin/executable_agent-vm:1472-1484`（env file の source → `forward_env_exports` → `exec` の順。export はこの間に入れる）
- 参照: `tests/agent-vm/run.sh:546-556`（既存の `build_launch_script` のテストの形）

- [ ] **Step 1: 失敗するテストを書く**

```bash
test_launch_script_exports_the_proxy_port_after_the_env_file() {
  local cmd
  cmd=$(PROXY_PORT=17305 build_launch_script claude /r /dev/shm/agent-vm.env.x)
  assert_contains "$cmd" "export PORTLESS_PORT=17305 PORTLESS_HTTPS=0; " "proxy port and no-TLS exported"
  local env_at port_at
  env_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "agent-vm.env.x") }')
  port_at=$(awk -v s="$cmd" 'BEGIN { print index(s, "PORTLESS_PORT") }')
  if [[ "$env_at" -gt 0 && "$port_at" -gt "$env_at" ]]; then record "PASS host port wins over the env file"; else record "FAIL host port wins over the env file ($env_at/$port_at)"; fi
}
test_launch_script_without_a_proxy_port_exports_nothing() {
  local cmd; cmd=$(PROXY_PORT="" build_launch_script claude /r "")
  assert_not_contains "$cmd" "PORTLESS" "no portless variables without an assigned port"
}
test_prepare_machine_reads_the_assigned_port() {
  # The launch path below the meta write is stubbed; only the hand-off of PROXY_PORT is under test.
  check_health() { :; }; resolve_repo_root() { echo /tmp/a; }; resolve_working_tree() { echo /tmp/wt; }
  acquire_lock() { :; }; release_lock() { :; }; check_git_surfaces() { :; }; ingest_outbox() { :; }
  build_staging() { echo "gen-1 v2:h"; }; ensure_machine() { :; }; ensure_browsers() { :; }; maybe_bootstrap() { :; }
  prepare_machine claude
  assert_eq 17300 "$PROXY_PORT" "PROXY_PORT comes from the machine record"
}
test_list_shows_the_proxy_port() {
  mkdir -p "$TMP_ROOT/repo-a"
  write_machine_meta agent-a-000000 "$TMP_ROOT/repo-a"
  assert_eq "agent-a-000000	present	$TMP_ROOT/repo-a	17300" "$(machine_rows)" "4th column is the proxy port"
}
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | grep -E 'proxy port|PORTLESS|PROXY_PORT|4th column|run,'`
期待: 4 つのテストの assert が FAIL になる。

- [ ] **Step 3: 最小実装を書く**

`build_launch_script` の env file の後、`forward_env_exports` の前に足す。

```bash
  # After the env file so the host's assignment wins over a PORTLESS_PORT the repo's env file might set.
  if [[ -n "${PROXY_PORT:-}" ]]; then script+="; export PORTLESS_PORT=$PROXY_PORT PORTLESS_HTTPS=0"; fi
  script+="; $(forward_env_exports)exec $tool"
```

`PROXY_PORT` は `valid_proxy_port` を通った数字だけなので、quote は要らない。

`prepare_machine` では、`write_machine_meta` の直後に足す。

```bash
  PROXY_PORT=$(read_meta_field "$MACHINE" proxy_port 2>/dev/null) || PROXY_PORT=""
```

`machine_rows` は 4 列目を出す。

```bash
machine_rows() { # TSV only: machine, state, repo_path, proxy_port (consumed by cmd_list and cmd_gc)
  ...
    printf '%s\t%s\t%s\t%s\n' "$m" "$(machine_state "$m")" "$(read_meta_field "$m" repo_path || true)" "$(read_meta_field "$m" proxy_port || true)"
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `bash tests/agent-vm/run.sh 2>&1 | tail -8`
期待:

- 新しいテストが PASS になる。
- 既存の `gc` のテスト、`golden is not a machine record`、`launch script` 系も PASS のままである。
- 末尾は「N run, 7 failed」。

続けて: `bash tests/agent-vm/run-shell.sh && bash scripts/lint-shell.sh`
期待: どちらも exit 0。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): hand the proxy port to VM sessions and show it in list"
```

### T3: portless の導入と Claude への指示（K7、K8）

**Files:**

- 編集: `home/dot_config/mise/config.toml:19-45`（`[tools]`）
- 編集: `home/dot_claude/CLAUDE.md:13-21`（Key Commands）
- 参照: `tests/agent-vm/run-templates.sh:24-56`（mise のファイルが plain TOML で、共有のセットに host のツールチェーンが無いことの検査）

- [ ] **Step 1: 変更**
  - `config.toml` の `"github:k1LoW/mo"` の行の前に、次を足す。

```toml
# Per-machine dev server proxy for agent-vm (docs/agent-vm.md, #207); harmless on hosts until run.
portless = "0.15.6"
```

- `CLAUDE.md` の Key Commands の `Worktree` の行の後に、次を足す。

```markdown
- **Dev server**: `PORTLESS_PORT` が設定されているとき（agent-vm）は `portless run <dev コマンド>` で起動し、表示された URL を使う。ポートを自分で選ばない
```

- [ ] **Step 2: 検査**

実行: `bash tests/agent-vm/run-templates.sh 2>&1 | tail -3`
期待: 全件 PASS（failed 0）。

実行: `python3 -c 'import tomllib,sys; print(tomllib.load(open("home/dot_config/mise/config.toml","rb"))["tools"]["portless"])'`
期待: `0.15.6`

- [ ] **Step 3: コミット**

```bash
git add home/dot_config/mise/config.toml home/dot_claude/CLAUDE.md
git commit -m "feat(mise): install portless for per-machine dev server URLs"
```

### T4: docs と ADR、成果物の保存（K9）

**Files:**

- 編集: `docs/agent-vm.md:50-52`（「VM でブラウザを使う」の箇条）、`:221-256`（mac 実機での確認項目の表）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md:85`、`:89-96`（Amended by）
- 新規: `docs/plans/agent-vm/portless/{research,spec,plan-1}.md`
- 参照: `docs/agent-vm.md:300-306`（2026-10-02 の観測。残す）

- [ ] **Step 1: docs/agent-vm.md**
  - 「人が画面を見るとき」と「同じポートの衝突」の 2 項を、次の内容に置き換える。
    - **dev server は portless で起動する。**
      - VM の中で `portless run <dev コマンド>` を実行する。例: `portless run pnpm dev`。
      - mac のブラウザで、表示された `http://<app>.localhost:<port>` を開く。
      - `<port>` は machine ごとの proxy のポートで、`agent-vm list` の 4 列目に出る。
      - linked worktree では、ブランチ名が付いて `http://<branch>.<app>.localhost:<port>` になる。
      - 名前は package.json の `name`、無ければ git の根の名前から決まる。`portless <name> <cmd>` の形はブランチ名を付けないので、worktree では使わない。
    - **portless を通さないとき。**
      - 既定の loopback bind のまま、mac の `http://localhost:<port>` で開ける。`<machine>.orb.local` は `0.0.0.0` に bind したときにしか届かない。
      - ただし、複数の machine が同じポートを使うと、`localhost` は先に bind した machine に届く。先に bind した側のサーバーを止めても、転送は後の machine に移らず、応答しなくなる（#207）。
      - portless を通せば、mac に転送されるのは machine ごとの proxy のポートだけになり、この衝突は起きない。
    - **ポートが割り当てられないとき。**
      - 17300〜17399 の枠がすべて使われていると、launcher が警告を出す。このとき portless は使えない。
      - `agent-vm gc` で、repo が無くなった machine の枠を空ける。
      - mac で同じポートを別のプログラムが使っている場合は、その machine を `agent-vm rm` で作り直す。
      - proxy が古いポートで動き続けているときは、VM の中で `portless proxy stop` を実行してから起動し直す。
  - 確認項目の表に V24〜V27 を足す。手順と期待は、下の「mac の実機での確認手順」をそのまま書く。
  - `8a6c0af` の 1 行は、上の「portless を通さないとき」に吸収する。
- [ ] **Step 2: ADR-0018**
  - Consequences の L85 の項の末尾に、次を足す。「（2026-10-04 追記）launcher が machine ごとに portless の proxy のポートを割り当て、dev server を portless 経由で開くことで避ける（`docs/plans/agent-vm/portless/spec.md`）」
  - Amended by に 1 項を足す。「`docs/plans/agent-vm/portless/spec.md`（2026-10-04、#207）: dev server のポートは、VM ごとの portless の proxy で振り分ける。launcher は machine ごとに 17300〜17399 から proxy のポートを 1 つ割り当てて meta（`proxy_port`）に記録し、`PORTLESS_PORT` と `PORTLESS_HTTPS=0` でセッションに渡す。割り当ての台帳は VM がマウントしない `machines/` に置くので、K1 の境界は変わらない。portless は host と共有の mise の設定で入る（K5 の軽量セットに 1 つ足す）」
- [ ] **Step 3: 成果物の保存**
  - `.tmp/sessions/e5bdfcdb/` の research.md、spec.md、plan-1.md を `docs/plans/agent-vm/portless/` にコピーする。
  - コピーでは、ワークフローの帳簿（`<!-- auto-review ... -->` などの marker）もそのまま残す。
- [ ] **Step 4: 検査**

実行: `npx oxfmt --check --ignore-path .oxfmtignore docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/portless home/dot_claude/CLAUDE.md`（repo の `format:check` と同じ整形器。`bun install` 済みの `node_modules` を使う）
期待: exit 0。差分が出たら `npx oxfmt` で整形してから再実行する。

- [ ] **Step 5: コミット**

```bash
git add docs/agent-vm.md docs/decisions/0018-agent-vm-orbstack.md docs/plans/agent-vm/portless/
git commit -m "docs(agent-vm): route dev servers through a per-machine portless proxy"
```

### T5: 全体の検査と PR

- [ ] **Step 1**: `bash tests/agent-vm/run.sh`、`bash tests/agent-vm/run-shell.sh`、`bash tests/agent-vm/run-templates.sh`、`bash tests/agent-vm/run-bootstrap.sh`（chezmoi があれば）、`bash scripts/lint-shell.sh` を実行する。期待: run.sh 以外は failed 0、run.sh は基準の 7 件のみ。
- [ ] **Step 2**: 自分の diff を読み直す。確かめる点は次の 3 つ。
  - bash 3.2 で使えない構文が無いこと（`((p = ...; ...))` の C 形式 for は bash 3.2 で使える）。
  - fd 6 を `exec` したまま orb を呼ぶ経路が無いこと。
  - `set -e` の下で `pick_proxy_port` の失敗が見落とされないこと。
- [ ] **Step 3**: `git push -u origin claude/serene-brahmagupta-bsiku2` で push する。PR を作り、本文に `Closes #207`、mac の実機での確認手順（V24〜V27）、この環境で実行できなかった検査を書く。

## mac の実機での確認手順（V24〜V27、docs/agent-vm.md にも書く）

前提: `chezmoi apply` の後、2 つの repo（X、Y）で `agent-vm shell` を開いておく。

- **V24（届くこと、`::1`）**
  - 操作: X で `agent-vm list` を実行し、X の 4 列目（例: 17300）を控える。X の VM で、package.json に `"name":"vx"` を持つ dir を作り、`portless run python3 -m http.server --bind 127.0.0.1 "$PORT"` を実行する。
  - 期待: mac の Chrome で `http://vx.localhost:17300/` が一覧を返す。mac で `curl -sS http://vx.localhost:17300/`（U2）と `curl -sS -H 'Host: vx.localhost' 'http://[::1]:17300/'`（R1）を試し、結果を記録する。
- **V25（machine 間で衝突しないこと）**
  - 操作: Y でも同じことを `"name":"vy"` で行う。Y の 4 列目（例: 17301）を控える。
  - 期待: 次の 3 点を満たす。
    - `http://vx.localhost:17300/` は X に、`http://vy.localhost:17301/` は Y に届く。
    - X で `portless proxy stop` を実行した後も、`http://vy.localhost:17301/` は Y に届く。
    - Y の proxy は X の停止に影響されない。
- **V26（worktree）**
  - 操作: X で `git worktree add ../x-feat -b feat/ui` を実行する。その worktree で、同じ `portless run ...` を実行する。
  - 期待: 表示された URL は `http://ui.vx.localhost:17300` で、main worktree の `http://vx.localhost:17300` と同時に、それぞれの内容を返す。
- **V27（導入）**
  - 操作: mac と VM の両方で `mise ls portless` と `portless --version` を実行する。
  - 期待: どちらも 0.15.6 である。mise が download 数の閾値で拒否した場合は、R4 の対処（`allow_low_downloads = true`）を別 PR で入れる。
  - 非 root の proxy の `~/.portless/proxy.log` に /etc/hosts の警告があっても、proxy が動き続けることを確かめる（U5）。

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: meta が 1 つも無い状態で `write_machine_meta agent-a-000000 /tmp/a` → **期待**: `proxy_port=17300`、`repo_path=/tmp/a`
- **入力**: ほかの meta が 17300 と 17302 を持つ → **期待**: 17301
- **入力**: 自分の meta が 17350 を持ち、ほかに重複なし → **期待**: 17350 のまま（17300 に移らない）
- **入力**: 自分とほかの meta が両方 17300 → **期待**: 自分は 17301、ほかは 17300 のまま
- **入力**: ほかの meta が `80` と `17300x`、自分が `17400` → **期待**: 自分は 17300（3 つとも無いものとして扱う）
- **入力**: `PROXY_PORT=17305` で `build_launch_script claude /r /dev/shm/agent-vm.env.x` → **期待**: 出力に `export PORTLESS_PORT=17305 PORTLESS_HTTPS=0; ` が含まれ、env file の source より後にある

### 互換性（共存性）

- **入力**: `write_machine_meta` の後に `read_meta_field <m> repo_path` → **期待**: 変更前と同じ値（`'='` を含むパスもそのまま）
- **入力**: meta を 1 つ書いた後の `machine_rows` → **期待**: `<m>\tpresent\t<repo>\t17300` の 1 行（`ports.lock` と一時ファイルは出ない）
- **入力**: 既存の `cmd_gc` のテスト → **期待**: PASS のまま

### 信頼性（障害許容性）

- **入力**: 17300〜17399 の 100 枠すべてを、ほかの meta が持つ → **期待**: 自分の meta は `proxy_port` なしで書かれ、stderr に `agent-vm gc` を含む警告が出て、関数は 0 で返る
- **入力**: 6 つの `write_machine_meta` を別プロセスで同時に実行する → **期待**: 6 つの meta の `proxy_port` がすべて異なる
- **入力**: `write_machine_meta` の後に、別プロセスで `acquire_port_lock 1` → **期待**: 0（lock は解放済み）

### セキュリティ（完全性）

- **入力**: env file が先、host の export が後の順の launch script → **期待**: export の位置が env file の source より後（repo の env file の `PORTLESS_PORT` は上書きされる）
- **入力**: `PROXY_PORT=""` で `build_launch_script` → **期待**: `PORTLESS` を含まない

## Approval

- Plan Status: complete
- Review Status: pending
- Approval Status: pending

## Reviewer Outputs (Round 1)

### logic-validator

- verdict:
- 主指摘:

### scope-justification-reviewer

- verdict:
- 主指摘:

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->
