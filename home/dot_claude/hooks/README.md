# Claude Code Hook Scripts

このディレクトリには、Claude Codeのフックスクリプト（TypeScript実装）が含まれています。

## ディレクトリ構造

```
hooks/
├── implementations/              # Hook実装スクリプト（TypeScript）
│   ├── auto-approve.ts          # 自動承認スクリプト
│   ├── deny-repository-outside.ts  # リポジトリ外アクセス制限
│   ├── block-tsx.ts             # tsx/ts-node実行制限
│   ├── deny-node-modules.ts     # node_modules書き込み制限
│   ├── block-package-json-tsx.ts   # package.json tsx制限
│   ├── web-fetch-guardian.ts    # WebFetch制限
│   ├── command-logger.ts        # コマンド実行ログ
│   ├── session.ts               # セッション管理
│   ├── notification.ts          # 通知処理
│   ├── speak-notification.ts    # 音声通知
│   └── user-prompt-logger.ts    # プロンプトログ
├── lib/                         # 共有ライブラリ（TypeScript）
│   ├── bash-parser.ts           # Bashコマンド構造解析
│   ├── centralized-logging.ts   # 統合ロギング
│   ├── chezmoi-utils.ts         # chezmoi関連ユーティリティ
│   ├── command-parsing.ts       # コマンド解析・危険コマンド検出
│   ├── context-helpers.ts       # コンテキストヘルパー
│   ├── decision-maker.ts        # 判定ロジック
│   ├── file-permission-inference.ts # ファイルパーミッション推論
│   ├── git-context.ts           # Git リポジトリ情報管理
│   ├── path-utils.ts            # パス操作ユーティリティ
│   ├── pattern-matcher.ts       # パターンマッチング
│   ├── permission-analyzer.ts   # パーミッション分析
│   ├── permission-request-helpers.ts # パーミッション要求ヘルパー
│   ├── risk-assessment.ts       # リスク評価
│   ├── sed-parser.ts            # sedコマンド解析
│   └── structured-llm-evaluator.ts # LLM評価ロジック
├── utilities/                   # スタンドアロンツール
│   └── generate-stats.ts        # 統計レポート生成
├── types/                       # 型定義
│   ├── project-types.ts           # Hook型定義
│   └── tool-schemas.ts          # ツールスキーマ
├── tests/                       # テストスイート
│   ├── integration/             # 統合テスト
│   ├── unit/                    # 単体テスト
│   └── README_TESTING.md        # テスト実行ガイド
├── scripts/                     # 実行用シェルスクリプト
│   ├── all_tests.sh             # 全テスト実行
│   ├── ci_test.sh               # CI用テスト
│   └── test-with-types.sh       # 型チェック付きテスト
├── sounds/                      # 通知音ファイル
├── common.json.tmpl             # hook設定テンプレート
├── README.md                    # このファイル
└── SAMPLE.md                    # Hook I/Oリファレンス
```

## 主要なHook実装

### auto-approve.ts

権限設定に基づいてコマンドを自動承認/拒否するスクリプトです。

#### 機能

1. **危険なコマンドの検出**（`command-parsing.ts` の `checkDangerousCommand` で実装）
   - **ファイル操作**: `rm -rf`（変数展開/ルート指定）、`sudo rm`、`dd`、`mkfs`
   - **Git操作**: `push --force/-f`、`reset --hard`、`clean -fd`、`branch -D`、`--no-verify`
   - **GitHub CLI**: `pr merge/close`、`issue close/delete`、`repo delete/archive`
   - **パッケージマネージャ**: `npm/pnpm/bun publish/unpublish/deprecate`
   - **その他**: piped shell execution、環境変数操作
   - **除外**: コマンド全文が read-only 先頭語の単一単純コマンド（`grep -e "..." file` など）のときは、引数の綴りに対する危険判定を適用しない（条件は `lib/read-only-command.ts` を参照）。判定はコマンド全文に対して行うので、パイプやリストの中の read-only コマンドは除外されない。read-only 以外の先頭語（`echo "rm -rf /"` など）の引数による誤検知は残る
   - deny-node-modules も同じ判定を使う。`find` / `less` / `more` / `ll` / `la` 先頭や複合コマンドの中で削除語を含むものは deny になる

2. **パターンマッチング**
   - Allow/Deny リストの `Bash(p *)`（前方一致）と `Bash(p)`（完全一致）
   - allow と deny で入力の読み方が違う（下の「allow と deny の判定の分け方」）
   - Allow/Denyリストによる柔軟な制御

3. **ログ記録**
   - 詳細な分析結果をログファイルに記録

#### アーキテクチャ

モジュール化されたTypeScript設計により、保守性と拡張性を向上：

- **bash-parser.ts**: 複合コマンド（`&&`, `||`, `;`）の構造解析
- **command-parsing.ts**: コマンド抽出と危険なコマンドの検出（`checkDangerousCommand`）
- **pattern-matcher.ts**: Allow/Denyパターンとのマッチング処理
- **decision-maker.ts**: 最終的な承認/拒否の判定ロジック
- **centralized-logging.ts**: 分析結果のロギング

#### allow と deny の判定の分け方

- **allow**: `lib/safe-command-list.ts` の `scanSafeList` が、コマンド全文を単純コマンドに過不足なく分割できたときだけ判定する。区切りは引用符外の `&&` `||` `;` `|` 改行。`$(…)`・バッククォート・heredoc・サブシェル・`{ }`・背景の `&`・`2>&1` `>/dev/null` `2>/dev/null` `</dev/null` 以外のリダイレクト・語頭の `#`・代入の前置・引数を実行する先頭語（`env` `xargs` `find` `timeout` `bash` など）・宣言（`export` など）を含むと分割せず、hook は判定しない（Claude Code 本体の許可ルールと PermissionRequest 層に委ねる）。分割できたら、各単純コマンドが Layer 1・sed -i の推論・allow パターン（先頭からのアンカー付き照合）・組み込みの安全なコマンド（allow list が空でないときの `sleep`）のどれかに当たるときだけ allow。`git commit -m "$(cat <<'EOF' …)"` は hook でも Claude Code 本体の `Bash(git commit *)` でも承認されず、確認が出る
- **deny / ask**: `lib/deny-input.ts` の `prepareDenyInput`（内部で `lib/bash-parser.ts` の `extractCommandsStructured`）の断片に当てる。断片は実行されうるテキストの上位集合（AST の実行単位。網羅を保証できない入力では全文と、`;` `&` `|` 改行で割った粗い分割片も足す）で、allow の根拠には使わない。deny-node-modules・document-workflow-guard・pattern-matcher の deny も同じ断片を使う。deny 側の hook（deny-node-modules・auto-approve の deny 段・document-workflow-guard）は `prepareDenyInput` を通して読み、cat / tee がデータとして書くだけの heredoc の本文を空にしてから判定する。条件は `lib/heredoc-data.ts` にあり、判定できない形は本文を残す側に倒している。サブシェルなど複合文の全文の綴りによる誤検知は残る。ほかの hook と LLM evaluator は本文を含む全文を読む。許可ルールの提案ツール（`lib/permission-analyzer.ts`）は、上位集合を足す前の断片（`extractBaseCommands`）を使う
- 字句の読み方（引用符、`\`、`$` の形、語頭の `#`）は `lib/shell-lex.ts` に置き、read-only 除外の判定（`lib/read-only-command.ts`）と allow の分割が共有する

#### 既知の限界

`Bash(p *)` の allow は先頭語と前方一致しか見ない。次は allow ルールの範囲の問題で、hook では塞いでいない。**引数でコマンドを実行する先頭語や、任意のスクリプトを実行する先頭語の allow ルールを足さない。**

- git が別のコマンドを実行する、またはファイルを書く形: `git -c alias.x='!…' x`、`git rebase --exec`、`git fetch --upload-pack`。`git log` / `git diff` / `git show` の `--output=<path>` は Layer 1 にも当たる
- 書き込みと状態の変更: `tee`、`sort -o`、`printf -v`、`cd`（同じ呼び出しの後続のコマンドの作業ディレクトリが変わる）
- 任意のスクリプトの実行: `pnpm run`、`bun run`、`node --test`、`bunx prettier --plugin`
- sed -i の推論はスクリプトを検査しない。GNU sed の `e` / `w` は、対象ファイルが Edit 許可に当たれば allow になる（macOS の BSD sed に `e` は無い）
- 引数を実行する先頭語の拒否リストは網羅ではない（`watch`、`parallel`、`setsid`、`stdbuf`、zsh の `noglob` など）。効くのは、それらの allow ルールを足した場合だけ
- 分割は zsh の `~[name]`（`zsh_directory_name` 関数があれば実行される）を拒否しない
- deny 側で拾えないもの: `curl … | bash` はパイプの両側が別の断片になり、パイプの規則に当たらない。`export` / `declare`・`[[ ]]`・算術展開の外側のテキストは断片に入らない（中の `$(…)` は入る）。document-workflow-guard は `&>`・`>&`・`&>>`・`3<>`・`2>`・`{fd}>` の先を書き込み先として認識しない
- 一部の deny 側の正規表現（`command-parsing.ts` と `permission-auto-approve.ts` の `rm` / `dd` / `git push` / `curl … | sh` の規則）は、長い空白の連続や、`dd` / `curl` / `wget` の語を繰り返す入力で後退時間が伸びる。PreToolUse の hook はタイムアウト（既定 600 秒）しても allow にはならず、通常の許可フローに進む。deny-node-modules の `standaloneSymlinkRemovalOperands` の空白の切り詰め（`/^ +| +$/g`）も、長い空白の連続で二乗時間になる（`eslint` + 空白 500,000 個で約 100 秒）。

### document-workflow-guard.ts

Document Workflow の gate を実装系の書き込み（Write / Edit / MultiEdit / NotebookEdit / Bash）で強制する PreToolUse hook。matcher は `lib/guarded-tools.ts` の `GUARDED_TOOLS` と同期する。承認の形のプロンプト（`承認` / `approve` だけなど）を `CronCreate` / `ScheduleWakeup` で予約することも deny する（`lib/workflow-approval.ts` の `isApprovalShapedPrompt`）。

### permission-auto-approve.ts

PermissionRequest hook。Claude Code が確認を出す場面で、静的な規則で allow を返す（Layer 2a）。同じ PermissionRequest の LLM evaluator（`permission-llm-evaluator.ts`、Layer 2b）とは並列に走る。

- Bash は、auto-approve と同じ `scanSafeList` で全文を分割できて、各単純コマンドが `SAFE_BASH_PATTERNS` か `cd <1 語>` に当たるときだけ allow。一致した部分に英数字と `_ . / : = @ + , ~ -`・空白・タブ以外の文字（引用符、`\`、`$`、glob、リダイレクトなど）があるとき、また一致した部分が shell の語の切れ目で終わらないとき（`npx vitest-evil`、`ls-evil`）は当たったとみなさない（`git -c "a status" push` を `status` と、`npx vitest-evil` を `vitest` と読まないため）。そのため `pnpm test:unit` のようなコロンつきのスクリプト名の短縮形は allow しない（`pnpm run test:unit` は allow）。代入の前置（`FOO=1 cmd`）と `env` は allow しない
- `SAFE_BASH_PATTERNS` は auto-approve の Layer 1 とは別の集合で、より広い（git の書き込み系、`pnpm run`、`chezmoi apply` など）。PermissionRequest は本体が確認を出す場面でだけ走る層なので、PreToolUse の Layer 1 より広く取っている
- allow しなかった理由は決定ログの `source` に残る: `scan-demoted`（分割前の規則なら allow だった入力。ほかの理由より優先する）、`scan-null`（分割できない）、`scan-mismatch`（当たらない単純コマンドがある）、`scan-error`（例外）
- 既知の限界: `SAFE_BASH_PATTERNS` は引数を検査しない（`git -c core.fsmonitor=… status`、`git rebase`、`pnpm run`、`npm install` の postinstall、`chezmoi apply`、`mkdir` / `touch`）。`-c` の値そのものがコマンドになる設定（`git -c core.fsmonitor=… status`、`core.pager`、`core.sshCommand`）と、`node --require=<file> --test` も通る。`cd <dir>` の後の `pnpm test` は `<dir>` の package.json のスクリプトを実行する。project-scope の判定は cwd 配下の `.sh` を引数を検査せずに allow する。`/` を含まない `x.sh` は cwd のファイルとして判定するが、shell は PATH から探す（PATH に `.` が無ければ実害はない）。Edit / Write の path 判定は cwd との前方一致で、`..` を正規化しない

### 設定例

`.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(npm install *)",
      "Bash(pnpm install *)",
      "Edit(src/**)",
      "Read(**)"
    ],
    "deny": ["Bash(rm -rf *)", "Edit(.git/**)"]
  }
}
```

**注意**: パターン構文は `Bash(command *)` 形式を使用します（旧 `:*` 形式は非推奨）。
安全のため、`git *` や `npm *` のような広範なワイルドカードは避け、個別のサブコマンドを指定してください。

## 技術仕様

### 実行環境

- **Runtime**: Bun (推奨) または Node.js
- **Language**: TypeScript
- **Framework**: cc-hooks-ts (型安全なhook定義)

### 依存関係管理

- **Package Manager**: bun
- **Location**: プロジェクトルート (`/home/berlysia/.local/share/chezmoi/`)

### Hook設定

- **設定ファイル**: `common.json.tmpl` (chezmoi管理)
- **実行パス**: `{{ .chezmoi.homeDir }}/.claude/hooks/implementations/`

## テスト

```bash
# 型チェック付き全テスト実行
./scripts/test-with-types.sh

# 統合テスト実行
./tests/integration/run-ts-hook-tests.sh

# CI環境でのテスト
./scripts/ci_test.sh
```

## 開発

### 新しいHookの追加

1. `implementations/` に TypeScript ファイルを作成
2. `cc-hooks-ts` の `defineHook` を使用
3. `common.json.tmpl` に設定を追加
4. テストケースを `tests/` に追加

### 例: 新しいHook実装

```typescript
#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";

export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // validation logic here

    return context.success({
      messageForUser: "Hook executed successfully",
    });
  },
});
```

**注意**: `messageForUser` は `SessionStart` / `UserPromptSubmit` では `cc-hooks-ts` の
`handleHookResult` に読まれず破棄される（この 2 イベントでは `additionalClaudeContext`
のみが参照される）。これらのイベントでユーザーに表示したい場合は
`context.json({ event, output: { systemMessage } })` を使う。`systemMessage` は UI に
表示され Claude のモデル入力には入らない。`hookSpecificOutput.additionalContext` は
逆にモデル入力へ入る。

## ユーティリティ

### Hook telemetry

`~/.claude/settings.json` に載る全 command hook は、chezmoi が settings.json を生成する段（`run_onchange_update-settings-json.sh.tmpl` の jq merge）で `hook-timer.sh` に自動的にラップされ、実行 1 回ごとの wall-clock 所要時間が `$CLAUDE_LOGS_DIR/hook-timing.jsonl`（既定 `~/.claude/logs/hook-timing.jsonl`）に 1 行 1 実行で追記される。tmpl 自体は変えないので、新しいフックを追加してもラップは自動的に効く。

記録する識別子は `session_id` / `tool_name` / `tool_use_id` / `source` / `prompt_id` の 5 つだけで、`source` と `prompt_id` は文字列のみ 64 文字で切って残す（プロンプトやツール入出力は残さない）。`source` の語彙は event ごとに違う（UserPromptSubmit は `user` / `schedule_wakeup` など、SessionStart は `startup` / `resume` など）ので、必ず `event` と組で読む。

計測対象は chezmoi が生成する `~/.claude/settings.json` の command hook に限る。次の 2 つは計測されない:

- **プラグインの `hooks/hooks.json`**（例: codex プラグインの SessionStart / SessionEnd / Stop）。ファイルは `claude plugin` CLI が管理するキャッシュで、Claude Code のフック起動に割り込む手段が無い。遅いと疑ったときは、トランスクリプト JSONL の `hook_success` attachment（`command` と `durationMs` を持つ）で個別に確認する。**ただし `hook_success` は stdout/stderr が空でないフックしか記録されないので、記録が無いことは速いことを意味しない**。
- **プロジェクトの `.claude/settings.json`**。本リポジトリでは `CLAUDE_CODE_REMOTE`（claude.ai/code の web 環境）のときだけ動く SessionStart が 1 本あるが、その環境には `hook-timer.sh` が配備されない（配備は chezmoi apply による）ため、包むとフック自体が壊れる。

集計は `hook-timing` コマンド（`~/.local/bin/hook-timing`）で見る:

```bash
hook-timing                          # 直近24時間
hook-timing --since 3d               # 直近3日
hook-timing --session <id前方一致>    # 特定セッションだけ
hook-timing --json                   # {byHook, blocking} をJSONで出力（jqでの追加分析用）
```

出力は2つの表:

- **フック別**: label（`implementations/<name>.ts` から取れなければ `inline:` + コマンド先頭40文字）ごとの count / p50 / p95 / max / 合計ms、および stderr の最大バイト数（出力肥大の傾向を追う手がかり）。
- **イベント別のブロック時間**: 同一イベントのフックは並列実行されるため、1回の発火でツール呼び出しが実際に待った時間は、その発火にマッチした sync フックの duration の**最大値**であり、合計ではない。この表の p50 / p95 / max はその最大値の分布。`topBottleneck` はどのフックが最大値を最も多く占めたか。`async: true` のフックはツール呼び出しをブロックしないため、この表に含まれない。

### generate-stats.ts

コマンド実行統計の生成とレポート出力

## トラブルシューティング

### 実行エラー

1. プロジェクトルートから実行しているか確認
2. 依存関係が正しくインストールされているか確認
3. TypeScriptの型エラーがないか確認

### デバッグ

```bash
# 個別hookの実行テスト
echo '{"tool_name": "Bash", "tool_input": {"command": "ls"}}' | bun implementations/auto-approve.ts

# 型チェック（TypeScript 7 native tsc。tsconfig.json 検出時はファイル直接指定不可のため引数なしで実行）
bunx tsc --noEmit
```
