# Research: Claude Code scratchpad の定期 GC

調査日: 2026-10-04。対象は macOS の 1 台。
計測はすべて読み取りのみで、削除は行っていない。
セッションやプロジェクトを特定する値（session id、プロジェクト名、ユーザー名を含むパス）は、この文書では伏せて記号に置き換えている。

## 1. オーダー

Claude Code のセッション scratchpad（`/private/tmp/claude-<uid>/<project>/<session-id>/`）を定期的に GC する仕組みを、この dotfiles に追加する。
発端は 2026-10-04 の実測で、scratchpad の合計が 8.8GB、ディスク空きが 122MB まで減った。
最大は 1 セッションで 5.9GB、最も古いものでも 3 日程度だった（ユーザーの実測。手動掃除の後なので、本調査では再現できない）。
macOS は `/private/tmp` を再起動時にしか掃除しない。調査時点で 3 週間以上、再起動していなかった。

## 2. 対象ディレクトリの実態（手動掃除の後）

`/private/tmp/claude-<uid>/` の合計は 279MB。

### 2.1 階層は一様ではない

| 階層                        | 実際にあるもの                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1 階層目（ディレクトリ 13） | プロジェクトの絶対パスをハイフン化した名前が 10。それ以外に、プロジェクト名でないディレクトリが 3                         |
| 1 階層目（ファイル 27）     | `cache-break-state-<session-id>.json` が 22。ほかに、セッションと無関係な一時ファイルが 5                                 |
| 2 階層目                    | UUID 形式（8-4-4-4-12）のディレクトリが 79。UUID でないものは、1 階層目のプロジェクト名でないディレクトリの配下だけにある |
| 3 階層目                    | `scratchpad` が 77、`tasks` が 34。それ以外は、プロジェクト名でないディレクトリの配下                                     |

- セッションディレクトリの中身は `scratchpad/` と `tasks/`（バックグラウンドタスクの出力）の 2 種類。
- 3 階層目までに symlink は無い（`find -maxdepth 3 -type l` が 0 件）。
- 79 のうち 50 以上は中身が空（0KB）。

### 2.2 終了判定に使える信号の比較

79 セッションのうち上位 40 を、信号ごとの経過時間（時間単位）で並べた。抜粋:

| session | サイズ | 配下の最新ファイル | ディレクトリ mtime | transcript mtime | 備考                                                  |
| ------- | ------ | ------------------ | ------------------ | ---------------- | ----------------------------------------------------- |
| A       | 91MB   | 57h                | 66h                | 65h              | 終了済み                                              |
| B       | 7.6MB  | 53h                | 59h                | 52h              | scratchpad 内のスクリプトのプロセスが 40 個残っている |
| C       | 2.5MB  | 44h                | 47h                | **25h**          | scratchpad を触らずに会話だけ続いた                   |
| D       | 8KB    | **0h**             | **24h**            | 0h               | ディレクトリ mtime が配下の更新を反映しない           |
| E       | 212KB  | 0h                 | 1h                 | 0h               | 実行中                                                |
| F       | 4KB    | 0h                 | 0h                 | 0h               | 調査を行ったセッション                                |

transcript は `~/.claude/projects/<project>/<session-id>.jsonl`。79 のうち数件は transcript が無い。

読み取れること:

- ディレクトリ mtime は配下の更新を反映しない（D: 配下 0h、ディレクトリ 24h）。既存 GC の `find -maxdepth 1 -mtime` はここでは使えない。
- 配下の最新ファイル mtime だけでも足りない（C: 配下 44h、transcript 25h）。
- transcript mtime は「会話が続いているか」を表すが、存在しないセッションがある。

### 2.3 実行中セッションとプロセスの信号

- `~/.claude/sessions/<pid>.json` が実行中セッションの登録簿になっている。キーは `pid`、`sessionId`、`cwd`、`kind`、`status`、`updatedAt` など。調査時点の 3 件はすべて pid が生きていて、`sessionId` は 2.2 で最新ファイルが「0h」だったセッションと一致した。
  - これは Claude Code の内部形式で、文書化された契約ではない。版が変われば形式も変わりうる。
  - 同じディレクトリに `<pid>.<hash>.key` がある。GC は読む必要がない。
- `claude` 本体のプロセス引数には session id が出ない（`--resume` / `--session-id` の一致は 0 件）。プロセス引数から実行中セッションを引くことはできない。
- 孤児プロセスは引数と cwd の両方に出る。B は `ps` の引数で 40 件が一致し、`lsof -d cwd` でも `cat`、`tee`、`bash`、`zsh` が scratchpad の配下を cwd にしていた。`cat` と `tee` は引数にパスを持たないので、引数だけ見ると数え漏らす。
- 実行中の Claude Code の環境変数に `CLAUDE_CODE_SESSION_ID` がある。一時ディレクトリの場所を上書きする変数は設定されていなかった。

### 2.4 未確認のこと

- Linux での scratchpad の場所。`/tmp/claude-<uid>/` と推測されるが、実機では確かめていない。
- 8.8GB・5.9GB という数字。掃除の後なので本調査では再現していない。
- `~/.claude/sessions/*.json` が、クラッシュしたセッションの分をいつ消すか。調査時点では 3 件とも生きていたので、死んだ pid の登録が残る場合の挙動は見ていない。

## 3. 既存の仕組み

### 3.1 `run_after_gc.sh.tmpl`

- `chezmoi apply` のたびに呼ばれ、`~/.claude/.last-gc` で 7 日に 1 回に絞る（`home/.chezmoiscripts/run_after_gc.sh.tmpl:11-23`）。
- `.tmp/sessions/` の削除は `find "$SESSIONS_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} +`（同 `:28-35`）。対象の根はテンプレートで固定され、深さは 1 に限られる。
- 出力は標準出力への `[日時] [GC] ...` だけで、ファイルには残らない。
- `set -euo pipefail` で動く。ADR-0017 R1 は、これが `run_after_` の途中で落ちると後続の verifier が走らないことをリスクとして挙げている。
- テストは無い（`tests/`、`scripts/`、`.github/` に参照なし）。
- CONTEXT.md の「Chezmoi 用語」と「GC スクリプト」の節が、この SAFE pattern を説明している。

### 3.2 launchd の定期実行（distill-insights）

- plist: `home/Library/LaunchAgents/com.berlysia.distill-insights.plist.tmpl`。`StartCalendarInterval` で毎日 04:00、`RunAtLoad` あり、`ProcessType=Background`、`LowPriorityIO`、`Umask=63`。`StandardOutPath` は無い。
- 登録: `home/.chezmoiscripts/run_after_register-distill-insights-schedule.sh.tmpl`。毎回の apply で走り、plist の sha256 が前回ロード時と同じなら何もしない。失敗は WARNING と復旧コマンドを出して exit 0（ADR-0017 K2 / R1）。Linux は systemd の user timer。
- 本体: `home/dot_claude/scripts/executable_run-distill-insights.sh`。
  - ログは `~/.claude/logs/insights/distill-run.log`、形式は `[日時] [LEVEL] msg`、終了時に末尾 2000 行へ切り詰める。
  - 多重起動は `flock` か `lockf` で防ぐ。
  - 失敗は `last-run-failed` に 1 行で残す。
- `run_after_zz-verify-provisioning` は distill-insights の登録を検査していない。

### 3.3 置き場所の慣習

- スケジューラが指すジョブ本体は `home/dot_claude/scripts/executable_*.sh`（`~/.claude/scripts/`）。
- 人が叩く CLI は `home/dot_local/bin/executable_*`（`~/.local/bin/`）。

### 3.4 テストと lint

- shell のテストは `tests/<name>/run.sh` 形式。`tests/git-worktree-cleanup/run.sh` は `mktemp -d` で作った場所に `HOME` などを向け、対象スクリプトを直接実行して `assert_*` で結果を確かめる。CI は ubuntu と macOS の両方で、macOS は `/bin/bash`（3.2）で動かす。
- `scripts/lint-shell.sh` が shebang で対象を見つけ、`*.sh.tmpl` は darwin / linux / linux-wsl の 3 通りに描画して shellcheck にかける。CI と pre-commit は全 severity で落とす。
- `scripts/smoke-chezmoi-scripts.sh` は `tests/smoke/<script-name>/<scenario>/setup.sh` を持つ `.chezmoiscripts` を、隔離した HOME で描画して実行する。

### 3.5 削除を拒否する hook

- `home/dot_claude/hooks/lib/command-parsing.ts:121-137` が Bash tool のコマンド文字列を見て、`rm` に再帰と強制のフラグがあり、後ろに `/` で始まる語があれば「Dangerous system deletion」、`$` か `{` を含めば「rm -rf with variable substitution is too dangerous」で拒否する。
- 見るのは Bash tool に渡したコマンド文字列だけ。スクリプトを起動するコマンド（`bash ~/.claude/scripts/xxx.sh`）は拒否されず、スクリプトの中の `rm` は hook から見えない。launchd から起動される場合は hook を通らない。
- したがって GC スクリプトの安全性は hook では担保されない。スクリプト自身が対象を限定する必要がある。

## 4. 関連して見つかったもの

- actrun: `.mise.toml` で `github:mizchi/actrun` を入れている。`$TMPDIR/actrun/workspace/` の worktree が残ること（3 本で約 930MB）、未コミット変更があることはユーザーの実測で、リポジトリ内に掃除の仕組みは無い。
- pnpm dlx: `~/Library/Caches/pnpm/dlx` が 1.9GB まで溜まっていた（ユーザーの実測）。リポジトリ内に `pnpm/dlx`、`Caches/pnpm` への言及は無い。

## 4.5 ユーザーが決めたこと（2026-10-04）

- **閾値**: サイズで 2 段階。100MB 以上は 24 時間無更新で削除、それ未満は 7 日無更新で削除。どちらも終了判定（登録簿に生存 pid なし、参照プロセスなし）を満たしたものだけが対象。
- **スコープ**: scratchpad のみ。actrun の worktree と pnpm dlx キャッシュは今回提供せず、spec に「提供しない体験」として記録して別タスクにする。
- **対象 OS**: macOS と Linux の両方。distill-insights と同じく plist と systemd timer を用意する。
  - 先に Linux 実機で、scratchpad の場所と `/tmp` の掃除設定（tmpfs か、systemd-tmpfiles の `tmp.conf` の有無と期間）を確かめる調査が要る（2.4 の未確認事項）。
- **進め方**: アプリが作る worktree のセッションではなく、本体 checkout のセッションで Document Workflow を進める。worktree のセッションでは、workflow dir（本体 checkout 側）への書き込みを worktree 隔離の hook が拒否するため。

まだ決めていないこと（spec で推奨を示して承認を得る）: 起動方式（launchd / systemd の定期実行を推奨）、ログの置き場所と形式、孤児プロセスが残るセッションの知らせ方。

## 5. 設計に効く事実のまとめ

1. 「7 日超」の日数だけの閾値では、今回の事象（最古 3 日、最大 5.9GB）は 1 件も消えない。
2. apply 時だけの起動では、apply しない期間は掃除されない。既存の GC はさらに 7 日ゲートを持つ。
3. 終了判定は 1 つの信号では足りない。配下の最新 mtime、transcript mtime、登録簿の生存 pid、パスを参照するプロセス（引数と cwd）のそれぞれに、他の信号でしか拾えない事例が 1 つ以上ある。
4. 孤児プロセスが残るセッション（2.2 の B）は、プロセス参照を見る限り永久に GC されない。ここは人が kill する必要があり、気づける出力が要る。
5. セッションの単位は 2 階層目の UUID ディレクトリ。1 階層目にはプロジェクト名でないディレクトリやファイルが混ざる。
6. hook は GC スクリプトの中の削除を見ない。
