# git-worktree-deps

Prepare the dependencies of a git worktree

## 概要

`git-worktree-deps` は、作った worktree でテストや lint を実行できるように、依存を準備する。`git-worktree-create` と Claude Code の `WorktreeCreate` hook の両方がこれを呼ぶので、どちらで作っても同じ条件で install される。

agent-vm の machine の中では、VM ローカルの `node_modules` を attach してから install する。host では、install してから動いている machine に sync を頼む。attach に失敗したら install しない。

PM の判定と実行するコマンドは [git-worktree-create](./git-worktree-create.md) の「依存のインストール」と同じである。

## 使用方法

```bash
git-worktree-deps [--no-install] [--source new|local|remote] [--timeout <秒>] <worktree>
```

- `--no-install`: PM の実行だけを省き、実行するコマンドを表示する。attach と sync は行う
- `--source`: コードの出どころ。`new`（省略時）と `local` は install する。`remote` は `origin/<branch>` から取り込んだコードで、`package.json` の script を読んでいないので、install せずコマンドを表示する
- `--timeout`: この CLI の開始から数えた秒数で、install を打ち切る。attach にかかった時間は install の持ち時間から引く。`timeout` か `gtimeout` が必要で、どちらも無ければ install しない

install の失敗と打ち切りでは、警告を出して終了コード 0 で終わる。worktree 自体は使えるからである。指定の誤りだけが終了コード 1 になる。

## 途中で終わった install

install が失敗か打ち切りで終わると、`node_modules` の中身を消す。途中まで入った `node_modules` があると、依存が入ったものと誤解されるからである。

- 消すのは、install の前に `node_modules` が無いか空だったときだけである
- install の前から中身があれば消さず、警告だけ出す
- symlink の `node_modules` には触らない
- `node_modules` のディレクトリ自体は残す。VM では mount 先だからである

消している間は `node_modules/.git-worktree-deps-incomplete` を置き、消し終えたら取り除く。このファイルが残っていれば、消す作業が途中で止まっている。次の案内は未 install と伝え、この CLI の再実行を勧める。再実行すると中身を消し直して install する。

## Claude Code の worktree

`WorktreeCreate` hook は、新しく作った worktree に `--source new --timeout <残り時間>` で呼ぶ。name が `agent-` か `wf_` で始まる worktree と、再利用した worktree には `--no-install` で呼ぶ。理由と期限の計算は ADR-0033 の Amendments にある。

install しなかった worktree には、依存が無いことを hook の案内（`[deps]`）で伝える。セッションには `SessionStart` で、subagent には `SubagentStart` で届く。

## 実装

スクリプトの場所: `~/.local/bin/git-worktree-deps`

ソースコード: `home/dot_local/bin/executable_git-worktree-deps`

テスト: `tests/git-worktree-deps/run.sh`
