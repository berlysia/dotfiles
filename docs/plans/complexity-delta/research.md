# Research: 変更した関数の複雑度が悪化したときだけ知らせる hook

- 依頼: `.tmp/docs/cccc-task-completion-check.md`（セッション `b72ce94a` の引き継ぎメモ）の案について、調査と計画に進む
- 状態: 調査済み。設計は未着手

## 出どころの区別

- 「確認」: このセッションのメインループがコマンドを実行した、またはファイルを読んだ事実
- 「subagent」: sonnet の subagent が読んだと報告した事実（メインループは同じ箇所を読み直していない）
- 「メモ」: 引き継ぎメモに書かれ、このセッションでは再確認していない事実
- 「未確認」: 誰も確かめていない点

パスは特記が無いかぎり `home/dot_claude/` 起点。`tmpl` は `.settings.hooks.json.tmpl` を指す。

## 前セッションが決めたこと

- subagent: `b72ce94a` の plan は `cccc` を `home/dot_config/mise/config.toml` に固定するところまでを扱った。hook、閾値、CI、octocov、実行の時機についての決定は無い。今回の計画が覆す決定は無い
- subagent: 共有の `config.toml` に置いた理由は、`cccc` の用途を「他のプロジェクトでの計測」と見たため（K2）
- subagent: `rules/code-quality.md` と `CLAUDE.md` には `cccc` を書かない（K4）。`Bash(cccc *)` の静的許可も足さない（K5）
- subagent: 人間の承認は `approvals.log` に記録があり、コミット `c775571` と `5546bd9` は plan の Files と一致する

## 最大の制約: hook は全プロジェクトで動く

- 確認: Stop の hook は `tmpl` に登録し、`~/.claude/settings.json` へ配布する。dotfiles に限らず、全プロジェクトの全 Stop で発火する
- 引き継ぎメモの「効くのは `hooks/` の TypeScript が中心」は dotfiles だけを見た記述である。全プロジェクトで動かすなら、`cccc` が対応する全言語が対象になる
- 対象を dotfiles に限るか、全プロジェクトにするかは、閾値と対象ファイルの選び方を左右する。設計の前に決める

## cccc の仕様（1.7.0）

- 確認: 出力は JSON で、最上位は `files` と `summary`。関数は `name`、`kind`（`function` / `arrow` / `method`）、`line`、`cognitive`、`cyclomatic`、`children` を持つ
- 確認: 無名関数の `name` は `<anonymous>` 固定。`line` は編集で動くので、同定の鍵には使えない
- 確認: 存在しないパスを渡すと終了コード 2（`cccc: path does not exist`）。削除したファイルを変更後の側に渡すと全体が失敗する
- 確認: `--exclude <GLOB>` でファイルを除外できる（例: `*.test.ts`）
- 確認: 比較のオプションは無い。`--max-cognitive` は絶対値の閾値だけを扱う
- 確認: `hooks/` のテスト以外の `.ts` 85 ファイル（969 関数）で 0.008 秒。cognitive の中央値は 1、p90 は 12、p95 は 18、最大は 107
- メモ: 標準入力は読めない。言語は拡張子で決まる
- メモ: 入れ子の関数は親に加算されず、子として独立に採点される

- 確認: 構文エラーのあるファイルは `functions` が空になり、`parse_errors` を持つ。`summary.parse_error_files` にパスが並ぶ。終了コードは 0
- 確認: 1 つのファイルに `class A { run() }` と `class B { run() }` があると、どちらも `name: "run"`、`kind: "method"` で最上位に並ぶ。クラスは親にならない。鍵の重複は無名関数に限らない

## cccc の呼び出し方

- 確認: `~/.local/share/mise/shims/cccc` は `~/.local/bin/mise` への symlink。shim を通すと mise が動く
- 確認: このセッションの Bash の PATH には `~/.local/share/mise/installs/<tool>/<version>` が直接並ぶ。`cccc` は shim を通らず実体で解決される
- 未確認: shim 経由の実行が、他のプロジェクトの `mise.toml` にある未インストールのツールをインストールするか。確かめるには実際にインストールを起こす必要があるので試していない

- 確認: `mise exec -- cccc` は 1 回 0.095 秒、バイナリの直接実行は 0.001 秒。差は mise の起動にある
- 確認: `mise.toml`（`node = "22"`）を置いた別のディレクトリで `mise exec -- cccc --version` を実行すると、mise は node 22.23.3 をインストールしてから `cccc` を実行した。hook が `mise exec` を使うと、他のプロジェクトで意図しないインストールを起こす
- 確認: `~/.local/share/mise/shims/cccc` がある。このセッションの Bash では `cccc` は PATH で解決できる
- subagent: 既存の hook に `mise exec` を使うものは無い。`hooks/executable_run-guard.sh:33` は bun を探す候補に `~/.local/share/mise/shims/bun` を含める
- 未確認: hook を実行するときの PATH に mise の shims があるか

## Stop hook の既存の作り

- subagent: Stop には `resume-incomplete-work.ts`、`completion-gate.ts`、`compaction-testament.ts` の順で登録がある（`tmpl:207-245`）。`timeout` の指定は無い。`hook-timer.sh` によるラップは settings の生成時に自動でかかる
- 確認: Stop の出力には 2 つの経路がある。`hooks/README.md` の記述では、`systemMessage` は UI にだけ出て、モデルの入力に入らない（公式ドキュメントはここまで明記していない。下の「Round 1 のレビューを受けて確かめたこと」を参照）。`hookSpecificOutput.additionalContext` はモデルの入力に入る（`hooks/README.md` の出力の節）
- 確認: `cc-hooks-ts` の `StopHookOutput` は `decision`、`reason`、`hookSpecificOutput.additionalContext` を型として持つ
- subagent: ブロックしない通知の先例は `compaction-testament.ts:396-401`（`reason` を付けず `systemMessage` だけを返す）
- 確認: `completion-gate.ts` は UserPromptSubmit で作業ツリーの fingerprint を保存し、Stop で変化が無ければ検査を省く
- subagent: `git commit` に反応する hook は `tmpl` に無い

## Round 1 のレビューを受けて確かめたこと

- 確認: Claude Code 本体のプロセス（このセッションの親）の PATH は 93 エントリで、`github-moznion-cccc` のディレクトリを 1 つ含む。相対のエントリと空のエントリは 0。hook はこのプロセスの環境を引き継ぐ
- subagent（claude-code-guide、公式 `code.claude.com/docs/en/hooks.md` の引用つき）: Stop で `hookSpecificOutput.additionalContext` を返すと、`decision: "block"` が無くても会話が続き、モデルにもう 1 ターンが回る。次の Stop の入力は `stop_hook_active: true` になる。連続 8 回の上限がある
- subagent（同上）: `systemMessage` は「ユーザーに表示する警告」と書かれている。モデルの入力に入らないとは明記されていない
- subagent（同上）: UserPromptSubmit の `additionalContext` はそのプロンプトの文脈に入る。同じイベントの hook は並列に走り、`additionalContext` は全部まとめて渡される
- 推論: `tmpl:213` の Stop の `echo` は `{"event":"Stop","output":{...}}` の形で出力する。これは `cc-hooks-ts` の `context.json` に渡す引数の形で、Claude Code が読む形（最上位に `hookSpecificOutput`）ではない。この出力が効いていないなら、毎回の Stop で会話が続いていないことと合う。確かめていない
- 確認: `lib/sanitize-display.ts:73` の `sanitizeForDisplay` は、バッククォート、制御文字、表示されない文字を除き、長さを区切る。モデルの入力に入る文面向けで、JSON の値には使わないと書かれている
- 確認: `lib/working-tree-fingerprint.ts:32` の `SESSION_ID_PATTERN` は `/^[A-Za-z0-9_-]{1,128}$/` で、export されていない。`saveBaseline` は `<session_id>.txt` に fingerprint の文字列を書く専用の関数である
- 確認: `logEvent` は `event`（`"Stop"`、`"Error"` など 6 種）と文字列の `message` だけを受ける（`lib/centralized-logging.ts:280-286`、`types/logging-types.ts:13-21`）。構造を持つ値は書けない
- 確認: 採用した条件（25 以上、追加または 5 以上の上昇）で、再生した 19 コミットの 1 コミットあたりの該当は最大 4 件。4 件以上は 1 コミットだけ
- 未確認: `cccc` がルートの外を指す symlink をたどるか

## spec の承認後に確かめたこと（R2、R8）

スクリプトは `probe.sh`。8 コアの host で実行した。

- 確認: `cccc` はルートの外を指す symlink をたどらない。ディレクトリへの symlink（`linkdir -> ../outside`）も、ファイルへの symlink（`linkfile.ts -> ../outside/out.ts`）も、出力の `files` に現れなかった。R8 は解消
- 確認: 生成した 1 万ファイル（1 ファイル 3 関数、約 25 行）で 35〜37 ミリ秒、出力は 4.5MB。3 万ファイルで 149〜156 ミリ秒、出力は 13.8MB。1 秒の timeout には 1 万ファイルで約 27 倍の余裕がある
- 限界: ファイルは小さく、ディスクのキャッシュが温まった状態である。計ったのは `cccc` の実行だけで、hook の側の JSON の読み取りと bun の起動（`hook-timing.jsonl` では既存の hook が 1 回 56〜58 ミリ秒）は含まない。出力は 3 万ファイルで 13.8MB なので、`maxBuffer` の 64MiB には収まる
- 確認: `session.ts:286-291` のコメントに「`systemMessage` は UI に表示され、モデル入力には入らない唯一のチャネル（Claude Code 2.1.234 の binary 実測）」とある。再検証の手順は `docs/plans/hook-target-diagnostics-followups.md` の「課題 A」にあると書かれている（本文は未読）

## 「変更前」の取り方

- subagent: セッション開始時点の内容を保存する既存の機構は無い。`lib/working-tree-fingerprint.ts` は変化の有無だけを返し、ファイル一覧も内容も持たない。`.tripwire-baseline` は呼び出しごとに上書きする
- 確認（使い捨てのリポジトリで試した）: `git stash create` は、作業ツリーが汚れていれば、その内容を持つコミットを作って SHA を返す。index、`git status`、stash の一覧、ref は変わらない。作業ツリーがきれいなら何も出力せず、終了コードは 0
- 確認: 上の SHA を基準にすると、その後にコミットをしても `git diff --name-only <SHA> --` で変更したファイルが取れ、`git archive <SHA> -- <path>` で変更前の内容が取れる
- 確認: `git stash create` のスナップショットに未追跡のファイルは入らない
- 推論: HEAD を基準にすると 2 つの誤りが出る。プロンプトの前からあった未コミットの変更を今回の悪化として数える。ターンの途中でコミットすると、Stop の時点で差分が消えて何も出ない

## 基準を数値で持つ方式の実測

内容を git に残す代わりに、プロンプトの時点で `cccc` をツリー全体にかけ、関数ごとの数値だけを保存する方式を測った。

- 確認: `cccc --no-config .` は `.gitignore` に従うが、`.git/` を除外しない。このリポジトリでは 1562 ファイルのうち 1363 が `.git/worktree/` 配下だった
- 確認: `cccc --no-config --exclude '.git/**' .` は 199 ファイル 4430 関数を 0.020 秒で処理する。ワークツリーの中で実行しても同じ 199 ファイルになる
- 確認: `.git/` を含む 1562 ファイル 34047 関数でも 0.114 秒（1 秒あたり約 1.4 万ファイル）
- 確認: 関数ごとに鍵と cognitive だけへ平らにした JSON は約 100KB
- 確認: `--cache-file` を付けた 2 回目は 0.015 秒から 0.009 秒になる。この規模では差が小さい
- 確認: 対応言語は `es, rust, go, php, ruby, scheme, commonlisp, emacslisp, clojure, kotlin, python, zig, c, cpp, perl, swift, java, dart, scala`
- 未確認: 数万ファイルの規模での所要時間

## 閾値ごとの発火の頻度

`hooks/implementations`、`hooks/lib`、`hooks/cli` の `.ts` に触れた直近 150 コミットを再生し、名前のある関数について、親コミットより cognitive が上がったもの、または追加されたものを数えた（スクリプトは `replay.sh`）。

| 条件                                        | 該当コミット | 該当関数 |
| ------------------------------------------- | ------------ | -------- |
| 上昇または追加（閾値なし）                  | 115（76%）   | 582      |
| 新しい値が 15 以上                          | 59（39%）    | 88       |
| 新しい値が 15 以上、追加または 5 以上の上昇 | 43（28%）    | 62       |
| 新しい値が 15 以上、既存の関数のみ          | 35（23%）    | 42       |
| 新しい値が 15 以上、追加のみ                | 32（21%）    | 46       |
| 新しい値が 25 以上                          | 31（20%）    | 39       |
| 新しい値が 25 以上、追加または 5 以上の上昇 | 19（12%）    | 26       |
| 新しい値が 15 以上、既存のみ、5 以上の上昇  | 14（9%）     | 16       |

- 確認: 新しい値が 15 以上の既存の関数 42 件のうち、上昇が 2 以下のものが 20 件ある。上昇幅の中央値は 3、最大は 20
- 確認: 追加で値が大きかった例は `lib/read-only-command.ts` の `scanArguments`（48）、`lib/safe-command-list.ts` の `scan`（45）。既存で上昇が大きかった例は `document-workflow-guard.ts` の `run`（24 → 44）、`cli/workflow.ts` の `cmdRound`（23 → 42）
- 限界: 単位はコミットで、hook が見る 1 ターンとは一致しない。関数をファイル間で移した場合は「追加」に数えている。対象は構文解析の多いこのリポジトリの hook だけで、他のプロジェクトの分布は測っていない

## 新しい hook が満たす規約

- subagent: `implementations/` に置いたファイルは `tmpl` への登録が必須。`tests/unit/hook-target-drift.test.ts` が双方向に照合する。登録しない共有ロジックは `hooks/lib/` に置く
- subagent: テストは `node:test`。実行は リポジトリ直下の `bun run test`。単体テストは `hooks/tests/unit/<名前>.test.ts` に置く
- subagent: 外部コマンドは `node:child_process` の `execFileSync` に配列の引数と timeout を渡す形が主流
- subagent: `logQuality` の `source` は型で `"quality-loop" | "completion-gate"` に限られる（`hooks/types/logging-types.ts:45`）。新しい名前でログを書くなら型を広げる
- subagent: `knip.json` は `hooks/implementations/*.ts` を entry として扱う。未知のバイナリは `ignoreBinaries` への追加が要ることがある

## 検証の経路

- 確認: `chezmoi apply` の source は既定で `/home/berlysia/.local/share/chezmoi`。ワークツリー（`.git/worktree/<branch>`）の変更は、そのままでは配布されない
- subagent: 単体テストは source のツリーで動き、`chezmoi apply` を必要としない
- 確認: 既存のワークツリーが 5 本ある

## 引き継ぎメモの限界のうち、残るもの

- 改名とファイル間の移動は「削除 + 追加」に見える
- 新規ファイルと未追跡のファイルには変更前が無い
