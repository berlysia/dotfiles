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
- `SubagentStart` は workflow agent にも来て、`additionalContext` も届く（2.1.314 で 1 回観察）。
- `-p` の session は workflow の完了を待たずに終わる。workflow agent に SubagentStop が来るか、来るなら `agent_id` と `wf_…` の name の対応がどうなるかは、まだ確かめていない。
- 次にやること: 対話 session で workflow を最後まで実行し、SubagentStop（または別のイベント）の入力を記録する hook を足して、name との対応を調べる。対応が取れれば K6 で探すブランチ名に `worktree-wf_*` を加える（spec の変更として扱う）。それまでは `git worktree remove <path>` と `git branch -D worktree-wf_…` で手で消す。

## `git-worktree-cleanup` の helper が無いときの削除（未対応）

- VM の中で `agent-vm-node-modules` が無いと、`git-worktree-cleanup` は mount を確かめずに git で消す（`home/dot_local/bin/executable_git-worktree-cleanup` の `nm_helper`）。hook は mountinfo で確かめる（ADR-0033 の Amendments）。
- 次にやること: 同じ判定を cleanup に入れるかを、実害が出たら決める。

## VM で入れ子のパッケージが attach されていないときの install の案内（見送り）

- 観察: `attach` はパッケージごとに mount し、部分的に失敗しうる。`[deps]` の案内は root の `node_modules` だけを調べるので、root が mount 済みで入れ子が未 attach でも install を勧める。
- 最悪の場合: 入れ子の `node_modules` が host と共有のまま VM 向けのパッケージで書かれ、host で `tsc` などが動かなくなる。
- 起きる条件: VM の monorepo で、root の attach が成功し、入れ子の attach が失敗し、root が空のまま agent が案内に従う。
- 見積もり: 実装者は 500 回に 1 回未満、別の subagent は約 1000 回に 1 回未満とした。どちらも attach の失敗率は実測していない。
- 判断（両者同じ）: 戻せないか気づけないか → いいえ（host で install し直せば戻り、host で `tsc` などが落ちるので気づける）。深刻度が高いか → いいえ（データの損失も秘密の漏えいもない）。頻繁に起きるか → いいえ（部分的な失敗と root の mount 済みが同時に要る）。
- 次にやること: 実害が出たら判断し直す。
