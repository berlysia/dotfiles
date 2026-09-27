# Research: hook telemetry (実行時間計測)

## Order

各種フックのテレメトリを取りたい。処理時間を計測し、どのフックに時間がかかっているかを追跡できる仕組みを用意する。

## 観測事実

### 既存のフック配線

- `home/dot_claude/.settings.hooks.json.tmpl` に全フックが定義され、`home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl` が jq で `~/.claude/settings.json` に統合する。
- コマンド形態は 3 種類: `bun <impl>.ts`、`sh run-guard.sh <impl>.ts || exit 2`（fail-closed guard）、`echo ...` / `jq | sed >> log` のインライン shell。
- `async: true` のフックは command-logger / reviewer-run-recorder / notification 系 / user-prompt-logger / command_history echo。

### Claude Code 本体が持つ計測

1. **トランスクリプト JSONL の `hook_success` attachment**: `command` と `durationMs` を持つ。ただし本セッションでの実測では、Bash 呼び出し 1 回につき記録は 3 本（echo, deny-node-modules, run-guard 1 本）だけだった。PreToolUse にマッチするはずの block-tsx / block-package-json-tsx / web-fetch-guardian / もう 1 本の run-guard、および PostToolUse 全フックの記録は無い。記録されたのは stdout か stderr が空でないものだけ（stdout と stderr の長さで確認）で、**出力の無いフックは記録されない**。したがって網羅的な計器として使えない。
2. **OTEL span `claude_code.hook`**（claude-code-guide 経由、https://code.claude.com/docs/en/monitoring-usage.md）: `duration_ms` は「イベントにマッチした全フックの wall-clock」で、**フック単位ではない**。beta 環境変数群が必要で、対話 CLI では org の allowlisting が要る。
3. **`--debug` ログ**: matched hooks / exit code / stdout / stderr を出すが、duration は文書化されていない。

### 実行モデル（docs: https://code.claude.com/docs/en/hooks.md）

- 同一イベントにマッチしたフックは**並列**実行。体感のブロック時間は、マッチしたフックの duration の和ではなく最大値になる。
- `async: true` はツール呼び出しをブロックしない。
- command hook の既定 timeout は 600s（UserPromptSubmit は 30s）。

### ラッパー化の影響を受ける既存コンシューマ

- `hooks/tests/unit/hook-target-drift.test.ts`: tmpl を全文走査して `{{ .chezmoi.homeDir }}/.claude/hooks/implementations/<name>.ts` を拾う。**tmpl を変えなければ影響なし。**
- `session.ts` の `extractGuardMatcher`: settings.json の `command.includes("document-workflow-guard.ts")` で検索する。包んだ後もパスは文字列に残るため影響なし。
- `CLAUDE_LOGS_DIR`: `centralized-logging.ts` と test preload (`tests/preload-test-env.mjs`) が使う。ログの置き場所を変えるときはこの変数で上書きする。

### 環境

- Linux (WSL2) では `date +%s%N` を使える。run-guard.sh に `gtimeout` のフォールバックがあることから、macOS も対象。macOS の BSD date は `%N` 非対応で、`/bin/sh` は bash 3.2 なので `$EPOCHREALTIME` も使えない。`perl -MTime::HiRes` は macOS 標準で使える。
- テストは `node --test`（`package.json` の `test` script）で、run-guard.test.ts は spawnSync + fake bin パターン。

### 付随観測（スコープ外、記録のみ）

- run-guard 経由の PreToolUse フックの stderr が、同一セッション内で 2.6KB → 19KB → 44KB → 80KB と増えていた。本件では原因を診断しない。stderr のバイト数を記録項目に含め、傾向を後から追えるようにする。
