# git-worktree-cleanup

Remove git worktrees whose work is finished, without touching worktrees that other sessions may still be using.

## 概要

`git-worktree-cleanup` は `origin` を fetch したうえで各 worktree を分類し、作業が安全に終わっているものだけを削除します。複数の Claude session が同じ repo で worktree を並行して使っていても、origin に無い commit・`.tmp/` `.entire/` の中身・作業開始直後の worktree を確認なしに消さないことを目的にしています。branch は削除しません。

## 使用方法

```bash
git-worktree-cleanup [--yes | --non-interactive] [--] [<worktree-path | branch>...]
git-worktree-cleanup --help
```

- 引数なし: `<repo>/.git/worktree/` 配下の worktree だけを走査する。それ以外の worktree は「outside .git/worktree」と表示して残す
- target あり: worktree のパス（相対・絶対）か branch 名。置き場の規約外でも対象にできる。解決できない target が 1 つでもあれば何も消さずに終了コード 1 で終わる
- 自分の worktree を片付けるときは、main worktree から `git-worktree-cleanup <branch>` を実行する（worktree の中から呼ぶと、その cwd が使用中として残る）

## オプション

- `--yes`, `-y`: 確認のうち「commit がすべて origin にあり、merged と判定できない」ものだけに yes と答える
- `--non-interactive`, `-n`: 確認せず、確認対象はすべて残す
- `--help`, `-h`: ヘルプを表示

`--yes` と `--non-interactive` は後に書いた方が有効です。stdin が TTY でない場合（パイプ・`</dev/null`・エージェントの Bash 実行など）は `--non-interactive` と同じ動作になります。確認を出すのは TTY のときだけです。

## 分類

各 worktree を上から順に評価し、最初に当たった段で確定します。判定に使う git コマンドが失敗したときは、その段の保守側（KEEP か ASK_HUMAN）に倒れます。

| 段  | 条件                                                                                               | 分類      |
| --- | -------------------------------------------------------------------------------------------------- | --------- |
| 1   | locked（`git worktree lock`）                                                                      | KEEP      |
| 2   | 使用中（自分のプロセスの cwd が worktree 自身かその配下、または実行者の cwd）                      | KEEP      |
| 3   | 未 commit の変更・untracked がある                                                                 | KEEP      |
| 4   | branch の `origin/<branch>` があり、それより先行している                                           | KEEP      |
| 5   | 使用中を検出できない、または `.tmp/` `.entire/` に ignored ファイルがある                          | ASK_HUMAN |
| 6   | 作業開始直後（worktree の HEAD reflog が空・読めない、または全 entry が現在の HEAD と同じ commit） | ASK_HUMAN |
| 7   | merged（tip が `origin/<main>` の祖先、rebase merge、squash merge のいずれか）                     | REMOVE    |
| 8   | origin のどの ref にも無い commit がある                                                           | ASK_HUMAN |
| 9   | それ以外（commit はすべて origin にあるが merged と判定できない。detached HEAD で未 merge を含む） | ASK       |

- `<main>` は `origin/HEAD`、無ければ `origin/main`、`origin/master` の順で決まる。どれも無ければ merged は常に偽になる
- detached HEAD では段 4 を評価しない
- 段 5 の ignored の案内: merged でも `.tmp/sessions/` の spec / plan が `docs/` へ移されていないことがあるため、`(merged: <方式>)` を添えて確認に回す。中身を確認して TTY で `y` と答えるか、中身を移してから再実行する
- `.tmp/` `.entire/` の 2 つは固定。`node_modules/` は再生成できるので対象外

## 処分

| 分類      | 対話（TTY あり） | `--non-interactive` / TTY なし | `--yes` | `--yes` かつ offline |
| --------- | ---------------- | ------------------------------ | ------- | -------------------- |
| KEEP      | 残す             | 残す                           | 残す    | 残す                 |
| REMOVE    | 消す             | 消す                           | 消す    | 消す                 |
| ASK       | 確認             | 残す                           | 消す    | 残す                 |
| ASK_HUMAN | 確認             | 残す                           | 残す    | 残す                 |

- `git fetch --prune origin` が失敗したか origin が無い場合（offline）、`--yes` は `--non-interactive` と同じ結果になります。REMOVE は、古い `origin/<main>` に含まれるものは新しい `origin/<main>` にも含まれるので offline でも消します
- 削除の直前に同じ worktree をもう一度分類し、分類か tip が最初と変わっていれば「state changed since the check」で残します（確認待ちの間に別 session が使い始めた場合を拾う）
- `git worktree remove` は `--force` なしで呼びます。削除の直前にファイルが増えた場合は git が拒否し、その理由を表示して次へ進みます

## 終了コード

| 状況                                                                             | 走査（target なし） | target 指定 |
| -------------------------------------------------------------------------------- | ------------------- | ----------- |
| 対象をすべて処理し、残したものが無い                                             | 0                   | 0           |
| KEEP / ASK / ASK_HUMAN で残した、git が削除を拒否した、offline で ASK を残した   | 0                   | 2           |
| 未知の option、解決できない target（既に消えたものを含む）、main worktree の指定 | 1                   | 1           |

走査で残すのは正常な結果なので 0 です。target 指定で既に消えた target を 1 にするのは、branch 名の打ち間違いと区別できないためです（出力に `git worktree list` で確かめるよう出ます）。

agent-vm の machine の中で、VM ローカルの `node_modules` を外せなかった、lock を取れなかった、ヘルパーが拒否した、のいずれかで残ったときも 2 になる。

## 使用例

```bash
# 自分の branch の worktree だけを片付ける（main worktree から）
git-worktree-cleanup my-branch

# 引数なし: .git/worktree/ 配下を走査し、merged を消す
git-worktree-cleanup --non-interactive

# 確認のうち --yes が答えてよいものにだけ yes と答える
git-worktree-cleanup --yes
```

### 実行例

```text
$ git-worktree-cleanup --non-interactive
🔍 Checking git worktrees...

📁 Checking worktree: /path/to/repo/.git/worktree/feature-a
✓ merged into master (squash)
✓ Removing worktree: /path/to/repo/.git/worktree/feature-a

📁 Checking worktree: /path/to/repo/.git/worktree/feature-b
✗ uncommitted changes - skipping

📁 Checking worktree: /path/to/repo/.git/worktree/feature-c
⚠️  2 commits not on origin
Delete anyway? (y/N) n [non-interactive] - skipping

🧹 Pruning worktree list...

Removed 1, kept 2, outside .git/worktree 0.
```

## 注意事項

- `origin` という名前の remote を前提にします（`git-worktree-create` と同じ前提）
- 作業開始直後かどうかは worktree の HEAD reflog で判定するため、merge 済みの remote branch を `git-worktree-create` で checkout しただけの worktree や、最後に HEAD を動かしてから reflog の期限（既定 90 日）を過ぎた worktree は確認になります。対話で `y` と答えれば消せます
- 使用中の検出は、Linux では `/proc/*/cwd`、それ以外では `lsof` で、自分のユーザーのプロセスの cwd だけを見ます。main worktree で起動した session が絶対パスで別の worktree を使っている場合や、他のユーザーのプロセスは見えません。そのため段 5・6・8 が主な防御です
- merged の判定のために、worktree 1 つにつき最大 1 つの dangling commit object を書きます（ref は動かさず、`git gc` で消えます）
- 削除成功後、`git worktree prune` が自動実行されます
- git 2.36 以降が必要です（`git worktree list --porcelain -z`）
- agent-vm の machine の中（`/etc/agent-vm` があり、`agent-vm-node-modules` がある）では、`.git/worktree` 配下の worktree を `agent-vm-node-modules remove <wt> -- git -C <main> worktree remove -- <wt>` で消す。VM ローカルの `node_modules` を外してから消し、失敗したら張り直す（`docs/decisions/0022-agent-vm-node-modules.md`）。外せない、lock を取れない、ヘルパーが拒否した場合は、理由を表示して worktree を残す。消せた後にヘルパーが出した警告（保存先を消せなかった、など）は、黄色で表示する。host では挙動は変わらない。

### 変更点（2026-10）

- `--yes` が答える範囲が狭まった。従来は確認対象をすべて消したが、今は「commit がすべて origin にあり、merged と判定できない」ものだけを消す
- `--non-interactive` が squash merge / rebase merge 済みの worktree を消すようになった（`.tmp/` `.entire/` に何も無い場合）
- stash 検査を廃止した（worktree を消しても stash は残るため）
- 引数なしの走査が `.git/worktree/` 配下に限られた。規約外の worktree は target で指定する
- `help`（ハイフンなし）を受けなくなり、target として扱う。ヘルプは `--help` / `-h`
- `git worktree remove` から `--force` を外したので、git が削除を拒否することがある
- 終了コード 2（target 指定で残したものがある）を追加した

## 関連コマンド

- `git-worktree-create`: 新しい worktree を作成
- `git worktree list`: 既存の worktree を一覧表示
- `git worktree prune`: worktree リストをクリーンアップ

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-cleanup`

ソースコード: `home/dot_local/bin/executable_git-worktree-cleanup`

テスト: `tests/git-worktree-cleanup/run.sh`
