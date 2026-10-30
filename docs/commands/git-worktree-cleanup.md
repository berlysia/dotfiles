# git-worktree-cleanup

Remove git worktrees whose work is finished, without touching worktrees that other sessions may still be using.

## 概要

`git-worktree-cleanup` は `origin` を fetch したうえで各 worktree を分類し、作業が安全に終わっているものだけを削除します。複数の Claude session が同じ repo で worktree を並行して使っていても、origin に無い commit・`.tmp/` `.entire/` の中身・作業開始直後の worktree を確認なしに消さないことを目的にしています。branch は削除しません。

## 使用方法

```bash
git-worktree-cleanup [--yes | --non-interactive] [--discard-tmp=<id>]... [--] [<worktree-path | branch>...]
git-worktree-cleanup --help
```

- 引数なし: `~/worktrees/<repo>/` と `<repo>/.git/worktree/` の配下の worktree だけを走査する。それ以外の worktree は「outside managed worktree roots」と表示して残す
- target あり: worktree のパス（相対・絶対）か branch 名。置き場の規約外でも対象にできる。解決できない target が 1 つでもあれば何も消さずに終了コード 1 で終わる
- 自分の worktree を片付けるときは、main worktree から `git-worktree-cleanup <branch>` を実行する（worktree の中から呼ぶと、その cwd が使用中として残る）

## オプション

- `--yes`, `-y`: 確認のうち「commit がすべて origin にあり、merged と判定できない」ものだけに yes と答える
- `--non-interactive`, `-n`: 確認せず、確認対象はすべて残す（`--discard-tmp=<id>` が答えるものを除く）
- `--discard-tmp=<id>`: 名指しした target のうち、分類が ASK_TMP で、ファイル一覧の id が `<id>` と一致するものに yes と答える。繰り返せる。target が無い、id が 12 桁の 16 進数でない、のどちらも終了コード 1。短縮形は無い。offline でも働く
- `--help`, `-h`: ヘルプを表示

`--yes` と `--non-interactive` は後に書いた方が有効です。stdin が TTY でない場合（パイプ・`</dev/null`・エージェントの Bash 実行など）は `--non-interactive` と同じ動作になります。確認を出すのは TTY のときだけです。`--discard-tmp=<id>` は TTY の有無に関係なく働きます。

## 分類

各 worktree を上から順に評価し、最初に該当した段で確定します。判定に使う git コマンドが失敗したときは、その段の保守側（KEEP か ASK_HUMAN）に倒れます。

| 段  | 条件                                                                                                               | 分類                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | locked（`git worktree lock`）                                                                                      | KEEP                                                                                                                                |
| 2   | 使用中（自分のプロセスの cwd が worktree 自身かその配下、または実行者の cwd）                                      | KEEP                                                                                                                                |
| 3   | 未 commit の変更・untracked がある                                                                                 | KEEP                                                                                                                                |
| 4   | branch の `origin/<branch>` があり、それより先行している                                                           | KEEP                                                                                                                                |
| 5a  | 使用中を検出できない                                                                                               | ASK_HUMAN                                                                                                                           |
| 5b  | `.tmp/` `.entire/` に ignored ファイルがある                                                                       | ASK_TMP（merged、作業開始直後でない、tip がその worktree で作られた、一覧と id を取れた、の全部を満たすとき）。それ以外は ASK_HUMAN |
| 6   | 作業開始直後（worktree の HEAD reflog が空・読めない、または全 entry が現在の HEAD と同じ commit）                 | ASK_HUMAN                                                                                                                           |
| 7   | merged（tip が `origin/<main>` の祖先、rebase merge、squash merge のいずれか。下の「context を外した比較」を含む） | REMOVE                                                                                                                              |
| 8   | origin のどの ref にも無い commit がある                                                                           | ASK_HUMAN                                                                                                                           |
| 9   | それ以外（commit はすべて origin にあるが merged と判定できない。detached HEAD で未 merge を含む）                 | ASK                                                                                                                                 |

- `<main>` は `origin/HEAD`、無ければ `origin/main`、`origin/master` の順で決まる。どれも無ければ merged は常に偽になる
- detached HEAD では段 4 を評価しない
- context を外した比較: rebase merge と squash merge は、まず `git cherry`（変更行の前後 3 行を含む patch-id）で判定する。当たらないときは、前後の行を外した patch-id で `merge-base..tip` の commit と `merge-base..origin/<main>` の commit を比べ直す。マージの前に main が隣の行を変えていた branch は、こちらで merged になり、出力は `(rebase, context ignored)` / `(squash, context ignored)` になる
  - この比較は、同じファイルに同じ行を足し引きする commit を、位置が違っても同じとみなす。空白だけの違いも同じとみなす。branch の commit すべてが main に相手を持つときだけ merged になる。取り違えても branch は残り、出力の `branch <名前> stays at <tip>` から `git worktree add <path> <branch>` で戻せる
  - detached HEAD の worktree には、この比較を使わない。branch が無く、取り違えると commit を指す ref が残らないためである
- 段 5b の ignored の案内: merged でも `.tmp/sessions/` の spec / plan が `docs/` へ移されていないことがあるため、`(merged: <方式>)` を添えて確認に回す。`<方式>` は `ancestor` `rebase` `squash` と、`rebase, context ignored` `squash, context ignored`。`status.showUntrackedFiles=no` の設定でも `.tmp/` `.entire/` を検知する
  - ASK_TMP では、`.tmp/` `.entire/` のファイルの先頭 20 件と総数、その他の ignored パス（`git status` が畳んだ単位）、一覧の id を理由の直後に出す。一覧の各行は `| ` で始まり、空白を含む名前はシェルのクォート形式で出る
  - id は worktree のパス、branch 名、tip の commit、2 つの一覧から計算する。`.tmp/` `.entire/` のファイルの名前が増減すると変わる。中身の変更と、畳まれた ignored（`node_modules/` など）の中の増減では変わらない。id は一覧が変わっていないことを示すもので、誰かが承認したことを示すものではない。桁数や計算方法が変わった版では、古い出力の id は使えない
  - 片付け方は 3 つ: TTY で `y` と答える / 出力が示した `--discard-tmp=<id> <target>` で再実行する / 中身を移して再実行する
  - 「tip がその worktree で作られた」の判定: HEAD を現在の tip にした reflog entry が、`commit`（amend を含む）か、commit を再生した rebase（`git pull --rebase` を含む）。tip が `git merge` の作った merge commit のときは、merge する前の HEAD で同じ判定をする。fast-forward・reset・checkout・cherry-pick・revert・`git pull` の merge で届いた tip と、reflog が読めない・期限切れ（既定 90 日）の場合は ASK_HUMAN になり、理由に `but its tip was not made in this worktree` が出る
  - その理由: `origin/<main>` や他人の branch へ fast-forward しただけの worktree、reset で main に戻した worktree も merged と判定され、そこにある `.tmp/` は commit 前の plan でありうる。reflog からの推定で、tip の commit を誰が書いたかは見ない
- `.tmp/` `.entire/` の 2 つは固定。`node_modules/` は再生成できるので対象外
- 分類に使うのはこの 2 つだけだが、worktree を消すと ignored ファイルはすべて消える。ASK_TMP の出力は、この 2 つ以外の ignored パスも示す

## 処分

| 分類      | 対話（TTY あり） | `--non-interactive` / TTY なし | `--yes` | `--yes` かつ offline | `--discard-tmp=<id>` を 1 つでも渡した実行                                                             |
| --------- | ---------------- | ------------------------------ | ------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| KEEP      | 残す             | 残す                           | 残す    | 残す                 | 残す                                                                                                   |
| REMOVE    | 消す             | 消す                           | 消す    | 消す                 | 消す                                                                                                   |
| ASK       | 確認             | 残す                           | 消す    | 残す                 | 他の option に従う                                                                                     |
| ASK_TMP   | 確認             | 残す                           | 残す    | 残す                 | id が一致すれば消す（offline でも）。一致しない ASK_TMP は、その実行ではすべて残す（対話でも聞かない） |
| ASK_HUMAN | 確認             | 残す                           | 残す    | 残す                 | 他の option に従う                                                                                     |

- `git fetch --prune origin` が失敗したか origin が無い場合（offline）、`--yes` は `--non-interactive` と同じ結果になります。REMOVE は、古い `origin/<main>` に含まれるものは新しい `origin/<main>` にも含まれるので offline でも消します
- 削除の直前に同じ worktree をもう一度分類し、分類か tip が最初と変わっていれば「state changed since the check」で残します（確認待ちの間に別 session が使い始めた場合を拾う）
- ASK_TMP では、再分類で id も比べる。確認待ちの間に `.tmp/` `.entire/` のファイルが増減していれば残す
- `git worktree remove` は `--force` なしで呼びます。削除の直前に ignored でないファイルが増えた場合は git が拒否し、その理由を表示して次へ進みます。ignored なファイルが増えても git は拒否しません

## 終了コード

| 状況                                                                                                                              | 走査（target なし） | target 指定 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------- |
| 対象をすべて処理し、残したものが無い                                                                                              | 0                   | 0           |
| KEEP / ASK / ASK_TMP / ASK_HUMAN で残した、git が削除を拒否した、offline で ASK を残した                                          | 0                   | 2           |
| 未知の option、`--discard-tmp` に target が無い、id の形が違う、解決できない target（既に消えたものを含む）、main worktree の指定 | 1                   | 1           |

走査で残すのは正常な結果なので 0 です。target 指定で既に消えた target を 1 にするのは、branch 名の打ち間違いと区別できないためです（出力に `git worktree list` で確かめるよう出ます）。

agent-vm の machine の中で、VM ローカルの `node_modules` を外せなかった、lock を取れなかった、ヘルパーが拒否した、のいずれかで残ったときも 2 になる。

## 使用例

```bash
# 自分の branch の worktree だけを片付ける（main worktree から）
git-worktree-cleanup my-branch

# 引数なし: ~/worktrees/<repo>/ と .git/worktree/ の配下を走査し、merged を消す
git-worktree-cleanup --non-interactive

# 確認のうち --yes が答えてよいものにだけ yes と答える
git-worktree-cleanup --yes

# 中身を確認した人の答えを受けて、.tmp/ ごと消す（id は残したときの出力にある）
git-worktree-cleanup --discard-tmp=3f2a9c1b7d04 my-branch
```

### 実行例

```text
$ git-worktree-cleanup --non-interactive
🔍 Checking git worktrees...

📁 Checking worktree: /home/you/worktrees/repo/feature-a
✓ merged into master (squash)
✓ Removing worktree: /home/you/worktrees/repo/feature-a

📁 Checking worktree: /home/you/worktrees/repo/feature-b
✗ uncommitted changes - skipping

📁 Checking worktree: /home/you/worktrees/repo/feature-c
⚠️  2 commits not on origin
Delete anyway? (y/N) n [non-interactive] - skipping

🧹 Pruning worktree list...

Removed 1, kept 2, outside managed worktree roots 0.
```

## 注意事項

- `origin` という名前の remote を前提にします（`git-worktree-create` と同じ前提）
- 作業開始直後かどうかは worktree の HEAD reflog で判定するため、merge 済みの remote branch を `git-worktree-create` で checkout しただけの worktree や、最後に HEAD を動かしてから reflog の期限（既定 90 日）を過ぎた worktree は確認になります。対話で `y` と答えれば消せます
- 使用中の検出は、Linux では `/proc/*/cwd`、それ以外では `lsof` で、自分のユーザーのプロセスの cwd だけを見ます。main worktree で起動した session が絶対パスで別の worktree を使っている場合や、他のユーザーのプロセスは見えません。そのため段 5・6・8 が主な防御です
- merged の判定のために、worktree 1 つにつき最大 1 つの dangling commit object を書きます（ref は動かさず、`git gc` で消えます）。context を外した比較は object を書きません
- 削除成功後、`git worktree prune` が自動実行されます
- `permission-auto-approve` が静的に allow するのは、`--yes` `--non-interactive` `--help`（と短縮形）、`2>&1` などの redirect、英数字と `_ . / @ + -` だけの target を引数に持つ呼び出しです。`--discard-tmp=<id>`、`--`、引用符つきの target などを含む呼び出しは次の層に回ります。次の層が allow すれば人間の確認なしに実行されます。人間に聞くことは `~/.claude/rules/developer-experience.md` の手順で定めており、機構による保証ではありません
- `git worktree remove --force` や `rm -rf` を直接呼べば、このツールの判定は通りません
- git 2.36 以降が必要です（`git worktree list --porcelain -z`）
- agent-vm の machine の中（`/etc/agent-vm` があり、`agent-vm-node-modules` がある）では、管理下の置き場の worktree を `agent-vm-node-modules remove <wt> -- git -C <main> worktree remove -- <wt>` で消す。VM ローカルの `node_modules` を外してから消し、失敗したら張り直す（`docs/decisions/0022-agent-vm-node-modules.md`）。外せない、lock を取れない、ヘルパーが拒否した場合は、理由を表示して worktree を残す。消せた後にヘルパーが出した警告（保存先を消せなかった、など）は、黄色で表示する。host では挙動は変わらない。

## Claude Code の worktree hook の確認手順

hook（`WorktreeCreate` / `WorktreeRemove` / `SubagentStop`）は、`~/worktrees/<repo>/worktree-<name>` に worktree を作り、変更が無ければ片付ける（ADR-0033）。Claude Code を更新した後や、片付けが空振りしているように見えるときに、使い捨ての repo で確かめる。hook は `claude --settings <一時ファイル>` で足し、`~/.claude/settings.json` は変えない。

1. `claude --settings <tmp> --worktree probe -p 'pwd'` を実行する。`~/worktrees/<repo>/worktree-probe` が返る（stdout の契約）
2. 何も変更させない Agent を `isolation: "worktree"` で 1 回呼ぶ指示を `claude --settings <tmp> -p` に渡す。終了後に worktree もブランチも残らない（`SubagentStop` の `agent_id` と name の対応）
3. 2 で残るなら、`SubagentStop` の入力（`agent_id`、`cwd`）と `WorktreeCreate` の `name` を記録する hook を足して、対応が変わっていないかを見る

### 手で片付けるとき

- hook の登録を外した後に残った `~/worktrees/<repo>/worktree-*` と `.git/worktree/worktree-*`: `git worktree list` で探し、`git worktree remove <path>` と `git branch -D worktree-<name>` で消す
- hook を入れる前の `<repo>/.claude/worktrees/*`: hook 無しで作られたものは `locked` が付いているので、`git worktree remove -f -f <path>` と `git branch -D worktree-<name>` で消す
- `branch-exists` で作成が失敗する: 前の作成が強制終了で途中まで進んだ残骸のことがある。`git branch --list worktree-<name>` と `git log worktree-<name>` で中身が無いことを確かめてから `git branch -D worktree-<name>` する
- prunable な登録が残る: `git worktree prune`。リポジトリ全体が対象になるので、外付けドライブの worktree が見えていることを確かめてから実行する

## 関連コマンド

- `git-worktree-create`: 新しい worktree を作成
- `git worktree list`: 既存の worktree を一覧表示
- `git worktree prune`: worktree リストをクリーンアップ

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-cleanup`

ソースコード: `home/dot_local/bin/executable_git-worktree-cleanup`

テスト: `tests/git-worktree-cleanup/run.sh`
