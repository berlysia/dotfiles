# Plan: hook telemetry (per-hook wall-clock timing)

## Goal

chezmoi が `~/.claude/settings.json` に生成する全 command hook について、実行 1 回ごとの wall-clock 所要時間を記録し、「どのフックが遅いか」「ツール呼び出し 1 回あたり実際に何 ms 待たされているか」を集計コマンド 1 発で確認できるようにする。

## Experience Delta

- 変更前: フックの遅さは体感でしか分からない。トランスクリプトの `durationMs` は出力したフックしか残らず、PostToolUse や無出力のフックは見えない（research.md 観測事実 1）。
- 変更後: `hook-timing` を実行すると、フック別の count / p50 / p95 / max / 合計と、イベント別のブロック時間（並列実行を考慮した最大値）の p50 / p95 と、その最大値を最も多く占めたフックが表で出る。フック別の表には stderr の最大バイト数も併記し、出力肥大の傾向を同じ表で追えるようにする（research.md 付随観測）。

## Architecture

```
settings.hooks.json.tmpl (変更なし)
   │ run_onchange_update-settings-json.sh.tmpl の jq で全 command hook を自動ラップ
   ▼
~/.claude/settings.json:  sh ~/.claude/hooks/hook-timer.sh <Event> <async 0|1> '<元の command>' [|| exit 2]
   │ stdin をそのまま子に渡し、stdout / stderr / exit code を素通しする
   ▼
$CLAUDE_LOGS_DIR/hook-timing.jsonl (既定 ~/.claude/logs)   ← 子の終了後、バックグラウンドの jq で 1 行追記
   ▼
hook-timing (~/.local/bin) → bun ~/.claude/hooks/cli/hook-timing.ts → lib/hook-timing-report.ts (純関数)
```

### 記録スキーマ（1 行 1 実行）

```json
{
  "ts": "2026-09-28T10:00:00.123Z",
  "start_ms": 1790527306651,
  "duration_ms": 42,
  "event": "PreToolUse",
  "async": false,
  "exit_code": 0,
  "stdout_bytes": 142,
  "stderr_bytes": 0,
  "command": "bun /home/…/implementations/block-tsx.ts",
  "session_id": "5a9f…",
  "tool_name": "Bash",
  "tool_use_id": "toolu_…",
  "terminated": null
}
```

`session_id` / `tool_name` / `tool_use_id` はフック入力 JSON に無ければ `null`。フック入力から取り出すのはこの 3 フィールドだけで、`tool_input` / `tool_response` / prompt 本文は記録しない（秘密情報が混入し得るため）。ログファイルは 600 で作る。

## Alternative Approaches (Greenfield View)

| 案                                                         | 内容                                                                             | 判定                                                                                                                                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 差分最小案 A: トランスクリプト集計                         | `~/.claude/projects/*/*.jsonl` の `hook_success.durationMs` を集計するだけの CLI | 却下。本セッションの実測で、Bash 1 回あたり PreToolUse に 7 本以上マッチするのに記録は 3 本だけ。無出力のフックと PostToolUse の全フックが欠落するため、「遅いフックを探す」という目的に対して標本が偏る |
| 差分最小案 B: OTEL span                                    | `claude_code.hook` span を有効化                                                 | 却下。`duration_ms` はイベント単位の合計でフック単位の内訳が無い。beta env と、対話 CLI では org allowlisting が必要                                                                                     |
| 案 C: 各 TS フック内で計測                                 | cc-hooks-ts の `defineHook` 周りに計測を挟む                                     | 却下。bun の起動時間（本セッション実測で最速の bun フックでも 39ms）と、echo / jq のインライン shell フックを測れない。Claude Code が実際に待つ時間ではない                                              |
| **白紙設計案 = 採用案 D: プロセス外ラッパー + 自動ラップ** | settings.json 生成時に全 command hook を計時ラッパーで包む                       | 採用                                                                                                                                                                                                     |

白紙設計の起源: 測りたい量は「Claude Code が子プロセスを起動してから終了するまでの時間」なので、計測点はプロセス境界の外側に置くことになる。フック定義のたびに計測を書き足す方式だと新しいフックが計測から漏れるので、定義から配備へ変換する単一の地点（jq merge）で機械的に包む。tmpl を変えないため、`hook-target-drift.test.ts` の全文走査と `session.ts` の `command.includes("document-workflow-guard.ts")` はどちらも影響を受けない（research.md「ラッパー化の影響を受ける既存コンシューマ」）。

## Key Decisions

- **K0 計測範囲**。対象は chezmoi が生成する `~/.claude/settings.json` の command hook に限る。計測対象外で、受け入れる欠落は次の 2 つ。(a) プラグインの `hooks/hooks.json`（現在は codex プラグインが SessionStart / SessionEnd / Stop を持ち、Stop の timeout は 900s。ファイルは `claude plugin` CLI が管理するキャッシュで、書き換えても更新時に消える）。(b) プロジェクトの `.claude/settings.json`（本リポジトリでは `CLAUDE_CODE_REMOTE` のときだけ動く SessionStart が 1 本）。(a) を包むには Claude Code 側のフック起動に割り込む手段が要り、その手段は無い。(a) の粗い代替として OTEL span（Alternative B）も検討し直したが採らない。対話 CLI では org の allowlisting が必要で、この環境で有効にできる保証が無いため。codex の Stop hook（timeout 900s）は `/codex:setup` で有効にしたときだけ動く、任意のレビューゲートである。遅いと疑ったときは、トランスクリプトの `hook_success`（出力があったときだけ記録される）で個別に確認する手順を README に載せる。(b) を包まない理由: このフックは `CLAUDE_CODE_REMOTE` のとき、つまり claude.ai/code の web 環境でだけ動く。その環境には `~/.claude/hooks/hook-timer.sh` が配備されない（配備は chezmoi apply による）ので、包むと存在しないファイルを実行することになり、スキル導入そのものが壊れる。README の Hook telemetry 節にこの範囲を明記する。

- **K1 自動ラップを jq merge 段で行う**（却下: tmpl の各行を手で書き換える）。手書きだと 30 行近くの重複が生じ、新しいフックを追加するときにラップを忘れて計測が欠ける。tmpl を読みやすいまま保てる。
- **K2 fail-closed を外側で維持する**。元の command が `|| exit 2` で終わる場合（run-guard 系）は、ラップ後の文字列の末尾にも ` || exit 2` を付ける。ラッパー自身が起動に失敗した場合（ファイル欠落なら 127）もブロックに倒すため。ラッパーは子の exit code をそのまま返す。
- **K3 記録は子の終了後にバックグラウンドで行う**。stdin / stdout / stderr は一時ディレクトリのファイル経由で子に渡し、コマンド置換による末尾改行の正規化を避ける。mktemp が失敗したときは計測せずに `exec sh -c "$cmd"` で素通しする。jq による JSON 生成と追記は `( … ) </dev/null >/dev/null 2>&1 &` で切り離し、stdout を握らない。ラッパーが同期的に足す処理は `mktemp -d`・`cat` 3 回・`date` 2 回・`sh -c` だけにする（試作での実測は 1 回あたり約 4ms）。
- **K9 kill されたフックも記録する**。ラッパーは `trap` で TERM / INT / HUP を捕まえる。捕まえたら子プロセスに同じシグナルを送り、`exit_code:null`、`terminated:"<SIG>"`、`duration_ms` = kill までの経過時間で記録してから `128+signo` で終了する。タイムアウトで完走しないほど遅いフックが、記録から静かに消えないようにするため。SIGKILL は捕まえられないので欠落を受け入れる。シグナルを受けてから子を待つのは最大 1 秒で、それを過ぎたら子を SIGKILL する。子が自前で TERM を trap して居座ると、Claude Code が SIGKILL に切り替えたときにラッパーだけが死に、子は孤児として残る。これを防ぐため。孫プロセス（`sh -c` の中で起動されたもの）には SIGKILL が届かず、自然に終わるまで残り得る。プロセスグループ単位の kill（`set -m`）も試したが、dash は tty が無いと job control を有効にできず、zsh はオプションの変更自体を拒否したので採らない。この限界は受け入れる。これに合わせて記録スキーマに `terminated`（通常は `null`）を加え、13 キーにする。
- **K4 記録はベストエフォート**。ツール呼び出しの直後にプロセスグループごと kill される環境では、切り離した記録処理が完了せず、行の欠落や temp file の残留が起こり得る。これも欠落として受け入れる（temp file は OS の tmp 掃除に任せる）。jq が無い、またはログを書き込めないときは記録を捨てる。フックの判定結果（stdout / exit code）には一切影響させない。計測の失敗でガードを止めるのは本末転倒なため。この場合は該当フックが集計に現れないので欠落に気づける。
- **K5 時刻取得の移植性**。macOS を対象に含めるのは推測による（run-guard.sh の `gtimeout` フォールバックと、`run_onchange_install-packages-1-darwin.sh.tmpl` が存在することから）。`date +%s%N` の結果が数字だけならそれを ms に切り詰めて使う（GNU）。`N` を含むか空なら `perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'` を使う（macOS）。どちらも無理なら duration_ms を `null` にし、フックはそのまま実行する。
- **K6 ローテーション**。記録を追記するバックグラウンド処理の中で、ファイルが 10,000,000 bytes を超えていたら `hook-timing.jsonl.1` に mv する（世代は 1 つだけ保持）。centralized-logging は TS 側の仕組みなので shell からは使えない。1 行あたり約 500 bytes なので 10MB は約 2 万実行分で、数日分の分析には足りる。
- **K7 ブロック時間の算出**。同一イベントのフックは並列に走るため、1 回の発火のブロック時間は `async=false` のレコードの duration_ms の**最大値**とする。発火のまとまり（グループ）の決め方: `tool_use_id` があれば `(session_id, event, tool_use_id)` でまとめる。無ければ（SessionStart / Stop / UserPromptSubmit 等）同じ session_id・event 内で `start_ms` を昇順に並べ、グループ先頭から 1000ms 以内を同じ発火とみなす。1000ms の根拠: 同一発火の全フックは Claude Code がほぼ同時に spawn するので start_ms の差は数十 ms に収まる。一方、同じ種類のイベントが 1 秒以内に連続して発火することは、人手のプロンプトやターン終了の頻度からは起きにくい。
- **K8 ラベル**。`command` に `implementations/<name>.ts` が含まれればラベルは `<name>`。含まれなければ `inline:` + command 先頭 40 文字にする。command 文字列から決定的に得られ、同じ command は常に同じラベルになるため。

## Files

```
# 新規作成
home/dot_claude/hooks/executable_hook-timer.sh
home/dot_claude/hooks/lib/hook-timing-report.ts
home/dot_claude/hooks/cli/hook-timing.ts
home/dot_local/bin/executable_hook-timing

# 編集
home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl
home/dot_claude/hooks/README.md

# テスト
home/dot_claude/hooks/tests/unit/hook-timer.test.ts
home/dot_claude/hooks/tests/unit/hook-timing-report.test.ts
```

## Tasks

### T1: 計時ラッパー `hook-timer.sh`

**Files:** 新規 `home/dot_claude/hooks/executable_hook-timer.sh`、テスト `home/dot_claude/hooks/tests/unit/hook-timer.test.ts`
参照: `home/dot_claude/hooks/executable_run-guard.sh:1-58`（stdout バッファ・exit code 素通しの流儀）、`home/dot_claude/hooks/tests/unit/run-guard.test.ts:1-47`（spawnSync + temp dir のテスト流儀）

- [ ] Step 1: 失敗するテストを書く。基本は `spawnSync("sh", [timer, "PreToolUse", "0", cmd], { input, env: { ...process.env, CLAUDE_LOGS_DIR: tmp } })` で呼ぶ。「300ms 後に SIGTERM」を送る 3 ケースだけは非同期の `spawn` を使い、`setTimeout(() => child.kill("SIGTERM"), 300)` で送ってから `close` イベントの `(code, signal)` と、spawn から close までの経過時間を assert する。以下を assert する:
  - `cmd = 'cat'`、input `{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1"}`（末尾改行なし）→ stdout がこの input とバイト単位で完全一致し、status 0
  - `cmd = 'echo out; echo err >&2; exit 2'` → stdout `out\n`、stderr `err\n`、status 2
  - `cmd = 'exit 7'` → status 7
  - 実行後、`tmp/hook-timing.jsonl` が現れるまで最大 3000ms、50ms 間隔でポーリングし、最終行を JSON.parse して `event==="PreToolUse"`、`async===false`、`exit_code===2`、`stderr_bytes===4`、`stdout_bytes===4`、`session_id` / `tool_use_id` が input 由来の値、`typeof duration_ms==="number" && duration_ms>=0` であること
  - input が JSON でない（`not json`）→ stdout は素通しされ status 0。記録には `session_id:null` が入る
  - input に `"tool_input":{"command":"echo SECRET_TOKEN_X"}` を含めたとき → 記録行のキー集合が schema の 13 キーと完全一致し、記録行の文字列に `SECRET_TOKEN_X` が含まれない
  - 新規作成されたログファイルの mode が `0o600`
  - `cmd = 'sleep 5'` を spawn して 300ms 後にラッパーへ SIGTERM を送る → status 143、記録に `terminated:"TERM"`・`exit_code:null` が入り、`duration_ms` が 250 以上 2000 未満
  - PATH の先頭に `sleep 3` するだけの fake `jq` を置いて実行 → spawnSync が 1500ms 未満で返る（記録処理の切り離しの回帰テスト）
  - `TMPDIR` を専用 temp dir にして実行し、3500ms 後にその dir が空である。jq を含まない PATH（sh / date / cat / mktemp / wc / tr / rm / mkdir / mv へのシンボリックリンクだけを置いた dir）の場合と、`CLAUDE_LOGS_DIR=/proc/nonexistent` の場合も同様に空になる（フック入力の生データを残さない）
  - `cmd = 'trap "echo bye; exit 0" TERM; sleep 5 & wait'` に SIGTERM → stdout に `bye` が含まれる（シグナルを転送したあと子の終了を待ってから出力を流す）
  - `cmd = 'trap "" TERM; sleep 5'`（TERM を無視する子）に 300ms 後 SIGTERM → ラッパーが 2000ms 未満で status 143 を返し、`terminated:"TERM"` が記録される（試作での実測は 1311ms）
  - `CLAUDE_LOGS_DIR` を書き込み不可のパスにする（`/proc/nonexistent`）→ status と stdout は子のまま変わらない
- [ ] Step 2: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/hook-timer.test.ts` で FAIL を確認
- [ ] Step 3: 実装する。骨子:

```sh
#!/bin/sh
# Wall-clock timer around one hook command (see hooks/README.md "Hook telemetry").
# Usage: hook-timer.sh <event> <async 0|1> <command-string>   (stdin: hook input JSON)
# Exit: the child's exit code, untouched; 128+signo when the wrapper itself is
# signalled (TERM/INT/HUP). Recording is best-effort and detached.
event="$1"; is_async="$2"; cmd="$3"
log_dir="${CLAUDE_LOGS_DIR:-$HOME/.claude/logs}"

now_ms() {
  t=$(date +%s%N 2>/dev/null)
  case "$t" in
    '' | *[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null ;;
    *) printf '%s\n' "${t%??????}" ;;
  esac
}

# Without a scratch dir we cannot capture byte-exact streams; run untimed.
work=$(mktemp -d 2>/dev/null) || exec sh -c "$cmd"

record() { # $1 exit_code|null  $2 terminated-signal|""
  end=$(now_ms)
  rec_rc="$1"; rec_sig="$2"  # write_record below has its own positional args
  (
    umask 077
    # write_record may bail out early; the scratch dir (a raw copy of the
    # hook input) is removed on every path.
    write_record() {
    command -v jq >/dev/null 2>&1 || return 0
    out_b=$(wc -c <"$work/out" 2>/dev/null | tr -d ' ')
    err_b=$(wc -c <"$work/err" 2>/dev/null | tr -d ' ')
    mkdir -p "$log_dir" && log="$log_dir/hook-timing.jsonl" || return 0
    # Only three identifiers are projected from the hook input; tool_input,
    # tool_response and prompts never reach the log.
    jq -c -R -s \
      --arg event "$event" --arg is_async "$is_async" --arg cmd "$cmd" \
      --arg start "$start" --arg end "$end" --arg rc "$rec_rc" --arg sig "$rec_sig" \
      --arg out_b "${out_b:-}" --arg err_b "${err_b:-}" '
      (try fromjson catch {}) as $in
      | ($start | tonumber? // null) as $s | ($end | tonumber? // null) as $e
      | {ts: (if $s then ($s / 1000 | floor | todate) else (now | floor | todate) end),
         start_ms: $s,
         duration_ms: (if $s and $e then $e - $s else null end),
         event: $event, async: ($is_async == "1"),
         exit_code: ($rc | tonumber? // null),
         stdout_bytes: ($out_b | tonumber? // 0),
         stderr_bytes: ($err_b | tonumber? // null),
         command: $cmd,
         session_id: ($in | objects | .session_id // null),
         tool_name: ($in | objects | .tool_name // null),
         tool_use_id: ($in | objects | .tool_use_id // null),
         terminated: (if $sig == "" then null else $sig end)}' \
      <"$work/in" >>"$log" || return 0
    size=$(wc -c <"$log" | tr -d ' ')
    [ "$size" -gt 10000000 ] && mv -f "$log" "$log.1"
    }
    write_record
    rm -rf "$work"
  ) </dev/null >/dev/null 2>&1 &
}

on_signal() { # $1 signal name  $2 signal number
  # Forward the signal and give the child up to 1s to finish writing, then
  # SIGKILL it: otherwise a child that traps the signal would outlive the
  # wrapper once Claude Code escalates to SIGKILL, which only reaches us.
  if [ -n "$child" ]; then
    kill "-$1" "$child" 2>/dev/null
    i=0
    while kill -0 "$child" 2>/dev/null && [ "$i" -lt 10 ]; do
      sleep 0.1
      i=$((i + 1))
    done
    kill -KILL "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  cat "$work/out" 2>/dev/null
  cat "$work/err" >&2 2>/dev/null
  record null "$1"
  exit $((128 + $2))
}
trap 'on_signal TERM 15' TERM
trap 'on_signal INT 2' INT
trap 'on_signal HUP 1' HUP

cat >"$work/in"
child=""
start=$(now_ms)
sh -c "$cmd" <"$work/in" >"$work/out" 2>"$work/err" &
child=$!
wait "$child"
rc=$?
child=""
cat "$work/out"
cat "$work/err" >&2
record "$rc" ""
exit "$rc"
```

上の骨子は scratchpad で試作して実測済み（Round 2 の指摘を受けて、記録処理が途中で抜けた場合の temp dir 削除と、シグナル受信時に子を最大 1 秒待ってから SIGKILL する処理を加え、再実測した）: 入力 104 bytes が出力 104 bytes で一致、exit 2 / 7 / 143 が素通し、ログ mode 600、記録行に SECRET を含まない、`jq` を 3 秒 sleep する fake に差し替えてもラッパーは 5ms で戻る（切り離しが stdout を握っていない）、一時ディレクトリが残らない。stdin / stdout / stderr はコマンド置換を使わず一時ファイル経由で扱うので、末尾改行も含めてバイト単位で一致する。`ts` は jq の `todate` で start_ms から秒精度で作る（GNU の `date +%3N` に依存しないため）。

- [ ] Step 4: 同コマンドで PASS を確認

### T2: settings.json 生成時の自動ラップ

**Files:** 編集 `home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl`
参照: 同ファイル 26-35 行（`HOOKS_CONTENT` 生成から `TEMPLATE_CONTENT` の jq 合成まで）、`home/dot_claude/hooks/implementations/session.ts:54-70`（`command.includes` による検出。ラップ後も一致する根拠）

- [ ] Step 1: `HOOKS_CONTENT=$(chezmoi execute-template …)` の直後に次を挿入する:

```bash
# Every command hook runs through hook-timer.sh so per-hook wall-clock time
# lands in ~/.claude/logs/hook-timing.jsonl. Wrapping here, not in the tmpl,
# keeps new hooks from escaping measurement. A trailing `|| exit 2` is
# repeated outside the wrapper so a missing/crashing timer still blocks.
HOOKS_CONTENT=$(printf '%s' "$HOOKS_CONTENT" | jq --arg timer "{{ .chezmoi.homeDir }}/.claude/hooks/hook-timer.sh" '
  with_entries(.key as $ev | .value |= map(.hooks |= map(
    if .type == "command" then
      .command = "sh \($timer | @sh) \($ev | @sh) \(if .async then 1 else 0 end) \(.command | @sh)"
        + (if (.command | test("\\|\\|\\s*exit 2\\s*$")) then " || exit 2" else "" end)
    else . end)))')
```

- [ ] Step 2: 検証。`chezmoi execute-template < home/.chezmoiscripts/run_onchange_update-settings-json.sh.tmpl > "$SCRATCH/s.sh"` で描画し、ラップ部分だけを抜き出して実行する: `chezmoi execute-template < home/dot_claude/.settings.hooks.json.tmpl | jq …（上の式）`。結果について次を確認する: (a) 全 `type=="command"` の command が `sh '` で始まる、(b) run-guard 系 3 本（document-workflow-guard / auto-approve / file-access-guard）の末尾が ` || exit 2`、(c) `jq -r '.. | .command? // empty' | grep -c document-workflow-guard.ts` が 1
- [ ] Step 3: ラップ後の run-guard コマンド 1 本を、`{"tool_name":"Bash","tool_input":{"command":"ls"}}` を stdin にして手で実行し、exit 0 と、ラップ前と同じ stdout を得ることを確認する

### T3: 集計ロジック（純関数）

**Files:** 新規 `home/dot_claude/hooks/lib/hook-timing-report.ts`、テスト `home/dot_claude/hooks/tests/unit/hook-timing-report.test.ts`
参照: `home/dot_claude/hooks/cli/workflow.ts:1-17`（「純関数 + deps 注入、`import.meta.main` だけが process に触る」という CLI 構成の流儀）

公開 API:

```ts
export type HookTimingRecord = {
  ts: string;
  start_ms: number | null;
  duration_ms: number | null;
  event: string;
  async: boolean;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number | null;
  command: string;
  session_id: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  terminated: string | null;
};
export function parseHookTimingLines(text: string): {
  records: HookTimingRecord[];
  invalidLines: number;
};
export function labelForCommand(command: string): string; // K8
export type HookStats = {
  label: string;
  event: string;
  async: boolean;
  count: number;
  terminatedCount: number;
  p50: number;
  p95: number;
  max: number;
  totalMs: number;
  maxStderrBytes: number;
};
export function summarizeByHook(records: HookTimingRecord[]): HookStats[]; // totalMs 降順
export type EventBlockingStats = {
  event: string;
  invocations: number;
  p50: number;
  p95: number;
  max: number;
  topBottleneck: { label: string; share: number } | null;
};
export function summarizeBlocking(
  records: HookTimingRecord[],
): EventBlockingStats[]; // K7。topBottleneck は各発火で最大だった label の出現率が最も高いもの。同率なら label の辞書順で先のもの
export function formatReport(
  byHook: HookStats[],
  blocking: EventBlockingStats[],
): string;
```

percentile は nearest-rank（`sorted[ceil(p/100*n)-1]`）。`duration_ms===null` のレコードは統計から除外し、件数を `formatReport` の末尾に `excluded (no duration): N` として出す。

- [ ] Step 1: 失敗するテストを書く（fixture は各テスト内に inline のレコード配列で定義する）:
  - `parseHookTimingLines('{"event":"X",...}\nbroken\n\n')` → records 1 件、invalidLines 1
  - `labelForCommand("bun /h/.claude/hooks/implementations/block-tsx.ts")` → `"block-tsx"`。`labelForCommand("sh /h/.claude/hooks/run-guard.sh /h/.claude/hooks/implementations/auto-approve.ts || exit 2")` → `"auto-approve"`。`labelForCommand("echo 'x'")` → `"inline:echo 'x'"`
  - duration [10,20,30,40,100] の 1 フック → p50 30、p95 100、max 100、totalMs 200
  - 同じ tool_use_id "t1" に sync 40ms (A) / sync 90ms (B) / async 500ms (C)、"t2" に A 50ms / B 20ms → PreToolUse の invocations 2、max 90、p50 50（2 件 [50,90] の nearest-rank p50 = 50）、topBottleneck `{label:"A", share:0.5}`（t1 の最大は B、t2 の最大は A で、1 回ずつの同率。同率は label の辞書順で先のものを採る）
  - tool_use_id が null の Stop 3 件（start_ms 1000, 1300, 2600）→ invocations 2（1000 と 1300 が同じ発火、2600 は別）
- [ ] Step 2: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/hook-timing-report.test.ts` で FAIL を確認
- [ ] Step 3: 実装する
- [ ] Step 4: PASS を確認

### T4: CLI とランチャー

**Files:** 新規 `home/dot_claude/hooks/cli/hook-timing.ts`、`home/dot_local/bin/executable_hook-timing`
参照: `home/dot_local/bin/executable_workflow-cli:1-8`（ランチャーの形）

- [ ] Step 1: `hook-timing.ts` を書く。引数は `--since <N>(h|d)`（既定 `24h`。`ts` で絞り込む）、`--session <id 前方一致>`（遅いと感じた特定セッションだけを見るため）、`--json`（`{byHook, blocking}` を出力する。テスト計画のトランスクリプト突き合わせや jq での追加分析に使う）。`$CLAUDE_LOGS_DIR/hook-timing.jsonl` と `.1` を読む。ファイルが無ければ `no telemetry yet: <path> (hooks are wrapped after chezmoi apply)` を stderr に出して exit 1。引数が不正なら usage を stderr に出して exit 2
- [ ] Step 2: ランチャーは `exec bun run --silent "${HOME}/.claude/hooks/cli/hook-timing.ts" "$@"`
- [ ] Step 3: T1 のテストで生成した jsonl を `CLAUDE_LOGS_DIR` に置いて `bun home/dot_claude/hooks/cli/hook-timing.ts --since 1d` を実行し、表が出ることを確認する

### T5: ドキュメント・全体検証

**Files:** 編集 `home/dot_claude/hooks/README.md`
参照: `home/dot_claude/hooks/README.md` の「## ユーティリティ」節

- [ ] Step 1: 「## ユーティリティ」に「### Hook telemetry」を追加する。内容は、計測範囲と対象外のソース（K0）、対象外のプラグイン hook をトランスクリプトの `hook_success` で確認する手順（出力が空のフックは記録されないので、記録が無いことは速いことを意味しないという注意書きを添える）、計測の仕組み（jq merge で自動ラップ）、記録先、`hook-timing` の使い方、ブロック時間 = 並列実行の最大値という読み方、async フックはブロック時間に含まれないこと
- [ ] Step 2: `pnpm run test`、`pnpm run typecheck`、`pnpm run lint` がすべて exit 0
- [ ] Step 3: `chezmoi apply` の後、新しいセッションで Bash を数回実行し、`hook-timing` にフックが 1 本以上出ることを確認する（apply と新規セッションの起動はユーザーに依頼する）

## テスト計画 (ISO 25010)

### 機能適合性（機能正確性）

- 入力: T1 Step 1 の全ケース（13 件） → 期待: stdout / stderr / exit code が子と完全一致し、記録の各フィールドが列挙した値になる
- 入力: T3 Step 1 の 5 ケース → 期待: 列挙した数値に完全一致する

### 信頼性（障害許容性）

- 入力: ラップ後の run-guard 行で、`hook-timer.sh` を一時的に別名に mv した状態を模擬する（`sh /nonexistent/hook-timer.sh PreToolUse 0 'exit 0' || exit 2` を実行）→ 期待: exit 2（fail-closed を維持）
- 入力: ログディレクトリを書き込み不可にする → 期待: 子の exit code と stdout が変わらない（T1 のケースに含む）

### 性能効率性（時間効率性）

- 入力: `for i in $(seq 20); do echo '{}' | sh hook-timer.sh X 0 'true'; done` と `for i in $(seq 20); do echo '{}' | sh -c 'true'; done` を `time` で比較する → 期待: 1 回あたりの差が 15ms 以下（WSL2 の本機で測る）。超えた場合は同期部分のどのプロセス起動が支配的かを報告してから判断する
- 入力: 実運用 1 セッションのトランスクリプト `hook_success.durationMs`（ラッパー込み）と `hook-timing.jsonl` の duration_ms（子のみ）を tool_use_id と command で突き合わせる → 期待: 差分（ラッパーのオーバーヘッド）の中央値が 15ms 以下。計器が「子プロセスの所要時間」を測っていることの較正を兼ねる

### 移植性（適応性）

- 入力: `now_ms` の分岐を、`date` を `echo 1790527306N` だけ出す fake に差し替えて実行する（PATH の先頭に fake date を置く）→ 期待: perl 経路に入り、13 桁の数字が出る
- 対象外: macOS 実機での実行。本機にない。fake date で分岐を検証することで代える

### 対象外の特性

- セキュリティ: 記録するのは settings 由来の command と ID 類だけで、tool_input 本体は記録しない。新たな秘密情報の流出経路は増えない
- 使用性: CLI の出力は表 1 つだけで、評価に必要な操作は無い

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T2 の jq 式の閉じ括弧が 1 つ多く syntax error になる。run-guard 系は 5 本ではなく 3 本。topBottleneck の期待値が自己矛盾している。コマンド置換が末尾改行を正規化するため、テストの「完全一致」と骨子が矛盾する。すべて反映済みで、骨子は試作して実測した。

### scope-justification-reviewer

- verdict: pass
- 主指摘: 1000ms 窓、`--json` / `--session`、macOS を対象とする前提、stderr 列について根拠の記述が不足している。反映済み。

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（目的適合性と整合性）と整合している。1000ms の根拠を追記するよう advisory があり、反映済み。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: F1 プラグイン hooks.json と project settings の hook が計測されない。K0 として範囲を明記し、欠落を受け入れる形で反映した。F2 kill されたフックが記録から消える。K9 の trap で反映した。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 記録項目を 3 識別子に限る allow-list とその否定テスト、ログ mode 600、mktemp 失敗時に stderr を素通しすること、イベント名の `@sh`。反映済み。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: TERM を trap した子に対して `wait` が子の終了までブロックし、K9 が効かない（実測 5.5s）。最大 1 秒の猶予を置いてから SIGKILL にする形に修正し、TERM を無視する子で 1311ms を実測した。プロセスグループ kill は dash と zsh で動かないので不採用とし、孫プロセスの残留を限界として明記した。

### scope-justification-reviewer

- verdict: pass
- 主指摘: K0 / K9 / allow-list / 試作による裏付けは、いずれも根拠があり scope drift も無い。

### decision-quality-reviewer

- verdict: pass
- 主指摘: K0 は技術制約による境界、K9 は生存バイアスへの対策で、支配軸と整合している。

### greenfield-perspective-reviewer

- verdict: needs-work
- 主指摘: project settings を除外する根拠が薄い。プラグイン側の代替信号を検討した跡が無い。K0 に、web 環境では hook-timer.sh が存在しないこと、OTEL が org allowlisting 前提であること、codex Stop ゲートが opt-in であることを追記した。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: advisory として、jq が無い場合の temp dir（入力の生データ）の残留と、シグナル後に wait しないことの 2 点。どちらも修正し再実測した。

<!-- auto-review: verdict=needs-work; hash=9bbdccf4e47480bafc20c3cd6b28f6c4b9aa3bfba4cde74e743dbdab504cff84; design-hash=b4dd2fb9ac679455f50e7c746acf0f6bb03ca4d1f2e0931429ceb6db85c9d2c7; at=2026-09-27T16:58:52.814Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: K9 の修正（1311ms / 406ms）を実測で再確認し、骨子と試作がバイト単位で一致することも確認した。記述のずれ 3 点（ケース数、spawnSync とシグナル送信のテスト手段、ヘッダコメントの exit 仕様）は反映済み。

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: K0 の除外根拠は妥当。advisory として、README に「hook_success に記録が無いことは速いことを意味しない」を明記するよう指摘があり、T5 に反映した。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=8bf1694c6dc2c62267436f78ff4aedb30618aacdedb6c4d81edf326a2478ee5f; design-hash=06ba9c52be6da7dca13d4e82c70e8157d19aaeb81d7110c442c6ec6f69296830; at=2026-09-27T17:34:32.769Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-vulnerability-analyzer -->

<!-- auto-review: verdict=pass; hash=24bd627c4b53104b37a2b90033eae00922d35463aa61f6cffc3f70372d7e1aeb; design-hash=8039721be6927f7ca8db323a1d0e0c5dbd6cc36a825bb3aba42d49e18bf1de97; at=2026-09-27T17:42:42.159Z; reviewers=logic-validator+greenfield-perspective-reviewer -->
<!-- intent-triage: adopted=28; excluded=1; at=2026-09-27T17:43:03.013Z -->
