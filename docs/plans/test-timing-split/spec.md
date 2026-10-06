# Spec: 実時間・タイムアウト依存テストの分離

## Goal

pre-commit と completion gate が回す `test` を、並列負荷によって落ちない決定的なものにする。実時間を本当に測るテストは `test:perf` に分け、CI と全件実行（`check`）でだけ回す。本番フックのタイムアウト値は変えない。

## Experience Delta

- 変更前: completion gate / pre-commit の `bun run test` が、ロジックに問題がなくても負荷で落ちる。本機の測定では、アイドル時に 3 回中 2 回、CPU 飽和時に 3 回中 3 回失敗した（research.md §2, §5.5）。依頼文の観測では、gate が 2 回続けてブロックされた
- 変更後: `test` に含まれるロジックテストは、注入した十分に長いタイムアウト・予算で検証される。タイムアウト経路そのものは、ブロックし続ける fake プロセスか予算 0 で決定的に検証される。CPU 飽和実験で落ちた経路も含めて、負荷の大きさが結果を左右しない。実時間の検証は `test:perf` に分け、CI（`ci-typescript.yml`）と `check` だけが回す

## Architecture

```
package.json
  test       = node --import preload --test hooks/tests/unit/*.test.ts tests/tailnet-ssh.test.mjs
  test:perf  = node --import preload --test --test-concurrency=1 hooks/tests/perf/*.test.ts
  check      = test && test:perf && typecheck && lint

呼び出し元              回す script
  completion gate        test          (completion-gate.ts:213-214、変更なし)
  pre-commit             test          (scripts/hooks/pre-commit §6、変更なし)
  CI ci-typescript.yml   test, test:perf (step 追加)
  check                  test, test:perf

決定化（tests/unit に残る）
  workflow-bash-sync   : createHook(getEnv) + HookEnv.tripwireGitTimeoutMs を新設（既定 200）
  working-tree-fp      : checkTreeChange に deadlineMs 引数（既定 2000）を追加
  complexity-delta     : HookEnv に gitTimeoutMs を追加（既定 2000）。テスト setup は呼び出しごとに cccc の timeout を切り替える
  compaction-testament : createHook(getEnv) + HookEnv.gitTimeoutMs を新設（既定 2000）
  bash-parser          : 予算をモジュール内の可変値にし、setParseBudgetMs() で差し替える（既定 100）
                         preload-test-env.mjs が全テストプロセスで 10_000 に設定する
  hook-timer :456      : 固定 300ms ではなく、trap 設置後の marker を待って kill する
```

二層の実行単位:

- plan-1: フックのタイムアウト注入（workflow-bash-sync / working-tree-fingerprint / complexity-delta / compaction-testament）と hook-timer :456
- plan-2: bash-parser の予算注入（setter、preload、予算 0 による give-up テストの決定化）
- plan-3: perf 分離（`tests/perf/` と `tests/support/` の新設、分類 C のテストの移設と分割、配置を検査するテスト（K9）、scripts と CI の配線、`tests/README_TESTING.md` と `tests/unit/README.md` への perf の記載）。plan-2 で決定化した give-up テストの経過時間部分もここで perf に移す

## Alternative Approaches (Greenfield View)

### 差分最小案 (Incremental)

落ちたテストの assertion だけを緩める。たとえば workflow-bash-sync の tripwire テストで "tripwire disabled" も許容する、complexity-delta の 200ms を 1000ms に上げる、などがありうる。本番コードには触れず、perf の分離もしない。
欠点: 緩めた assertion は本来の検証（re-arm / off-plan 検知）を失う。200→1000 は余裕を増やすだけで、決定的にはならない。perf のガード（<50ms など）は gate に残り続ける。

### 白紙設計案 (Greenfield)

ゼロから設計するなら、時間に依存する依存先（タイムアウト値・時計）は、すべてフックの生成時に注入する環境として受け取る。ロジックテストは常に十分に長い値か fake clock で回し、実時間の検証は別のスイートに隔離する。
起源: 本番値を構成値として外に出しておけば、テストは「タイムアウトしたか」を入力で決められる。「機械が速いか」に結果が左右されなくなる。complexity-delta の `createHook(getEnv)`（`implementations/complexity-delta.ts:409`）は、すでにこの形になっている。
完全版は、bash-parser の `PARSE_BUDGET_MS`、各フックの `GIT_TIMEOUT_MS = 2000`、hook-timer の poll 予算まで含めて全面的に注入可能にし、`node:test` の `mock.timers` を導入する。

### 採用案と理由

白紙案の構造（生成時注入 + 実時間スイートの隔離）を採る。注入点を新設する対象は、アイドル時か CPU 飽和時に実際に落ちた経路すべてとする（research.md §2, §5.5）。

- アイドル時に失敗: workflow-bash-sync（依頼文で 2 回、並走負荷で 1 回）、working-tree-fingerprint の `checkTreeChange`（3 回中 1 回）、complexity-delta :387（3 回中 2 回。既存の注入点で足り、テスト側だけ直す）
- CPU 飽和時に失敗: complexity-delta と compaction-testament の `GIT_TIMEOUT_MS = 2000`、bash-parser の `PARSE_BUDGET_MS = 100`。当初は「未観測で余裕が大きい」として見送ったが、飽和負荷で落ちたため、ユーザー判断で対象に加えた
- 見送るもの: hook-timer / run-guard の poll 予算（3〜5s）、session.test.ts の 30s、quality-loop の `findRepoRoot` 3000ms など。飽和負荷の 3 回でも落ちていない。完了判定（負荷なしで 10 回、失敗 0 件）で落ちた場合は、範囲を広げる前にユーザーに報告する
- bash-parser にはフックの factory がなく、予算は 10 のモジュールから使われるモジュール定数なので、`createHook(getEnv)` の形は取れない。引数で全 API に通すのは、利用元すべてのシグネチャが変わり過大。そのためモジュール内の可変値と setter にする（K11）
- `mock.timers` は、子プロセスの timeout（`execFile` の `timeout` オプション）には効かない。`performance.now()` も対象外（Node の MockTimers は `Date` と timer 関数が対象）。そのため今回の対象には適用できない

## Key Decisions

- **K1: workflow-bash-sync に complexity-delta と同形の注入点を設ける** — `type HookEnv = { tripwireGitTimeoutMs: number }`。`defaultEnv()` は定数 `TRIPWIRE_GIT_TIMEOUT_MS`（200）をそのまま返し、`process.env` は読まない。環境変数で値を変えられるようにすると、agent が自分の Bash で timeout を縮め、tripwire を無効化できてしまうため。`export function createHook(getEnv = defaultEnv)`、`const hook = createHook(); export default hook;`。`checkTripwire(wfDir, cwd, timeoutMs)` と `describeGitFailure(error, timeoutMs)` は module-private のまま値を受け取る
  - ロジックテスト（tripwire K2 の describe 内で実 git を起動するもの）は `createHook(() => ({ tripwireGitTimeoutMs: PATIENT_TIMEOUT_MS /* 10_000 */ }))` を使う
  - タイムアウト経路のテストは、注入しない **default export の `hook`** をそのまま使い、本番の既定値 200ms で動かす。これで既定値の検証も兼ねる。`createGitWorkflowRepo()` で fixture を作った **後で**、fake git のディレクトリを `envHelper.set("PATH", ...)` で先頭に足す（既存 :231 と同じく `process.env.PATH` を書き換え、afterEach で戻す）。fake git は `status` を含む呼び出しでだけ `echo >> calls; exec sleep 30` し、それ以外は実 git（`which git` で解決した絶対パス）に `exec` で委譲する
    - assert 1: 返ってくる文言が `/tripwire disabled/` に一致する
    - assert 2: `.tripwire-disabled` が存在し、その内容が `git status timed out after 200ms` を含む。200 は本番の既定値を検証するために意図してリテラルで書く（定数を参照させると、既定値が変わっても検知できない）
    - assert 3: 2 回目の呼び出しで calls ファイルの行数が増えない（latch によって git を起動しない）
    - `exec` なので、timeout の SIGTERM は `sleep` 自身に届き、プロセスは残らない
  - 参照: `home/dot_claude/hooks/implementations/workflow-bash-sync.ts:69, :71-118, :264-293, :340-349, :464-469`
  - 参照: `home/dot_claude/hooks/implementations/complexity-delta.ts:50-53, :78-83, :409-452`
  - 参照: `home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts:231-248`（PATH を書き換える既存の前例）
- **K2: `checkTreeChange` に `deadlineMs` 引数を追加し、`computeTreeFingerprint` へ渡す** — シグネチャは `checkTreeChange(stateDir, sessionId, cwd, deadlineMs = DEFAULT_DEADLINE_MS)`。本番の呼び出し元（completion-gate）は引数を渡さず、2000ms のまま動く
  - テスト helper の `saveCurrent` と `stateOf` は `PATIENT_DEADLINE_MS = 30_000` を渡すように変える。#7 と #13 はこの helper の中で失敗していた
  - `computeTreeFingerprint` / `checkTreeChange` を直接呼んでいる箇所も、null を期待するケースを含めて 30_000 を渡す。既定の deadline のままだと、null を期待するテストがタイムアウトのせいで偶然通りうるため、null が「論理的な理由」で返ったことを保証する。#16（deadline 0）だけは 0 のまま
  - 新しいテストは 2 本足す。どちらも決定的
    - 引数が届くこと: `checkTreeChange(stateDir, "s1", repo, 0)` は、正しい baseline があっても `{ state: "unknown", reason: "fingerprint unavailable" }` を返す
    - 既定の deadline の経路: fake git（`diff` を含む呼び出しでだけ `exec sleep 30`、それ以外は実 git に委譲）を PATH の先頭に置き、引数 3 つの `checkTreeChange` が `unknown` を返す。本番の既定値で必ずタイムアウトするので、所要時間は約 2 秒
  - 参照: `home/dot_claude/hooks/lib/working-tree-fingerprint.ts:27, :42-57, :131-135, :245-270`
  - 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:163, :185-189`
- **K3: complexity-delta は cccc の timeout をテストで切り替え、git の timeout を `HookEnv` に加える**
  - cccc: `setup()` の `getEnv` クロージャが可変の `timeoutMs` を読むようにし、戻り値に `setTimeoutMs(ms)` を加える。`getEnv` は呼び出しごとに評価される（`complexity-delta.ts:419`）。:387 は、成功させる呼び出しを `PATIENT_TIMEOUT_MS` で、`sleep 30` の呼び出しだけを 200ms で行う
  - git: `HookEnv` に `gitTimeoutMs: number` を加え、`defaultEnv()` は定数 `GIT_TIMEOUT_MS`（2000）を返す。`run` の中で `getEnv()` を `resolveRoot` より前に呼び、`resolveRoot(cwd, env.gitTimeoutMs)` に渡す。テストの `setup()`（:68）と、もう 1 か所の `createHook(() => ({...}))`（:251）の両方に `gitTimeoutMs: PATIENT_TIMEOUT_MS` を渡す（`HookEnv` の必須項目になるので、渡さないと typecheck で落ちる）
  - 参照: `home/dot_claude/hooks/implementations/complexity-delta.ts:43, :50-53, :78-83, :166-177, :409-420`
  - 参照: `home/dot_claude/hooks/tests/unit/complexity-delta.test.ts:38, :59-72, :147, :173, :387-398`
- **K10: compaction-testament に complexity-delta と同形の注入点を設ける** — `type HookEnv = { gitTimeoutMs: number }`、`defaultEnv()` は定数 `GIT_TIMEOUT_MS`（2000）を返し、`process.env` は読まない。`export function createHook(getEnv = defaultEnv)` の中で今の `defineHook({...})` を返し、`const hook = createHook(); export default hook;`。`runGit(cwd, args, timeoutMs)` と、それを呼ぶ `classifyGit` と branch / status の取得（:446-448, :504-507）に値を渡す。テストは `createHook(() => ({ gitTimeoutMs: PATIENT_TIMEOUT_MS }))` を使う。
  - タイムアウト経路のテスト: 既存のコメント「Anything else (broken repo, timeout, spawn failure) is "not ignored"」（:453）の挙動を固定する。default export の `hook` を使い、`check-ignore` を含む呼び出しでだけ `exec sleep 30` する fake git を PATH の先頭に置く。snapshot に詳細が含まれない（"ignore されていないため省略" を含む）ことを assert する
  - 参照: `home/dot_claude/hooks/implementations/compaction-testament.ts:63, :408-437, :445-456, :504-507, :607, :719-724`
  - 参照: `home/dot_claude/hooks/tests/unit/compaction-testament.test.ts:21`
- **K11: bash-parser の予算をモジュール内の可変値にし、setter で差し替える** — `export const DEFAULT_PARSE_BUDGET_MS = 100;` と `let parseBudgetMs = DEFAULT_PARSE_BUDGET_MS;`、`export function setParseBudgetMs(ms: number): void`（有限で 0 以上の数でなければ throw）。`overBudget` は `parseBudgetMs` を読む。本番コードは setter を呼ばないので、既定値 100 のまま動く
  - 全テストプロセスへの適用: `tests/preload-test-env.mjs` の末尾で `bash-parser.ts` を import し、`setParseBudgetMs(10_000)` を呼ぶ。preload は `node --test` が起動するファイルごとの子プロセスで毎回走るので、bash-parser を使うテストファイル（10 モジュール経由で多数）すべてに漏れなく効く。ファイルごとに setter を呼ぶ方式は、呼び忘れたファイルが flake として残る
  - bash-parser の静的 import は型だけで（:1099 の `import type`）、web-tree-sitter は初回解析時に動的 import される（:260-269）。preload で import しても wasm の初期化もログ設定の読み込みも起きない。それでも import は preload の末尾、既存の環境変数の設定の後に置く
  - give-up の決定的な検証: 予算を超えることを期待するテスト（research.md §5.5 の 6 件。bash-parser.test.ts に 4 件、auto-approve.test.ts に 1 件、document-workflow-guard.test.ts に 1 件）は、予算 0 で give-up させる。`overBudget` は `performance.now() - start > budget`（:215）で、解析の途中の `progressCallback` か解析後の確認（:221）で必ず真になる
    - 予算 0 は **切りたい解析の呼び出しの間だけ** 効かせる。予算 0 はどんな入力の解析も切るので、テスト全体に効かせると、短い入力（`ls -la`、`echo after-limit-c`）まで give-up し、テストが狙いの経路を通らずに通ってしまう。auto-approve :368 では `classifyBashDeny` の中の `parseForCollect(...)` の前後だけ、bash-parser :652 では 1 回目の解析だけを予算 0 にする
    - 予算は `try/finally` で 10_000 に戻す。assert が失敗しても、同じファイルの後続テストに 0 が残らないように。helper `withParseBudget(ms, fn)` を `tests/support/parse-budget.ts` に置き、これ経由でだけ切り替える
    - 予算 0 で切った入力は `timedOutInputs`（:145, :210-213）にプロセスが終わるまで残り、同じ文字列は以後どの予算でも give-up する。そのため give-up テストの入力は、ファイル内で一意な文字列にする（既存の `limit-a`〜`limit-d`、`aa-limit` の慣習どおり。各ファイル内で一意であることは確認済み）
  - give-up の理由文の「100 ms」は本番の値を説明する文で、テストで差し替えた予算とは連動させない
  - perf で本番の予算を測るテストは、ファイルの先頭で `setParseBudgetMs(DEFAULT_PARSE_BUDGET_MS)` を呼ぶ。preload は perf の子プロセスでも 10_000 に設定するため
  - preload が効いていることを検査する: K9 のファイルで、bash-parser の現在の予算（読み取り用に `getParseBudgetMs()` を export する）が 10_000 であることを assert する。preload が外れても、静かに flake に戻らず失敗として現れるように
  - サブプロセスへは届かない: preload が効くのは `node --test` の子プロセスの中だけで、テストが bun で起動したフックには届かない。該当するのは run-guard.test.ts:266 の 1 件（実 bun で `deny-node-modules.ts` を起動し、`rm -rf node_modules` に `deny` を期待）だけ。予算を超えて give-up しても結果は同じ `deny` なので、本番の予算のままでも結果は負荷に左右されない
  - 安全性の根拠: setter は値を大きくも小さくもできるので、根拠は「縮める方向だけ」ではなく「本番コードからは呼ばれない」ことにある。これを R7 で機械的に検査する。setter は agent の Bash からは呼べない（フックのプロセス内の関数呼び出しのみ）。環境変数で予算を変える案は採らない。値の出所を `process.env` にすると、フックの実行環境しだいで本番の予算が変わりうるため（K1 の `defaultEnv()` と同じ方針）
  - 型の除去: preload（`.mjs`）から `.ts` を import できるのは、`node --test` が型を除去して実行するため。CI の Node（`.github/actions/setup-node-bun` の既定 `22`）でも、既存の `.ts` テストが同じ仕組みで動いているので、新しい前提は増えない
  - 参照: `home/dot_claude/hooks/lib/bash-parser.ts:120-146, :197-236`, `home/dot_claude/hooks/tests/preload-test-env.mjs`
- **K4: hook-timer :456 は marker で同期する（race は未観測。コードからの推論）** — 子プロセスは `trap` を設置した後に marker を touch する。テストは `waitForFile(marker)` の後で kill する。:483 の既存パターンと同じにする。`waitForFile` には既に 5000ms の上限があり（:96）、marker が現れなければ明示的なエラーで失敗する
  - 参照: `home/dot_claude/hooks/tests/unit/hook-timer.test.ts:91-104, :456-480, :483-500`
- **K5: perf はディレクトリで分け、`test` の glob を `tests/unit/` に狭める** — bun run の shell は `**` を 1 階層の `*` として展開する（実測。research.md §1）。そのため `tests/perf/*.test.ts` は今の `tests/**/*.test.ts` に一致してしまう。`test` を `home/dot_claude/hooks/tests/unit/*.test.ts` に変える。今あるテストは全て `tests/unit/` 直下にあるので、`test` の対象集合は「perf に移すテストを除いて」変わらない
  - unit と perf が共有する helper は、中立なディレクトリ `tests/support/` に置く（例: `tests/support/hook-timer-helpers.ts`）。perf → unit というディレクトリ間の依存を作らないため。`*.test.ts` ではないので、どちらの glob にも一致しない。`tests/support/` は `tests/unit/` と同じ深さなので、`import.meta.url` からの相対パス（`../../executable_hook-timer.sh`）はそのまま使える
  - 参照: `package.json` scripts.test, `home/dot_claude/hooks/tests/unit/hook-timer.test.ts:31-32`
- **K6: `test:perf` は `--test-concurrency=1` で回す** — 実時間を測るテスト同士が CPU を奪い合わないよう、ファイルを逐次実行する。perf は数ファイルなので、直列化しても所要時間の増加は小さい。閾値は今の値のまま変えない。CI で perf が落ちたら、再実行で流さず、退行か閾値の妥当性を調べる対象として扱う
- **K7: perf の配線は CI と `check` だけにする** — `ci-typescript.yml` の `Run tests` の後に `Run perf tests: bun run test:perf` を足す。paths フィルタは `**/*.ts` なので `tests/perf/` も対象に入る。TypeScript CI は `status-check.yml:43` で必須チェックに集約されているので、perf の step も merge を止められる。`check` は `npm run test && npm run test:perf && npm run typecheck && npm run lint`。completion gate（`${pm} run test`）と pre-commit（`bun run test`）は `test` を呼ぶので、変更しなくても perf を回さなくなる
  - トレードオフ（意図したもの）: perf の退行は、ローカルの gate と pre-commit では検知されず、PR の CI で初めて表に出る
  - 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:213-214`, `scripts/hooks/pre-commit` §6, `.github/workflows/ci-typescript.yml:64-65`, `.github/workflows/status-check.yml:43`
- **K8: 実時間の assert はすべて perf に移す** — ユーザーの選択「C を全部移す」に従い、`test`（unit）には経過時間を assert する行を 1 つも残さない
  - (a) 時間が主題の `it`（ReDoS・線形時間ガード、hook-timer の時間範囲、run-guard :149「早く終われば待たない」）は、`it` ブロックごと perf に移す
  - (b) 本番の実時間予算を入力が実際に超えることに依存していた `it`（give-up 系 6 件、3 ファイル: bash-parser.test.ts 4 件、auto-approve.test.ts:368、document-workflow-guard.test.ts:754-767。research.md §5.5）は、K11 で予算 0 にして unit に残す。経過時間の assert（`< 1000`, `< 50`）だけを、(c) と同じく perf の `it` に分ける。perf 側は本番の予算 100ms で測る
  - (c) ロジックが主題で、経過時間の上限は付随する「ハング検知」にすぎない `it`（quality-loop :245、run-guard :132）は分割する。unit には経過時間の assert を除いたロジック検証を残し、perf には同じ操作で経過時間の上限だけを assert する `it` を新設する
  - 移動対象の `it` の一覧と、各項目がどの区分に当たるかは plan-3 の T2 に列挙する
  - 「経過時間を assert しない」ことと「実時間を待たない」ことは別。K2 と K10 のタイムアウト経路のテスト（本番の既定値 2000ms を fake git で必ず超えさせるもの）は、結果だけを assert し、経過時間は assert しない。1 本あたり約 2 秒の固定コストがかかるが、結果は負荷に左右されないので unit に置く
  - `describe` レベルの setup（`before`/`after`、temp dir、環境変数の書き換え、bash-parser のプロセス全体の状態）に依存する `it` は、perf 側に同じ setup を用意する。プロセス全体の状態は、`parserGiveUpMark()` による差分で比較しているので、ファイルが別プロセスに分かれても影響しない
- **K9: テストの配置を検査するテストを unit に置く** — `tests/unit/test-layout.test.ts` を新設する。`home/dot_claude/hooks/tests/` 以下を再帰的に走査し、2 点を assert する
  - `*.test.ts` が `tests/unit/` か `tests/perf/` の直下にしか無いこと。どちらの glob にも拾われない配置を作らせない
  - `tests/perf/` に 1 つ以上の `*.test.ts` があること
  - K5 で glob を狭めたことで、テストが黙って実行対象から漏れる経路が生まれる。それを恒久的に塞ぐため。2 点目は、perf が空になって CI の `test:perf` が何も検査しない状態も防ぐ
  - R7 の検査（setter が本番コードから参照されていないこと）と、preload の予算が 10_000 であることの検査（K11）も同じファイルに置く
  - K8 の検査は `performance.now()` の直後の減算（正規表現 `/performance\.now\(\)\s*-/`）を拾う経験則で、`Date.now()` や `process.hrtime` による経過時間の計算や、`performance.now()` を変数に入れてから引く書き方は拾えない。今の unit にある `Date.now() -` はすべて日付の fixture（例: working-tree-fingerprint.test.ts:348 の `Date.now() - day`）なので、検査に加えると誤検知になる。この限界は受け入れる
  - 検査ファイル自身に検索語が現れて一致してしまわないよう、検索語は文字列の連結で組み立てる（例: `"setParse" + "BudgetMs"`）。検査ファイル自身は `tests/unit/` にあるので、K8 の検査の対象からは自分自身を除く
  - K8 の不変条件も同じファイルで機械的に検査する。`tests/unit/*.test.ts` に `performance.now() -` という部分文字列（経過時間の計算）が 0 件であること。poll の締め切り（`performance.now() + N`）は待ち合わせなので対象外で、`tests/support/` の helper に置く
  - README の更新（plan-3）は、`test` の対象が `tests/unit/` に変わり `test:perf` が増えることを、テストを書く人が知るための最小限の記載にとどめる

## Risks

- **R1**: unit から perf へ `it` を移すとき、テストが消える・重複する → plan-3 で 2 点を確認する。(1) plan-3 着手前（plan-1・plan-2 の完了後）の `ℹ tests` 件数に、K8(b)(c) で perf に新設する件数と K9 の件数を足したものが、plan-3 完了後の unit + perf の合計と一致すること。(2) `test:perf` の出力に、plan-3 T2 で列挙した `it` 名が全部あること
- **R2**: hook-timer の perf テストは helper（`waitForFile`, `pollForLastRecord`, `runWrapperSync`, `baseEnv`, `makeTempDir` など）を共有している → `tests/support/hook-timer-helpers.ts` に切り出す（K5）
- **R3**: （解消済み）completion-gate.test.ts が import しているのは `runCheck` だけで、hook 本体も fingerprint も呼ばない（grep で確認。`checkTreeChange`・`computeTreeFingerprint`・`invokeRun` は 0 件）
- **R4**: 見送った時間要因（hook-timer / run-guard の poll 予算 3〜5s、session.test.ts の 30s、quality-loop の `findRepoRoot` 3000ms など）は、負荷しだいで落ちる可能性が残る → 完了判定（負荷なしで 10 回、失敗 0 件）で落ちたら、範囲を広げる前に、どのテストが何で落ちたかをユーザーに報告する
- **R7**: bash-parser の予算を可変にすると、本番コードが誤って setter を呼ぶ経路が生まれる → K9 のファイルで機械的に検査する。`home/dot_claude/` 以下の `.ts` / `.mjs` / `.js`（`node_modules/` とパス接頭辞 `hooks/tests/` を除く）から、括弧なしの識別子 `setParseBudgetMs` を検索し、一致が `lib/bash-parser.ts` の `export function setParseBudgetMs(` の定義行ちょうど 1 件であることを assert する。括弧なしの識別子で探すので、別名 import や再 export も一致として拾える。この検査が成り立つよう、`bash-parser.ts` の中では定義行以外に識別子を書かない（JSDoc や throw の文言にも書かず、定義は 1 行に収める）
- **R8**: 並走負荷で見つかった、固定パスを共有するテスト（log-rotation の `/tmp/test-log-rotation`、resume-incomplete-work の `process.cwd()/.tmp/sessions/test-ses`）は、別 worktree の gate が同時に走ると衝突しうる → 時間依存ではないので今回の範囲外とし、完了報告で別件として伝える
- **R5**: CI の `ci-typescript.yml` の paths フィルタには `executable_hook-timer.sh` と `executable_run-guard.sh` が無い。シェルスクリプトだけを変えた PR では、perf も unit も CI で走らない → この状態は今回の変更の前からあり、今回は変えない（範囲外として記録する）
- **R6**: perf の閾値（<50ms など）は、CI runner が混んでいると落ちうる → K6 のとおり、閾値は変えずに、落ちたら調べる対象として扱う

## ISO 25010 次元選択

- **信頼性（成熟性）**: 主目的。`test` が負荷によって落ちないこと。
  - 手順: 負荷を足さずに、`bun run test` を 10 回続けて実行する。`bun run test` 自体がテストファイルを並列の子プロセスで走らせるので、その並列負荷の下での挙動を見ることになる
  - 合格基準: 10 回すべてで失敗 0 件。これは「flake が無い」ことの証明ではなく、「観測された主因が消えた」ことの確認と位置づける（変更前はアイドル時に 3 回中 2 回失敗。research.md §2）。完了報告もこの表現にそろえる
  - 失敗が出た場合: 見送った要因（R4）でも想定外の経路でも、範囲を広げる前に、どのテストが何で落ちたかをユーザーに報告する
  - 各 plan の完了時にも、その plan が対象にしたテストファイルを `bun run test` と同じ並列度で 3 回実行し、失敗 0 件を確認する
  - CPU 飽和（`yes` × コア数）を完了判定に使わない理由: 本機ではウイルス対策ソフト（Cybereason）がプロセスの起動ごとに検査をかけ、飽和負荷と重なると 1 件のテストに 25〜70 秒かかった（2026-10-06、ロードアベレージ 28）。この条件では注入した 10 秒の値も超え、変更の良し悪しではなく検査のコストを測ることになる（research.md §5.6）。飽和実験は、注入の対象を決める根拠（§5.5）としてだけ使う
- **機能適合性（機能正確性）**: 注入点の新設で本番の既定値と挙動が変わらないこと、tripwire のタイムアウト経路が引き続き無効化を記録すること
- **保守性（試験性）**: 時間依存の検証を入力で制御できるようにする
- **対象外**: 性能効率性（本番の性能は変えない。perf スイートは既存の性能ガードを移すだけ）、セキュリティ・互換性・使用性・移植性（フックの外部仕様に変更なし）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: K8 の基準 (a) と、quality-loop :245（`<3000` を assert）を unit に残す例外とが矛盾し、「C を全部移す」選択ともずれる。件数一致だけでは perf の glob 漏れを検知できない。K1 のタイムアウト経路のテスト（PATH の差し替え順序、`.tripwire-disabled` の内容）と、K2 の helper（`saveCurrent`/`stateOf`）の変更を明記すべき

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全変更に根拠があり、scope drift はない。未観測の項目（K4、bash-parser の give-up テストの移設）は推論ベースであることを明示し、5 回実行の合格基準を具体値で書くべき

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸（gate の偽陽性を防ぐ品質影響）と整合している。perf の退行が CI まで検知されない点と、`tests/unit/` に狭めた glob から将来テストが漏れうる点をリスクとして書くとよい

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案と同じ形（注入 + 実時間スイートの隔離）。未観測経路の見送りは記録済みのトレードオフ。合否判定はアイドル時の 5 回ではなく、負荷をかけた状態で行うべき

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 注入点の依存方向は健全。共有 helper は `tests/unit/` ではなく中立な場所に置き、perf→unit の依存を避けたほうがよい。`import.meta.url` 基準のパス解決に注意

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 注入点は本番で定数既定値になり、tripwire / gate を弱めない。`defaultEnv()` が `process.env` を読まないことを保証すべき（agent が timeout を縮めて tripwire を無効化できてしまう）

### resilience-analyzer

- verdict: pass
- 主指摘: タイムアウト経路は fake git で決定的に覆える。latch（2 回目に git を起動しない）と `timed out after 200ms` まで assert すること。kill 後に `sleep` が残らないことを確認すること

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

> Round 2 の 4 名は全員 pass だったが、その後の CPU 飽和実験で見送りの前提（未観測）が崩れ、ユーザー判断で範囲を広げた（K3, K10, K11）。Round 2 は stamp せず、Round 3 で全員に再レビューを依頼する。

### logic-validator

- verdict: pass
- 主指摘: Round 1 の指摘はすべて解消。R1 の件数の式に K2 の新しいテストが入っていない。ISO の前提確認が満たされなかったときの扱いがない

### scope-justification-reviewer

- verdict: pass
- 主指摘: 新しい項目（K9, R5/R6, 負荷下の検証）に scope drift はない。K8(b) が未観測であることの明記と、README 更新の理由を 1 行足すとよい

### decision-quality-reviewer

- verdict: pass
- 主指摘: 支配軸と整合。K2 の約 2 秒のテストは経過時間を assert しないので K8 と矛盾しないが、一言書いておくとよい

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: incremental は妥当。「unit に経過時間の assert が無い」ことを機械的に強制していない点は、受け入れるか K9 に grep を足すかの判断事項

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: needs-work
- 主指摘: 予算 0 をテスト全体に効かせると、bash-parser :652 の後続の解析も give-up し、auto-approve :368 は狙いの経路を通らずに通ってしまう。予算 0 は切りたい解析の間だけにし、try/finally で戻すべき。R7 と K9 の grep は定義行や検査ファイル自身に一致してしまう

### scope-justification-reviewer

- verdict: pass
- 主指摘: 新項目はすべて §5.5 の実測かユーザー判断に裏付けられ、scope drift はない。research.md §6 の「bash-parser は未観測」が古いまま。R7 の走査範囲を明記すべき

### decision-quality-reviewer

- verdict: pass
- 主指摘: K11 の setter + preload は現状の最善に近い。予算の復元を try/finally で保証し、完了基準は「既知の主因が消えたことの確認」と位置づけ、想定外の失敗も報告扱いにする

### greenfield-perspective-reviewer

- verdict: pass
- 主指摘: 白紙案と同じ形。見送った poll 予算、約 4〜5 秒の実待ち、bash-parser の setter は、根拠つきのトレードオフとして受け入れ可能

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存方向は健全（tests → lib）。安全性の根拠は「縮める方向だけ」ではなく「`tests/` からしか呼ばれない」と書くべき。preload が効いていることを assert するテストを置くとよい

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 本番でガードもコンパクションのプライバシー判定も弱めない。R7 の grep は識別子そのものを対象にし、定義行だけを許可すべき（別名 import などを取りこぼさない）

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 呼び出し元は壊れず、永続データの形式も変わらない。complexity-delta.test.ts:251 の `createHook` 呼び出しにも `gitTimeoutMs` が要る。サブプロセスで起動したフックには preload の予算が届かない

<!-- auto-review: verdict=needs-work; hash=d014cc4d5a8eb339db5547f9814617741397a4f8a4be38364683395f803a9dda; design-hash=93ce14b1f856544a386a4784c593f7cd4b37b5750722c3a5f231521d9f6ffb29; round=1; at=2026-10-05T21:23:12.364Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=24; excluded=1; at=2026-10-05T21:23:13.315Z -->

## Reviewer Outputs (Round 4)

### logic-validator

- verdict: pass
- 主指摘: Round 3 の指摘はすべて解消。軽微な点として、K9 の経過時間の検査が `Date.now()` や hrtime を拾わない限界と、R7 の「定義行ちょうど 1 件」が成り立つ条件（bash-parser.ts の他の行に識別子を書かない）を明記すべき → 反映済み

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=cedfc373f887a9930d8a8d0e20c64d0fb18c2d2c21e801e018c710b0529ef6de; design-hash=2e8e6c33078c8a8bfbe88b07f8ed11046ea001c2a11720c0d40793f800523686; round=3; at=2026-10-05T21:40:06.655Z; reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=17; excluded=0; at=2026-10-05T21:40:06.708Z -->

## Reviewer Outputs (Round 5)

### logic-validator

- verdict: pass
- 主指摘: 完了基準を「負荷なしで 10 回、失敗 0 件」に変えた箇所は一貫している。変更前のアイドル時の失敗率（3 回中 2 回）に対して検出力は十分。CPU 飽和でだけ落ちた経路（git 2000ms、bash-parser 100ms）は、この基準ではなく決定的なテストが担保する。K3・K10・K11 の根拠（§5.5）は損なわれない

### scope-justification-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### decision-quality-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### greenfield-perspective-reviewer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 4)
- 主指摘: Round 4 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=36a179d137aa3116e9ecbb5ddb950d4815896d431fee0fe3f28f2ab8139f2766; design-hash=868afafc64cabd459c30150b5b6067776086f713ebb0f46c3258832922b7ab6b; round=4; at=2026-10-05T21:42:27.237Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-05T21:42:27.262Z -->

<!-- auto-review: verdict=pass; hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; design-hash=868afafc64cabd459c30150b5b6067776086f713ebb0f46c3258832922b7ab6b; round=5; at=2026-10-05T22:58:17.893Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-10-05T22:58:18.189Z -->
