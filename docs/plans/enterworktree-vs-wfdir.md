# EnterWorktree と Document Workflow の wfDir が噛み合わない

元のチェックアウトで起動したセッションが、`git-worktree-create` で作ったワークツリーに `EnterWorktree(path)` で入ると、Document Workflow の成果物を書けなくなる。対策を決めて入れたら、このファイルを消す。

## 起きたこと

2026-10-19、writing-skills-by-role の作業で起きた。

- `workflow-cli dir` の wfDir は、起動した dir（`CLAUDE_PROJECT_DIR`）の `.tmp/sessions/<id>` に固定される（`document-workflow-reference` の「worktree で Document Workflow を使う」）
- EnterWorktree 中のセッションは、元のチェックアウトへの Write を拒まれ、research.md を書けなかった
- `ExitWorktree(keep)` で起動した dir に戻り、ワークツリーのファイルは絶対パスで編集して回避した
- 利用者の指摘: ツールの使い方そのものを制限しないと、同じことがまた起きる

## 対策の候補

- `home/dot_claude/rules/developer-experience.md` の Git Worktree Convention に、Document Workflow を伴う作業では EnterWorktree を使わない（絶対パスで編集するか、ワークツリーの中で起動し直す）と書く
- PreToolUse hook で `EnterWorktree` を検査し、wfDir に成果物があるとき、または起動した dir がワークツリーの外のときに deny して、上の 2 通りを案内する
- `document-workflow-reference` の該当節に、EnterWorktree との関係を 1 行足す

## 回避した後に残る注意

- Stop hook の completion-gate は起動した dir（元のチェックアウト）でテストを走らせるので、ワークツリーの変更は自分でワークツリーの中で検証する
