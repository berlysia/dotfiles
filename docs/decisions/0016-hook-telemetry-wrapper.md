# ADR-0016: フックの実行時間を、settings.json 生成時に差し込む計時ラッパーで記録する

## Status

accepted (2026-09-28)

## Context

どのフックがツール呼び出しをどれだけ遅くしているかを、体感でなく数字で追いたい。既存の計器はどれもこの問いに答えられなかった（`git show 52dc6fd447:docs/plans/hook-telemetry/research.md`）。

- トランスクリプト JSONL の `hook_success` は `command` と `durationMs` を持つ。ただし stdout / stderr が空でないフックしか記録しない。実測では、Bash 1 回あたり PreToolUse に 7 本以上マッチしているのに、記録は 3 本だった。PostToolUse は全滅していた。これを集計すると標本が偏る
- OTEL の `claude_code.hook` span の `duration_ms` は、イベントにマッチした全フックの合計値で、フック単位の内訳が無い。beta の環境変数が必要で、対話 CLI では org の allowlisting も要る
- 各 TS フックの中で計測すると、bun の起動時間（最速のフックでも 25〜40ms）と、`echo` / `jq` で書いたインライン shell のフックを測れない

加えて、同じイベントにマッチしたフックは並列に実行される。そのため 1 回の発火で待たされる時間は、各フックの時間の和ではなく最大値になる。

## Decision

設計の全文は `git show 52dc6fd447:docs/plans/hook-telemetry/plan.md`（K0〜K9、5 名 × 3 ラウンドのレビューと intent triage を経て verdict=pass）にある。ここには骨子と、却下した代替案を記す。

### 1. 計測点はプロセス境界の外に置き、settings.json 生成時に機械的に包む（K1）

`run_onchange_update-settings-json.sh.tmpl` の jq が、全 `type: "command"` の hook を `sh ~/.claude/hooks/hook-timer.sh <Event> <async 0|1> '<元の command>'` に書き換える。`.settings.hooks.json.tmpl` は変更しない。こうすると、新しく追加したフックも計測から漏れない。`hook-target-drift.test.ts` の全文走査と `session.ts` の `command.includes("document-workflow-guard.ts")` による配線監査も、そのまま通る。

**却下**: tmpl の各行を手で書き換える案。30 行近い重複が生じるうえ、ラップし忘れた新しいフックが計測から静かに欠ける。

### 2. ラッパーはフックの判定に一切影響させない（K2〜K4）

- stdin / stdout / stderr は一時ディレクトリのファイル経由で渡し、バイト単位で素通しする。子の exit code もそのまま返す
- 元の command が `|| exit 2` で終わるガードは、ラップ後の外側にも `|| exit 2` を付ける。ラッパー自体の起動に失敗してもブロックに倒すためである（fail-closed を維持する）
- 記録は子の終了後に、`( … ) </dev/null >/dev/null 2>&1 &` で切り離して行う。jq が無い、ログを書き込めない、途中で kill された、といった場合は記録を捨てる。どの経路でも、フック入力の生データを置いた一時ディレクトリは消す
- フック入力から記録するのは `session_id` / `tool_name` / `tool_use_id` の 3 つだけで、`tool_input` 等は記録しない。ログは mode 600 で作る

### 3. kill されたフックも記録する（K9）

ラッパーは TERM / INT / HUP を trap する。受け取ったシグナルを子に転送して最大 1 秒待ち、それでも終わらなければ子を SIGKILL する。そのうえで `terminated` を付けて記録する。これが無いと、完走できないほど遅いフックほど記録から消えてしまう。

1 秒で打ち切るのは、子が TERM を無視した場合に備えるためである。その場合、Claude Code が SIGKILL に切り替えたときに死ぬのはラッパーだけで、子は孤児として残る。

**却下**: プロセスグループ単位の kill（`set -m`）。dash は tty が無いと job control を有効にできず、wait が 5 秒ブロックした。zsh はオプションの変更自体を拒否した。

### 4. 集計は並列実行を前提にする（K7）

`hook-timing` CLI（`hooks/cli/hook-timing.ts` → `hooks/lib/hook-timing-report.ts`）は 2 つの表を出す。

- フック別: count / p50 / p95 / max / total / stderr の最大バイト数
- イベント別のブロック時間: 同期フックの duration の最大値。最大値を最も多く占めたフックも併記する

発火のまとまりは `tool_use_id` で決める。`tool_use_id` が無いイベントは、同じセッション・同じイベントの中で、先頭から 1000ms 以内のものを 1 回の発火とみなす。

## Consequences

- 1 回のフック実行に約 4.4ms が上乗せされる（20 回の実測）。同じイベントのフックは並列に走るため、ツール呼び出し 1 回あたりの増分もこの程度に収まる
- 次の 2 つは計測対象外として受け入れる（K0）。README の Hook telemetry 節に明記した
  - プラグインの `hooks/hooks.json`: `claude plugin` CLI が管理するキャッシュにあり、書き換えても更新で消える
  - project の `.claude/settings.json`: 唯一のフックが `CLAUDE_CODE_REMOTE` のときだけ動く。その環境には `hook-timer.sh` が配備されないので、包むと壊れる
- 次の場合は記録が残らない: SIGKILL で直接殺されたとき、`sh -c` の中から起動された孫プロセスが残るとき
- ログ `~/.claude/logs/hook-timing.jsonl` は 10MB を超えたら `.1` に 1 世代だけ退避する。`centralized-logging` の回転は TS 側の仕組みなので、shell のラッパーからは使えない
- macOS の `date` は `%N` を解釈しないので、その場合は perl で時刻を取る。この分岐は、偽の `date` を使ったテストでしか確かめていない（macOS 実機では未検証）

## References

- `git show 52dc6fd447:docs/plans/hook-telemetry/plan.md` / `research.md`
- `home/dot_claude/hooks/executable_hook-timer.sh`, `home/dot_claude/hooks/lib/hook-timing-report.ts`, `home/dot_claude/hooks/cli/hook-timing.ts`
- `home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl`
- https://code.claude.com/docs/en/hooks.md（並列実行、timeout、`async`）
- https://code.claude.com/docs/en/monitoring-usage.md（OTEL `claude_code.hook` span）
