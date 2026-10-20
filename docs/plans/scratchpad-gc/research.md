# Research: Claude Code scratchpad の定期 GC

未着手。Claude Code のセッション scratchpad（macOS は `/private/tmp/claude-<uid>/<project>/<session-id>/`、Linux は `/tmp/claude-<uid>/<project>/<session-id>/`）を定期的に GC する仕組みを、この dotfiles に追加するかどうかは、利用者の判断を待つ。作らないと決めたら、このファイルを消す。

動機: scratchpad は 1 セッションで GB 単位に育ち（macOS で合計 8.8GB、最大 1 セッション 5.9GB、ディスク空き 122MB まで減った実測がある。掃除の後なので再現できていない）、macOS は `/private/tmp` を再起動時にしか掃除しない。調査は macOS の 1 台で、計測はすべて読み取りのみで行った。

## 決めたこと

- **閾値**: サイズで 2 段階。100MB 以上は 24 時間無更新で削除、それ未満は 7 日無更新で削除。どちらも終了判定（登録簿に生存 pid なし、参照プロセスなし）を満たしたものだけが対象。
- **スコープ**: scratchpad のみ。actrun の worktree（`$TMPDIR/actrun/workspace/` に残る）と pnpm dlx キャッシュは今回提供せず、spec に「提供しない体験」として記録して別タスクにする。
- **対象 OS**: macOS と Linux の両方。distill-insights と同じく plist と systemd timer を用意する。先に Linux 実機で `/tmp` の掃除設定（tmpfs か、systemd-tmpfiles の `tmp.conf` の有無と期間）を確かめる調査が要る。
- **進め方**: アプリが作る worktree のセッションではなく、本体 checkout のセッションで Document Workflow を進める。worktree のセッションでは、workflow dir（本体 checkout 側）への書き込みを worktree 隔離の hook が拒否するため。

まだ決めていないこと（spec で推奨を示して承認を得る）: 起動方式（launchd / systemd の定期実行を推奨）、ログの置き場所と形式、孤児プロセスが残るセッションの知らせ方。

## 設計に効く事実

1. 「7 日超」の日数だけの閾値では、実測の事象（最古 3 日、最大 5.9GB）は 1 件も消えない。
2. apply 時だけの起動では、apply しない期間は掃除されない。既存の GC（`run_after_gc.sh.tmpl`）はさらに 7 日ゲートを持ち、削除の根は `.tmp/sessions/` に固定され、深さは 1 に限られる。
3. 階層は一様ではない。セッションの単位は 2 階層目の UUID ディレクトリで、中身は `scratchpad/` と `tasks/`（バックグラウンドタスクの出力）。1 階層目にはプロジェクト名でないディレクトリや、`cache-break-state-<session-id>.json` のようなファイルが混ざる。3 階層目までに symlink は無い。UUID ディレクトリの過半は中身が空。
4. 終了判定は 1 つの信号では足りない。次のそれぞれに、他の信号でしか拾えない事例が 1 つ以上ある。
   - ディレクトリ mtime は配下の更新を反映しない（配下が 0 時間前なのにディレクトリは 24 時間前）。既存 GC の `find -maxdepth 1 -mtime` は使えない
   - 配下の最新ファイル mtime だけでも足りない（scratchpad を触らずに会話だけ続くセッションがある）
   - transcript（`~/.claude/projects/<project>/<session-id>.jsonl`）の mtime は会話が続いているかを表すが、transcript が無いセッションがある
   - `~/.claude/sessions/<pid>.json` が実行中セッションの登録簿になっている（キーは `pid`、`sessionId`、`cwd`、`kind`、`status`、`updatedAt` など）。Claude Code の内部形式で文書化された契約ではなく、版が変われば変わりうる
   - パスを参照するプロセス。`claude` 本体のプロセス引数には session id が出ないので、引数から実行中セッションは引けない。孤児プロセスは引数と cwd の両方に出る。`cat` と `tee` は引数にパスを持たないので、cwd（`lsof -d cwd`）も見ないと数え漏らす
5. 孤児プロセスが残るセッションは、プロセス参照を見る限り永久に GC されない。ここは人が kill する必要があり、気づける出力が要る。
6. hook は GC スクリプトの中の削除を見ない。`lib/command-parsing.ts` が拒否するのは Bash tool に渡したコマンド文字列の `rm` だけで、スクリプトを起動するコマンドは拒否されず、launchd から起動される場合は hook を通らない。したがって GC スクリプト自身が対象を限定する必要がある。
7. 実行中の Claude Code の環境変数に `CLAUDE_CODE_SESSION_ID` がある。一時ディレクトリの場所を上書きする変数は設定されていなかった。

## 置き場所とテストの慣習

- スケジューラが指すジョブ本体は `home/dot_claude/scripts/executable_*.sh`（`~/.claude/scripts/`）、人が叩く CLI は `home/dot_local/bin/executable_*`（`~/.local/bin/`）。
- 定期実行の前例は distill-insights の launchd / systemd timer（`run_after_register-distill-insights-schedule.sh.tmpl` が登録し、本体は `executable_run-distill-insights.sh`。多重起動は `flock` か `lockf` で防ぎ、失敗は `last-run-failed` に 1 行で残し、`distill-run.log` は末尾 2000 行へ切り詰める）。`run_after_zz-verify-provisioning` は distill-insights の登録を検査していない。
- shell のテストは `tests/<name>/run.sh` 形式（`tests/git-worktree-cleanup/run.sh` が前例。CI は ubuntu と macOS の両方で、macOS は `/bin/bash` 3.2）。`scripts/lint-shell.sh` が `*.sh.tmpl` を 3 通りに描画して shellcheck にかける。`scripts/smoke-chezmoi-scripts.sh` は `tests/smoke/<script-name>/<scenario>/setup.sh` を持つ `.chezmoiscripts` を隔離した HOME で実行する。

## 未確認

- Linux での `/tmp` の掃除設定（上の「決めたこと」の調査）。scratchpad の場所そのものは `/tmp/claude-<uid>/` で確認済み。
- `~/.claude/sessions/*.json` が、クラッシュしたセッションの分をいつ消すか。死んだ pid の登録が残る場合の挙動は見ていない。
