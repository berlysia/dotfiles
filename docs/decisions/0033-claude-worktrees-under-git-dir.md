# ADR-0033: Claude Code の worktree を hook で `.git/worktree/` に作り、変更が無ければ hook が片付ける

## Status

accepted (2026-10-15)

## Context

`claude remote-control --spawn worktree` が、このリポジトリに `.claude/worktrees/bridge-<session id>` を作った。

- 規約（`home/dot_claude/rules/developer-experience.md` の Git Worktree Convention）は worktree を `<repo>/.git/worktree/<branch>` に置き、`.claude/worktrees/` を禁じている。
- `git status` に `?? .claude/worktrees/` が出た。どこにも ignore されていなかった。
- pre-commit の oxlint は `.` を走査する。worktree の中の `custom-lint-plugin.mjs` を拾い、プラグインの二重登録で commit が失敗した。
- `.git/` の下に置けば、リポジトリを走査するツールにも `git status` にも見えない。

Claude Code は、`WorktreeCreate` hook を定義するとそれで既定の worktree 作成を置き換える（公式 docs の hooks / worktrees）。置き換わるのは作成だけではない。ブランチの作成、起点の選択、片付けの判断もまとめて hook の責任になる。

- `WorktreeCreate` だけを定義すると、remote-control の片付けは `worktree removal failed, kept` になり、worktree が残る（docs）。
- subagent の `isolation: "worktree"` は、hook 経由だと終了しても `WorktreeRemove` が呼ばれない（試した結果）。hook が無いときは、変更の無い subagent の worktree は自動で消えていた。
- matcher は無く、全リポジトリの、worktree を作るすべての場面（`--worktree`、`EnterWorktree`、subagent、workflow agent、background session、remote-control）で発火する。

## Decision

### D1. 置き場とブランチ

- 置き場は `<git-common-dir>/worktree/worktree-<name>`、ブランチは `worktree-<name>`。既定のブランチ名を保ち、ディレクトリ名とブランチ名を一致させる。
- `git-common-dir` を基準にするので、linked worktree の中から呼ばれてもメインの `.git` の下に作る。common dir に制御文字があれば作成を失敗にする（stdout のパスを 1 行に保つため）。
- name は英数字を基調にした限定的な文字種だけを受け付け、`..`、`.lock` の接尾、`git check-ref-format --branch` を通らない名前は拒否する。`/` を通すと置き場が入れ子になり、ref の D/F 衝突が起きるため。Claude Code が生成する名前（`agent-<16進>`、`bridge-cse_…`、`bold-oak-a3f2` 形式）はすべて通る。
- 起点は `origin/HEAD`（fetch しない）。無ければ `HEAD` から切り、stderr に警告を出す。

### D2. 作成は「ブランチを作る → worktree を付ける」の 2 段

- `git branch` は既存のブランチ名を原子的に拒否する。成功した呼び出しだけがそのブランチを作ったと確定する。
- `git worktree add` が失敗したら、自分が作ったブランチだけを消す。条件は、どの worktree にも checkout されていないこと、tip が起点の sha のままであること。削除は `update-ref -d <ref> <起点の sha>`（CAS）で行う。
- 並行する `add` は、別の呼び出しが作りかけの管理用ディレクトリを読んで失敗することがある。自分のブランチを巻き戻せたときに限り 1 回だけやり直す。エラー文言では絞らない。
- 再利用は「同じ置き場に、同じブランチで登録済み」のときだけ。ブランチだけがある場合は `branch-exists` で失敗し、人のブランチを奪わない。

### D3. 「新しい作業が無い」の判定

次の 3 つをすべて満たすときだけ「作業なし」とする。外れたら残す。

1. worktree の HEAD が `refs/heads/<ディレクトリ名>` を指す（detached や別ブランチは「作業あり」）。
2. ブランチの reflog がちょうど 1 件で、メッセージが `branch: Created from ` で始まる。
3. ブランチの tip がその 1 件の new-sha と等しい。

作成時の commit を別ファイルに記録しない。git の reflog はブランチと一緒に生き、ブランチが消えれば判定も要らない。条件 2 を「1 件ちょうど」にしたのは、reflog の切り詰めや reset による誤判定を「残す」側に倒すため。

### D4. 片付け

- `WorktreeRemove`: 管理下の場所（`<common-dir>/worktree/worktree-*` の直下）で登録済み、かつ HEAD が自分のブランチを指す worktree だけを `git worktree remove --force` で消す。ブランチは D3 を満たすときだけ CAS で消す。存在せず未登録のパスには何もせず exit 0（冪等）。
- `SubagentStop`: `agent_id` から `worktree-agent-<agent_id>` のブランチを持つ登録を完全一致で探す。D3 を満たし、`git status --porcelain` が空のときだけ、`--force` なしで消す。exit code は常に 0（exit 2 は subagent の停止を妨げる）。
- hook は `git worktree prune` を呼ばない。prune はリポジトリ全体の prunable な登録を消し、外付けドライブなどで一時的に見えないだけの worktree も巻き込むため。

### D5. 実装の形

- 依存は entry → handlers → core → git の一方向の 4 層にする。
- entry は cc-hooks-ts の `defineHook` を使わない素の bun script にする。`WorktreeCreate` は stdout の最後の非空行をパスとして読み、JSON を受けない。cc-hooks-ts の `runHook` は入力の検証失敗と例外を exit 1 にするので、`SubagentStop` を常に exit 0 にできない。cc-hooks-ts が stdout の生出力と exit code の制御を持てば、entry だけを defineHook に戻せる。
- git の実行は agent-learnings の `runGit` を使わない（stderr を捨てるため）。同じ防御（環境変数の許可リスト、`core.fsmonitor=false`、`core.hooksPath=/dev/null`、gpgsign 無効）を写し、stderr を捕捉する。
- 1 回の呼び出しは締め切りを持ち、各 git の timeout はその残り時間を超えない。
- install しない、lock しない（`git-worktree-cleanup` が常に残し、削除に `-f -f` が要るため）、`.worktreeinclude` に対応しない（使うリポジトリが無い）。

## 却下した代替案

- **`WorktreeCreate` だけを足して `git-worktree-create` を呼ぶ**: remote-control の worktree が `kept` で残り、subagent の worktree も溜まり続ける。`git-worktree-create` は現在の HEAD から切り、依存の install 進捗を stdout に出すので、起点も stdout の契約も合わない。
- **name ごとの lock（`mkdir`）と SIGTERM での巻き戻し**: 設計の途中で入れて外した。守る対象（同じ name の同時作成）は Claude Code が一意の名前を作るので稀なのに、残骸の判定、解放の競合、同期実行中にシグナルハンドラが動かない問題という新しい故障面が増えた。所有の確定は D2 のブランチ作成が担う。
- **hook で `git worktree prune` する**: D4 の理由。
- **hook 導入前の `.claude/worktrees/*` を hook で片付ける**: hook 無しで作られたものは `locked` が付いていて `--force` 1 回では消えず、作成時の reflog も未検証。手で消す（R4）。
- **lock 失敗だけを狙ったやり直し**: 計画では lock の競合を想定していたが、再現したのは D2 の別の競合だったので、やり直しの条件を文言で絞らない。

## Consequences

- **R2**: workflow agent の worktree に `SubagentStop` が来るかは未確認。展開後に試すと、name が `wf_<run id>-<n>` の形で `SubagentStop` が探すブランチ名に当たらず残り、`-p` の session が workflow の完了を待たずに終わったため、`SubagentStop` が来るか自体は分からなかった。来なければ worktree が残る。`SubagentStop` を逃した worktree（異常終了を含む）を後から回収する仕組みは無い。`git-worktree-cleanup` は「作ってから commit が無い」worktree を TTY 無しでは消さないので、手で `git worktree remove` と `git branch -D` を実行する。
- **R4**: hook 導入前に作られた `.claude/worktrees/*` は、`locked` が付いていて hook では片付けない。手で消す。
- **R6**: remote-control と対話 session が、hook で作った worktree について「変更なし」を判定して `WorktreeRemove` を呼ぶかは、展開後の確認に委ねた。対話 session では呼ばれて消えた。remote-control の session をアプリで終えても `WorktreeRemove` は呼ばれず、変更の無い worktree とブランチが残った。session がつながったままの停止は未確認である。次の手は `docs/plans/claude-worktree-hook-followups.md` にある。
- **R7**: hook の契約（stdout の最後の行がパス、`WorktreeRemove` が呼ばれる条件、`agent_id` と name の対応）は公式 docs と試した結果に依存する。Claude Code の更新で変わると、作成は目に見えて失敗するが、片付けは空振りして worktree が溜まる（目に見えにくい）。確認手順は `docs/commands/git-worktree-cleanup.md` の「Claude Code の worktree hook の確認手順」にある。
- **R9**: 撤去は、`home/dot_claude/.settings.hooks.json.tmpl` から `WorktreeCreate`・`WorktreeRemove`・`SubagentStop` の登録を消して `chezmoi apply` する。残った `.git/worktree/worktree-*` は remote-control の片付けで消えなくなるので手で消す。復旧の手順は上の文書にある。
- **R10**: `.gitattributes` の filter（smudge / process / clean）は checkout と `git status` で実行されうる。既定の Claude Code も同じ repo で同じ git を呼ぶので、既定より広げない。`core.hooksPath=/dev/null` により `post-checkout` hook は実行されない（既定とは違う）。人が `git-worktree-create worktree-foo` で作った worktree も管理下に入る（`WorktreeRemove` を呼ぶのは Claude Code だけで、自分が作ったパスでしか呼ばない）。
- 判別できない入力が cleanup の entry に来たら exit 0 にする。

## References

- `home/dot_claude/rules/developer-experience.md` の Git Worktree Convention
- Claude Code 公式 docs: hooks（`WorktreeCreate` / `WorktreeRemove`）、worktrees、remote-control
