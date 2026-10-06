# Research: 実時間・タイムアウトに依存するテストの分離

## 1. 実行経路（どこが何を回しているか）

| 経路                   | 実行内容                                                                        | 根拠                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| completion gate (Stop) | `${pm} run typecheck` → `${pm} run test`（`execSync`, timeout 120000）          | `home/dot_claude/hooks/implementations/completion-gate.ts:205-218`, `:130-132` |
| pre-commit             | staged に `*claude/hooks/*` があるか `FORCE_HOOK_TESTS=1` のとき `bun run test` | `scripts/hooks/pre-commit` §6                                                  |
| pre-push               | zizmor, gitleaks のみ（テストなし）                                             | `scripts/hooks/pre-push`                                                       |
| CI                     | `ci-typescript.yml` の `Run tests` step が `bun run test`（paths フィルタ付き） | `.github/workflows/ci-typescript.yml:64-65`                                    |
| 全件                   | `check` = `npm run test && typecheck && lint`                                   | `package.json` scripts                                                         |

- `test` = `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/**/*.test.ts tests/tailnet-ssh.test.mjs`
- `--test-concurrency` 指定なし。node:test はファイル単位で子プロセスを並列起動する（約 100 ファイル）。ファイル内は逐次（`concurrency` 指定は grep で 0 件）
- bun run の shell では `**` は 1 階層の `*` として展開される（実測: `a/**/*.test.ts` → `a/b/x.test.ts` のみ、`a/b/c/y.test.ts` は不一致）。テストは全て `tests/unit/` 直下（99 ファイル）。したがって `tests/perf/*.test.ts` を新設すると現行 glob に一致してしまう
- perf 系の命名規約・`test:perf` script は現存しない

## 2. 再現観測（2026-10-06, 本機, `bun run test` を 3 回連続）

| run | 結果   | 失敗テスト                                                                          |
| --- | ------ | ----------------------------------------------------------------------------------- |
| 1   | fail 3 | complexity-delta.test.ts:387, working-tree-fingerprint.test.ts:169 (#7), :249 (#13) |
| 2   | pass   | —                                                                                   |
| 3   | fail 1 | complexity-delta.test.ts:387                                                        |

workflow-bash-sync は今回の 3 回では落ちていない（依頼文の観測では 2 回落ちた）。並列負荷下の flake が複数ファイルに散在していることは実測で確認できた。

## 3. 失敗の根本原因（コードで確認済み）

### 3.1 workflow-bash-sync tripwire（依頼の観測ケース）

- `TRIPWIRE_GIT_TIMEOUT_MS = 200`（`implementations/workflow-bash-sync.ts:69`）を `execFileAsync("git", [... status ...], { timeout })`（:288）に渡す。モジュール private で注入点なし
- タイムアウトすると `.tripwire-disabled` マーカーを書き（:290-292）、以後そのセッションでは tripwire を走らせない（ラッチ）。依頼文の失敗 2（`off-plan-writes.log` ENOENT）は、ctx1 で disabled がラッチ → ctx2 で tripwire 不実行 → log 未作成、と説明でき二次的失敗という見立てと一致する
- 影響テスト: describe "tripwire (K2)" の :161 / :170 / :193 / :211 / :250（いずれも `createGitWorkflowRepo` の一時 repo で実 git を起動）
- 既存の「git が無い」テスト（:231）は `PATH=""` による ENOENT 経路で、`err.killed`（真のタイムアウト）経路は未テスト

### 3.2 complexity-delta「counts a stop timeout and resets the count on a success」(:387)

- `setup({ timeoutMs: 200 })` の 200ms は `createHook(() => ({ ccccTimeoutMs }))` 経由で **全呼び出し** に適用される（test :59-72）
- テストは「成功 → sleep 30 でタイムアウト → 成功」を期待するが、成功させたい呼び出し（`t.respond(...)` = `exec cat`）も 200ms 以内に終わる必要がある。失敗値 `2 !== 0`（:396）は最後の成功呼び出しが負荷でタイムアウトしたことを示す
- 注入点は既にある。直すのはテスト側（呼び出しごとにタイムアウトを切り替えられる setup）
- 同ファイル :362「two consecutive timeouts」は全呼び出しが `sleep 30` なので決定的

### 3.3 working-tree-fingerprint #7 / #13

- `computeTreeFingerprint(cwd, deadlineMs = DEFAULT_DEADLINE_MS /* 2000 */)`（`lib/working-tree-fingerprint.ts:27, :131-135`）。複数の git 起動と untracked ハッシュを 1 つの deadline で測り、超えると `null`
- #7 の `'unknown'`、#13 の baseline 不在は、いずれも fingerprint が `null` になった結果（#7 は 4430ms かかっている）
- `computeTreeFingerprint` は `deadlineMs` を受け取るが、`checkTreeChange(stateDir, sessionId, cwd)`（:245）は受け取らず既定値で呼ぶ。テストの `saveCurrent` / `stateOf` も既定値を使う
- 本番呼び出し元は `completion-gate.ts:163, :185` のみ

## 4. 時間依存テストの全体棚卸し（分類）

分類: **A** = ロジックテストが本番タイムアウトと偶然競争している（注入で決定的にできる） / **B** = タイムアウト挙動そのものの検証 / **C** = 実時間を測る性能ガード / **D** = 時間は使うが flaky 要因でない

### A（注入で決定化する対象）

| 対象                                                                                                                                                                                                   | 時間要因                                                                 | 注入点                                                        | 観測              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------- |
| workflow-bash-sync.test.ts tripwire 群                                                                                                                                                                 | 本番 200ms git timeout                                                   | なし（新設が必要）                                            | 依頼文で 2 回失敗 |
| complexity-delta.test.ts:387                                                                                                                                                                           | テストが注入した 200ms が成功経路にも効く                                | あり（テスト側修正）                                          | 2/3 失敗          |
| working-tree-fingerprint.test.ts（`saveCurrent`/`stateOf`/直接呼び出し）                                                                                                                               | 本番 2000ms deadline                                                     | `computeTreeFingerprint` にはあり、`checkTreeChange` にはなし | 1/3 失敗          |
| bash-parser 経由で `parsingMethod: "tree-sitter"` を期待するテスト（8 ファイル）                                                                                                                       | 本番 `PARSE_BUDGET_MS = 100`（`lib/bash-parser.ts:128`, モジュール定数） | なし                                                          | 未観測            |
| hook-timer.test.ts:456「waits for a child that traps TERM」                                                                                                                                            | 固定 300ms 後に kill。trap 設置前に kill すると "bye" が出ない           | なし（他テスト同様 marker 同期に変えられる）                  | 未観測            |
| complexity-delta 内部 git `GIT_TIMEOUT_MS = 2000`、compaction-testament `GIT_TIMEOUT_MS = 2000`、quality-loop `findRepoRoot` 3000ms、run-guard / hook-timer の poll 予算（3〜5s）、session.test.ts 30s | 余裕 10 倍以上                                                           | 一部なし                                                      | 未観測            |

### B（タイムアウト挙動の検証。小さいタイムアウト + 長時間ブロックで既に結果は決定的）

complexity-delta :362、quality-loop.test.ts:245（200ms vs `sleep 5`）、run-guard.test.ts:121/:132（`RUN_GUARD_TIMEOUT=1` vs `sleep 30`、最小 1 秒単位）、working-tree-fingerprint #16（deadline 0）。
例外: bash-parser.test.ts:642「gives up within the time budget」と :668 は、本番 100ms 予算を **入力が実際に超えること** に依存する（速い機械では逆方向に不確定）。

### C（実時間を測る性能ガード → `test:perf` 候補）

- ReDoS / 線形時間ガード（`performance.now()` で `< N ms`）: bash-parser.test.ts :602, :642(上限部分), :668(<50ms), :720; linear-match.test.ts:163-171; linear-match-equivalence.test.ts:559; shell-lex.test.ts:132, :152 (<200ms); command-parsing.test.ts:220; pattern-matching.test.ts:474-484 (<50ms); safe-command-list.test.ts:270; read-only-command.test.ts:141, :148; node-modules-policy.test.ts:151, :209; deny-node-modules.test.ts:296, :310, :326; permission-auto-approve.test.ts:305, :1331; document-workflow-guard.test.ts:760
- シェルラッパの実時間: hook-timer.test.ts:360（SIGTERM `250 <= d < 2000`）, :396（slow jq `< 1500`）, :483（SIGKILL grace `1000 <= e < 4000`）; run-guard.test.ts:149（早期終了 `< 10000`）; quality-loop.test.ts:245 の `< 3000` 部分
- 上限が厳しいもの（<50ms, <200ms, <1500ms）ほど負荷で落ちやすい

### D（対象外）

Date.now() を大きな余裕で使う fixture（discord-forum, distill-health-notice, insight-digest-notice, session, workflow-cli 等）、hook-timing-report の数値 fixture、`sleep 5` 等を文字列として分類するだけのテスト、`afkTimeoutMs` 等のデータ項目、byte/round 予算。

### 対象範囲外（`test` に含まれない）

`tests/agent-vm`, `tests/shell-gate`, `tests/git-worktree-*` 等の bash スイートは実 `sleep`/`timeout` を使うが、`test` からも gate からも呼ばれない（個別 script / 個別 CI）。今回は対象外。`tests/tailnet-ssh.test.mjs` は時間要因なし。

## 5. 先行例

`complexity-delta.ts` の `createHook(getEnv: () => HookEnv = defaultEnv)`（:409）と `HookEnv.ccccTimeoutMs`。テストは `PATIENT_TIMEOUT_MS = 10_000` で決定的にロジックを検証し、タイムアウト挙動だけ 200ms + `sleep 30` で検証する。default export は `createHook()`（本番値）。

## 5.5 負荷実験（2026-10-06, 本機 8 コア, 変更前のコード）

### 同じ worktree でスイートを並走させた場合（3 回中 2 回失敗）

- 時間依存: deny-node-modules「asks for a repeated cp/ls word in linear time」、workflow-bash-sync「runs the tripwire for an approved plan whose research.md is missing」（依頼文の観測を再現）
- 時間と無関係の衝突: log-rotation.test.ts（固定パス `/tmp/test-log-rotation` を 2 本のスイートが取り合う）、resume-incomplete-work.test.ts（実 repo の `process.cwd()/.tmp/sessions/test-ses` を作って消す）
- → この負荷のかけ方は、時間とは無関係の失敗が混ざるので、検証には使えない。衝突する 2 ファイルはテストの分離の問題で、今回の範囲外として別途報告する

### CPU 飽和（`yes > /dev/null` × 8）の場合（3 回中 3 回失敗）

| テスト                                                                                               | 所要             | 原因（コードで確認）                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| compaction-testament「includes utterances outside any git repository」                               | 2010ms           | `runGit` の `GIT_TIMEOUT_MS = 2000`（`implementations/compaction-testament.ts:63, :421`）で `check-ignore` が失敗 → `classifyGit` が「ignore されていない」扱い（:446-455）→ 詳細を省略 |
| complexity-delta「shows a function that got worse…」(:147)、「stays silent on a second stop…」(:173) | 6457ms / 17326ms | `resolveRoot` の `GIT_TIMEOUT_MS = 2000`（`implementations/complexity-delta.ts:43, :166-177`）超過 → `null` → 何も出力しない                                                            |
| deny-node-modules「should allow read-only commands」(:145)                                           | 206ms            | bash-parser の `PARSE_BUDGET_MS = 100` 超過 → give-up → deny（`success` を期待）                                                                                                        |
| deny-node-modules「asks for a repeated cp/ls word in linear time」(:301)                             | 132〜142ms       | 同上（`ask` を期待して `deny`）                                                                                                                                                         |

→ 「余裕が大きいので見送り」とした経路（`GIT_TIMEOUT_MS`、bash-parser の予算）も、飽和負荷の下では落ちる。ユーザー判断により、これらも注入の対象に加える（2026-10-06）。

### bash-parser の予算に依存するテスト（予算を超えることを期待するもの）

- bash-parser.test.ts :637-650「gives up within the time budget」×2、:652「keeps the parser usable after a cancelled parse」、:663「does not parse an input again after giving up」
- auto-approve.test.ts:368「denies when a fragment's re-parse gives up during classification」（`parseForCollect` に `>` × 20000）
- document-workflow-guard.test.ts:755-767（`>` × 20000 で「within 100 ms」を期待し、経過 < 1000ms も assert）
- 予算を注入できれば、予算 0 で give-up を決定的に起こせる（`overBudget = performance.now() - start > budget`、`lib/bash-parser.ts:215`）

### bash-parser の利用元

lib: permission-analyzer, deny-input, sed-parser, pattern-matcher, safe-command-list, command-parsing, heredoc-data。implementations: deny-node-modules, document-workflow-guard, auto-approve。予算はモジュール定数で、プロセス全体の状態（`giveUps`, `timedOutInputs`）と並んでいる（:141-146）。

## 5.6 飽和負荷が計器として使えなかった件（2026-10-06）

plan-1 の実装後、plan-1 の 5 テストファイルを `yes` × 8 の下で実行したところ、1 回目で 13 件が失敗した。所要は 1 件あたり 10〜70 秒（例: working-tree-fingerprint #21 が 70253ms）。失敗の多くは、注入した「十分長い」10 秒（`PATIENT_TIMEOUT_MS`）そのものを超えたもの。

同時刻のロードアベレージは 28（8 コア）。CPU 使用率の最上位は `yes` ではなく Cybereason（ウイルス対策、279%、起動から 1 時間 22 分）だった。テストは git / sh / sleep を大量に起動し、そのたびに検査が入る。§5.5 の飽和実験（3 回とも 30 秒前後で完走）のときとは、ウイルス対策の動き方が違っていた可能性が高い。

→ この条件の飽和負荷は、変更の良し悪しではなく検査のコストを測る計器になっている。ユーザー判断で、完了判定は「負荷なしで `bun run test` を 10 回、失敗 0 件」に変えた。負荷なしの 5 ファイルの実行は 164 件すべて pass。

## 5.7 棚卸しの見落とし: run-guard「kills descendants」（2026-10-06）

§4 では run-guard.test.ts:132 を「`RUN_GUARD_TIMEOUT=1` の待ちで結果が決まる B」とした。実際には、fake の bun が `sleep 30 &` の直後に子の PID をファイルに書き、その後にテストがそのファイルを読む。ラッパーの 1 秒のタイムアウトまでに fake の bun の起動と PID の書き込みが終わらないと、ファイルが作られず `readFileSync` が ENOENT で落ちる（時間との競争。分類は A）。

観測: plan-1 の実装時の全件実行で 1 回（unit、約 1074ms）、plan-3 の後の `test:perf` 3 回中 1 回（perf の対、1102ms）、完了基準の `bun run test` 10 回中 1 回（unit、1095ms）。ほかの失敗は 10 回とも無し。

`RUN_GUARD_TIMEOUT` は既存の環境変数の注入点（整数秒、最小 1）。ユーザー判断で、このテストだけ 5 秒にして直す（plan-3 T3.5）。

## 6. 未確認事項

- （更新）bash-parser の 100ms 予算に起因する失敗は、アイドル時の 3 回では未観測だったが、CPU 飽和時に観測した（§5.5）
- hook-timer :456 の race は未観測（コードからの推論）
- completion-gate.test.ts は `runCheck` だけを import し、fingerprint を使わない（grep で確認済み）
