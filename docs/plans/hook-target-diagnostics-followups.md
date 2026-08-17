# hook 参照検出の後続課題

`test(hooks): detect source-internal hook reference drift in CI` (5edc478) の調査中に発見した、本体スコープ外の課題をまとめる。層1（ソース内リンク切れの CI 検出）は実装済み。以下は未着手。

調査時の実測は全て 2026-08-18 時点。session 成果物 (`.tmp/sessions/`) は 7 日で GC されるため、再調査コストの高い事実をここへ移送している。

## 課題 A: `session.ts` のユーザー向け出力がどこにも届いていない

### 確定した事実

- `cc-hooks-ts/dist/index.mjs:527-533` の `success` 分岐は、`SessionStart` と `UserPromptSubmit` では `additionalClaudeContext` のみを見て早期 return し、**`messageForUser` を破棄する**
- 実測: `echo '{...SessionStart...}' | bun ~/.claude/hooks/implementations/session.ts` は exit 0 / stdout 0 バイト。同時に `~/.claude/logs/events.jsonl` に SessionStart が記録され、hook 本体は実行されている
- 影響を受ける実装は `session.ts` のみ。`SessionStart` / `UserPromptSubmit` を trigger に持つ他の 4 実装（`completion-gate` / `resume-incomplete-work` / `user-prompt-logger` / `discord-notification`）は `messageForUser` を使っていない
- 届いていないもの: 起動メッセージ、`CLAUDE_CODE_TASK_LIST_ID` 共有警告、insight digest プレビュー

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

A3 を推奨する。起動メッセージとタスク共有警告は自リポジトリ生成で曝露がなく、digest だけを notice に落とせば Goal（出力を届ける）を満たしつつ流出経路を作らない。

### 注意

`normalize()`（`insight-digest.ts:170-188`）を表示用に転用してはならない。末尾で `.toLowerCase()` するため大小文字が潰れる。加えて `DEFAULT_REDACT_PATTERNS`（同 `:55-65`）9 本のうち `AKIA[0-9A-Z]{16}` / `eyJ...`（JWT）/ `-----BEGIN ... PRIVATE KEY-----` / `^[A-Z][A-Z0-9_]{2,}=\S+$` の 4 本は大文字を要求するため、小文字化後の文字列には原理的にマッチしない。再利用できるのは `sanitize()` のみ。

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
