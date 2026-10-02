<!-- spec-ref: spec.md -->

# Plan 2: launcher の連携（起動時の `sync`、install の通知、`agent-vm node-modules-sync`）

spec の K4、K5 と、K7 のうち `agent-vm node-modules-sync [repo]` の契約を実装する。対象は host（macOS）の launcher `home/dot_local/bin/executable_agent-vm` とそのテスト `tests/agent-vm/run.sh` である。

ヘルパー側の契約は、plan-1 の「ヘルパーの契約」の節を正本とする（plan-1 は実装済み。コミット 24b1640、0fa6628）。docs の警告表と ADR は plan-3 で扱う。

前提と決めごと:

- launcher は bash 3.2 互換を保つ（CI の macOS では `/bin/bash` で `tests/agent-vm/run.sh` を走らせる）。連想配列や `mapfile` を使わない。
- VM の中の処理は、1 回の `orb_q -m <machine> bash -lc "$NM_REMOTE_SCRIPT" _ <contract> <repo>` で行う。呼び出しが 1 回なので、起動時の遅延は orb の往復 1 回ぶんで済む。
  - VM 側のスクリプト `NM_REMOTE_SCRIPT` は、次の順に動く。
    1. ヘルパーが無ければ 90 で終わる。
    2. `--contract` が `1` でなければ 91 で終わる。このとき `sync` は呼ばない。
    3. `ran` の 1 行を出してから、`exec` でヘルパーの `sync` に置き換わる。
  - `ran` の行があれば、終了コードはヘルパー自身のもの（0〜3、64）である。無ければ、orb かシェルの失敗である（machine に届かなかった、など）。orb やシェル自身が 1 や 2 を返しても、ヘルパーの部分失敗や lock の待ち切れと取り違えない。
  - repo のパスは位置引数で渡し、スクリプトの文字列に埋め込まない（クォートの事故を避ける）。orb が引数の境界を保つことは、plan-3 の V4 で空白を含むパスを使って実機で確かめる（plan-3 への申し送り）。
  - スクリプトは関数ではなく変数に置き、テストで手元の bash に直接走らせて、90 / 91 / `ran` の振る舞いを確かめる。
- stdout のうち、launcher が読むのは `ran` の行と、`empty\t<path>` のレコードだけである。login shell の profile が stdout に何か出しても、無視される。
- VM が返した `empty` のパスは信頼しない（VM ではユーザーが sudo を持ち、agent が動いている）。host は、次をすべて満たすパスだけを使う。満たさないレコードは黙って捨てる。
  - 絶対パスで、空の要素、`.`、`..` を含まない。制御文字（ESC など）を含まない。
  - 文字列として repo のルートと等しいかその配下にある。ヘルパーは `<repo>/.git/worktree/` の外の worktree を扱わないので（plan-1 の K6）、正しいレコードは必ず repo の配下にある。
  - repo から先の各要素が symlink でない（`[[ -L ]]` で上から順に確かめる）。最後はディレクトリである。repo は VM と共有されていて、VM は repo の中に symlink を作れる。symlink を辿ると、host が automount やネットワークのパスに触れて止まりうる。正しいレコードは worktree やパッケージの実体のディレクトリで、symlink を含まない。
  - `cd` も正規化もしない。repo のルート（`nm_record_path` の第 1 引数）は、呼び出し元の `run_tool` と `cmd_node_modules_sync` がどちらも `resolve_repo_root`（`cd -P` と `pwd -P`）で得たもので、正規化済みである。`nm_record_path` 自身はそれを検査しない。symlink の無い配下のパスは、そのまま正規である。
  - 残余リスク（可用性のみ）: `-L` で辿り終えてから、`-d` と `nm_host_has_install` の glob までの間に、VM がディレクトリを symlink に差し替えると、host は差し替え先に対して stat と readdir を 1 回ずつ行う。差し替え先が応答しない `/net` や NFS なら、その 1 回の sync が止まりうる。書き込みも内容の表示もしないので、機密性と完全性には影響しない。VM の中の agent は同じユーザーの権限で動くので、受け入れる。
  - `nm_host_has_install` は、`node_modules` 自体が symlink なら install 無しとして扱い、辿らない。中の各エントリも `-L` を先に見て、symlink を辿らない。
- ヘルパーの stderr（詳しい警告）は捨て、launcher は 1 行だけ出す。起動のたびに複数行の警告が並ぶと読まれなくなるため。
  - 回復手順は `cd <repo> && agent-vm shell, then agent-vm-node-modules sync <repo>` とする。`agent-vm shell` は cwd の repo の machine に入るので、`cd` を付ける。VM の shell でヘルパーを直接実行すれば、詳しい警告が見える。
  - ヘルパーが無い / 契約が合わない（90 / 91）ときは、`agent-vm rm <repo>, then start agent-vm again in <repo>` とする。
  - `<repo>` とパスは `nm_q`（関数の中で `local LC_ALL=C` にしてから `printf %q`）でクォートする。空白や改行を含むパスでも 1 行に収まり、貼り付けて動く。`LC_ALL=C` にすると非 ASCII が `$'\343…'` の ASCII になり、`step` の `sanitize_for_terminal` が `?` に置き換えない。bash 3.2 では、組み込みの `printf` に `LC_ALL=C` を前置しても効かない（Round 3 で実機確認）ので、`local` で設定する。
- `nm_sync` は、`notice_*` と違って終了コードを返す。`agent-vm node-modules-sync` がその値を使うためである。`run_tool` では `|| true` で受ける。
- テストは既存の `tests/agent-vm/run.sh` の流儀に従う。`tests/agent-vm/stubs/orb` を使い、`STUB_ORB_STDOUT`、`STUB_ORB_EXIT`、`STUB_ORB_FAIL_ON`、`STUB_ORB_LIST_STDOUT` で VM 側の応答を作る。
- spec との差分:
  - **警告の文言**: spec K4 は、`sync` が非 0 なら一律に `node_modules is shared with the host in the VM (<理由>)` と出すとする。plan では次のように変える。
    - 3（回収の中止）では、張る処理は済んでいて共有されていない。spec K10 が「理由を区別した警告」を求めることを優先し、3 だけ次の文言にする。
      `agent-vm: kept VM-local node_modules that may be stale in <machine> (a worktree or package list could not be trusted); recover: cd <repo> && agent-vm shell, then agent-vm-node-modules sync <repo>`
    - それ以外の失敗は、`is shared` を `may be shared` にする。lock の待ち切れや orb の失敗では、前回までの mount が残っていて共有されていない可能性があるためである。
    - plan-3 の docs の警告表には、3 の行と、それ以外の行を分けて載せる（plan-3 への申し送り）。
  - **ヘルパーが無い / 契約が合わないときの判定方法**: VM 側のスクリプトが、それぞれ終了コード 90 / 91 を返して launcher に伝える。どちらの値も、ヘルパーの終了コード（0〜3、64）とは重ならない。`--contract` がヘルパーの 64（不正な保存先の根）で失敗した場合も 91 になる。launcher と worktree 用ツールは保存先の根を設定しないので、起きない。
  - **`agent-vm node-modules-sync` が黙って 0 で終わる場合**: spec K7 は「machine の記録が無い」と「machine が止まっている」の 2 つを挙げる。plan では次の 3 つを足す。どれも次の起動で収束し、起動の側（`run_tool`）では表に出るためである。
    - git の外（git が使えない repo を含む）
    - `orb list` が答えない（OrbStack が動いていない場合を含む）
    - repo の lock を、1 秒おきに 5 回試しても取れない（起動中の launcher が bootstrap でヘルパーを入れている最中かもしれない。そのとき 90 で「helper is missing; recover: agent-vm rm」と誤って警告すると、machine を消させてしまう）。`ingest_outbox` や `finish_session` のような短い保持は、試し直しのうちに終わる。

## `agent-vm node-modules-sync [repo]` の契約（plan-3 が参照する正本）

| 状況 | 終了コード | stderr | stdout |
|---|---|---|---|
| 存在しないディレクトリを渡した | 1 | `agent-vm: no such directory: <dir>` | 無し |
| git の外（git が使えない repo を含む）、machine の記録が無い、`orb list` が答えない、machine が存在しないか動いていない、repo の lock を 5 回試しても取れない | 0 | 無し | 無し |
| VM で `sync` が収束した | 0 | install の通知（K5）だけ | 無し |
| ヘルパーが動き（`ran` あり）、回収を中止した（3） | 3 | 「kept ... may be stale」の 1 行（＋ install の通知） | 無し |
| それ以外の失敗（`ran` ありのヘルパーの 1 / 2 / 64 / 未知の値、`ran` 無しの 90 / 91 / orb やシェルの失敗。`ran` 無しの 3 もここ） | VM 側の値そのまま（0 以外） | 「may be shared」の 1 行（＋ install の通知） | 無し |

- plan-3 の `git-worktree-create` は、終了コードが 0 以外なら一律に「警告が出た」と扱い、値で分岐しない。警告の文面は人間向けで、機械で読まない。
- 1 は「ディレクトリが無い」「ヘルパーの部分失敗」「orb の失敗」に使われ、3 も `ran` の有無で意味が違う。終了コードだけで原因を分類してはならない。plan-3 は区別しない。
- 実行時間: lock を待つのは最大で約 4 秒。lock を取った後は、VM 側の `sync` が終わるまで lock を持つ（orb の呼び出しに時間制限は付けない。lock を持ったまま `sync` を途中で殺さないため）。

## Files

```
# 編集
home/dot_local/bin/executable_agent-vm
tests/agent-vm/run.sh
```

## Tasks

### T1: 起動時の `sync` と install の通知（K4、K5）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`
  - `NM_CONTRACT`、`NM_REMOTE_SCRIPT`、`nm_record_path`、`nm_q`、`nm_host_has_install`、`nm_sync` を足す（`notice_gh_token_expiry` の定義の後）。
  - `run_tool` の `notice_gh_token_expiry "$MACHINE"` の次の行に、`nm_sync "$MACHINE" "$REPO" || true` を足す。
- テスト: `tests/agent-vm/run.sh`（後述「テストのコード」の T1 の節。`test_gh_notice_only_when_near_expiry_or_unknown` の後に置く）
- 参照: spec.md K4、K5。plan-1「ヘルパーの契約」（レコード、終了コード）。
- 参照: `executable_agent-vm` の `notice_gh_token_expiry`（必要なときだけ話す通知の既存モデル）、`orb_q`、`step`

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の T1 の節を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `/bin/bash tests/agent-vm/run.sh`（mac でそのまま走る）
期待: T1 の節のテストが FAIL するか、`test aborted` になる。`nm_sync` などを直接呼ぶテストは、関数が無いので `test aborted` になる。`run_tool` の順序のテストは、`nm_sync` をテストの中で定義するので、順序の不一致で FAIL する。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」の T1 の部分と、`run_tool` の 1 行を書く。

- [ ] **Step 4: テストを実行して通過を確認**

期待: `run.sh` がすべて PASS する。

既存の起動フローのテスト（`run_tool claude` を stub の orb で走らせるもの）は、`nm_sync` も通る。stub の orb の既定の応答では、`nm_sync` は黙って 0 を返す（R1 の logic-validator が、既存のテストへの影響が無い見込みであることを確認済み）。落ちたテストがあれば、そのテストの中で `nm_sync() { :; }` と上書きし、上書きしたテストの名前を実装の報告に列挙する。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): sync VM-local node_modules on every launch"
```

### T2: `agent-vm node-modules-sync [repo]`（K7 の契約）

**Files:**

- 編集: `home/dot_local/bin/executable_agent-vm`
  - `cmd_node_modules_sync` と `nm_lock_quietly` を足す（`cmd_rm` の前）。
  - `main` の `restore-git)` の前に、次の行を足す。`fetch-browsers` と同じく `|| exit $?` で受け、非 0 で ERR trap の「failed unexpectedly」が出ないようにする。

    ```bash
        node-modules-sync) shift; cmd_node_modules_sync "$@" || exit $? ;;
    ```

  - `show_help` の `agent-vm fetch-browsers` の行の後に、次の行を足す。

    ```
      agent-vm node-modules-sync [repo]  Give a running machine the VM-local node_modules of new worktrees
    ```

- テスト: `tests/agent-vm/run.sh`（後述「テストのコード」の T2 の節）
- 参照: spec.md K7（`agent-vm node-modules-sync` の契約）、この plan の「`agent-vm node-modules-sync [repo]` の契約」
- 参照: `executable_agent-vm` の `cmd_rm`（`[repo]` 引数の解決）、`orb_machine_state`、`meta_path`、`acquire_lock`（`acquire_lock <m> 1` は 1 回だけ試し、待ちのメッセージを出さずに 1 を返す）、`release_lock`

- [ ] **Step 1: 失敗するテストを書く**

「テストのコード」の T2 の節を書く。

- [ ] **Step 2: テストを実行して失敗を確認**

期待: T2 の節のテストが FAIL するか、`test aborted` になる（`cmd_node_modules_sync` が無い。help に行が無い。`main` が `unknown command` で die する）。

- [ ] **Step 3: 最小実装を書く**

「完成形のコード」の T2 の部分と、`main`、`show_help` の各 1 行を書く。

- [ ] **Step 4: テストを実行して通過を確認**

期待: `run.sh` がすべて PASS する。

- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_agent-vm tests/agent-vm/run.sh
git commit -m "feat(agent-vm): add node-modules-sync for a running machine"
```

## 完成形のコード: `home/dot_local/bin/executable_agent-vm` への追加

```bash
# [T1] Each package's node_modules inside the VM is a VM-local bind mount made by agent-vm-node-modules
# (delivered by chezmoi). The launcher only asks for a sync and reports.
NM_CONTRACT=1
# [T1] Runs in the machine with $1 = contract and $2 = repository. 90: no helper, 91: another contract.
# "ran" marks that the helper itself started, so a non-zero status without it belongs to orb or the shell.
NM_REMOTE_SCRIPT='command -v agent-vm-node-modules >/dev/null 2>&1 || exit 90
[ "$(agent-vm-node-modules --contract 2>/dev/null)" = "$1" ] || exit 91
echo ran
exec agent-vm-node-modules sync "$2"'

# [T1] repo path -> the path when it is a directory of the repository reached without a symlink. The path comes
# from the VM, which the host does not trust and which can write into the shared repository: anything relative,
# with empty, . or .. parts, holding control characters (a forged message line), outside the repository, or
# passing through a symlink (which could lead the host into an automount or a network path) is dropped. Each part
# is checked with lstat from the canonical repository down, so nothing outside it is ever touched. A real record
# is a worktree or package directory, never a symlink.
nm_record_path() {
  local cur=$1 rest part
  case "$2" in /*) ;; *) return 1 ;; esac
  case "$2/" in */./* | */../* | *//*) return 1 ;; esac
  case "$2" in *[[:cntrl:]]*) return 1 ;; esac
  [[ "$2" == "$1" || "$2" == "$1"/* ]] || return 1
  rest=${2#"$1"}
  while [[ -n "$rest" ]]; do
    rest=${rest#/}
    part=${rest%%/*}
    rest=${rest#"$part"}
    cur=$cur/$part
    if [[ -L "$cur" ]]; then return 1; fi
  done
  [[ -d "$2" ]] || return 1
  printf '%s\n' "$2"
}

# [T1] word -> the word quoted for a shell, in plain ASCII ($'\343...' for non-ASCII), so the terminal sanitizer
# leaves a recovery command intact enough to paste. bash 3.2 ignores LC_ALL=C prefixed to the printf builtin;
# only a variable set in the shell takes effect.
nm_q() {
  local LC_ALL=C
  printf '%q' "$1"
}

# [T1] dir -> 0 when the host's dir/node_modules has an entry not starting with "." (an install, not a cache).
# A node_modules that is a symlink (the VM can make one) counts as no install and is not followed; -L comes first
# so a symlinked entry is not followed either.
nm_host_has_install() {
  local e
  if [[ -L "$1/node_modules" ]]; then return 1; fi
  for e in "$1"/node_modules/*; do
    if [[ -L "$e" || -e "$e" ]]; then return 0; fi
  done
  return 1
}

# [T1] machine repo -> 0, the helper's own status, 90/91, or orb's status. Never stops anything by itself: one
# warning line on failure, and one install hint per worktree whose VM node_modules is empty while the host's is
# not (spec K4, K5). Unlike notice_*, it returns the status for `agent-vm node-modules-sync`.
nm_sync() {
  local m=$1 repo=$2 out status=0 ran=0 kind path p q reason recover
  out=$(orb_q -m "$m" bash -lc "$NM_REMOTE_SCRIPT" _ "$NM_CONTRACT" "$repo" 2>/dev/null) || status=$?
  # Only "ran" and empty records are read, so a login profile writing to stdout changes nothing.
  # Records stay valid whatever the status.
  while IFS=$'\t' read -r kind path; do
    if [[ "$kind" == ran ]]; then ran=1; continue; fi
    [[ "$kind" == empty && -n "$path" ]] || continue
    p=$(nm_record_path "$repo" "$path") || continue
    if nm_host_has_install "$p"; then
      step "node_modules in the VM is empty for $(nm_q "$p") (the host has one); recover: run the package manager's install in $(nm_q "$p") inside the VM"
    fi
  done <<<"$out"
  if [[ "$status" -eq 0 ]]; then return 0; fi
  # agent-vm shell and agent-vm (re)start act on the repository of the current directory, hence the cd
  q=$(nm_q "$repo")
  recover="cd $q && agent-vm shell, then agent-vm-node-modules sync $q"
  case "$ran:$status" in
    1:3)
      step "kept VM-local node_modules that may be stale in $m (a worktree or package list could not be trusted); recover: $recover"
      return 3
      ;;
    0:90) reason="the helper is missing"; recover="agent-vm rm $q, then start agent-vm again in $q" ;;
    0:91) reason="the helper does not speak contract $NM_CONTRACT"; recover="agent-vm rm $q, then start agent-vm again in $q" ;;
    1:1) reason="some packages could not be mounted" ;;
    1:2) reason="another sync held the lock" ;;
    1:*) reason="the helper failed: status $status" ;;
    *) reason="the sync did not run: status $status" ;;
  esac
  step "node_modules may be shared with the host in the VM ($reason); recover: $recover"
  return "$status"
}

# [T1] run_tool: the line after `notice_gh_token_expiry "$MACHINE"`
  nm_sync "$MACHINE" "$REPO" || true

# [T2] [repo]: sync a running machine now (spec K7; the contract table is in plan-2). The repository comes from git
# alone, unlike cmd_rm's record lookup: without .git there is no worktree to sync. Quiet 0 whenever the next launch
# will converge anyway.
cmd_node_modules_sync() {
  local path repo m state status=0
  path=$(cd -P -- "${1:-.}" 2>/dev/null && pwd -P) || die "no such directory: ${1:-.}"
  repo=$(cd "$path" && resolve_repo_root 2>/dev/null) || return 0
  m=$(derive_machine_name "$repo")
  [[ -f "$(meta_path "$m")" ]] || return 0
  state=$(orb_machine_state "$m" 2>/dev/null) || return 0
  [[ "$state" == running ]] || return 0
  # A launch may be bootstrapping the machine (installing the helper) under the repo lock; a missing helper reported
  # then would send the user to `agent-vm rm`. Short holders (ingest_outbox, finish_session) get a few quiet retries;
  # a bootstrap outlasts them and is skipped. The lock is then held for as long as the helper's sync takes.
  nm_lock_quietly "$m" 5 || return 0
  nm_sync "$m" "$repo" || status=$?
  release_lock
  return "$status"
}
# [T2] machine tries -> 0 once the repo lock is held; one try per second, without acquire_lock's waiting messages
nm_lock_quietly() {
  local i
  for ((i = 1; i <= $2; i++)); do
    if acquire_lock "$1" 1; then return 0; fi
    if [[ $i -lt $2 ]]; then sleep 1; fi
  done
  return 1
}
```

`# [Tn]` の行は、その部分を足すタスクの印で、実装では書かない（説明が続く行は、印だけを除く）。`run_tool` の 1 行は、既存の行の間に挿入するもので、関数として定義するものではない。

## テストのコード: `tests/agent-vm/run.sh` への追加

```bash
# --- T1 ---
nm_host_install() { mkdir -p "$1/node_modules/pkg"; } # dir: the host has an install there
nm_repo() { # a canonical repository path under TMP_ROOT (macOS /var vs /private/var)
  local r; r="$(cd -P "$TMP_ROOT" && pwd -P)/r"; mkdir -p "$r"; printf '%s' "$r"
}
nm_fake_helper() { # contract sync_status: an agent-vm-node-modules on $TMP_ROOT/vmbin that logs its sync calls
  mkdir -p "$TMP_ROOT/vmbin"
  cat >"$TMP_ROOT/vmbin/agent-vm-node-modules" <<EOF
#!/bin/sh
case "\$1" in
  --contract) printf '%s\n' '$1' ;;
  sync) echo "sync \$2" >>"$TMP_ROOT/helper.log"; printf 'mounted\t%s\n' "\$2"; exit $2 ;;
esac
EOF
  chmod +x "$TMP_ROOT/vmbin/agent-vm-node-modules"
}
test_nm_remote_script_checks_the_helper_and_its_contract() {
  local out
  assert_status 90 "no helper" -- env PATH=/usr/bin:/bin bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  nm_fake_helper 2 0
  assert_status 91 "another contract" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  if [[ -e "$TMP_ROOT/helper.log" ]]; then record "FAIL no sync under another contract"; else record "PASS no sync under another contract"; fi
  nm_fake_helper '' 0
  assert_status 91 "an empty contract" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
  nm_fake_helper 1 3
  out=$(PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r) || true
  assert_eq $'ran\nmounted\t/r' "$out" "ran, then the helper's records"
  assert_eq "sync /r" "$(cat "$TMP_ROOT/helper.log")" "sync of the given repository"
  assert_status 3 "the helper's status passes through" -- env PATH="$TMP_ROOT/vmbin:/usr/bin:/bin" bash -c "$NM_REMOTE_SCRIPT" _ 1 /r
}
test_nm_sync_is_silent_when_converged() {
  local out
  out=$(STUB_ORB_STDOUT=$'ran\nmounted\t/r' nm_sync agent-r-000000 /r 2>&1)
  assert_eq "" "$out" "nothing to say when every package is mounted"
  assert_contains "$(cat "$STUB_LOG")" "orb -m agent-r-000000 bash -lc" "runs one orb call in the machine"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 /r" "passes the contract and the repository as arguments"
}
test_nm_sync_hints_install_only_when_the_host_has_one() {
  local r out; r=$(nm_repo)
  mkdir -p "$r/node_modules/.cache"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a host node_modules with only dot entries is not an install"
  nm_host_install "$r"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "agent-vm: node_modules in the VM is empty for $r (the host has one); recover: run the package manager's install in $r inside the VM" "$out" "install hint"
  out=$(STUB_ORB_STDOUT=$'ran\nmounted\t'"$r" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "no hint once the VM has its own install"
  mkdir -p "$r/packages/a"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/packages/a" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "no hint when the host has not installed there either"
}
test_nm_sync_trusts_only_paths_inside_the_repository() {
  local r o out; r=$(nm_repo); o="$(cd -P "$TMP_ROOT" && pwd -P)/other"
  nm_host_install "$r"; nm_host_install "$o"
  ln -s "$o" "$r/link"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$o" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path outside the repository is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\tr' nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a relative path is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/../other" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path with .. is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/link" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a symlink resolving outside the repository is ignored"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/link/sub" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path passing through a symlink is ignored"
  mkdir -p "$r/real"; nm_host_install "$r/real"; ln -s "$r/real" "$r/inner"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/inner" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a symlink is ignored even when it stays inside the repository"
  mkdir -p "$r/pkg"; ln -s "$o/node_modules" "$r/pkg/node_modules"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/pkg" nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a node_modules that is a symlink is not an install"
}
test_nm_sync_drops_paths_with_control_characters() {
  local r out; r=$(nm_repo)
  nm_host_install "$r/"$'\e[31mx'
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r/"$'\e[31mx' nm_sync agent-r-000000 "$r" 2>&1)
  assert_eq "" "$out" "a path with an escape character is dropped"
}
test_nm_sync_hints_even_when_the_sync_fails() {
  local r out; r=$(nm_repo)
  nm_host_install "$r"
  out=$(STUB_ORB_STDOUT=$'ran\nempty\t'"$r" STUB_ORB_EXIT=1 nm_sync agent-r-000000 "$r" 2>&1 || true)
  assert_contains "$out" "node_modules in the VM is empty for $r" "records are read whatever the status"
  assert_contains "$out" "(some packages could not be mounted)" "and the failure is reported too"
}
test_nm_sync_warns_once_per_failure_kind() {
  local out status
  nm_try() { status=0; out=$(STUB_ORB_STDOUT="$1" STUB_ORB_EXIT="$2" nm_sync agent-r-000000 /r 2>&1) || status=$?; }
  nm_try "" 90
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (the helper is missing); recover: agent-vm rm /r, then start agent-vm again in /r" "$out" "missing helper"
  assert_eq 90 "$status" "status 90"
  nm_try "" 91
  assert_contains "$out" "(the helper does not speak contract 1); recover: agent-vm rm /r, then start agent-vm again in /r" "contract mismatch"
  assert_eq 91 "$status" "status 91"
  nm_try ran 1
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (some packages could not be mounted); recover: cd /r && agent-vm shell, then agent-vm-node-modules sync /r" "$out" "partial"
  assert_eq 1 "$status" "status 1"
  nm_try ran 2
  assert_contains "$out" "(another sync held the lock)" "lock"
  assert_eq 2 "$status" "status 2"
  nm_try ran 3
  assert_eq "agent-vm: kept VM-local node_modules that may be stale in agent-r-000000 (a worktree or package list could not be trusted); recover: cd /r && agent-vm shell, then agent-vm-node-modules sync /r" "$out" "reclaim aborted"
  assert_eq 3 "$status" "status 3"
  nm_try ran 64
  assert_contains "$out" "(the helper failed: status 64)" "the helper's usage error"
  nm_try "" 1
  assert_contains "$out" "(the sync did not run: status 1)" "orb's own 1 is not the helper's partial failure"
  assert_eq 1 "$status" "status 1 from orb"
  nm_try "" 255
  assert_contains "$out" "(the sync did not run: status 255)" "orb failure"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c .)" "exactly one line"
}
test_nm_sync_quotes_the_repository_in_the_recovery() {
  local out
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 "/a b" 2>&1 || true)
  assert_contains "$out" 'cd /a\ b && agent-vm shell, then agent-vm-node-modules sync /a\ b' "a path with a space is quoted"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 /a\\ b" "and passed as one argument"
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 $'/a\nb' 2>&1 || true)
  assert_contains "$out" "sync \$'/a\\nb'" "a newline is quoted as \$'\\n'"
  assert_eq 1 "$(printf '%s\n' "$out" | grep -c .)" "and stays on one line"
  out=$(STUB_ORB_STDOUT=ran STUB_ORB_EXIT=1 nm_sync agent-r-000000 "/$(printf '\343\201\202')" 2>&1 || true)
  assert_contains "$out" "sync \$'/\\343\\201\\202'" "non-ASCII is quoted in plain ASCII, so the sanitizer keeps it"
}
test_run_tool_syncs_after_the_notices_and_goes_on_when_it_fails() {
  local order="$TMP_ROOT/order"
  prepare_machine() { MACHINE=agent-r-000000 REPO=/r; }
  notice_orphan_env() { :; }
  notice_gh_token_expiry() { echo gh >>"$order"; }
  nm_sync() { echo "nm $1 $2" >>"$order"; return 1; }
  inject_secrets() { :; }
  build_launch_script() { :; }
  finish_session() { :; }
  session_exec() { echo session >>"$order"; }
  host_reason() { :; }
  assert_status 0 "a failing sync does not stop the launch" -- run_tool claude
  assert_eq $'gh\nnm agent-r-000000 /r\nsession' "$(cat "$order")" "sync runs after the notices and before the session"
}

# --- T2 ---
nm_record_machine() { # repo: write the host record of its machine; prints the machine name
  local m; m=$(derive_machine_name "$1")
  write_machine_meta "$m" "$1"; printf '%s' "$m"
}
nm_hold_lock() { # machine secs: a background process holding the repo lock; it creates $TMP_ROOT/held once it has it
  perl -MFcntl=:flock -e 'open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $h, ">", $ARGV[1]) or die; close $h; sleep $ARGV[2]' \
    "$AGENT_VM_STATE_DIR/machines/$1.lock" "$TMP_ROOT/held" "$2" &
}
nm_wait_for_holder() { # waits up to 10 s for nm_hold_lock's marker, so the test never races the holder
  local i
  for ((i = 0; i < 100; i++)); do
    if [[ -e "$TMP_ROOT/held" ]]; then return 0; fi
    sleep 0.1
  done
  record "FAIL the lock holder did not start"
}
nm_git_repo() { # a canonical git repository with one commit
  local r; r=$(nm_repo); git -C "$r" init -q
  git -C "$r" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init
  printf '%s' "$r"
}
test_node_modules_sync_is_silent_without_a_machine_record() {
  local r; r=$(nm_git_repo)
  assert_eq "" "$(cmd_node_modules_sync "$r" 2>&1)" "no output for a repository agent-vm never ran in"
  assert_status 0 "exit 0" -- cmd_node_modules_sync "$r"
  assert_not_contains "$(cat "$STUB_LOG")" "orb" "orb is not called"
}
test_node_modules_sync_is_silent_outside_git() {
  mkdir -p "$TMP_ROOT/plain"
  assert_eq "" "$(GIT_CEILING_DIRECTORIES="$TMP_ROOT" cmd_node_modules_sync "$TMP_ROOT/plain" 2>&1)" "no output outside git"
  assert_status 0 "exit 0" -- env GIT_CEILING_DIRECTORIES="$TMP_ROOT" bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$TMP_ROOT/plain"
}
test_node_modules_sync_fails_for_a_missing_directory() {
  local out status=0
  out=$(bash "$LAUNCHER" node-modules-sync "$TMP_ROOT/none" 2>&1) || status=$?
  assert_eq 1 "$status" "exit 1"
  assert_contains "$out" "no such directory: $TMP_ROOT/none" "says which directory"
}
test_node_modules_sync_skips_a_stopped_machine() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m stopped" cmd_node_modules_sync "$r" 2>&1)" "no output for a stopped machine"
  assert_status 0 "exit 0" -- env STUB_ORB_LIST_STDOUT="$m stopped" bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
  assert_not_contains "$(cat "$STUB_LOG")" "orb -m $m" "the stopped machine is not started"
}
test_node_modules_sync_is_silent_when_orb_cannot_list() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  assert_eq "" "$(STUB_ORB_FAIL_ON=list cmd_node_modules_sync "$r" 2>&1)" "no output when orb list fails"
  assert_status 0 "exit 0" -- env STUB_ORB_FAIL_ON=list bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
}
test_node_modules_sync_skips_while_a_launch_holds_the_lock() {
  local r m holder; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  # The holder outlives the five quiet tries (about 4 s); the test kills it afterwards
  nm_hold_lock "$m" 30
  holder=$!
  nm_wait_for_holder
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_EXIT=90 cmd_node_modules_sync "$r" 2>&1)" "no missing-helper warning during a bootstrap"
  assert_not_contains "$(cat "$STUB_LOG")" "orb -m $m" "the sync is not attempted"
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
}
test_node_modules_sync_waits_out_a_short_lock_holder() {
  local r m holder; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  # A one-second holder (like ingest_outbox) ends well within the five quiet tries
  nm_hold_lock "$m" 1
  holder=$!
  nm_wait_for_holder
  assert_eq "" "$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran cmd_node_modules_sync "$r" 2>&1)" "no waiting messages"
  assert_contains "$(cat "$STUB_LOG")" "orb -m $m bash -lc" "the sync runs once the holder is gone"
  wait "$holder" 2>/dev/null || true
}
test_node_modules_sync_runs_in_a_running_machine() {
  local r m; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  assert_status 0 "converged" -- env STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran bash -c 'AGENT_VM_LIB=1 . "$1"; cmd_node_modules_sync "$2"' _ "$LAUNCHER" "$r"
  assert_contains "$(cat "$STUB_LOG")" "orb -m $m bash -lc" "the sync runs in the machine"
  assert_contains "$(cat "$STUB_LOG")" "_ 1 $r" "for this repository"
}
test_node_modules_sync_fails_with_one_warning_and_no_crash_report() {
  local r m out status=0; r=$(nm_git_repo); m=$(nm_record_machine "$r")
  out=$(STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_FAIL_ON=agent-vm-node-modules bash "$LAUNCHER" node-modules-sync "$r" 2>&1) || status=$?
  assert_eq 9 "$status" "the VM-side status"
  assert_eq "agent-vm: node_modules may be shared with the host in the VM (the sync did not run: status 9); recover: cd $r && agent-vm shell, then agent-vm-node-modules sync $r" "$out" "one warning line"
  assert_not_contains "$out" "failed unexpectedly" "no ERR trap report"
}
test_node_modules_sync_resolves_a_worktree_to_its_repository() {
  local r m; r=$(nm_git_repo)
  git -C "$r" worktree add -q "$r/.git/worktree/feat" -b feat
  m=$(nm_record_machine "$r")
  STUB_ORB_LIST_STDOUT="$m running" STUB_ORB_STDOUT=ran cmd_node_modules_sync "$r/.git/worktree/feat" 2>/dev/null
  assert_contains "$(cat "$STUB_LOG")" "_ 1 $r" "the main repository is synced"
}
test_main_dispatches_node_modules_sync() {
  cmd_node_modules_sync() { echo "nms $*"; }
  assert_eq "nms /r" "$(main node-modules-sync /r)" "main reaches cmd_node_modules_sync"
}
test_help_lists_node_modules_sync() {
  assert_contains "$(main --help)" "agent-vm node-modules-sync [repo]" "help lists node-modules-sync"
}
```

テストの補足:

- `assert_status` は、渡したコマンドを今のシェルで実行する。環境変数を付けて関数を呼ぶには、launcher を source し直す `bash -c` を使う（`env` は関数を呼べないため）。
- stub の orb は、`STUB_ORB_FAIL_ON` を含む呼び出しで 9 を返す（`orb list` も含む）。`STUB_ORB_FAIL_ON` が無ければ、`orb list` は `STUB_ORB_LIST_STDOUT` を返し、`STUB_ORB_EXIT` の影響を受けない。
- `STUB_LOG` には、orb の引数が `printf %q` で記録される。空白を含むパスは `/a\ b` と記録される。
- `nm_fake_helper` は heredoc の中で、`$1` と `$2`（関数の引数）だけを展開し、`\$1` と `\$2`（偽のヘルパー自身の引数）は展開しない。
- `test_nm_sync_drops_paths_with_control_characters` は、ESC を含むディレクトリ名を作る。macOS（APFS）と Linux のどちらでも作れる。VM が返す行は `read` が改行で区切るので、パスに改行は入らない。symlink を辿らないので、正規化で改行が入ることもない。
- lock の 2 つのテストは、holder の寿命で結果が決まる。30 秒の holder は 5 回の試行（約 4 秒）より長く、1 秒の holder は十分に短い。holder は lock を取った後に `$TMP_ROOT/held` を作り、テストはそれを待ってから始める（`sleep` の長さで待ち合わせない）。

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: VM 側のスクリプトを、ヘルパーの有無と契約の値を変えて手元で実行する。
  - **期待**: ヘルパーが無ければ 90。契約が `2` か空なら 91 で、`sync` は呼ばれない。契約が `1` なら `ran` の後にレコードが出て、ヘルパーの終了コード（3）がそのまま返る。
  - テスト: `test_nm_remote_script_checks_the_helper_and_its_contract`
- **入力**: VM が `ran` と `mounted\t/r` を返し、終了コード 0 → **期待**: 出力なし。orb の呼び出しは 1 回で、契約 `1` と repo を位置引数で渡す（`test_nm_sync_is_silent_when_converged`）。
- **入力**: VM が `empty\t<r>` を返し、host の `<r>/node_modules` に `pkg` がある → **期待**: install を促す 1 行（`test_nm_sync_hints_install_only_when_the_host_has_one`）。
- **入力**: `run_tool claude` → **期待**: 通知（gh）、`nm_sync`、セッションの順に呼ばれる（`test_run_tool_syncs_after_the_notices_and_goes_on_when_it_fails`）。
- **入力**: 動いている machine の repo で `node-modules-sync` → **期待**: 終了コード 0、VM で `sync` を実行する（`test_node_modules_sync_runs_in_a_running_machine`）。worktree のパスを渡しても、メインの repo を同期する（`test_node_modules_sync_resolves_a_worktree_to_its_repository`）。
- **入力**: `main node-modules-sync /r`、`agent-vm --help` → **期待**: `cmd_node_modules_sync` に届く。help に行がある（`test_main_dispatches_node_modules_sync`、`test_help_lists_node_modules_sync`）。

### 信頼性（障害許容性）

- **入力**: VM 側の結果が次のとき（`ran` の有無と終了コードの組）。
  - `ran` 無しで 90 / 91 / 1 / 255、`ran` 有りで 1 / 2 / 3 / 64
  - **期待**: どれも 1 行だけの警告で、理由と回復手順が組に応じて変わる。戻り値は VM 側の値のまま。
  - **期待**: `ran` の無い 1 は「the sync did not run」と書き、ヘルパーの部分失敗と取り違えない。3 は「共有」と書かない。
  - テスト: `test_nm_sync_warns_once_per_failure_kind`
- **入力**: `nm_sync` が 1 を返す状態で `run_tool claude` → **期待**: 起動は止まらず、セッションまで進む（`test_run_tool_syncs_after_the_notices_and_goes_on_when_it_fails`）。
- **入力**: VM が `empty` を返し、終了コード 1 → **期待**: install の通知と失敗の警告の両方が出る（`test_nm_sync_hints_even_when_the_sync_fails`）。
- **入力**: 次の場合に `node-modules-sync` を実行する。
  - machine の記録が無い repo
  - git の外のディレクトリ
  - 止まっている machine
  - `orb list` が失敗する
  - 別のプロセスが repo の lock を持っている
  - **期待**: どれも出力なし、終了コード 0。止まっている machine は起動せず、lock を持たれている間は VM に問い合わせない。
  - テスト: `test_node_modules_sync_is_silent_without_a_machine_record`、`test_node_modules_sync_is_silent_outside_git`、`test_node_modules_sync_skips_a_stopped_machine`、`test_node_modules_sync_is_silent_when_orb_cannot_list`、`test_node_modules_sync_skips_while_a_launch_holds_the_lock`
- **入力**: 1 秒だけ lock を持つプロセスがいる間に `node-modules-sync` → **期待**: 待ちのメッセージを出さず、holder が離した後に VM で `sync` を実行する（`test_node_modules_sync_waits_out_a_short_lock_holder`）。
- **入力**: 動いている machine で VM 側の呼び出しが失敗（stub が 9）し、launcher を丸ごと実行する → **期待**: 終了コード 9。警告は 1 行だけで、ERR trap の「failed unexpectedly」は出ない（`test_node_modules_sync_fails_with_one_warning_and_no_crash_report`）。
- **入力**: 存在しないディレクトリ → **期待**: 終了コード 1 と `no such directory`（`test_node_modules_sync_fails_for_a_missing_directory`）。

### セキュリティ（完全性）

- **入力**: VM が `empty` で、次のパスを返す。どれも host に install 済みの `node_modules` を持つ。
  - repo の外の絶対パス
  - 相対パス
  - `..` を含むパス
  - repo の外を指す symlink
  - repo の中の symlink を通るパス、repo の中を指す symlink、`node_modules` が repo の外への symlink であるパッケージ
  - **期待**: どれも通知を出さない（`test_nm_sync_trusts_only_paths_inside_the_repository`）。
- **入力**: ESC を含むパス → **期待**: 通知を出さない（`test_nm_sync_drops_paths_with_control_characters`）。
- **入力**: 改行や非 ASCII を含む repo のパスで失敗 → **期待**: 回復手順は `$'…'` の形の 1 行で、非 ASCII も `?` に化けない（`test_nm_sync_quotes_the_repository_in_the_recovery`）。

### 使用性（誤り防止）

- **入力**: host の `node_modules` に `.cache` だけ、host にも VM にも install が無い、VM に install がある → **期待**: どれも通知なし（`test_nm_sync_hints_install_only_when_the_host_has_one`）。正常な状態では通知しない（規約）。
- **入力**: 空白を含む repo のパスで失敗 → **期待**: 回復手順のパスがクォートされ、orb には 1 つの引数として渡る（`test_nm_sync_quotes_the_repository_in_the_recovery`）。

### 互換性（共存性）

- 既存の `run.sh` のテストは、すべて PASS したままである（T1 Step 4）。
- **対象外**: VM 側の実際の `sync` の挙動（plan-1 の統合テストで確かめ済み）。launcher と VM をつないだ実機の確認は、plan-3 の手動検証（V4。空白を含むパスでの引数の境界を含む）で行う。

## Round 1 からの変更

- VM 側のスクリプトを `NM_REMOTE_SCRIPT` に切り出し、`ran` の印を出すようにした。`ran` の無い非 0 は、orb かシェルの失敗として扱う。手元でスクリプトを実行するテストを足した。
- VM が返したパスを、絶対パスで `.` と `..` を含まず、正規化して repo の配下にあるものだけに限った。テストを足した（repo の外、相対パス、`..`、symlink、ESC）。
- `agent-vm node-modules-sync` を次のように変えた。
  - `orb list` の失敗と、repo の lock を取れない場合は、黙って 0 にした。lock を見るのは、bootstrap 中の誤警告を避けるためである。
  - `main` は `|| exit $?` で受け、ERR trap の行を出さないようにした。
  - 契約を表にした。
- 回復手順を `agent-vm shell, then agent-vm-node-modules sync <repo>` とし、パスを `printf %q` でクォートした。
- 警告の文言を変えた。
  - 3 以外は `may be shared` にした。
  - 理由の括弧を入れ子にしない（`the sync did not run: status N`）。
- 足したテスト: 戻り値の確認、`main` の配線、存在しないディレクトリ、`commit.gpgsign=false`、`GIT_CEILING_DIRECTORIES`。
- T1 Step 2 の期待を直した。

## Round 2 からの変更

- `nm_record_path`: repo の配下かを文字列で確かめてから `cd` する。正規化した後のパスに制御文字があれば捨てる（security）。
- `nm_q`（`LC_ALL=C printf %q`）を足し、通知のパスと回復手順をクォートする。改行は `$'\n'` になって 1 行に収まり、非 ASCII は ASCII の `$'\343…'` になる（security）。
- 回復手順に `cd <repo> &&` を付けた。90 / 91 の回復手順にも repo を入れた（architecture）。
- `node-modules-sync` の lock は、`nm_lock_quietly` で 1 秒おきに 5 回まで黙って試す。短い保持では諦めない（architecture）。lock を持つ時間が `sync` に依存することを契約に書いた。
- 契約表: `ran` 無しの 3 は「それ以外」の行、machine が存在しない場合、git が使えない repo を明記した（data-contract）。
- テスト: 制御文字（ESC、symlink の先の改行）、`cd` の前の検査、`$'…'` のクォート、短い lock の待ち。lock を持つテストの holder を 30 秒にし、待ち時間への依存を補足に書いた（logic）。

## Round 3 からの変更

- `nm_q` を `local LC_ALL=C` の形にした。bash 3.2 では前置の `LC_ALL=C` が組み込みの `printf` に効かない（logic、security が実機で確認）。
- `nm_record_path` は `cd -P` をやめ、repo から先の各要素が symlink でないことを `-L` で確かめる。repo の中の symlink を通って repo の外に触れる経路を閉じた（security）。制御文字の検査は、VM が返したパスの文字列に対して行う。
- `nm_host_has_install` は、`node_modules` 自体の symlink を install 無しとし、エントリも `-L` を先に見る（security）。
- テスト: symlink を通るパス、repo の中の symlink、`node_modules` の symlink を足した。`cd` を包むテストは、`cd` を使わなくなったので外した。lock のテストは、holder が作る印のファイルで待ち合わせる（logic）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: `main` の `node-modules-sync)` が非 0 を返すと、ERR trap が「failed unexpectedly」の行を足す（`|| exit $?` の形にする）。軽微な指摘は 3 つある。
  - テストの commit に `commit.gpgsign=false` が無い。
  - git の外のテストに `GIT_CEILING_DIRECTORIES` が無い。
  - T1 Step 2 の期待が不正確である。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: VM 側のスクリプト（90 / 91 の判定、契約が合わないときに `sync` を呼ばないこと）が一度も実行されない。足りないテストは 2 つある。
  - `main` から `node-modules-sync` への配線
  - 2 / 3 / 90 の戻り値

### architecture-boundary-analyzer
- verdict: needs-work
- 主指摘: 3 点ある。
  - `orb list` の失敗で `node-modules-sync` ごと die する。
  - repo の lock を取らないので、bootstrap と並走したときに「helper is missing; recover: agent-vm rm」という誤警告を出す。
  - 回復手順が、詳細を見られない `agent-vm shell` を指している。パスをクォートしていない。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: VM が返した `empty` のパスを検査しないまま、host のファイルシステムを調べてメッセージに出している。repo の配下に限るべきである。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 3 点ある。
  - orb 自身の失敗（1 など）を、ヘルパーの 1 と取り違える（`ran` の印で区別する）。
  - `node-modules-sync` の契約（`orb list` の失敗やディレクトリが無い場合を含む）が、表になっていない。
  - 2 と未知の値で「共有」と断定している。理由の括弧が入れ子になっている。

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: plan のコードとテストをコピーに貼り込み、/bin/bash 3.2.57 で run.sh を実行した。T1 と T2 のテストはすべて PASS した。軽微な指摘は 2 つ。
  - lock を持つテストが `sleep 1` の待ちに依存している。
  - help の桁を揃える。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 の指摘はすべて解消した。spec からの差分は、spec の意図の範囲内である。軽微な指摘として、承認を依頼するときの要約に、K4 / K7 を拡張したことを明記する。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 軽微な指摘は 4 つ。
  - lock を持つ時間が orb に依存する。
  - lock の 1 回だけの試行が、短い lock 保持とぶつかる（黙って何度か試し直す）。
  - 回復手順が cwd に依存する（`cd <repo> &&` を付ける）。
  - `$'..'` の形のパスのテストが無い。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 2 点ある。
  - 正規化した後のパスに改行が入ると、偽の行を出せる（制御文字を捨て、`%q` でクォートする）。
  - repo の配下かを文字列で確かめる前に、VM が選んだパスへ `cd` している（automount などで host が止まる）。
  - 軽微な指摘として、`%q` の非 ASCII が `?` に化ける（`LC_ALL=C`）。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: 契約表の文言を 3 か所補う。
  - `ran` の無い 3 は「それ以外」の文面になる。
  - machine が存在しない場合も含める。
  - git が使えない repo も含める。

<!-- auto-review: verdict=needs-work; hash=4ceed7b7f76f4beecb956f51366d9a9163e3daf5f7d1c26b30ff84d15e10e563; design-hash=cfc9f67acf1797ffda49af74b077f44a8ed11e6f216cc267a4f4fad8b29608a5; round=1; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T05:17:35.705Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=22; excluded=0; at=2026-10-02T05:17:35.735Z -->

## Reviewer Outputs (Round 3)

### logic-validator
- verdict: needs-work
- 主指摘: /bin/bash 3.2 で run.sh を通した結果、681 run で失敗は 2。plan 由来の失敗は 1 つで、非 ASCII のクォート。bash 3.2 では組み込みの `printf` に `LC_ALL=C` を前置しても効かない。`local LC_ALL=C` にすれば効く。
  - もう 1 つの失敗は、作業コピーに bootstrap.sh が無いための偽陽性。
  - 軽微な指摘は 2 つある。`cd` のログに陽性対照が無い。lock のテストが `sleep 1` で待ち合わせている（2 秒の holder では余裕が約 1 秒しかない）。

### security-vulnerability-analyzer
- verdict: needs-work
- 主指摘: 2 点ある。
  - `LC_ALL=C` の前置が効かず、非 ASCII が `?` に化ける（実機で確認）。
  - 文字列での検査を通った後、repo の中の symlink を通って `cd -P` が repo の外（`/net` など）に入る。`node_modules` 自体の symlink も `nm_host_has_install` が辿る。cd の前に、各要素と `node_modules` が symlink でないことを確かめる。

### scope-justification-reviewer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=ec0feda1afd6f7975180516229443b9beb2b6ee0d887fbf77dc6d60f89cb074b; design-hash=a78839ff4da800aaf5385db1ffe535f2ac75cb99d697bc81c37903670de56c63; round=2; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T05:26:01.089Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=13; excluded=0; at=2026-10-02T05:26:01.110Z -->

## Reviewer Outputs (Round 4)

### logic-validator
- verdict: pass
- 主指摘: plan のコードとテストを作業コピーに貼り込み、/bin/bash 3.2 で run.sh を通した結果は 682 run, 0 failed。Round 3 の指摘はすべて解消した。軽微な指摘として、30 秒の holder は 10 秒程度に短くしてよい。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: Round 3 の 3 点は解消した。軽微な指摘は 2 つある。
  - 差し替えの競合（TOCTOU）が残る。影響は可用性だけで、Risks に書けば足りる（反映済み）。
  - repo のルートが正規化済みであることを前提として明記する（反映済み）。

### scope-justification-reviewer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator
- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=da6c6393aabb54598b9cb9533364ec43dd0976989f5578eea010324d88abe4af; design-hash=96cad22c31abe190620a916b6b24d3b290f2dcbc4e3b0a201beb3e560874907d; round=3; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T05:33:02.398Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=5; excluded=0; at=2026-10-02T05:33:02.418Z -->

<!-- auto-review: verdict=pass; hash=0a0a4204bbea295ec93d0095cf8efc3660e3a67bda94a3f3911e379f4b904272; design-hash=96cad22c31abe190620a916b6b24d3b290f2dcbc4e3b0a201beb3e560874907d; round=4; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T05:38:50.351Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-02T05:38:50.372Z -->
