# hook 参照検出の後続課題

`test(hooks): detect source-internal hook reference drift in CI` (5edc478) の調査中に発見した、本体スコープ外の課題をまとめる。層1（ソース内リンク切れの CI 検出）は実装済み。以下は未着手。

調査時の実測は全て 2026-08-18 時点。session 成果物 (`.tmp/sessions/`) は 7 日で GC されるため、再調査コストの高い事実をここへ移送している。

## 課題 A: `session.ts` のユーザー向け出力がどこにも届いていない

**解決済み**（2026-08-18）。採用案は選択肢表の A1/A2/A3 のいずれでもなく、`context.json({ event: "SessionStart", output: { systemMessage } })` を使う案（下記「### 選択肢」節への追記を参照）。実装は `home/dot_claude/hooks/implementations/session.ts` の `return` 文の置換のみで、`messages` 配列の組み立てロジックは変更していない。

### 確定した事実

- `cc-hooks-ts/dist/index.mjs:527-533` の `success` 分岐は、`SessionStart` と `UserPromptSubmit` では `additionalClaudeContext` のみを見て早期 return し、**`messageForUser` を破棄する**
- 実測: `echo '{...SessionStart...}' | bun ~/.claude/hooks/implementations/session.ts` は exit 0 / stdout 0 バイト。同時に `~/.claude/logs/events.jsonl` に SessionStart が記録され、hook 本体は実行されている
- 影響を受ける実装は `session.ts` のみ。`SessionStart` / `UserPromptSubmit` を trigger に持つ他の 4 実装（`completion-gate` / `resume-incomplete-work` / `user-prompt-logger` / `discord-notification`）は `messageForUser` を使っていない
- 届いていないもの: 起動メッセージ、`CLAUDE_CODE_TASK_LIST_ID` 共有警告、insight digest プレビュー
- hook 由来の attachment type は 10 種で全て（Claude Code 2.1.234 の binary 実測。type guard による列挙と変換テーブルのキー列挙を突き合わせて確認済み）。このうちモデル入力へ注入するのは 4 種（`hook_additional_context` / `hook_blocking_error` / `hook_stopped_continuation` / `hook_success`）のみで、`hook_system_message` は `()=>[]` にマップされ注入しない
- SessionStart における素の stdout（JSON として妥当でない出力）は `hook_success` attachment の `content` に生 stdout が入る経路で、Claude のモデル入力に注入される。「stdout に出す」は「ユーザーに見せる」ではなく「Claude に見せる」に近い

### 設計判断が要る点

単純に `additionalClaudeContext` へ置換すると、`getUnreadDigestPreview()` の内容が Claude のコンテキストに入る。その内容は `PROJECTS_DIR = ~/.claude/projects` 配下の**全プロジェクト**の session ログから蒸留されたものであり、クロスプロジェクトの情報流出経路になる。

- `insight-digest.ts:128-148` の `getUnreadDigestPreview()` 自身は `sanitize()` を呼ばないが、digest 本体は取り込み時点で `sanitize()` 済み（`scripts/distill-insights.ts` の取り込み経路）
- ただし `sanitize()` が落とすのは既知フォーマットの秘密のみ。顧客名・内部パス・設計情報は素通りする
- `insight-digest.ts:111-127` に `getUnreadDigestNotice()`（パス通知のみ、プレビュー本文なし）が既に存在する

### 選択肢

| 案  | 内容                                                                                    | 曝露                       |
| --- | --------------------------------------------------------------------------------------- | -------------------------- |
| A1  | プレビュー全文を `additionalClaudeContext` へ                                           | クロスプロジェクト流出あり |
| A2  | `getUnreadDigestNotice()` のパス通知のみ。本文は `/insight-digest` skill が必要時に読む | ゼロ                       |
| A3  | 起動メッセージとタスクリスト警告は context、digest は notice のみ                       | ゼロ                       |

**この表は前提が無効化されている**: A1-A3 はいずれも「digest 本文を Claude のモデル入力に入れるか、notice に落として入れないか」の二択を前提に組まれている。しかし hook 出力 JSON のトップレベル `systemMessage` は Claude Code 2.1.234 で実測した結果、UI に表示されつつモデル入力には注入されない（`hook_system_message` の変換テーブルエントリが `()=>[]`）。この経路は二択の外側にあり、全文配信とモデル入力への流入ゼロを同時に満たす。採用したのはこの `systemMessage` 案であり、A1/A2/A3 のいずれでもない。

A3 を推奨する（この推奨は上記の理由により採用されなかった。当時の判断記録として残す）。起動メッセージとタスク共有警告は自リポジトリ生成で曝露がなく、digest だけを notice に落とせば Goal（出力を届ける）を満たしつつ流出経路を作らない。

### 注意

`normalize()`（`insight-digest.ts:170-188`）を表示用に転用してはならない。末尾で `.toLowerCase()` するため大小文字が潰れる。加えて `DEFAULT_REDACT_PATTERNS`（同 `:55-65`）9 本のうち `AKIA[0-9A-Z]{16}` / `eyJ...`（JWT）/ `-----BEGIN ... PRIVATE KEY-----` / `^[A-Z][A-Z0-9_]{2,}=\S+$` の 4 本は大文字を要求するため、小文字化後の文字列には原理的にマッチしない。再利用できるのは `sanitize()` のみ。

### 課題 A の解決作業（`session.ts` 出力チャネル修正、`.tmp/sessions/9fe32ad8/`）で確定した未解決事実

出力チャネル修正自体は完了した（節冒頭を参照）。その調査中に確定したが、修正対象外として残した事実をここへ移送する。選別基準は「調査中に確定した事実のうち、session 成果物の GC（7 日）で失われると再調査コストが高く、かつ出力チャネル修正では直さないもの」。

#### `session.ts:44-65` の `CLAUDE_ENV_FILE` への未エスケープ補間（severity: high — ローカル RCE）

`session.ts:44-65` は `sessionId` / `transcriptPath` / `projectHash` / `CLAUDE_CODE_TASK_LIST_ID` / `DOCUMENT_WORKFLOW_DIR` の 5 つの値を `export X="${value}"` の形でエスケープなしに `CLAUDE_ENV_FILE` へ追記している。double quote の内側では `"` / `$(...)` / backtick がいずれも生きているため、値にこれらが含まれると env file が source された時点で任意コマンド実行になる。

供給元別の到達性:

- `sessionId` / `transcriptPath`: Claude Code が生成
- `projectHash`: `cwd` からの導出（`session.ts:41-43`）
- `CLAUDE_CODE_TASK_LIST_ID`: 環境変数
- `DOCUMENT_WORKFLOW_DIR`: 環境変数。project-local `.claude/settings.json` の `env` ブロックからも供給されうる

最後の `DOCUMENT_WORKFLOW_DIR` が問題で、`CLAUDE_ENV_FILE` は Claude Code が Bash 実行のたびに source する前提のファイルであり、project-local `.claude/settings.json` の `env` ブロックは settings.json の正規の surface（本リポジトリの `home/dot_claude/.settings.base.json` 自身も使用）である以上、clone した repository が経路になりうる。実質はローカル任意コマンド実行であり、値に `"` / `$(...)` / backtick が入れば env file が source された時点で発火する。

出力チャネル修正では対応しなかった理由: 修正対象は `return` 文であり、この箇所は独立した既存の問題である。同一ファイルにあることは修正の根拠にならず、束ねるとレビュー対象が入力サニタイズにまで広がる。独立したオーダーとして扱う。

#### その他の移送事項

- **`systemMessage` の非注入性の再検証手順**: 「モデル入力に注入されない」という保証は Claude Code 2.1.234 の binary 実測に依拠しており、リポジトリ内のどのテストもこの事実を保持しない。変換テーブルが将来変われば digest 本文がモデル入力に流入し始めるが、テストは全緑のままになる。再検証トリガーは Claude Code のアップグレード。再検証手順（バージョン間で byte offset は変わるため offset に依存しない形で書く）: (1) 起動中の実体を特定する（`~/.local/share/claude/versions/<version>`）。(2) `grep -abo 'hook_system_message' <binary>` で全出現の byte offset を列挙する（複数ヒットするため、これ単独では変換テーブルのエントリを一意に特定できない）。(3) 各 offset の周辺を切り出し、`grep -o 'hook_[a-z_]*:('` と `grep -o 'case"hook_[a-z_]*"'` で attachment type キーを列挙する。両者が複数キーを返す領域が変換テーブル本体。(4) その領域内で `hook_system_message` に対応する値が `()=>[]` のままであることを確認する。(5) type guard（`hook_` 接頭辞を `||` で列挙している箇所）と突き合わせ、新しい attachment type が増えていないことを確認する
- **digest の表示経路でサニタイズが再適用されない**: `sanitize()` は取り込み時に 1 回だけ適用され、表示経路では再適用されない。`~/.claude/insight-distill-redact.txt` に後からパターンを追加しても既存の `insights.jsonl` と digest には遡及しない。加えて `sanitize()` は制御文字を扱わないため、ANSI エスケープ・bidi（`U+202A-202E`, `U+2066-2069`）・zero-width（`U+200B-200F`, `U+FEFF`）は素通りする。digest の元は `~/.claude/projects/*.jsonl` の assistant text であり、web fetch 結果や clone した repo の内容を model が echo したものを部分的に含みうる。同一 `systemMessage` 内で上位行（`CLAUDE_CODE_TASK_LIST_ID` 警告等）が制御文字で上書きされうるかは Claude Code の UI 実装が ANSI 等を素通しするかに依存し、**未検証**
- **同型の並行実行バグが他 2 ファイルに残る**: `command-logger.test.ts:23` と `user-prompt-logger.test.ts:23` が `join(tmpdir(), \`...-${Date.now()}\`)` で一時ディレクトリを作っており、`session.test.ts:28`（出力チャネル修正で `mkdtempSync` に置換済み）と同じ非決定性を持つ。実測での並行実行（4 プロセス並行 × 複数回）の失敗数は user-prompt-logger が 8/9/7/7、command-logger が 8/7/2/7。`tests/unit/\*.test.ts`の他ファイルは既に`mkdtempSync`を使っており、残存はこの 2 件のみ。修正自体は`mkdtempSync` への置換 1 行で、独立したオーダーとして実行できる
- **`hooks/README.md` の drift**: `common.json.tmpl`（実体は `.settings.hooks.json.tmpl`）/ `test-with-types.sh`・`tests/integration/run-ts-hook-tests.sh`・`ci_test.sh`（3 本とも不在）/ `generate-stats.ts`（不在）/ Package Manager を pnpm と記載（実体は bun）。出力チャネル修正で同 README の「### 例: 新しいHook実装」コードブロック直後に `messageForUser` の破棄条件についての注意書きを追記したが、隣接する記述が上記の通り drift しているため、「新しい hook を書く人が先に読む防御」としての実効性は割り引く必要がある。同文書「課題 C」（deploy と source の乖離）と同型の問題

## 課題 B: `run_onchange` のハッシュが chezmoi データを捕捉しない

### 発生した事象

`~/.config/chezmoi/chezmoi.toml` に `[data]` セクションが欠落し、`only_private` が不在になっていた。`home/.chezmoi.toml.tmpl:8` は当該マシンの hostname に対して `true` を宣言しているにもかかわらず、`discord-notification` / `slack-notification` の hook が `~/.claude/settings.json` に登録されていなかった（ユニーク実装参照が source 26 に対し deploy 24）。

原因は chezmoi が config を `init` 時にしか生成せず `apply` では再生成しないこと。`chezmoi init` の再実行で解消した。

### 残る構造的な問題

`run_onchange_update-settings-json.sh.tmpl:6` の再実行判定は

```
# Hash: {{ include "dot_claude/.settings.base.json" | sha256sum }}...
```

とソースファイルの**内容**から計算される。`.settings.hooks.json.tmpl` は `{{ if dig "only_private" false . }}` で chezmoi データに依存するが、データが変わってもソース内容は変わらないため**レンダリング結果が変わってもスクリプトが再実行されない**。

実際、`only_private` を修正した後の `chezmoi status` に `update-settings-json.sh` は現れず、settings.json は古いままだった。手動でスクリプトを描画・実行して解消している。

対処候補: Hash 行に `{{ .only_private }}` 等の依存データを含める、あるいはレンダリング結果のハッシュに変える。ただし後者は他の `run_onchange` にも波及する設計判断を伴う。

## 課題 C: chezmoi は managed 外のファイルを刈らない

### 発生した事象

`~/.claude/hooks/` に実ファイル 206 / chezmoi 管理下 74 で、管理外が 139 件（うち 7 件は `logs/` の実行時生成物で正当）蓄積していた。内訳は `scripts/` 68、`tests/` 34、`lib/` 9、`implementations/` 5 ほか。最終更新は 2025 年 8-9 月で、ソース側に `scripts/` ディレクトリ自体が存在しない（ADR-0002 の TypeScript 移行前のレガシー層）。

deploy 済み `settings.json` は `implementations/` のみを参照し（27 コマンド）、管理外 `lib/` への import もゼロであることを確認した上で、`logs/` を除く 132 件を削除済み。

### 残る構造的な問題

`chezmoi apply` を何度実行しても管理外ファイルは残り続けるため、リネーム・削除・ディレクトリ再編のたびに層が積もる。「apply が成功した」というシグナルは「deploy 済みの状態が正しい」を意味しない。

対処候補: `chezmoi managed` と実ファイルの差分を検出する `run_after_` スクリプト、または定期的な棚卸し。削除まで自動化するかは、`logs/` のような正当な管理外ファイルの扱いを含む設計判断になる。

## 共通する構造

A・B・C はいずれも「**状態が変わったのに、それを監視しているはずの機構が気付かない**」形をしている。`home/dot_claude/rules/code-quality.md` の `## Recoverable State Must Announce Itself`（a884352）はこの構造への規範であり、B は特にその典型（latch した状態 + 人手の回復手順 + 無通知）。

層1 のテスト（`home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts`）が塞いだのはソース内の 1 経路のみである。ソースとデプロイの間には `.chezmoiignore` による deploy 漏れ、`only_private` gate、chezmoi config 自身の drift、`apply` 未実施による stale deploy の 4 経路が開いており、層1 はいずれも塞がない。

## 層3（SessionStart 自己診断）の未解決事項

課題 A を含む「他リポジトリの settings が参照する実在しないスクリプトをセッション開始時に報告する」機構は、設計負荷が層1 と異なるため分離した。着手時に決める必要がある点:

- 非ブロッキング hook エラーの stderr が Claude Code の UI に何行表示されるか（1 行目のみの可能性がある）。壊れた hook を一時登録した実測が必要
- 診断の反復抑止。`SessionStart` は `["startup", "resume", "clear", "compact", "fork"]` の 5 source で発火する（`cc-hooks-ts/dist/index.d.mts:293`）ため「セッション開始時に 1 回だけ」は成立しない
- サニタイズの順序と対象集合。bidi (`U+202A-202E`, `U+2066-2069`) と zero-width (`U+200B-200F`, `U+FEFF`) は C0/C1 除去では落ちない
- 時間予算がブロッキング `stat()` を中断できない問題（WSL2 の `/mnt/` 配下 DrvFs、autofs、CIFS）
- `lib/` への settings 読み込み共通化。`auto-approve.ts:270` と `file-access-guard.ts:116` に同名 `getSettingsFiles` が 2 実装あり、後者は project-local を読まないドリフト状態にある

### 診断文言についての制約

hook の stderr は transcript に `type: "attachment"` / `attachment.type: "hook_non_blocking_error"` として永続化され、`stderr` に加えて `command` の生文字列・`exitCode`・`hookName` も記録される。したがって「stderr に出せば Claude のコンテキストへの経路が原理的に閉じる」は成立しない。

また診断は「存在しません」と断定してはならない。本件の起点となった実例（`workspace/my-secretary` の `bash .claude/hooks/lint-on-stop.sh`、exit 127）は**スクリプトが実在しており**、cwd が `.tmp/sessions/<id>` だったため相対パスが解決できなかったものだった。「cwd 基準で解決できません」と書く必要がある。
