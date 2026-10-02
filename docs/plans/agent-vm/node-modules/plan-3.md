<!-- spec-ref: spec.md -->

# Plan 3: worktree 用ツールの連携、docs、ADR、手動検証（K7、K8、V3〜V6）

spec の K7 のうち `git-worktree-create` と `git-worktree-cleanup` の連携、K8（ADR-0022 と ADR-0018 の `Amended by`）、docs、手動検証 V3〜V6 を扱う。

正本:

- ヘルパーの契約: plan-1「ヘルパーの契約」（実装済み。コミット 24b1640、0fa6628）。
- `agent-vm node-modules-sync [repo]` の契約: plan-2「`agent-vm node-modules-sync [repo]` の契約」（実装済み。コミット d20f800、2b9652b）。

前提と決めごと:

- **VM かどうかの判定**: 2 つのツールは `${AGENT_VM_MARKER:-/etc/agent-vm}` があるときだけ VM 側の連携をする。`AGENT_VM_MARKER` は bootstrap（`agent-vm/bootstrap.sh:34`）と golden-seal（`agent-vm/golden-seal.sh:8`）が既に使っている上書き口で、テストが VM を装うために使う。上書きしても、変わるのはヘルパーを呼ぶかどうかだけで、同じユーザーが自分で実行できること以上はできない。
- **VM の連携の条件**: 印があり、かつ `agent-vm-node-modules` が PATH にある（spec K7）。印があってもヘルパーが無ければ、今までどおり動く（bootstrap が途中で失敗した machine）。
- **host の連携の条件**: 印が無く、`agent-vm` が PATH にある。VM では launcher を配らないので（`.chezmoiignore` の host ブロック）、VM で `agent-vm` を呼ぶことは無い。印を先に見るので、両方があっても VM 側だけを使う。
- **既存テストを密閉する**: VM の中で開発者がテストを走らせると、本物の `/etc/agent-vm` とヘルパーで、TMP の fixture に mount しようとする。2 つのテストファイルは、冒頭で `AGENT_VM_MARKER` を存在しないパスに export し、VM を装うテストだけが上書きする。
- **`git-worktree-create`**:
  - VM: `git worktree add` が成功した後に `agent-vm-node-modules attach <worktree>` を実行する。stdout（レコード）は捨て、stderr（詳しい警告）は通す。0 以外なら、1 行の警告と回復手順を出す。作成は失敗にしない（終了コード 0 のまま）。
  - host: `agent-vm node-modules-sync <repo_root>` を実行する。stdout と stderr は通す（plan-2 の契約で、stdout には何も出ない。0 以外のときは、launcher が理由と回復手順の 1 行を stderr に出している）。0 以外なら、create が文脈の 1 行を足す。値で分岐しない（plan-2 の契約表の注記）。
  - `git worktree add` が失敗すると、`set -e` でその場で終わり、どちらも呼ばない。
  - 警告の書式（どちらも stderr、黄色）:
    - VM: `⚠️  node_modules of <wt> may be shared with the host (agent-vm-node-modules attach: status <n>); do not install there until this succeeds: agent-vm-node-modules attach <%q wt>`
    - host: `⚠️  the running agent-vm machine may not have VM-local node_modules for <wt> yet (agent-vm node-modules-sync: status <n>); the next agent-vm launch syncs it`
    - VM の警告に「install しない」と書くのは、mount の無いまま VM で install すると、host の worktree に linux 用のパッケージが入るためである（spec R1 と同じ害）。
- **`git-worktree-cleanup`**:
  - ヘルパーを通すのは、VM の連携の条件が成り立ち、かつ worktree の実パスが `<main の実パス>/.git/worktree/` の配下にある場合だけである。ヘルパーは `.git/worktree` の外の worktree を扱わず（plan-1 の K6、`resolve_worktree`）、そこには mount が無い。外の worktree（引数で名指ししたときだけ消す）は、今までどおり git を直接呼ぶ。
  - ヘルパーを通すときは、`agent-vm-node-modules remove <wt> -- git -C <main> worktree remove -- <wt>` を実行する（spec K7 のコマンドライン。契約テストで固定する）。
  - stdout と stderr は、今までどおり `err=$(... 2>&1)` で受けて、残すときの理由に出す（plan-1 の申し送り「remove の出力は捨てない」）。
  - 終了コードの扱い（ヘルパーを通したときだけ 64 / 70 / 71 を読む。git は 0 / 1 / 128 しか返さない）:

    | 終了コード | 表示 | worktree |
    |---|---|---|
    | 0 | `✓ Removing worktree: <wt>`（今までどおり） | 消える |
    | 64 | `✗ the node_modules helper refused it: <出力> - skipping` | 残す |
    | 70 | `✗ could not detach its VM-local node_modules: <出力> - skipping` | 残す |
    | 71 | `✗ another node_modules sync held the lock (try again): <出力> - skipping` | 残す |
    | それ以外 | `✗ git refused to remove it: <出力> - skipping`（今までどおり） | 残す |

  - **64 の扱い（plan-1 の申し送り）**: worktree を残し、git を直接は呼ばない。64 は、ヘルパーがその worktree を正規の worktree と認めなかったことを表す（解決できない、一覧に無い、メイン）。cleanup は `.git/worktree` の外とメインを渡さないので、通常は起きない。起きたときに git を直接呼ぶと、VM ローカルの中身を消してから mountpoint の削除で失敗しうる（spec R1）。残しておけば、次の `sync` と人の確認に回せる。
  - どの非 0 も、今までどおり `kept` に数える。引数で名指しした worktree が残れば、終了コード 2 になる（既存の契約）。
  - host では挙動を変えない（spec K7）。

## Files

```
# 編集
home/dot_local/bin/executable_git-worktree-create
home/dot_local/bin/executable_git-worktree-cleanup
tests/git-worktree-cleanup/run.sh
.github/workflows/ci-git-worktree-cleanup.yml
docs/commands/git-worktree-create.md
docs/commands/git-worktree-cleanup.md
docs/agent-vm.md
docs/decisions/0018-agent-vm-orbstack.md
home/dot_local/bin/executable_agent-vm-node-modules
home/.chezmoiignore
# 新規
tests/git-worktree-create/run.sh
docs/decisions/0022-agent-vm-node-modules.md
docs/plans/agent-vm/node-modules/spec.md
docs/plans/agent-vm/node-modules/research.md
docs/plans/agent-vm/node-modules/plan-1.md
docs/plans/agent-vm/node-modules/plan-2.md
docs/plans/agent-vm/node-modules/plan-3.md
```

spec の Files との差分:

- `docs/commands/git-worktree-create.md` と `docs/commands/git-worktree-cleanup.md` を足す。ツールの挙動の説明書で、VM での振る舞いと cleanup の終了コード 2 の意味が変わるため。
- `docs/plans/agent-vm/node-modules/` を足す。ADR-0022 が設計の全文として参照する。session の成果物（`.tmp/sessions/`）は 7 日で GC され、commit した docs は tracked のファイルにしか link できないため。既存の `docs/plans/agent-vm/golden-clone/` と同じ置き方である。
- spec の Files にある `.github/workflows/ci-agent-vm.yml` は、plan-1 で変更済みである（ヘルパーのテストの実行）。plan-3 では変えない。
- `ci-git-worktree-cleanup.yml` の paths には、create が既に入っている（spec の「paths に create を足す」は満たされている）。足すのは、create のテストの実行と、`tests/git-worktree-create/**` の paths である。

## Tasks

### T1: `git-worktree-create` の連携（K7）

**Files:**

- 編集: `home/dot_local/bin/executable_git-worktree-create`
  - `say_warn` を、`show_help` の定義の後に足す。
  - 「完成形のコード」の連携の節を、`echo -e "${GREEN}✓ Worktree created: ...` の行の次、`💡 To switch` の行の前に足す。
- 新規: `tests/git-worktree-create/run.sh`（「テストのコード」の T1）
- 編集: `.github/workflows/ci-git-worktree-cleanup.yml`
  - `on.push.paths` と `on.pull_request.paths` に `"tests/git-worktree-create/**"` を足す。
  - `Run git-worktree-cleanup tests` の step の後に、次の step を足す。

    ```yaml
          - name: Run git-worktree-create tests
            run: /bin/bash tests/git-worktree-create/run.sh
    ```

- 編集: `docs/commands/git-worktree-create.md`（「docs の文面」の T1）
- 参照: plan-1「ヘルパーの契約」（`attach` の終了コードとレコード）、plan-2「`agent-vm node-modules-sync [repo]` の契約」
- 参照: `tests/git-worktree-cleanup/run.sh`（fixture、assert、runner の既存の形。T1 のテストファイルはこれに合わせる）

- [ ] **Step 1: 失敗するテストを書く** — 「テストのコード」の T1 を `tests/git-worktree-create/run.sh` として作る。
- [ ] **Step 2: テストを実行して失敗を確認** — 実行: `/bin/bash tests/git-worktree-create/run.sh`。期待: `test_C1_vm_attaches_the_new_worktree`、`test_C2_vm_attach_failure_warns_and_keeps_the_worktree`、`test_C5_host_asks_a_running_machine_to_sync`、`test_C6_host_sync_failure_adds_one_warning`、`test_C8_paths_with_a_space_stay_one_argument` が FAIL する（呼び出しのログが無い、警告が無い）。`test_C3`、`test_C4`、`test_C7` は今の実装でも PASS する（呼ばないことを確かめるテスト）。呼び出しのログが無いテストでは、`cat` の「No such file」が stderr に出るが、結果には影響しない（Round 1 の logic-validator の実測で、赤は 18 PASS / 8 FAIL）。
- [ ] **Step 3: 最小実装を書く** — 「完成形のコード」の T1 を足す。CI と docs の変更を足す。
- [ ] **Step 4: テストを実行して通過を確認** — 期待: `tests/git-worktree-create/run.sh` が全 PASS。`/bin/bash tests/git-worktree-cleanup/run.sh` も全 PASS のまま（`wt` が create を使うため）。
- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_git-worktree-create tests/git-worktree-create/run.sh .github/workflows/ci-git-worktree-cleanup.yml docs/commands/git-worktree-create.md
git commit -F <message file>   # feat(git-worktree): give a new worktree its VM-local node_modules under agent-vm
```

### T2: `git-worktree-cleanup` の連携（K7）

**Files:**

- 編集: `home/dot_local/bin/executable_git-worktree-cleanup`
  - `nm_helper` と `remove_worktree` を、`main_phys=${wt_phys[0]}` の行の後に足す。
  - メインループの `git -C "$main_worktree" worktree remove` の `if` を、「完成形のコード」の T2 の形に置き換える。
  - `show_help` の終了コード 2 の説明の 2 行を、「完成形のコード」の T2 の 3 行に置き換える。
- 編集: `tests/git-worktree-cleanup/run.sh`
  - `export GIT_CEILING_DIRECTORIES=...` の行の次に、`export AGENT_VM_MARKER="$TMP_BASE/no-agent-vm"` と、その理由のコメント 1 行を足す。
  - 「テストのコード」の T2 を、`# ---- 使用性 ----` の節の前に足す。
- 編集: `docs/commands/git-worktree-cleanup.md`（「docs の文面」の T2）
- 参照: plan-1「ヘルパーの契約」（`remove` の 64 / 70 / 71、出力を通すこと）

- [ ] **Step 1: 失敗するテストを書く** — 「テストのコード」の T2 を足す。
- [ ] **Step 2: テストを実行して失敗を確認** — 実行: `/bin/bash tests/git-worktree-cleanup/run.sh`。期待: `test_N1`〜`test_N5` と `test_N9` が FAIL する（ヘルパーが呼ばれず、git が直接 worktree を消す。64 / 70 / 71 の表示もヘルパーの警告も無い）。`test_N6`〜`test_N8` は PASS する（呼ばないことを確かめるテスト）。VM の中でテストを走らせると、N6 は SKIP になる（本物のヘルパーが PATH にあるため）。
- [ ] **Step 3: 最小実装を書く** — 「完成形のコード」の T2 と docs の変更を足す。
- [ ] **Step 4: テストを実行して通過を確認** — 期待: `tests/git-worktree-cleanup/run.sh` と `tests/git-worktree-create/run.sh` が全 PASS。
- [ ] **Step 5: コミット**

```bash
git add home/dot_local/bin/executable_git-worktree-cleanup tests/git-worktree-cleanup/run.sh docs/commands/git-worktree-cleanup.md
git commit -F <message file>   # feat(git-worktree): remove a worktree through the node_modules helper under agent-vm
```

### T3: ADR-0022、ADR-0018 の `Amended by`、設計の全文、参照のコメント（K8）

**Files:**

- 新規: `docs/decisions/0022-agent-vm-node-modules.md`（「ADR-0022 の文面」）
- 編集: `docs/decisions/0018-agent-vm-orbstack.md` — `## Amended by` の最後の項目の次に、次の 1 行を足す。

  ```markdown
  - `docs/decisions/0022-agent-vm-node-modules.md` (2026-10-02) — VM では、repo の各パッケージの `node_modules` を VM ローカルのディスクへの bind mount に差し替える。repo を同じパスで共有する決定は変わらず、install 物の層だけを machine ごとに分ける。K17 の VM 許可リストに `agent-vm-node-modules` を足した
  ```

- 編集: `home/dot_local/bin/executable_agent-vm-node-modules` — 冒頭のコメントの 2 行目（`# host's install and ...`）の次に、`# Design: docs/decisions/0022-agent-vm-node-modules.md` の 1 行を足す。
- 編集: `home/.chezmoiignore` — `# agent-vm-node-modules runs only inside agent-vm machines` の行を `# agent-vm-node-modules runs only inside agent-vm machines (docs/decisions/0022-agent-vm-node-modules.md)` にする。
- 新規: `docs/plans/agent-vm/node-modules/` の 5 ファイル — `.tmp/sessions/26759938/` の `spec.md`、`research.md`、`plan-1.md`、`plan-2.md`、`plan-3.md` を `cp` で写す。中身は変えない（レビューの記録も、判断の経緯として残す）。plan-3.md は T5 の後に、もう一度写して上書きする（手動検証の結果を反映した版にする）。
- 参照: `docs/decisions/0021-agent-vm-golden-clone.md`（ADR の節立て）、`docs/plans/agent-vm/golden-clone/`（設計の全文の置き方）

- [ ] **Step 1**: ADR-0022 と、ADR-0018 の 1 行を書く。
- [ ] **Step 2**: ヘルパーと `.chezmoiignore` のコメントを直す。`chezmoi execute-template < home/.chezmoiignore >/dev/null` が成功することを確かめる（コメントの変更でテンプレートが壊れていない）。
- [ ] **Step 3**: 設計の全文を写す。`git ls-files docs/decisions/0022-agent-vm-node-modules.md` ではなく、ADR の中の参照先がすべて存在することを `for p in $(grep -o 'docs/[A-Za-z0-9/._-]*' docs/decisions/0022-agent-vm-node-modules.md | sort -u); do [ -e "$p" ] || echo "missing: $p"; done` で確かめる。期待: 何も出ない。
- [ ] **Step 4**: `/bin/bash tests/agent-vm/run-templates.sh` を実行する。期待: 全 PASS（`.chezmoiignore` のコメントの変更が配布に影響しない）。
- [ ] **Step 5: コミット** — T3 は単独でコミットせず、T4 と 1 つのコミットにする（ADR が参照する docs の 3 節と V24〜V29 は T4 で入るため）。T4 の Step 3 を参照。

### T4: `docs/agent-vm.md`（警告表、既知の制限、移行手順、V 表）

**Files:**

- 編集: `docs/agent-vm.md`（「docs の文面」の T4）
  - 3 節の `### VM でブラウザを使う` の節の後（`## 4. 秘密の渡し方` の前）に、`### node_modules は host と VM で別になる` の節を足す。
  - 7 節の箇条書きの最後に、2 項目を足す。
  - 9 節の表の最後に、V24〜V29 の 6 行を足す。
- 参照: plan-2「`agent-vm node-modules-sync [repo]` の契約」と、launcher の警告の文面（`executable_agent-vm` の `nm_sync`）

- [ ] **Step 1**: 文面を足す。警告の文言は、launcher（`nm_sync`）、T1、T2 の実際の文字列と一致させる。確認: 次の固定の部分文字列（どれも `<...>` を含まない）について、`grep -F -- '<文字列>' home/dot_local/bin/executable_agent-vm home/dot_local/bin/executable_git-worktree-create home/dot_local/bin/executable_git-worktree-cleanup` が 1 行以上を返すことを確かめる。症状の行（`Unable to resolve ...`）は TypeScript の出力で、照合しない。
  - `node_modules in the VM is empty for`
  - `kept VM-local node_modules that may be stale in`
  - `node_modules may be shared with the host in the VM`
  - `the helper is missing`
  - `the helper does not speak contract`
  - `may be shared with the host (agent-vm-node-modules attach: status`
  - `may not have VM-local node_modules for`
  - `could not detach its VM-local node_modules`
  - `another node_modules sync held the lock (try again)`
  - `the node_modules helper refused it`
- [ ] **Step 2**: `pnpm exec prettier --check docs/agent-vm.md` を実行する（表の整形。pre-commit も同じ整形をする）。
- [ ] **Step 3: コミット**（T3 の変更も含める） — `docs(agent-vm): record VM-local node_modules as ADR-0022 and explain its warnings`。本文に「`docs/plans/agent-vm/node-modules/plan-3.md` は承認時点の版（レビューの記録と未承認の印を含む、判断の経緯としての写し）で、手動検証の結果を反映した版は T5 のコミットで写し直す」と書く。

### T5: 手動検証 V3〜V6（docs の V26〜V29）

実機（OrbStack）でしか確かめられない項目。T1〜T4 を commit し、host で `chezmoi apply` を実行してから行う（ヘルパーと 2 つのツールが新しい版で VM に届く）。

**準備（試験用の repo）**:

- 場所: `/private/tmp/claude-501/-Users-berlysia--local-share-chezmoi/26759938-d812-4921-92ec-47def52f7d70/scratchpad/nm check`（空白を含む。V4 の引数の境界の確認を兼ねる）。以下 `<R>` と書く。
- 中身（npm workspace、spec の Case B 相当）:
  - `<R>/package.json`: `{"name":"nm-check","private":true,"workspaces":["packages/a"],"devDependencies":{"typescript":"7.0.0","oxlint":"<host の oxlint と同じ版>"}}`。typescript の版は、TS7 のネイティブのパッケージ（`@typescript/typescript-<platform>-<arch>`）を引く版にする。T5 の着手時に `npm view typescript version` と `npm view oxlint version` で確かめた版を書く。
  - `<R>/packages/a/package.json`: `{"name":"a","version":"0.0.0","devDependencies":{"typescript":"6.0.3"}}`（ルートと衝突する版にして、`packages/a/node_modules` に実体を置かせる。版は `npm view typescript@6 version` で確かめる）。
  - `<R>/tsconfig.json`: `{"compilerOptions":{"noEmit":true,"strict":true},"include":["index.ts"]}` と `<R>/index.ts`: `export const x: number = 1;`
  - `<R>/.gitignore`: `node_modules/`
  - `git init` して全部を commit する。
- machine: `<R>` で `agent-vm prewarm` を実行する。終わったら、machine 名 `<m>` を `agent-vm list` で控える。
- 実行の分担: 保護フックは、Bash のコマンド文字列に `node_modules` と `rm` / `mount` などが並ぶと止める。その形の手順（下で【人】と書く）は、ユーザーに `!` での実行を頼む。それ以外は Claude が実行する。

**V3（K9 と plan-1 の申し送り: `//deleted` と張り直し）**:

1. `agent-vm node-modules-sync "<R>"` → 終了コード 0。
2. `orb -m <m> bash -lc 'grep -F "nm\\040check" /proc/self/mountinfo'` → `<R>/node_modules` と `<R>/packages/a/node_modules` の 2 行。root 欄が `/var/lib/agent-vm/node_modules/<key>/data` で終わる。
3. 【人】host の Claude Code の入力欄で（VM の中ではなく）、`<R>` が scratchpad の `nm check` を指していることを確かめてから、`! rm -rf "<R>/node_modules" && mkdir "<R>/node_modules"` を実行する。Claude は、`<R>` を展開した完全なコマンドを提示して実行を待つ（VM の中で実行すると、mount された VM ローカルの中身を消すため）。
4. 2 と同じコマンド → `<R>/node_modules` の行の mountpoint が `//deleted` で終わる。
5. `agent-vm node-modules-sync "<R>"` → 終了コード 0。2 と同じコマンドで、`//deleted` でない `<R>/node_modules` の行がある。`orb -m <m> bash -lc 'stat -c %d:%i "$1/node_modules" /var/lib/agent-vm/node_modules/*/data'` _ "<R>" で、`<R>/node_modules` の device:inode がどれかの `data` と一致する。
6. 回収: host で `git -C "<R>" worktree add "<R>/.git/worktree/v3" -b v3`、`agent-vm node-modules-sync "<R>"`、`orb -m <m> bash -lc 'ls /var/lib/agent-vm/node_modules | wc -l'` を控える（n）。host で `git -C "<R>" worktree remove "<R>/.git/worktree/v3"`（host での削除は規約どおり挙動を変えない。VM の mount は `//deleted` になる）。`agent-vm node-modules-sync "<R>"` → 終了コード 0。同じ `ls | wc -l` が n−1（v3 の保存先が回収された）。
- 5 の `stat` は VM のユーザーで実行する。保存先の親と `<key>/` は root 所有の 0755、`data/` は VM のユーザーの所有（plan-1 の不変条件）なので、読める。
- **通過条件**: 1〜6 の期待がすべて成り立つ。
- **成り立たない場合**: V24〜V29 の残りの確認は続けるが、T5 のコミットで次の 3 か所を直す。
  - ADR-0022 の Decision にある自分の行の判定の段落に、「V26 で成り立たなかった。見直しは別の課題」と結果を足す。
  - docs の 9 節の確認結果に、事実を書く。
  - 判定の見直し（ヘルパーの変更）は、plan-3 の範囲外として新しい Document Workflow に回し、ユーザーに報告して止まる。

**V4（R2、plan-2 の申し送り: 両側の install と引数の境界）**:

1. host: `cd "<R>" && npm install && npx tsc -p . && npx oxlint index.ts` → どれも終了コード 0。
2. `agent-vm node-modules-sync "<R>"` → 終了コード 0（空白を含むパスが 1 つの引数として VM に届く。届かなければ、ヘルパーが `not a worktree` などで非 0 を返す）。
3. VM: `orb -m <m> bash -lc 'cd "$1" && npm install && npx tsc -p . && npx oxlint index.ts' _ "<R>"` → どれも終了コード 0。
4. host: 1 の `npx tsc -p . && npx oxlint index.ts` をもう一度 → 終了コード 0（VM の install が host を壊していない）。
5. host: `ls -A "<R>/packages/a/node_modules"` の結果を控える（R2: host の `npm install` の前に mount 先として作られた空のディレクトリか、npm の実体か）。1 の `npm install` を、もう一度実行して終了コード 0 であることも確かめる。
- **通過条件**: 1〜4 がすべて終了コード 0。5 の `npm install` も終了コード 0。
- **成り立たない場合**: docs の 3 節の「host に空の `node_modules` が現れることがある」の項と ADR-0022 の Consequences の同じ記述を、観測した事実に合わせて T5 のコミットで直す。両側の install が互いを壊す（1〜4 のどれかが失敗）なら、設計の前提が崩れているので、ユーザーに報告して止まる。

**V5（R5: 入れ直し系のコマンド）**:

- 準備: `<R>` の中に、PM ごとの独立したパッケージを 4 つ作る（`<R>/pm/npm`、`<R>/pm/pnpm`、`<R>/pm/yarn`、`<R>/pm/bun`。それぞれ `{"name":"pm-<x>","private":true,"devDependencies":{"is-number":"7.0.0"}}`）。commit してから `agent-vm node-modules-sync "<R>"`。それぞれ VM で 1 度 install して lockfile を作る（`npm install`、`npx --yes pnpm@10 install`、`npx --yes yarn@1 install`、`npx --yes bun@1 install`）。
- 実行（VM、`orb -m <m> bash -lc 'cd "$1" && <cmd>' _ "<R>/pm/<x>"`）: spec R5 のコマンドをそのまま使う。`npm ci`、`npx --yes pnpm@10 install --force`、`npx --yes yarn@1 install`、`npx --yes bun@1 install --force`。それぞれの終了コードと、失敗したときの stderr の先頭 5 行を控える。
- **通過条件**: 4 つのそれぞれが終了コード 0 である。0 でないものがあれば、T4 の docs の「VM での入れ直し」の項（「docs の文面」の T5 の分岐）に、そのコマンドの回避策を書く。

**V6（K6 の参照の実地確認: VM の Claude から worktree 用ツール）**:

1. 【人】`<R>` で `claude` を起動し（VM）、「`git-worktree-create v6` を実行して」と頼む。
   - 期待: 保護フックに止められず、終了コード 0。警告が出ない。
2. host: `orb -m <m> bash -lc 'grep -F "worktree/v6" /proc/self/mountinfo'` → `<R>/.git/worktree/v6/node_modules` の行がある。
3. 【人】同じ Claude に「`git-worktree-cleanup v6` を実行して」と頼む。
   - 期待: 終了コード 0 で、`✓ Removing worktree` が出る。v6 のディレクトリが消える。
   - v6 は commit していないので、cleanup は確認を求めるか残す。残った場合は「`git-worktree-cleanup --yes v6`」と頼む。それでも残る場合は、表示された理由を控える。
4. 2 と同じコマンド → 行が無い。`orb -m <m> bash -lc 'ls /var/lib/agent-vm/node_modules | wc -l'` が、1 の前より増えていない。
- **通過条件**: 1〜4 が期待どおり。
- **成り立たない場合**: 保護フックに止められたなら、docs の 3 節の「worktree は ... で作り、消す」の項と docs/commands の 2 ファイルに、VM の Claude からは使えないことと、その場合の手順（host で実行する）を T5 のコミットで足す。mount が張られない、外れないなら、ユーザーに報告して止まる。

**記録と片付け**:

- [ ] 結果を `docs/agent-vm.md` の 9 節に `### 2026-10-0X の確認結果（VM ローカルの node_modules）` として書く（「docs の文面」の T5）。V5 の結果で「docs の文面」の T5 の分岐を選ぶ。`research.md` にも同じ結果を足す。
- [ ] `docs/plans/agent-vm/node-modules/plan-3.md` と `research.md` を写し直す。
- [ ] コミット — `docs(agent-vm): record the VM-local node_modules checks on OrbStack`
- [ ] 片付け: 【人】`echo y | agent-vm rm "<R>"`（machine の削除）。`<R>` は scratchpad の中なので、そのまま残す。

## 完成形のコード

### T1: `home/dot_local/bin/executable_git-worktree-create`

`show_help` の定義の後:

```bash
# say_warn <message>: a warning on stderr, printed without interpreting backslashes in the message
say_warn() {
    printf '%b⚠️  %s%b\n' "$YELLOW" "$1" "$NC" >&2
}
```

`✓ Worktree created` の行の次:

```bash
# agent-vm (docs/decisions/0022-agent-vm-node-modules.md): inside a machine, the new worktree gets its VM-local
# node_modules now rather than at the next launch; on the host, a running machine of this repository is asked to
# sync. Neither stops the creation: the worktree is there, only its node_modules may still be shared.
if [[ -e "${AGENT_VM_MARKER:-/etc/agent-vm}" ]]; then
    if command -v agent-vm-node-modules >/dev/null 2>&1; then
        nm_status=0
        agent-vm-node-modules attach "$worktree_path" >/dev/null || nm_status=$?
        if [[ $nm_status -ne 0 ]]; then
            # An install there now would put linux packages into the host's worktree
            nm_wt=$(printf '%q' "$worktree_path")
            say_warn "node_modules of $nm_wt may be shared with the host (agent-vm-node-modules attach: status $nm_status); do not install there until this succeeds: agent-vm-node-modules attach $nm_wt"
        fi
    fi
elif command -v agent-vm >/dev/null 2>&1; then
    nm_status=0
    agent-vm node-modules-sync "$repo_root" || nm_status=$?
    if [[ $nm_status -ne 0 ]]; then
        say_warn "the running agent-vm machine may not have VM-local node_modules for $(printf '%q' "$worktree_path") yet (agent-vm node-modules-sync: status $nm_status); the next agent-vm launch syncs it"
    fi
fi
```

### T2: `home/dot_local/bin/executable_git-worktree-cleanup`

`main_phys=${wt_phys[0]}` の行の後:

```bash

# Inside an agent-vm machine, each worktree under .git/worktree carries VM-local node_modules mounts
# (docs/decisions/0022-agent-vm-node-modules.md). git alone would empty the VM-local copy and then fail on the
# mountpoint, so the helper detaches, runs the removal, and deletes or re-attaches the copy under its lock.
nm_helper=0
if [[ -e "${AGENT_VM_MARKER:-/etc/agent-vm}" ]] && command -v agent-vm-node-modules >/dev/null 2>&1; then
    nm_helper=1
fi
# remove_worktree <index>: git worktree remove, through the helper where it owns mounts; output goes to the caller.
# The helper's own statuses (64 refused, 70 failed, 71 lock) are its EXIT_USAGE / EXIT_RM_FAILED / EXIT_RM_LOCKED in
# agent-vm-node-modules; with any of them it ran nothing. Otherwise it returns the command's status.
remove_worktree() {
    local w=${wt_path[$1]}
    if [[ $nm_helper -eq 1 && "${wt_phys[$1]}" == "$main_phys/.git/worktree/"* ]]; then
        agent-vm-node-modules remove "$w" -- git -C "$main_worktree" worktree remove -- "$w"
    else
        git -C "$main_worktree" worktree remove -- "$w"
    fi
}
```

メインループの置き換え（前: `if ! err=$(git -C "$main_worktree" worktree remove -- "$worktree" 2>&1); then` から、その `fi` まで）:

```bash
    rm_status=0
    err=$(remove_worktree "$i" 2>&1) || rm_status=$?
    if [[ $rm_status -ne 0 ]]; then
        # 64, 70 and 71 come only from the helper (git uses 0, 1 and 128); the helper ran nothing for them
        case "$nm_helper:$rm_status" in
            1:64) say "$RED" "✗ the node_modules helper refused it: $err - skipping" ;;
            1:70) say "$RED" "✗ could not detach its VM-local node_modules: $err - skipping" ;;
            1:71) say "$RED" "✗ another node_modules sync held the lock (try again): $err - skipping" ;;
            *) say "$RED" "✗ git refused to remove it: $err - skipping" ;;
        esac
        kept=$((kept + 1))
        continue
    fi
    # The helper also warns after a removal (a store it could not delete, a copy it re-attached). Without the helper
    # the output stays discarded on success, as before.
    if [[ $nm_helper -eq 1 && -n "$err" ]]; then
        say "$YELLOW" "⚠️  $err"
    fi
```

置き換えの後に続く既存の `say "$GREEN" "✓ Removing worktree: $worktree"` と `removed=$((removed + 1))` は、そのまま残す。

`show_help` の終了コード 2 の 2 行（`  2  A target was given ...` と `     including when git refused to remove it.`）を、次の 3 行に置き換える:

```
  2  A target was given and at least one worktree was kept (the reason is printed),
     including when git refused to remove it or, inside an agent-vm machine, when
     its VM-local node_modules could not be detached.
```

`# [Tn]` のような印は無い。コメントはそのまま書く。

## テストのコード

### T1: `tests/git-worktree-create/run.sh`（新規）

```bash
#!/usr/bin/env bash
# shellcheck disable=SC2317,SC2329 # test_* functions are invoked indirectly by name from the runner at the bottom
# Tests for git-worktree-create's agent-vm integration (docs/decisions/0022-agent-vm-node-modules.md). Every fixture
# lives in a throwaway directory under $TMP_BASE; the real repository is never touched.
# Usage: run.sh [test_name...]  (no args = all tests)
set -euo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
CREATE="$REPO_ROOT/home/dot_local/bin/executable_git-worktree-create"
TMP_BASE=$(cd -P "$(mktemp -d -t gwcr-test-XXXXXX)" && pwd -P)
trap 'rm -rf "$TMP_BASE"' EXIT
# When started from a git hook, these variables would point fixtures at the real repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT GIT_NAMESPACE GIT_SSH_COMMAND GIT_SSH GIT_ASKPASS GIT_PROXY_COMMAND GIT_EXEC_PATH
export GIT_CEILING_DIRECTORIES="$TMP_BASE" HOME="$TMP_BASE/home" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$TMP_BASE/gitconfig" GIT_TERMINAL_PROMPT=0
# Not an agent-vm machine unless a test says so, even when the tests run inside one
export AGENT_VM_MARKER="$TMP_BASE/no-agent-vm"
mkdir -p "$HOME"
git config -f "$GIT_CONFIG_GLOBAL" user.name t
git config -f "$GIT_CONFIG_GLOBAL" user.email t@t
git config -f "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config -f "$GIT_CONFIG_GLOBAL" init.defaultBranch main
RESULTS_FILE="$TMP_BASE/results"
: >"$RESULTS_FILE"
REAL_GIT=$(command -v git)
# git and the base system only: no agent-vm or agent-vm-node-modules of the machine running the tests
BASE_PATH="$(dirname "$REAL_GIT"):/usr/bin:/bin"
VM_MARKER="$TMP_BASE/agent-vm-marker"
: >"$VM_MARKER"

# ---- assert ----------------------------------------------------------------
record() { printf '%s\n' "$1" >>"$RESULTS_FILE"; }
assert_eq() { if [[ "$1" == "$2" ]]; then record "PASS $3"; else record "FAIL $3 (expected: $1 / actual: $2)"; fi; }
assert_contains() { case "$1" in *"$2"*) record "PASS $3" ;; *) record "FAIL $3 (missing: $2)" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) record "FAIL $3 (unexpected: $2)" ;; *) record "PASS $3" ;; esac; }
assert_dir() { if [[ -d "$1" ]]; then record "PASS $2"; else record "FAIL $2 (missing dir: $1)"; fi; }
assert_no_file() { if [[ ! -e "$1" ]]; then record "PASS $2"; else record "FAIL $2 (exists: $1)"; fi; }

# ---- fixture -----------------------------------------------------------------
# make_repo <name>: a repository with one commit at $REPO, and an empty stub directory at $STUB
make_repo() {
  mkdir -p "$TMP_BASE/$1/repo" "$TMP_BASE/$1/bin"
  REPO=$(cd -P "$TMP_BASE/$1/repo" && pwd -P)
  STUB="$TMP_BASE/$1/bin"
  git -C "$REPO" init -q
  git -C "$REPO" commit -q --allow-empty -m init
}
# stub <command> <status> [stdout line] [stderr line]: a command in $STUB that logs each argument on its own line
# to $STUB/<command>.log, prints the lines, and exits with the status
stub() {
  {
    printf '#!/bin/sh\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$STUB/$1.log"
    if [[ -n "${3:-}" ]]; then printf 'printf "%%s\\n" %q\n' "$3"; fi
    if [[ -n "${4:-}" ]]; then printf 'printf "%%s\\n" %q >&2\n' "$4"; fi
    printf 'exit %d\n' "$2"
  } >"$STUB/$1"
  chmod +x "$STUB/$1"
}
# run_create <marker> <branch>: the real git-worktree-create in $REPO, with $STUB in front of the base PATH
run_create() {
  OUT=$(cd "$REPO" && AGENT_VM_MARKER="$1" PATH="$STUB:$BASE_PATH" bash "$CREATE" "$2" 2>&1) && STATUS=0 || STATUS=$?
}

# ---- 機能適合性 ------------------------------------------------------------------
test_C1_vm_attaches_the_new_worktree() {
  make_repo c1
  stub agent-vm-node-modules 0 "mounted	$REPO/.git/worktree/feat"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C1 exit 0"
  assert_dir "$REPO/.git/worktree/feat" "C1 worktree created"
  assert_eq $'attach\n'"$REPO/.git/worktree/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C1 attach <worktree>"
  assert_not_contains "$OUT" "mounted" "C1 the helper's records are not shown"
  assert_not_contains "$OUT" "node_modules" "C1 no warning when attached"
}
test_C5_host_asks_a_running_machine_to_sync() {
  make_repo c5
  stub agent-vm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C5 exit 0"
  assert_eq $'node-modules-sync\n'"$REPO" "$(cat "$STUB/agent-vm.log")" "C5 node-modules-sync <repo>"
  assert_not_contains "$OUT" "node_modules" "C5 no warning when the sync succeeds or is skipped"
}

# ---- 信頼性 ------------------------------------------------------------------------
test_C2_vm_attach_failure_warns_and_keeps_the_worktree() {
  make_repo c2
  stub agent-vm-node-modules 1 "" "agent-vm-node-modules: could not mount a VM-local node_modules"
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C2 the creation still succeeds"
  assert_dir "$REPO/.git/worktree/feat" "C2 worktree kept"
  assert_contains "$OUT" "could not mount a VM-local node_modules" "C2 the helper's stderr is shown"
  assert_contains "$OUT" "node_modules of $REPO/.git/worktree/feat may be shared with the host (agent-vm-node-modules attach: status 1); do not install there until this succeeds: agent-vm-node-modules attach $REPO/.git/worktree/feat" "C2 one warning with the recovery"
}
test_C3_nothing_is_called_when_the_worktree_is_not_created() {
  make_repo c3
  stub agent-vm-node-modules 0
  run_create "$VM_MARKER" "bad..name"
  if [[ "$STATUS" -ne 0 ]]; then record "PASS C3 creation fails"; else record "FAIL C3 creation fails (status 0)"; fi
  assert_no_file "$STUB/agent-vm-node-modules.log" "C3 attach is not called"
}
test_C6_host_sync_failure_adds_one_warning() {
  make_repo c6
  stub agent-vm 3 "" "agent-vm: kept VM-local node_modules that may be stale in agent-r-000000"
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C6 the creation still succeeds"
  assert_contains "$OUT" "kept VM-local node_modules that may be stale" "C6 agent-vm's warning is shown"
  assert_contains "$OUT" "the running agent-vm machine may not have VM-local node_modules for $REPO/.git/worktree/feat yet (agent-vm node-modules-sync: status 3); the next agent-vm launch syncs it" "C6 one context line"
}

# ---- 互換性 ------------------------------------------------------------------------
test_C4_vm_without_the_helper_behaves_as_before() {
  make_repo c4
  stub agent-vm 0
  run_create "$VM_MARKER" feat
  assert_eq 0 "$STATUS" "C4 exit 0"
  assert_no_file "$STUB/agent-vm.log" "C4 agent-vm is not called inside a machine"
  assert_not_contains "$OUT" "node_modules" "C4 no warning without the helper"
}
test_C7_host_without_agent_vm_behaves_as_before() {
  make_repo c7
  stub agent-vm-node-modules 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq 0 "$STATUS" "C7 exit 0"
  assert_no_file "$STUB/agent-vm-node-modules.log" "C7 the helper is not called on the host"
  assert_not_contains "$OUT" "node_modules" "C7 no warning"
  assert_contains "$OUT" "Worktree created: $REPO/.git/worktree/feat" "C7 the usual output"
}
test_C8_paths_with_a_space_stay_one_argument() {
  make_repo "c 8"
  stub agent-vm-node-modules 0
  run_create "$VM_MARKER" feat
  assert_eq $'attach\n'"$REPO/.git/worktree/feat" "$(cat "$STUB/agent-vm-node-modules.log")" "C8 VM: one argument"
  make_repo "c 8 host"
  stub agent-vm 0
  run_create "$AGENT_VM_MARKER" feat
  assert_eq $'node-modules-sync\n'"$REPO" "$(cat "$STUB/agent-vm.log")" "C8 host: one argument"
}

# ---- runner --------------------------------------------------------------------------
run_one() {
  local t=$1 rc
  set +e
  (
    set -e
    "$t"
  )
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then record "FAIL $t (aborted, rc=$rc)"; fi
}

tests=()
if [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    case "$arg" in test_*) tests+=("$arg") ;; *) tests+=("test_$arg") ;; esac
  done
else
  while IFS= read -r name; do tests+=("$name"); done < <(declare -F | sed -n 's/^declare -f \(test_.*\)$/\1/p')
fi

for t in ${tests[@]+"${tests[@]}"}; do
  if declare -F "$t" >/dev/null; then
    run_one "$t"
  else
    record "FAIL $t (no such test)"
  fi
done

cat "$RESULTS_FILE"
pass=$(grep -c '^PASS' "$RESULTS_FILE" || true)
fail=$(grep -c '^FAIL' "$RESULTS_FILE" || true)
echo "PASS: $pass FAIL: $fail"
if [[ "$fail" -gt 0 ]]; then exit 1; fi
```

テストの補足:

- `stub` の stdout の行（C1）にはタブが入っている。plan をコピーするときにタブが空白に化けないようにする（化けても C1 の「表示しない」の確認は `mounted` の語で行うので、結果は変わらない）。
- C3 の `bad..name` は、git が ref 名として拒否するので `git worktree add` が失敗する。create は `set -e` でその場で終わる。
- `BASE_PATH` は git のディレクトリと `/usr/bin:/bin` だけにする。開発者の mac の `~/.local/bin/agent-vm` を拾わないため。`dirname "$REAL_GIT"` が `/opt/homebrew/bin` でも、そこに `agent-vm` は無い（launcher は chezmoi が `~/.local/bin` に置く）。

### T2: `tests/git-worktree-cleanup/run.sh` への追加

`export GIT_CEILING_DIRECTORIES=...` の次の行:

```bash
# Not an agent-vm machine unless a test says so: inside one, the real helper would mount over the fixtures
export AGENT_VM_MARKER="$TMP_BASE/no-agent-vm"
```

`# ---- 使用性 ----` の前:

```bash
# ---- agent-vm（ADR-0022） ------------------------------------------------------------
# nm_helper_stub <status>: an agent-vm-node-modules in $TMP_BASE/nm-bin that logs each argument on its own line.
# With 0 it runs the command after "remove <wt> --", as the real helper does; otherwise it prints a reason and exits
# with the status without running anything.
# A second argument is a warning it prints on stderr before running the command (with status 0 only).
# $TMP_BASE is shared by every test, so each call starts a fresh log.
nm_helper_stub() {
  mkdir -p "$TMP_BASE/nm-bin"
  rm -f "$TMP_BASE/nm.log"
  {
    printf '#!/bin/bash\n'
    printf 'printf "%%s\\n" "$@" >>%q\n' "$TMP_BASE/nm.log"
    printf 'if [ %d -ne 0 ]; then echo "agent-vm-node-modules: stub status %d" >&2; exit %d; fi\n' "$1" "$1" "$1"
    if [[ -n "${2:-}" ]]; then printf 'echo %q >&2\n' "$2"; fi
    printf 'shift 3\nexec "$@"\n'
  } >"$TMP_BASE/nm-bin/agent-vm-node-modules"
  chmod +x "$TMP_BASE/nm-bin/agent-vm-node-modules"
  : >"$TMP_BASE/vm-marker"
}
# run_cleanup_vm [args...]: run_cleanup as inside an agent-vm machine with the stub helper
run_cleanup_vm() {
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" PATH="$TMP_BASE/nm-bin:$PATH" run_cleanup "$@"
}

test_N1() {
  make_repo n1
  local d
  d=$(mk_squashed n1 2)
  nm_helper_stub 0
  run_cleanup_vm -n n1
  assert_removed "$d" "N1 removed through the helper"
  assert_eq "$(printf '%s\n' remove "$d" -- git -C "$REPO" worktree remove -- "$d")" "$(cat "$TMP_BASE/nm.log")" "N1 remove <wt> -- git -C <main> worktree remove -- <wt>"
  assert_eq 0 "$STATUS" "N1 exit"
}
test_N2() {
  make_repo n2
  local d
  d=$(mk_squashed n2 2)
  nm_helper_stub 70
  run_cleanup_vm -n n2
  assert_kept "$d" "N2 kept"
  assert_contains "$OUT" "could not detach its VM-local node_modules: agent-vm-node-modules: stub status 70 - skipping" "N2 message with the helper's output"
  assert_eq 2 "$STATUS" "N2 exit"
}
test_N3() {
  make_repo n3
  local d
  d=$(mk_squashed n3 2)
  nm_helper_stub 71
  run_cleanup_vm -n n3
  assert_kept "$d" "N3 kept"
  assert_contains "$OUT" "another node_modules sync held the lock (try again)" "N3 message"
  assert_eq 2 "$STATUS" "N3 exit"
}
test_N4() {
  make_repo n4
  local d
  d=$(mk_squashed n4 2)
  nm_helper_stub 64
  run_cleanup_vm -n n4
  assert_kept "$d" "N4 kept, git is not run directly"
  assert_contains "$OUT" "the node_modules helper refused it" "N4 message"
  assert_eq 2 "$STATUS" "N4 exit"
}
test_N5() {
  make_repo n5
  local d
  d=$(mk_squashed n5 2)
  nm_helper_stub 0
  mkdir -p "$TMP_BASE/stub-git"
  {
    printf '#!/bin/bash\n'
    printf 'case " $* " in *" worktree remove "*) echo "fatal: stub refusal" >&2; exit 128 ;; esac\n'
    printf 'exec %q "$@"\n' "$REAL_GIT"
  } >"$TMP_BASE/stub-git/git"
  chmod +x "$TMP_BASE/stub-git/git"
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" PATH="$TMP_BASE/nm-bin:$TMP_BASE/stub-git:$PATH" run_cleanup -n n5
  assert_kept "$d" "N5 kept"
  assert_contains "$OUT" "git refused to remove it: fatal: stub refusal" "N5 git's refusal through the helper"
  assert_eq 2 "$STATUS" "N5 exit"
}
test_N6() {
  if command -v agent-vm-node-modules >/dev/null 2>&1; then
    record "SKIP N6 (agent-vm-node-modules is on the PATH of this machine)"; return 0
  fi
  make_repo n6
  local d
  d=$(mk_squashed n6 2)
  : >"$TMP_BASE/vm-marker"
  AGENT_VM_MARKER="$TMP_BASE/vm-marker" run_cleanup -n n6
  assert_removed "$d" "N6 inside a machine without the helper, git removes it as before"
  assert_eq 0 "$STATUS" "N6 exit"
}
test_N7() {
  make_repo n7
  local d
  d=$(mk_squashed n7 2)
  nm_helper_stub 0
  PATH="$TMP_BASE/nm-bin:$PATH" run_cleanup -n n7
  assert_removed "$d" "N7 on the host, git removes it as before"
  assert_no_dir "$TMP_BASE/nm.log" "N7 the helper is not called on the host"
}
test_N8() {
  make_repo n8
  local d="$BASE/outside"
  git -C "$REPO" worktree add -q -b out "$d"
  commit_in "$d" out-1.txt
  push_branch "$d"
  squash_merge out
  nm_helper_stub 0
  run_cleanup_vm -n out
  assert_removed "$d" "N8 a worktree outside .git/worktree is removed when named"
  assert_no_dir "$TMP_BASE/nm.log" "N8 without the helper, which owns no mounts there"
}
test_N9() {
  make_repo n9
  local d
  d=$(mk_squashed n9 2)
  nm_helper_stub 0 "agent-vm-node-modules: could not delete the store 0123456789abcdef; the next sync deletes it"
  run_cleanup_vm -n n9
  assert_removed "$d" "N9 removed"
  assert_contains "$OUT" "could not delete the store 0123456789abcdef; the next sync deletes it" "N9 the helper's warning after a removal is shown"
  assert_eq 0 "$STATUS" "N9 exit"
}
```

テストの補足:

- `assert_no_dir` は「パスが存在しない」を確かめる既存の assert で、ファイルにも使える（`[[ ! -e ]]`）。
- N1 の期待は、ヘルパーのコマンドラインそのもの（spec K7 の契約テスト）。`$d` と `$REPO` は、cleanup が `git worktree list` から得るパスと同じ実パスである（`make_repo` が `cd -P` で正規化し、`wt` がその配下に作る）。
- N8 は、既存の `test_F19`（外の worktree を `$BASE/outside` に作り、branch 名 `out` で名指しして消す）と同じ作り方にする。`.git/worktree-x` のような似た名前は、`remove_worktree` の判定が `"$main_phys/.git/worktree/"*`（末尾の `/` まで）なので外として扱われる。これは既存の選択（`test_R7`）と同じ判定である。
- `nm_helper_stub` の 0 以外は、実物の 64 / 70 / 71 と同じく、コマンドを実行しない（plan-1 の契約）。

## docs の文面

### T1: `docs/commands/git-worktree-create.md`

`## 使用例` の前に足す:

```markdown
## agent-vm との連携

agent-vm を使う repo では、作った worktree の `node_modules` を VM ローカルに差し替える（`docs/decisions/0022-agent-vm-node-modules.md`）。

- **VM の中**（`/etc/agent-vm` があり、`agent-vm-node-modules` がある）: 作成の後に `agent-vm-node-modules attach <worktree>` を実行する。失敗したら、警告と回復手順を 1 行出す。作成そのものは成功のままである。警告が出ている間は、その worktree で install しない（host の worktree に linux 用のパッケージが入る）。
- **host**（`agent-vm` がある）: 作成の後に `agent-vm node-modules-sync <repo>` を実行する。この repo の machine が動いていなければ、何もしない。動いていれば、起動中の処理が repo の lock を持っている間（最大で約 5 秒）と VM での sync の間、作成の完了が遅れる。失敗したら、agent-vm の警告に続けて 1 行出す。次の agent-vm の起動で揃う。
- どちらも無い環境では、今までどおり動く。
```

### T2: `docs/commands/git-worktree-cleanup.md`

`## 終了コード` の節の 2 の行の説明の末尾に、次の 1 文を足す（表か箇条書きかは既存の形に合わせる）:

```markdown
agent-vm の machine の中で、VM ローカルの `node_modules` を外せなかった、lock を取れなかった、ヘルパーが拒否した、のいずれかで残ったときも 2 になる。
```

`## 注意事項` の箇条書きの最後に、次を足す:

```markdown
- agent-vm の machine の中（`/etc/agent-vm` があり、`agent-vm-node-modules` がある）では、`.git/worktree` 配下の worktree を `agent-vm-node-modules remove <wt> -- git -C <main> worktree remove -- <wt>` で消す。VM ローカルの `node_modules` を外してから消し、失敗したら張り直す（`docs/decisions/0022-agent-vm-node-modules.md`）。外せない、lock を取れない、ヘルパーが拒否した場合は、理由を表示して worktree を残す。消せた後にヘルパーが出した警告（保存先を消せなかった、など）は、黄色で表示する。host では挙動は変わらない。
```

### T4: `docs/agent-vm.md`

3 節の `### VM でブラウザを使う` の節の後に足す:

```markdown
### node_modules は host と VM で別になる

VM の中では、repo の各パッケージ（`package.json` を持つディレクトリ）の `node_modules` が、VM ローカルのディスクへの bind mount に差し替わる（`docs/decisions/0022-agent-vm-node-modules.md`）。mac と VM が、互いの install でプラットフォーム別のパッケージ（TS7、oxc 系など）を壊し合わない。

- **VM で一度 install する。** 起動のたびに launcher が差し替えを揃える。VM の `node_modules` が空で host にある worktree では、起動時に 1 行で install を促す。
- **worktree は `git-worktree-create` と `git-worktree-cleanup` で作り、消す。** どちらも VM の中でも host でも、差し替えを追従させる。`git worktree add` / `git worktree remove` を直接使うと追従しない（下の表の最後の行）。
- **host に空の `node_modules` が現れることがある。** 差し替えの mount 先として VM が作ったディレクトリである。Node のモジュール解決は空の `node_modules` を素通りするので、host の動作は変わらない。git も空のディレクトリを追跡しない。
- **VM の Claude は、mount を手で張り直せない**（保護フック）。回復は下の表の手順で行う。
- **移行**: このリリースより前に VM で install したことのある repo は、host の `node_modules` が linux 用に上書きされている可能性がある。最初の起動の前に、host でその repo の install をやり直す。

警告は、VM の `node_modules` が host と共有されうる場面か、install が必要な場面で出る。どれも起動と worktree の作成は止めない。

| 場面 | 表示 | 回復手順 |
| --- | --- | --- |
| 起動 | `node_modules in the VM is empty for <dir> (the host has one)` | VM の中で、その dir の install を実行する |
| 起動、`agent-vm node-modules-sync` | `kept VM-local node_modules that may be stale in <machine> (a worktree or package list could not be trusted)` | `cd <repo> && agent-vm shell` の後に `agent-vm-node-modules sync <repo>` を実行し、詳しい警告を見る |
| 起動、`agent-vm node-modules-sync` | `node_modules may be shared with the host in the VM (the helper is missing)` または `(the helper does not speak contract <n>)` | `agent-vm rm <repo>` の後に、もう一度起動する |
| 起動、`agent-vm node-modules-sync` | `node_modules may be shared with the host in the VM (<それ以外の理由>)` | `cd <repo> && agent-vm shell` の後に `agent-vm-node-modules sync <repo>` を実行する |
| VM での `git-worktree-create` | `node_modules of <wt> may be shared with the host (agent-vm-node-modules attach: status <n>)` | 表示どおり `agent-vm-node-modules attach <wt>` を実行する。成功するまで、その worktree で install しない |
| host での `git-worktree-create` | `the running agent-vm machine may not have VM-local node_modules for <wt> yet` | 次の起動で揃う。すぐに揃えるなら `agent-vm node-modules-sync <repo>` |
| VM での `git-worktree-cleanup` | `could not detach its VM-local node_modules`、`another node_modules sync held the lock (try again)`、`the node_modules helper refused it` | worktree は残る。lock なら時間を置いて再実行する。それ以外は、表示されたヘルパーの理由に従う |
| （警告なし） | host の worktree で `tsc` が `Unable to resolve @typescript/typescript-darwin-arm64` で落ちる | 規約外の `git worktree add` の後に VM で install した。agent-vm を起動し直してから、host のその worktree で install をやり直す |
```

7 節の箇条書きの最後に足す:

```markdown
- VM で `node_modules` を作り直す系のコマンド（`npm ci` など）は、`node_modules` ディレクトリ自体が mount 先なので、消そうとして失敗する可能性がある。確認の結果は V28（9 節）に記録する。
- 1 つの worktree で差し替えるパッケージは 500 件までである。超えた worktree はルートのパッケージだけを差し替え、警告を出す。
```

9 節の表の最後に足す（V24〜V29 は spec の V1〜V6）:

```markdown
| V24 | VM で、fd 経由の bind mount（`mount --no-canonicalize --bind /proc/<pid>/fd/<src> /proc/<pid>/fd/<dst>`）を root の perl から行う | 成功し、mountinfo の mountpoint が正規化したパスになる |
| V25 | bind mount の mount 先と元の device:inode、mountinfo の root 欄と major:minor を見る | device:inode が一致し、root 欄が保存先の `data` で終わる |
| V26 | host で `node_modules` を消して作り直し、`agent-vm node-modules-sync` を実行する。host で worktree を消してから同じく実行する | 消えた mount が mountinfo で `//deleted` になり、sync が張り直す。消した worktree の保存先が回収される |
| V27 | 空白を含むパスの npm workspace を host と VM の両方で install し、両側で `tsc` と `oxlint` を実行する。host に現れた空の `node_modules` のまま、host で `npm install` と `tsc` をやり直す | どれも成功し、片側の install がもう片側を壊さない。host の空の `node_modules` は host の install と `tsc` を変えない |
| V28 | VM で `npm ci`、`pnpm install --force`、`yarn install`、`bun install --force` を実行する | 成功するか、失敗するものに回避策がある（7 節） |
| V29 | VM の Claude から `git-worktree-create` と `git-worktree-cleanup` を実行する | 保護フックに止められず、mount が張られて、外される |
```

（表の整形は prettier に任せる。列の幅は既存の表に合わせて広がる。）

### T5: `docs/agent-vm.md` 9 節の確認結果

9 節の最後に、次の形で足す。`<...>` は T5 の実測で埋める（V3〜V6 の各項目の「通過条件」に対応する事実を書く）。

```markdown
### 2026-10-0X の確認結果（VM ローカルの node_modules、macOS、OrbStack <版>、Ubuntu resolute arm64）

- V24、V25（2026-10-02、plan-1 の T0）: fd 経由の mount は成功した。device:inode は一致した。mountinfo の root 欄は `/scon/containers/<id>/rootfs/var/lib/agent-vm/node_modules/<key>/data` の形で、major:minor（0:37）は stat の st_dev（0:64）と一致しなかった。このため、自分の mount の判定は major:minor を使わず、root 欄の末尾一致と `//deleted` の除外で行う（ADR-0022）。
- V26: <`//deleted` の観測、張り直しと回収の結果>
- V27: <両側の install、`tsc`、`oxlint` の結果。host の `packages/a/node_modules` の中身>
- V28: <4 つのコマンドの終了コード>
- V29: <フックの有無、mount の行、cleanup の結果>
```

V5 の結果による分岐（7 節の 1 項目目を置き換える）:

- 4 つとも成功した場合: 「VM で `node_modules` を作り直す系のコマンド（`npm ci` など）は、`node_modules` ディレクトリが mount 先でも成功する（V28）。」
- 失敗したものがある場合: 「VM で `<失敗したコマンド>` は、`node_modules` ディレクトリが mount 先なので消せずに失敗する（V28）。中身だけを消してから install する: `find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +` の後に `<install のコマンド>`。」（失敗したコマンドごとに 1 文。成功したものは書かない。）

## ADR-0022 の文面

`docs/decisions/0022-agent-vm-node-modules.md`:

```markdown
# ADR-0022: agent-vm の VM では、repo の node_modules を VM ローカルのディスクに差し替える

## Status

accepted (2026-10-02)

## Context

ADR-0018 は、repo を host と同じパスで VM に mount する。`node_modules` もツリーの一部として共有される。TS7 のネイティブのコンパイラ（`@typescript/typescript-<platform>-<arch>`）や oxc 系のパッケージは、install したプラットフォームの分だけを入れる。mac で install した repo で VM の claude が `tsc` を実行すると `Unable to resolve @typescript/typescript-linux-arm64` で落ち、VM で install し直すと mac 側が壊れる。

対象は agent-vm で作るすべての machine で、repo ごとの設定を要求しない。

設計の全文は `docs/plans/agent-vm/node-modules/spec.md`（K1〜K10、R1〜R7）と `plan-1.md`〜`plan-3.md` にある。実験は `research.md` にある。ここには骨子と、却下した代替案を記す。

## Decision

ツリーは共有したまま、install 物の層だけを machine ごとに分ける。

- VM の中で、worktree の中の `package.json` を持つ各ディレクトリ（パッケージ）の `node_modules` を、VM ローカルの保存先（`/var/lib/agent-vm/node_modules/<key>/data`）への bind mount に差し替える。パッケージごとにするのは、npm、yarn、bun の hoisted がパッケージの下にプラットフォーム別の実体を置くためである（K1）。
- mount の仕組みは VM 側のヘルパー `agent-vm-node-modules` に閉じる。`sync <repo>`（収束。正はこれ）、`attach <worktree>`、`remove <worktree> -- <command>`、`--contract` を持つ。すべて冪等で、1 つの lock で直列化する。
- 呼び出しの入口は 3 つで、どれも収束を早める近道である。
  - launcher の起動のたびの `sync`。失敗は起動を止めない 1 行の警告にする。
  - `git-worktree-create`。VM では `attach`、host では `agent-vm node-modules-sync`。
  - `git-worktree-cleanup`。VM では `remove` で git の削除を包む。
- ヘルパーは chezmoi で VM にだけ配る。ADR-0018 K17 の VM 許可リストに足し、host では無視する。cloud-init と bootstrap の契約（ADR-0021 K9）には触れない。
- ヘルパーは権限の境界ではなく、正規の経路が偽の一覧や差し替えたパスに誘導されないための柵である（VM のユーザーはもともとパスワードなし sudo を持つ。ADR-0018 R6）。worktree は repo のルートか `<repo>/.git/worktree/` の配下に、パッケージは worktree の配下に限る。mount は root の perl が `O_NOFOLLOW` で開いた fd 経由で張り、mountinfo と device:inode で張った先を確かめる（K6）。
- mount の有効性は device:inode の一致で判定し、失効していれば張り直す（K9）。自分の mount の行は、mountinfo の root 欄が自分の `data` で終わり、mountpoint が `//deleted` で終わらない行とする。spec は major:minor の一致も条件にしていたが、OrbStack の btrfs では mountinfo の major:minor と stat の st_dev が一致しなかった（実測 0:37 と 0:64）。一致を条件にすると行を見つけられず、mount 中の中身を消す側に倒れるため、条件から外した。
- launcher の警告は、spec の「is shared」を次のように細かくした。回収を中止しただけ（ヘルパーの終了コード 3）は「kept VM-local node_modules that may be stale」、それ以外は「may be shared」。`agent-vm node-modules-sync` は、machine の記録が無い、止まっている、に加えて、git の外、`orb list` が答えない、lock を取れない、の場合も黙って 0 で終わる（次の起動で収束し、そこで表に出るため）。
- 起動時の install は自動で行わない。VM の `node_modules` が空で host にある worktree について、1 行で促す（K5）。
- worktree 用ツールの細部（spec K7 からの差分）:
  - `git-worktree-cleanup` がヘルパーを通すのは `<repo>/.git/worktree/` 配下の worktree だけである。名指しで消す外の worktree は git を直接呼ぶ。ヘルパーは外の worktree に mount を張らず、渡されても拒否（64）するため。
  - ヘルパーが拒否（64）したときは、git を直接呼ばずに worktree を残す。直接呼ぶと、mount された VM ローカルの中身を消してから mountpoint の削除で失敗しうるため。
  - `git-worktree-create` は `attach` のレコード（stdout）を捨て、警告（stderr）だけを通す。

## Consequences

- 2 つの環境の install が互いを壊さない。VM で一度 install すれば、両側が独立して動く。
- VM ごとに install が要り、ディスクを使う。保存先は machine と一緒に消える。
- host に空の `node_modules` ディレクトリ（mount 先）が現れることがある。Node のモジュール解決と git には影響しない。
- `git worktree add` / `remove` を直接使うと、次の起動まで差し替えが追従しない。VM で直接 add した worktree でそのまま install すると、host の worktree に linux 用のパッケージが入る。規約上、worktree の作成と削除は 2 つのツールに限る。
- このリリースより前に、VM の install で host の `node_modules` が上書きされた repo は、host で install をやり直すまで壊れたままである。自動検出はしない。
- 1 つの worktree で差し替えるパッケージは 500 件までである。
- 実機での確認項目は `docs/agent-vm.md` 9 節の V24〜V29 である。結果は同じ節の確認結果に記録する。

## Alternatives

- **PM のグローバル設定で両方のプラットフォームのパッケージを入れる**: yarn は `.yarnrc.yml`、pnpm は環境変数、bun は install のフラグで成立するが、npm は成立しない（`os` / `cpu` / `libc` が単一値で、install のたびに片方を消す）。仕組みが PM ごとに分かれ、npm の repo に穴が残る。却下。
- **machine 作成時の OrbStack の mount 一覧に `node_modules` を足す**: host 側で宣言でき、machine の設定の検査にも乗る。しかし mount 一覧は作成時に固定され、セッション中に増える worktree に張れない。保存先も host のディスクになり、linux 用の中身が host に置かれる。却下。
- **launcher が install を自動で実行する**: PM の判定と lifecycle スクリプトの方針は repo ごとに違い、agent の作業と競合する。通知に留める。

## References

- `docs/plans/agent-vm/node-modules/spec.md` / `research.md` / `plan-1.md` / `plan-2.md` / `plan-3.md`
- `docs/decisions/0018-agent-vm-orbstack.md`（K17 の VM 許可リスト、R6）
- `docs/decisions/0021-agent-vm-golden-clone.md`（K9 の bootstrap の契約）
- `docs/agent-vm.md`（3 節「node_modules は host と VM で別になる」、9 節 V24〜V29）
```

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: VM（印あり、ヘルパーあり）で `git-worktree-create feat` → **期待**: ヘルパーが `attach` と worktree のパスの 2 引数で 1 回呼ばれる。終了コード 0。レコードは表示しない（`test_C1_vm_attaches_the_new_worktree`）。
- **入力**: host（印なし、`agent-vm` あり）で `git-worktree-create feat` → **期待**: `agent-vm node-modules-sync <repo>` が 1 回呼ばれ、0 なら何も足さない（`test_C5_host_asks_a_running_machine_to_sync`）。
- **入力**: VM で、merge 済みの worktree を `git-worktree-cleanup -n <branch>` → **期待**: ヘルパーが `remove <wt> -- git -C <main> worktree remove -- <wt>` で呼ばれ、worktree が消える。終了コード 0（`test_N1`。spec K7 の契約テスト）。
- **入力**: 実機の VM で、create と cleanup を VM の Claude から実行する → **期待**: 保護フックに止められず、mount が張られて外される（V6、docs の V29）。
- **入力**: 実機で、host と VM の両方で install し、両側で `tsc` と `oxlint` → **期待**: どれも終了コード 0（V4、docs の V27）。

### 信頼性（障害許容性・回復性）

- **入力**: VM で `attach` が 1 を返す → **期待**: 作成は終了コード 0 で、worktree は残る。ヘルパーの stderr と、回復手順つきの 1 行が出る（`test_C2_vm_attach_failure_warns_and_keeps_the_worktree`）。
- **入力**: host で `agent-vm node-modules-sync` が 3 を返す → **期待**: 終了コード 0。agent-vm の警告と、文脈の 1 行（status 3）が出る（`test_C6_host_sync_failure_adds_one_warning`）。
- **入力**: `git worktree add` が失敗する ref 名 → **期待**: 作成は非 0 で、ヘルパーは呼ばれない（`test_C3_nothing_is_called_when_the_worktree_is_not_created`）。
- **入力**: VM の cleanup で、ヘルパーが 70 / 71 / 64 を返す → **期待**: どれも worktree を残し、それぞれの理由とヘルパーの出力を表示する。名指しなので終了コード 2（`test_N2`、`test_N3`、`test_N4`）。
- **入力**: VM の cleanup で、ヘルパー経由の git が 128 で拒否する → **期待**: 「git refused to remove it」と git の stderr、終了コード 2（`test_N5`）。
- **入力**: VM の cleanup で、ヘルパーが削除に成功した後に警告を出す（保存先を消せなかった）→ **期待**: worktree は消え、警告が表示される。終了コード 0（`test_N9`）。
- **入力**: 実機で、host が `node_modules` を作り直す、host が worktree を消す → **期待**: mountinfo の行が `//deleted` になり、次の `sync` が張り直し、消えた worktree の保存先を回収する（V3、docs の V26）。

### 互換性（共存性）

- **入力**: VM の印はあるがヘルパーが無い → **期待**: create は `agent-vm` を呼ばず、警告も出さない（`test_C4_vm_without_the_helper_behaves_as_before`）。cleanup は git で直接消す（`test_N6`）。
- **入力**: host で `agent-vm` が無い、またはヘルパーだけが PATH にある → **期待**: create はどちらも呼ばず、出力は今までどおり（`test_C7_host_without_agent_vm_behaves_as_before`）。cleanup はヘルパーを呼ばない（`test_N7`）。
- **入力**: VM で `.git/worktree` の外の worktree を名指しして cleanup → **期待**: ヘルパーを通さずに git で消す（`test_N8`）。
- **入力**: 既存の `tests/git-worktree-cleanup/run.sh` のすべてのテスト → **期待**: PASS のまま（T1、T2 の Step 4）。冒頭の `AGENT_VM_MARKER` の export で、VM の中で走らせても本物のヘルパーを使わない。
- **入力**: 空白を含む repo のパス → **期待**: VM の `attach` も host の `node-modules-sync` も、パスを 1 つの引数として受け取る（`test_C8_paths_with_a_space_stay_one_argument`）。実機では、orb を通しても 1 つの引数として届く（V4 の 2）。

### 対象外

- 性能効率性: ツールが足すのはヘルパーか agent-vm の呼び出し 1 回で、計測の対象にならない。
- 使用性: 追加の UI は警告の 1 行で、docs の警告表に載せる（T4）。
- セキュリティ: パスの検査はヘルパー（plan-1）と launcher（plan-2）が持つ。ツールは git が返したパスか、自分で組み立てたパスをそのまま渡すだけで、新しい信頼の境界を作らない。

## Round 1 からの変更

- `nm_helper_stub` が呼ばれるたびに `nm.log` を消す。前のテストのログが N7 と N8 に残っていた（logic、実測で 2 FAIL）。
- cleanup は、成功したときもヘルパーの出力（保存先を消せなかった、などの警告）を表示する。`test_N9` を足した（security）。
- cleanup の 64 / 70 / 71 の出典を、ヘルパーの定数名でコメントに書いた（architecture）。
- create の警告のパスを `%q` でクォートした（security）。docs に、host での create が lock と sync の分だけ遅れうることを書いた（architecture）。
- ADR と docs を、T5 の実機検証の前にコミットしても事実と食い違わない書き方にした。
  - ADR は「確認項目は V24〜V29、結果は確認結果に記録する」と書く。
  - docs の 7 節と V28 は「失敗する可能性がある」「回避策がある」と書く。
  - V3 が成り立たない場合に ADR と docs を直す手順を、T5 に足した（scope、data-contract）。
- ADR の Decision に、spec K7 からの差分を足した。外の worktree は git を直接呼ぶ。64 では残す。attach の stdout を捨てる（data-contract）。
- docs の V27 に、R2（host の空の `node_modules`）の確認を足した。docs の T2 の終了コードの文面を確定した（data-contract）。
- T4 の文言の照合を、固定の部分文字列の一覧に変えた。症状の行は照合しない（scope）。
- V3 の【人】の手順を「host で」と明記した。V5 は spec R5 のコマンド（`yarn install`）に合わせ、bun の版を固定した（security、data-contract）。

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator
- verdict: needs-work
- 主指摘: 作業コピーで /bin/bash 3.2 を使って確かめた。
  - create のテスト: 赤は Step 2 の予想どおり。緑は 26/26 PASS。
  - cleanup のテスト: 149 PASS、2 FAIL。`nm_helper_stub` が `$TMP_BASE/nm.log` を消さないので、前のテストのログが N7 と N8 に残る。
  - 実機で、orb の位置引数が空白を含むパスを 1 つの引数で受け取ることを確かめた。

### scope-justification-reviewer
- verdict: needs-work
- 主指摘: ADR と docs が、T5 の実機検証より前に「確認済み」「回避策がある」と書く順序になっている。V3 が失敗したときに、コミット済みの ADR と docs を直す手順が無い。
  - T4 の `grep -F` による照合は、警告表の最終行（症状の行）で必ず失敗する。
  - 申し送りはすべて覆われており、範囲の逸脱は無い。

### architecture-boundary-analyzer
- verdict: pass
- 主指摘: 境界、依存の向き、64 の扱い、外の worktree の迂回、テストの密閉は妥当。軽微な指摘は 2 つある。
  - cleanup の 64 / 70 / 71 の出典（ヘルパーの契約）をコメントで示す。
  - host での create が、lock を待つ間（最大約 5 秒）と sync の間だけ遅くなりうることを docs に書く。

### security-vulnerability-analyzer
- verdict: pass
- 主指摘: `AGENT_VM_MARKER` の上書き、PATH の検索、`--` による引数の区切りに問題は無い。軽微な指摘は 3 つある。
  - V3 の【人】の `rm -rf` を「host の端末で」と明記する。
  - cleanup が成功したときにヘルパーの警告（`err`）を捨てている。
  - V5 の bun の版を固定する。

### data-contract-evolution-evaluator
- verdict: needs-work
- 主指摘: 3 点ある。
  - ADR に、spec K7 からの逸脱が記録されていない（外の worktree は git を直接呼ぶ、64 では残す、attach の stdout を捨てる）。
  - ADR の「V24〜V29 に記録した」が、T5 の前のコミットの時点では成り立たない。
  - docs の V27 の期待に、R2（host の空の `node_modules` で host の install と `tsc` が変わらない）が無い。
  - 軽微な指摘は 2 つある。docs の T2 の終了コードの文面が確定していない。V28 の `yarn install --force` が spec の `yarn install` と違う。

## Reviewer Outputs (Round 2)

### logic-validator
- verdict: pass
- 主指摘: 作業コピーに当てて /bin/bash 3.2 で実行した。
  - create のテスト: 26 PASS / 0 FAIL。
  - cleanup のテスト: 154 PASS / 0 FAIL。Round 1 で FAIL だった N7 / N8 も通った。
  - 成功時の `git worktree remove` は何も出さず、既存のテストに影響しない。
  - T4 の照合の 10 件は、すべて見つかった。

### scope-justification-reviewer
- verdict: pass
- 主指摘: Round 1 の 2 点は解消した。軽微な指摘は 2 つある（反映済み）。
  - V4 と V6 が成り立たないときの訂正の手順を足す。
  - 成功時の出力の表示が host にも効く点を扱う。ヘルパーを通したときだけ表示する形にした。

### data-contract-evolution-evaluator
- verdict: pass
- 主指摘: Round 1 の指摘はすべて解消した。軽微な指摘は 3 つあり、すべて反映済み。
  - 成功時の警告を docs に 1 文書く。
  - show_help の行数の記述を直す。
  - T3 と T4 を 1 つのコミットにする（ADR が参照する docs の節が T4 で入るため）。

### architecture-boundary-analyzer
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### security-vulnerability-analyzer
- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=fb7d68aba5490ae2b1ac3b8b611c7a7ae7558369bfa4fb06cd958dbba66d87e4; design-hash=afc262a28a1c1518b3bdb907479dd18931bc98df9b4e4406e7044ab9ff70420d; round=1; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T06:21:16.425Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=15; excluded=1; at=2026-10-02T06:21:16.446Z -->
<!-- intent-triage: adopted=16; excluded=0; at=2026-10-02T06:21:21.423Z -->

<!-- auto-review: verdict=pass; hash=881473a5d9c9c4c349d2a7cb2ef599c5a22fe309c57c68e7eff5cbf47d07d634; design-hash=292e74e51ea01ca917d12fffa9f7efcd249c300e1abf54842ef9271cbca68fef; round=2; parent-spec-hash=e2c7ba57e41e8bfa1714bdcfe7eae1040274fcc43701ea97798c7fe3034f76ec; at=2026-10-02T06:26:04.199Z; reviewers=logic-validator+scope-justification-reviewer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-10-02T06:26:04.220Z -->
