# ADR-0033: Claude Code の worktree を hook で `.git/worktree/` に作り、変更が無ければ hook が片付ける

## Status

accepted (2026-10-15)

## Context

`claude remote-control --spawn worktree`（PR #308 の claude-rc）が、このリポジトリに `.claude/worktrees/bridge-<session id>` を作った。

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
- `git-common-dir` を基準にするので、linked worktree の中から呼ばれてもメインの `.git` の下に作る。
- name は `^[A-Za-z0-9]([A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$` に一致し、`..` を含まず、`.lock` で終わらず、`git check-ref-format --branch` を通るものだけを受け付ける。`/` を通すと置き場が入れ子になり、ref の D/F 衝突が起きるため。Claude Code が生成する名前（`agent-<16進>`、`bridge-cse_…`、`bold-oak-a3f2` 形式）はすべて通る。
- 起点は `origin/HEAD`（fetch しない）。無ければ `HEAD` から切り、stderr に警告を出す。

### D2. 作成は「ブランチを作る → worktree を付ける」の 2 段

- `git branch` は既存のブランチ名を原子的に拒否する。成功した呼び出しだけがそのブランチを作ったと確定する。
- `git worktree add` が失敗したら、自分が作ったブランチだけを消す。条件は、どの worktree にも checkout されていないこと、tip が起点の sha のままであること。削除は `update-ref -d <ref> <起点の sha>`（CAS）で行う。
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

- `lib/claude-worktree-git.ts`（git の実行、制御文字の除去、依存の型）、`lib/claude-worktree.ts`（作成・判定・削除）、`lib/claude-worktree-handlers.ts`（入力 JSON → stdout・stderr・exit code）、entry 2 本の 4 層。依存は entry → handlers → core → git の一方向。
- entry は cc-hooks-ts の `defineHook` を使わない素の bun script。`WorktreeCreate` は stdout の最後の非空行をパスとして読み、JSON を受けない。cc-hooks-ts の `runHook` は入力の検証失敗と例外を exit 1 にするので、`SubagentStop` を常に exit 0 にできない。`implementations/*.ts` で defineHook を使わないのはこの 2 本が初めて。cc-hooks-ts が stdout の生出力と exit code の制御を持てば、entry だけを defineHook に戻せる。
- git の実行は agent-learnings の `runGit` を使わない（timeout 5 秒、stderr を捨てる）。同じ防御（環境変数の許可リスト、`core.fsmonitor=false`、`core.hooksPath=/dev/null`、gpgsign 無効）を写し、stderr を捕捉する。
- 1 回の呼び出しは 200 秒の締め切りを持ち、各 git の timeout はその種類の上限（読み取り 10 秒、`add` / `remove` 120 秒）と残り時間の小さいほう。hook の timeout は 240 秒。
- install しない、lock しない（`git-worktree-cleanup` が常に残し、削除に `-f -f` が要るため）、`.worktreeinclude` に対応しない（使うリポジトリが無い）。

## 却下した代替案

- **`WorktreeCreate` だけを足して `git-worktree-create` を呼ぶ**: remote-control の worktree が `kept` で残り、subagent の worktree も溜まり続ける。`git-worktree-create` は現在の HEAD から切り、依存の install 進捗を stdout に出すので、起点も stdout の契約も合わない。
- **name ごとの lock（`mkdir`）と SIGTERM での巻き戻し**: 設計の途中で入れて外した。守る対象（同じ name の同時作成）は Claude Code が一意の名前を作るので稀なのに、残骸の判定、解放の競合、同期実行中にシグナルハンドラが動かない問題という新しい故障面が増えた。所有の確定は D2 のブランチ作成が担う。
- **hook で `git worktree prune` する**: D4 の理由。
- **hook 導入前の `.claude/worktrees/*` を hook で片付ける**: hook 無しで作られたものは `locked` が付いていて `--force` 1 回では消えず、作成時の reflog も未検証。手で消す（下の手順）。
- **lock 失敗だけを狙ったやり直し**: 計画では lock の競合を想定していた。試して再現したのは別の競合だったので、やり直しの条件はエラー文言で絞らない（「計画から外れた点」）。

## Consequences

### 受け入れたリスク

- **R2**: workflow agent の worktree に `SubagentStop` が来るかは未確認。来なければ worktree が残る。`SubagentStop` を逃した worktree（異常終了を含む）を後から回収する仕組みは無い。`git-worktree-cleanup` は「作ってから commit が無い」worktree を TTY 無しでは消さないので、手で `git worktree remove` と `git branch -D` を実行する。
- **R6**: remote-control と対話 session が、hook で作った worktree について「変更なし」を判定して `WorktreeRemove` を呼ぶかは、展開後の確認に委ねた（確認の結果は下）。
- **R7**: hook の契約（stdout の最後の行がパス、`WorktreeRemove` が呼ばれる条件、`agent_id` と name の対応）は公式 docs と試した結果に依存する。Claude Code の更新で変わると、作成は目に見えて失敗するが、片付けは空振りして worktree が溜まる（目に見えにくい）。下の確認手順で検知する。
- **R10**: `.gitattributes` の filter（smudge / process / clean）は checkout と `git status` で実行されうる。既定の Claude Code も同じ repo で同じ git を呼ぶので、既定より広げない。`core.hooksPath=/dev/null` により `post-checkout` hook は実行されない（既定とは違う）。人が `git-worktree-create worktree-foo` で作った worktree も管理下に入る（`WorktreeRemove` を呼ぶのは Claude Code だけで、自分が作ったパスでしか呼ばない）。作成で使ったブランチの checkout の確認と削除の間に、人が同じブランチを checkout する窓が残る（ミリ秒、同じ name を人と hook が同時に使う場合だけ）。
- 判別できない入力（JSON として読めない、`hook_event_name` が無い）が cleanup の entry に来たら exit 0 にする。`WorktreeRemove` 宛てでも exit 0 になる（Claude Code が読めない JSON を送ることは想定しない）。
- stderr に出す文字列から除く制御文字は C0（`\n` 以外）と `\x7f`。C1（`\x80-\x9f`）と U+2028/2029 は除かない。

## 根拠にした計測（2026-10-15）

- hook 無しの remote-control worktree spawn は `.claude/worktrees/bridge-<id>`、ブランチ `worktree-bridge-<id>`、起点は origin/master（cwd のブランチではない）、`locked`。サーバーの再起動で worktree とブランチが消え、空の `.claude/worktrees/` が残った。
- hook が `<git-common-dir>/worktree/…` に `git worktree add` してパスを返すと、`.git` の下でも受け入れられた（`Refusing to use … as an isolation worktree` にならない）。入力は `name` と `cwd`（起動した repo）。
- subagent の `isolation: "worktree"` は name が `agent-<16進>`。`SubagentStop` の `agent_id` は name から `agent-` を除いたもの、`cwd` は worktree のパス。`WorktreeRemove` は呼ばれない。
- `git worktree add -b` / `git branch` で作ったブランチの reflog は `branch: Created from <起点>` の 1 件で、続く `worktree add` は reflog を足さない。
- ignored ファイルだけがある worktree は `--force` なしの `git worktree remove` で消える。`git -C <common-dir>` は `safe.bareRepository=explicit` で拒否される（メインの worktree を cwd にする）。
- 置き場が既にあって `worktree add` が失敗しても、git は管理用ディレクトリも登録も残さない。同じ名前の `git branch` は `already exists` で原子的に失敗する。

## 展開後の確認（2026-10-15）

| 確認                                                      | 結果                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude --worktree probe -p`                              | `<repo>/.git/worktree/worktree-probe` に作られた                                                                                                                                                                                                                           |
| 何も変更しない subagent（`isolation: "worktree"`）        | 終了後に worktree もブランチも残らなかった                                                                                                                                                                                                                                 |
| workflow agent（`isolation: "worktree"`）                 | **未達**。name が `wf_<run id>-<n>` の形で `worktree-wf_…` に作られ、`SubagentStop` が探すブランチ名（`worktree-agent-<agent_id>`）に当たらず残った。`-p` の session が workflow の完了を待たずに終わったため、workflow agent に `SubagentStop` が来るか自体は未確認（R2） |
| `git-worktree-cleanup --non-interactive`                  | hook が作った worktree を分類し、消さずに残した                                                                                                                                                                                                                            |
| 対話 session（`claude --worktree probe2` を何もせず終了） | `WorktreeCreate` / `WorktreeRemove` とも exit 0、worktree とブランチが消えた                                                                                                                                                                                               |
| `chezmoi apply`（本番反映）                               | settings.json の hooks 以外は変わらず、3 イベントが timer 越しに入った。配置済みの claude-rc は中身が変わらなかった                                                                                                                                                        |
| 動いている `claude-rc@dotfiles`                           | settings を起動時に読む。反映直後の session は `.claude/worktrees/` に作られ、再起動後は `.git/worktree/worktree-bridge-…`（起点 origin/master）に作られた                                                                                                                 |
| remote-control の session をアプリで終える                | **未達**。`WorktreeRemove` は呼ばれず、変更の無い worktree とブランチが残った。その後サーバーを再起動しても呼ばれなかった。session がつながったままの停止は未確認（R6）                                                                                                    |

未達の 2 件の次の手は `docs/plans/claude-worktree-hook-followups.md` にある。

## 計画から外れた点

- 計画では並列の `worktree add` が git の lock で競合することを想定していた。4 並列 × 20 回で再現したのは別の競合で、並行する add が作りかけの管理用ディレクトリを読んで失敗した（`failed to read .git/worktrees/<x>/commondir`）。やり直しは「`add` が失敗し、自分のブランチを巻き戻せたとき 1 回だけ」で、エラー文言では絞らない。
- 作成するパス（common dir）に制御文字があれば作成を失敗にした。spec に無い防御で、stdout のパスを 1 行に保つため。
- `safe.bareRepository=explicit` の環境では、bare のディレクトリを直接 cwd にすると git が拒否するので `not-git` になる。`bare-repo` になるのは bare の linked worktree を cwd にしたとき。
- `chezmoi apply` を umask 022 のシェルから行うと、配る file のモードが 644/755 になる。後で umask 002 のシェルから apply すると、chezmoi が「変更された」とみなして確認を求め、TTY が無いと apply ごと止まる（後続の `run_after_` も実行されない）。Claude から apply するときは `umask 002` を付ける。

## hook 契約への依存と確認手順

Claude Code を更新した後や、片付けが空振りしているように見えるときに、使い捨ての repo で確かめる。hook を `claude --settings <一時ファイル>` で足し、`~/.claude/settings.json` は変えない。

1. `claude --settings <tmp> --worktree probe -p 'pwd'` → `<repo>/.git/worktree/worktree-probe` が返る（stdout の契約）。
2. `claude --settings <tmp> -p '<何も変更させない Agent を isolation: "worktree" で 1 回呼ぶ指示>'` → 終了後に worktree もブランチも残らない（`SubagentStop` の `agent_id` と name の対応）。
3. 2 が残るなら、`SubagentStop` の入力（`agent_id`、`cwd`）と `WorktreeCreate` の `name` を記録する hook を足して、対応が変わっていないかを見る。

## 撤去と復旧

- 撤去（R9）: `home/dot_claude/.settings.hooks.json.tmpl` から `WorktreeCreate`・`WorktreeRemove`・`SubagentStop`（worktree-cleanup.ts）の登録を消して `chezmoi apply`。残った `.git/worktree/worktree-*` は remote-control の片付けで消えなくなる（`WorktreeRemove` が無い）。`git worktree list` で探し、`git worktree remove <path>` と `git branch -D worktree-<name>` で消す。
- hook 導入前の worktree（R4）: `<repo>/.claude/worktrees/*` が残っていたら、`git worktree remove -f -f <path>` と `git branch -D worktree-<name>` で消す（hook 無しで作られたものは `locked` が付いている）。
- `branch-exists` で作成が失敗する: 前の作成が強制終了で途中まで進んだ残骸のことがある。`git branch --list worktree-<name>` と `git log worktree-<name>` で中身が無いことを確かめてから `git branch -D worktree-<name>`。
- prunable な登録が残る: `git worktree prune`（リポジトリ全体が対象になるので、外付けドライブの worktree が見えていることを確かめてから）。

## References

- 実装: `2d627e9`（作成）ほか、この ADR と同じ PR
- `home/dot_claude/rules/developer-experience.md` の Git Worktree Convention
- Claude Code 公式 docs: hooks（`WorktreeCreate` / `WorktreeRemove`）、worktrees、remote-control
