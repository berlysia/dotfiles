# Claude Code worktree hook: 展開で残った件

## R6: remote-control の worktree が session を終えても片付かない（未達）

- hook を配った後、`claude-rc@<name>` は起動時に settings を読むため、最初の session は `.claude/worktrees/` に作られる（R3: 起動時に読む。再起動で解消）。
- 再起動後にスマホから作った session の worktree は `.git/worktree/worktree-bridge-cse_…`（起点は origin/master）にできる。
- session をアプリで削除して終えると、子プロセスは消えるが `WorktreeRemove` は呼ばれず、worktree とブランチが残る（変更なし・commit なし）。サーバーを再起動しても呼ばれない。
- 比較: hook 無しの既定（M2）は、session がつながったままサーバーを再起動すると片付く。対話 session（`claude --worktree` を `/exit`）は hook 経由で片付く（T7a-5）。
- まだ確かめていないこと: session がつながったままサーバーを止めたときに `WorktreeRemove` が呼ばれるか。
- 当面の対処: 残った `worktree-bridge-*` は、変更が無いことを確かめて `git worktree remove` と `git branch -d`。
- 次にやること: session がつながったままの停止で確かめる。呼ばれないなら、remote-control の session 終了で worktree を片付ける別の手段（例: SessionEnd hook で、自分の bridge worktree を K4 の判定で片付ける）を spec の変更として検討する。

## R2: workflow agent の worktree が片付かない（未達）

- 再現: 使い捨て repo で `claude --settings <tmp> -p` の中から Workflow を 1 回（agent 1 つ、`isolation: "worktree"`）。
- worktree は `<repo>/.git/worktree/worktree-wf_<run id>-<n>`（ブランチ `worktree-wf_<run id>-<n>`）に作られる。WorktreeCreate の name が `agent-<id>` ではなく `wf_<run id>-<n>` の形になる。
- SubagentStop が探すブランチ名は `worktree-agent-<agent_id>` の完全一致なので、この形は片付けの対象にならず、worktree とブランチが残る。
- `-p` の session は workflow の完了を待たずに終わる。workflow agent に SubagentStop が来るか、来るなら `agent_id` と `wf_…` の name の対応がどうなるかは、まだ確かめていない。
- 次にやること: 対話 session で workflow を最後まで実行し、SubagentStop（または別のイベント）の入力を記録する hook を足して、name との対応を調べる。対応が取れれば K6 で探すブランチ名に `worktree-wf_*` を加える（spec の変更として扱う）。それまでは `git worktree remove <path>` と `git branch -D worktree-wf_…` で手で消す。

## RC の --spawn worktree で作った worktree に依存が入らない

未達・未調査。出どころ: dotfiles-feedback 20261029T102037Z-f1232d2a1cfe。

- **観察**（2026-10-29、dotfiles）: `claude remote-control --spawn worktree` で始まった session を調べた。
  - その worktree に `node_modules` が無かった
- completion-gate の Stop hook が typecheck と test を実行すると、`cc-hooks-ts` などが見つからず 172 件が落ち、完了が拒まれた。
- `bun install --frozen-lockfile` を手で実行すると、typecheck は通った。
- `git-worktree-create` は `resolve_install` で lockfile に合う install を実行する。WorktreeCreate hook（`home/dot_claude/hooks/implementations/worktree-create.ts`）には、install の処理が見当たらない。
- **期待**: RC や EnterWorktree の経路で作った worktree にも、`git-worktree-create` と同じ規則で依存が入る。
- **未決**:
  - hook の中で install を実行すると WorktreeCreate が遅くなる。install を hook の中でするか、Stop の前に別の手段で用意するかを決める
  - `resolve_install` の規則を hook と共有する形にするか。シェルの関数を TypeScript に移すか、hook から `git-worktree-create` の該当部分を呼ぶかを選ぶ
  - 送った人は WorktreeCreate hook の中身を読んだ範囲で書いている。対話 session の `claude --worktree` でも同じ状態になるかは、確かめていない
