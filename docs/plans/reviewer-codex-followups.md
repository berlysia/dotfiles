# reviewer を Codex で実行する仕組みの残件

この PR は、`~/.claude/scripts/reviewer-codex-run.ts` と、1 行を足した reviewer の定義を追加する。`chezmoi apply` がこれらを `~/.claude/` の下に置いたら、次の確認をする。確かめたらこのファイルを消す。

## apply の後に、定義の 1 行から通して確かめる

merge の前の確認では、定義の 1 行を依頼文にコピーし、スクリプトは worktree のパスで呼んだ。subagent が読むのは `~/.claude/agents/` に置かれた定義だけなので、apply の後にもう一度確かめる。

1. この PR の merge を確かめてから、引数なしで `chezmoi apply` を実行する
2. 確認用の依頼本文を Write で scratchpad のファイルに書く。中身は、この PR の差分の 1 ファイルを読ませる短いレビューの依頼にする
3. logic-validator を Agent の `model: "haiku"` で起動する。依頼は `executor: codex` / `brief: <そのファイルの絶対パス>` / `root: <リポジトリの絶対パス>` の 3 行だけにする
4. 返答が `reviewed-by: codex` と `reviewer: logic-validator` で始まり、最後の行が verdict であることを確かめる

この形で返ったら、このファイルを消す commit を作る。返らなければ `executor: codex` を使わない運用に戻す。定義の 1 行は `executor: codex` の依頼でしか働かないので、使わなければ今までと同じに動く。原因はこのファイルに書き足す。
