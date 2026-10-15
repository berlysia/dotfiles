# Claude Code worktree hook: 展開で残った件

## R6: remote-control の worktree が session を終えても片付かない（未達）

- 2026-10-15 の T7c。hook を配った後、`claude-rc@dotfiles` は起動時に settings を読むため、最初の session は `.claude/worktrees/` に作られた（R3: 起動時に読む。再起動で解消）。
- 再起動後、スマホから作った session の worktree は `.git/worktree/worktree-bridge-cse_…`（起点は origin/master）にできた。
- 2 つの session をアプリで削除して終えた。子プロセスは消えたが `WorktreeRemove` は呼ばれず、worktree とブランチが残った（どちらも変更なし・commit なし）。その後サーバーを再起動しても呼ばれなかった。
- 比較: hook 無しの既定（M2）は、session がつながったままサーバーを再起動すると片付いた。対話 session（`claude --worktree` を `/exit`）は hook 経由で片付いた（T7a-5）。
- まだ確かめていないこと: session がつながったままサーバーを止めたときに `WorktreeRemove` が呼ばれるか。
- 当面の対処: 残った `worktree-bridge-*` は、変更が無いことを確かめて `git worktree remove` と `git branch -d`。2026-10-15 の 2 つはそうして消した。
- 次にやること: session がつながったままの停止で確かめる。呼ばれないなら、remote-control の session 終了で worktree を片付ける別の手段（例: SessionEnd hook で、自分の bridge worktree を K4 の判定で片付ける）を spec の変更として検討する。

## R2: workflow agent の worktree が片付かない（未達）

- 2026-10-15 の T7a-3。使い捨て repo で `claude --settings <tmp> -p` の中から Workflow を 1 回（agent 1 つ、`isolation: "worktree"`）。
- worktree は `<repo>/.git/worktree/worktree-wf_3ef3533c-255-1`（ブランチ `worktree-wf_3ef3533c-255-1`）に作られた。WorktreeCreate の name が `agent-<id>` ではなく `wf_<run id>-<n>` の形だった。
- SubagentStop が探すブランチ名は `worktree-agent-<agent_id>` の完全一致なので、この形は片付けの対象にならず、worktree とブランチが残った。
- `-p` の session は workflow の完了を待たずに終わっていた。workflow agent に SubagentStop が来るか、来るなら `agent_id` と `wf_…` の name の対応がどうなるかは、まだ確かめていない。
- 次にやること: 対話 session で workflow を最後まで実行し、SubagentStop（または別のイベント）の入力を記録する hook を足して、name との対応を調べる。対応が取れれば K6 で探すブランチ名に `worktree-wf_*` を加える（spec の変更として扱う）。それまでは `git worktree remove <path>` と `git branch -D worktree-wf_…` で手で消す。
