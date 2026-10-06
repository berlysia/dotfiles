<!-- spec-ref: spec.md -->

# Plan 3: perf の分離 (Execution layer)

spec の K5〜K9 と、K11 の残り（perf で本番の予算を測る対、preload の検査の移設）、R7 を実装する。plan-1・plan-2 の完了（`tests/support/fake-git.ts`、`tests/support/parse-budget.ts`、bash-parser の setter / getter）を前提にする。

共通事項:

- パスは `home/dot_claude/hooks/` からの相対で書く（以下 `H/`）。単一ファイルの実行は repo ルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`（以下 `RUN <file>`）
- 移す・分ける `it` は **テスト名** で特定する。行番号は plan-3 作成時点（plan-2 の実装前）の目安で、plan-2 の編集でずれている
- 「`it` ごと移す」は、`it` ブロックを一字一句変えずに perf ファイルへ移し、unit 側からは消すことを指す。テスト名も変えない（R1 の名前の照合に使う）
- perf ファイルは、元の unit ファイルと同じ名前で `H/tests/perf/` に置く（例: `tests/perf/shell-lex.test.ts`）。例外は本番の予算で測る give-up の対で、`tests/perf/parse-budget.test.ts` にまとめる
- perf ファイルの `describe` 名は、元の unit ファイルの `describe` の並びをそのまま再現する（失敗時にどこから来たテストか分かるように）
- 元の `describe` が `beforeEach` / `afterEach` で `ConsoleCapture` や `EnvironmentHelper` を使っていた `it` は、perf 側の `describe` でも同じ setup を用意する
- 経過時間の上限は変えない（spec K6）
- 本番の予算 100ms に依存する perf テストは `parse-budget.test.ts` だけ。ほかの perf ファイルは preload の予算 10_000 のまま動き、give-up に邪魔されずに実際の解析時間を測る

## Files

```
# 新規作成
home/dot_claude/hooks/tests/support/hook-timer-helpers.ts
home/dot_claude/hooks/tests/support/run-guard-helpers.ts
home/dot_claude/hooks/tests/support/quality-loop-helpers.ts
home/dot_claude/hooks/tests/support/linear-match-rules.ts
home/dot_claude/hooks/tests/perf/bash-parser.test.ts
home/dot_claude/hooks/tests/perf/command-parsing.test.ts
home/dot_claude/hooks/tests/perf/deny-node-modules.test.ts
home/dot_claude/hooks/tests/perf/hook-timer.test.ts
home/dot_claude/hooks/tests/perf/linear-match.test.ts
home/dot_claude/hooks/tests/perf/linear-match-equivalence.test.ts
home/dot_claude/hooks/tests/perf/node-modules-policy.test.ts
home/dot_claude/hooks/tests/perf/pattern-matching.test.ts
home/dot_claude/hooks/tests/perf/permission-auto-approve.test.ts
home/dot_claude/hooks/tests/perf/quality-loop.test.ts
home/dot_claude/hooks/tests/perf/read-only-command.test.ts
home/dot_claude/hooks/tests/perf/run-guard.test.ts
home/dot_claude/hooks/tests/perf/safe-command-list.test.ts
home/dot_claude/hooks/tests/perf/shell-lex.test.ts
home/dot_claude/hooks/tests/perf/parse-budget.test.ts
home/dot_claude/hooks/tests/unit/test-layout.test.ts

# 移動（git mv）
home/dot_claude/hooks/tests/unit/test-helpers.ts
home/dot_claude/hooks/tests/support/test-helpers.ts

# 編集
package.json
.github/workflows/ci-typescript.yml
home/dot_claude/hooks/tests/README_TESTING.md
home/dot_claude/hooks/tests/unit/README.md
.skills/update-auto-approve/SKILL.md

# テスト（import の書き換えと、it の移設・分割）
home/dot_claude/hooks/tests/unit/bash-parser.test.ts
home/dot_claude/hooks/tests/unit/command-parsing.test.ts
home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/hook-timer.test.ts
home/dot_claude/hooks/tests/unit/linear-match.test.ts
home/dot_claude/hooks/tests/unit/linear-match-equivalence.test.ts
home/dot_claude/hooks/tests/unit/node-modules-policy.test.ts
home/dot_claude/hooks/tests/unit/pattern-matching.test.ts
home/dot_claude/hooks/tests/unit/permission-auto-approve.test.ts
home/dot_claude/hooks/tests/unit/quality-loop.test.ts
home/dot_claude/hooks/tests/unit/read-only-command.test.ts
home/dot_claude/hooks/tests/unit/run-guard.test.ts
home/dot_claude/hooks/tests/unit/safe-command-list.test.ts
home/dot_claude/hooks/tests/unit/shell-lex.test.ts
```

`test-helpers.ts` を import している unit ファイル（33 個）は、T1 で import の 1 行だけを機械的に書き換える。対象は `grep -l '"./test-helpers.ts"' H/tests/unit/*.ts` で得られる一覧で、上の Files に個別には列挙しない（1 行の置換のみで、内容は変えない）。plan-3 の実装は承認済みの三状態の下で行うので、一覧外への書き込みは warn として `off-plan-writes.log` に記録される。

## Tasks

### T0: 着手前の件数を記録する（R1）

- [ ] **Step 1**: `bun run test 2>&1 | grep -E "^ℹ tests"` の値を `BEFORE` として記録する（plan-1・plan-2 の完了後）

### T1: test-helpers.ts を tests/support/ に移す（K5）

**Files:** `H/tests/unit/test-helpers.ts` → `H/tests/support/test-helpers.ts`、importer 33 ファイル
**参照:** `H/tests/unit/test-helpers.ts:5-33`（import は `../../lib/` と node 組み込みだけで、`tests/support/` は同じ深さなので書き換え不要）

- [ ] **Step 1**: `git mv home/dot_claude/hooks/tests/unit/test-helpers.ts home/dot_claude/hooks/tests/support/test-helpers.ts`
- [ ] **Step 2**: `H/tests/unit/` の `*.ts` で、`from "./test-helpers.ts"` を `from "../support/test-helpers.ts"` に置き換える（33 ファイル、1 ファイル 1 か所）
- [ ] **Step 3**: `grep -rn '"./test-helpers.ts"' H/tests/` が 0 件、`bun run test` が失敗 0 件で、`ℹ tests` が `BEFORE` と同じ

### T2: 共有 helper を tests/support/ に切り出す（K5, R2）

挙動は変えない。切り出した後、元の unit ファイルは helper を import して、全件が今までどおり通ること。

1. `H/tests/support/hook-timer-helpers.ts`: `hook-timer.test.ts` のモジュールレベルの定義を移して export する。対象は `here`、`wrapper`、`makeTempDir`、`cleanupTempDirs`（下記）、`sleepSync`、`buildMinimalBinDir`、`fakeBinDir`、`type HookTimingRecord`、`waitForFile`、`pollForLastRecord`、`pollUntilEmpty`、`runWrapperSync`、`baseEnv`。モジュールレベルの `after(() => { for (const dir of tempDirs) rmSync(...) })` は helper では登録せず、次の関数として export し、各テストファイルが `after(cleanupTempDirs);` で登録する

```ts
const tempDirs: string[] = [];

/** Removes every dir makeTempDir created; register with after() in each test file. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

`here` は helper 自身の `import.meta.url` から求める。`tests/support/` は `tests/unit/` と同じ深さなので、`join(here, "..", "..", "executable_hook-timer.sh")` はそのまま正しい。:27-29 の `performance.now()` を使う理由のコメントは `waitForFile` の上に移す

2. `H/tests/support/run-guard-helpers.ts`: `run-guard.test.ts` の `here`、`wrapper`、`throwingHook`、`makeTempDir`、`cleanupTempDirs`（上と同じ形）、`fakeBunDir`、`isGone`、`runWrapper` を移して export する。`throwingHook` は `join(here, "..", "__fixtures__", "throwing-guard-hook.ts")` で同じ深さから解決できる
3. `H/tests/support/quality-loop-helpers.ts`: `quality-loop.test.ts` の `makeDir`、`writeFile`、`installBin`、`cleanupTempDirs`（上と同じ形）と、`describe("runFormat")` の中の `setup()` を `setupFormatRepo()` という名前で移して export する
4. `H/tests/support/linear-match-rules.ts`: #14 で perf に移す「adversarial inputs run in linear time」と、unit に残る等価性のテストが、どちらも `RULES` / `genericShapes` / `entriesWithSpec` を使うため、共有の定義として切り出す。対象は `NM`、`isOracleMatcher`、`oraclesOf`、`TABLES`、`RuleSpec`、`spec`、`RM_HEAD`、`readOnlyVerbsByCategory`、`RULES`、`SPEC_BY_SOURCE`、`genericShapes`、`entriesWithSpec`。`readOnlyVerbsByCategory` は `RULES`（unit の :332）が呼ぶので一緒に移し、unit に残る `ORIGINAL_SOURCES`（:111）は helper から `readOnlyVerbsByCategory` と `NM`（:94-99 で使う）を import して使う。unit に残すのは `isPrefixThenOnLine`、`ORIGINAL_SOURCES`、`EXPECTED_TOTAL` など、`RULES` の生成に関わらない定義。移した定義が import していたもの（`DANGEROUS_COMMAND_PATTERNS`、`READ_ONLY_VERBS`、`WS_CORE` など。材料 §7）は helper 側で import する。tsconfig は `**/tests/**` を除外していて typecheck では漏れが見つからないので、Step 2 の実行で import の解決まで確かめる

`H/tests/sourced-rules.ts`（tests 直下の既存の helper）は unit のテスト 3 本だけが使い、perf からは使わないので、K5 の対象外として動かさない。

- [ ] **Step 1**: 上の 4 ファイルを作り、元の unit ファイルの定義を消して import に置き換える
- [ ] **Step 2**: 4 つの unit ファイルを `RUN` し、件数と結果が切り出し前と同じ（失敗 0 件）

### T3: perf に移す・分ける（K8）

区分は spec K8 のとおり: (a) 時間が主題 → `it` ごと移す（17 行）。(c) ロジックが主題で経過時間は付随 → 分割（unit は経過時間の assert を外す、perf は同じ操作で経過時間を assert する `it` を新設。4 行）。(b) 本番の予算の give-up → plan-2 で unit を決定化し、経過時間の行も外し済み（`grep -n "performance.now() -" H/tests/unit/bash-parser.test.ts H/tests/unit/document-workflow-guard.test.ts` に #3〜#5 の `it` の行が出ないことを確かめる）。unit の `it` は **移さずに残し**、perf の対を `parse-budget.test.ts` に **新設** する（3 行、4 件）。表の「perf の置き場」の列は、(b) では新設先を指す。

| #   | unit ファイル            | テスト名（`describe` の並び）                                                                                                                                         | 区分 | perf の置き場                 |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------- |
| 1   | bash-parser              | `for-loop body splitting (Issue #219 H)` > splits a body with a long blank run in linear time                                                                         | (a)  | perf/bash-parser              |
| 2   | bash-parser              | `parser limits (Issue #235)` > stops the extractor at the scan limit on a chain of wrapper words / on sibling substitutions（2 件）                                   | (c)  | perf/bash-parser              |
| 3   | bash-parser              | `parser limits (Issue #235)` > gives up within the time budget on a long run of redirects / on repeated subshells（2 件）                                             | (b)  | perf/parse-budget             |
| 4   | bash-parser              | `parser limits (Issue #235)` > does not parse an input again after giving up on it                                                                                    | (b)  | perf/parse-budget             |
| 5   | document-workflow-guard  | `document-workflow-guard.ts hook behavior` > `parser limits (Issue #235)` > denies a write hidden behind an input the parser gives up on                              | (b)  | perf/parse-budget             |
| 6   | command-parsing          | judges a long blank run inside rm -r -f / after git push / a repeated dd word in linear time（3 件、ループ）                                                          | (a)  | perf/command-parsing          |
| 7   | deny-node-modules        | `long repeated words` > asks for a repeated cp word / a repeated ls word in linear time（2 件、ループ）                                                               | (a)  | perf/deny-node-modules        |
| 8   | deny-node-modules        | `long repeated words` > judges a long run of redirect characters in linear time                                                                                       | (a)  | perf/deny-node-modules        |
| 9   | deny-node-modules        | `long repeated words` > denies a command over the length limit that mentions node_modules / does not mention it（2 件、ループ）                                       | (c)  | perf/deny-node-modules        |
| 10  | hook-timer               | records a SIGTERM'd child as terminated with exit_code null                                                                                                           | (a)  | perf/hook-timer               |
| 11  | hook-timer               | does not block on a slow jq (recording is detached)                                                                                                                   | (a)  | perf/hook-timer               |
| 12  | hook-timer               | escalates to SIGKILL after its 1s grace when the child ignores TERM                                                                                                   | (a)  | perf/hook-timer               |
| 13  | linear-match             | `prefixThenOnLine` > scans a repeated prefix word in linear time / scans a long whitespace run after the prefix in linear time                                        | (a)  | perf/linear-match             |
| 14  | linear-match-equivalence | `describe("adversarial inputs run in linear time")` 全体（`generic shapes: ${rule.source}` のループ）                                                                 | (a)  | perf/linear-match-equivalence |
| 15  | node-modules-policy      | `classifyDeletion` > judges a long repeated verb in linear time / `standaloneSymlinkRemovalOperands` > rejects a long inner blank run in linear time                  | (a)  | perf/node-modules-policy      |
| 16  | pattern-matching         | `matchGitignorePattern: absolute wildcard patterns` > stays fast on long paths with stacked ** (no backtracking blowup)                                               | (a)  | perf/pattern-matching         |
| 17  | permission-auto-approve  | `staticRuleEngine - Dangerous patterns` > judges a long blank run after dd / a repeated dd word / a repeated curl word in linear time without denying（3 件、ループ） | (a)  | perf/permission-auto-approve  |
| 18  | permission-auto-approve  | `staticRuleEngine - Bash allow from the whole-text split (spec K8)` > runs in linear time on long inputs                                                              | (a)  | perf/permission-auto-approve  |
| 19  | quality-loop             | `runFormat` > fails with a message when the formatter times out                                                                                                       | (c)  | perf/quality-loop             |
| 20  | read-only-command        | `isExemptReadOnlyCommand` > scans 100,000 characters in linear time / scans a long inner blank run in linear time                                                     | (a)  | perf/read-only-command        |
| 21  | run-guard                | `run-guard.sh` > returns within the timeout and kills descendants that hold stdout                                                                                    | (c)  | perf/run-guard                |
| 22  | run-guard                | `run-guard.sh` > does not wait for the timeout when the hook finishes early                                                                                           | (a)  | perf/run-guard                |
| 23  | safe-command-list        | `scanSafeList` > scans 100,000 characters in linear time                                                                                                              | (a)  | perf/safe-command-list        |
| 24  | shell-lex                | `trimTrailingBlanks / trimSpaceTab` > runs in linear time on long inner blank runs / `trimSpaces` > trims a long inner blank run in linear time                       | (a)  | perf/shell-lex                |

(a) の移設で perf 側に要る定義:

- #6〜#8・#17・#18・#5: 元の `describe` の `ConsoleCapture` / `EnvironmentHelper` の `beforeEach` / `afterEach` を perf 側の `describe` に再現する。#7〜#9 は `const NM = "node" + "_modules";` を perf 側の `describe` に置く。#18 は `describe` レベルの `bash` helper（unit の :1181-1187）を perf 側の `describe` に写す
- #13 は `const DD = prefixThenOnLine(/dd\s+/, /\/dev\//);` を perf 側に置く。#16 は `const ctx = { cwd: "/repo", home: "/home/u" };`、#20 は `const exempt = (cmd: string) => isExemptReadOnlyCommand(cmd, { parsingMethod: "tree-sitter" });`（unit の :15-16 と同じ式）を perf 側に置く
- #10〜#12 は `hook-timer-helpers.ts`、#21・#22 は `run-guard-helpers.ts`、#14 は `linear-match-rules.ts`、#19 は `quality-loop-helpers.ts` を import し、`after(cleanupTempDirs);` を登録する

(c) の分割（unit は経過時間の 1〜2 行だけを外す。perf は同じ操作で、経過時間と、元の `it` の判定のうち操作の成功を示す 1 行を assert する）:

- #2 perf: テスト名 `stops the extractor at the scan limit within 1 s on ${name}`。本体は unit の元の `it` と同じ操作と assert（経過時間 `< 1000` を含む）。unit は `const start` と `ok(performance.now() - start < 1000)` の 2 行を外す
- #9 perf: テスト名 `denies a command over the length limit within 1 s that ${name}`。本体は元の `it` と同じ（`elapsed < 1000` と `context.assertDeny()`）。unit は `start` と `elapsed` の 3 行を外す
- #19 perf: テスト名 `aborts a hanging formatter within 3 s`。`setupFormatRepo()`、`installBin(root, "oxfmt", "exec sleep 5")`、`runFormat(file, root, 200)` を行い、`ok(performance.now() - started < 3000)` と `ok(result?.output.startsWith("oxfmt failed:"))` を assert する。unit は `started` と `< 3000` の 2 行を外す
- #21 perf: テスト名 `returns within 10 s and kills descendants that hold stdout`。本体は元の `it` と同じ。unit は `started`・`elapsed` と `elapsed < 10_000` の行を外し、`status === 2`・`"timed out"`・`isGone(childPid)` の assert を残す

(b) の対（`H/tests/perf/parse-budget.test.ts`、新規）:

```ts
import { ok, strictEqual } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import documentWorkflowGuardHook from "../../implementations/document-workflow-guard.ts";
import {
  DEFAULT_PARSE_BUDGET_MS,
  extractCommandsStructured,
  getParseBudgetMs,
  parseForCollect,
  parserGiveUpMark,
  parserGiveUpReasonSince,
  setParseBudgetMs,
} from "../../lib/bash-parser.ts";
import {
  ConsoleCapture,
  createPreToolUseContextFor,
  createWorkflowRepo,
  EnvironmentHelper,
  invokeRun,
  pendingWorkflowRepo,
  TEST_WORKFLOW_DIR,
} from "../support/test-helpers.ts";

// The preload gives every test process a patient budget; this file measures
// the production one. It is set in before() and restored in after() rather
// than at module load, so the file stays correct even if a runner ever loads
// several files into one process.
let preloadBudgetMs = 0;
before(() => {
  preloadBudgetMs = getParseBudgetMs();
  setParseBudgetMs(DEFAULT_PARSE_BUDGET_MS);
});
after(() => {
  setParseBudgetMs(preloadBudgetMs);
});

describe("bash-parser: production parse budget", () => {
  for (const [name, command] of [
    ["a long run of redirects", `echo perf-limit-a ${">".repeat(20000)}`],
    ["repeated subshells", `${"(a) ".repeat(5000)}perf-limit-b`],
  ] as const) {
    it(`gives up within 1 s on ${name}`, async () => {
      const mark = parserGiveUpMark();
      const start = performance.now();
      const result = await extractCommandsStructured(command);
      ok(performance.now() - start < 1000);
      strictEqual(result.parsingMethod, "fallback");
      ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
    });
  }

  it("answers a cut input again within 50 ms", async () => {
    const command = `echo perf-limit-d ${">".repeat(20000)}`;
    strictEqual(await parseForCollect(command), null);
    const start = performance.now();
    strictEqual(await parseForCollect(command), null);
    ok(performance.now() - start < 50);
  });
});

describe("document-workflow-guard: production parse budget", () => {
  const envHelper = new EnvironmentHelper();
  const consoleCapture = new ConsoleCapture();

  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    envHelper.set("DOCUMENT_WORKFLOW_DIR", TEST_WORKFLOW_DIR);
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  it("denies a write hidden behind a cut input within 1 s", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const context = createPreToolUseContextFor(
      documentWorkflowGuardHook,
      "Bash",
      {
        command: `for f in a; do tee src/a.ts; done; echo ${">".repeat(20000)}`,
      },
    );
    const start = performance.now();
    await invokeRun(documentWorkflowGuardHook, context);
    ok(performance.now() - start < 1000);
    context.assertDeny();
  });
});
```

`consoleCapture` / `envHelper` の setup は、unit の document-workflow-guard の外側の `describe`（:72-85）と同じ。

- [ ] **Step 1**: 表の (a) 17 行ぶんの `it` を perf に移し、unit から消す
- [ ] **Step 2**: (c) の 4 行ぶんを分割する（perf の `it` を 6 件新設、unit の経過時間の行を外す）
- [ ] **Step 3**: `parse-budget.test.ts` を作る（perf の `it` を 4 件新設）
- [ ] **Step 4**: unit 側で使われなくなった import・定数を消す（`bun run lint:oxlint` の unused の警告が、plan-3 で触れたファイルで 0 件）
- [ ] **Step 5**: `RUN H/tests/perf/*.test.ts`（`--test-concurrency=1`）で全件 PASS、触れた unit ファイルを `RUN` して全件 PASS

### T3.5: run-guard「kills descendants」の時間との競争を直す（spec R4 の報告を受けたユーザー判断）

**Files:** `H/tests/unit/run-guard.test.ts`（「returns within the timeout and kills descendants that hold stdout」）、`H/tests/perf/run-guard.test.ts`（「returns within 10 s and kills descendants that hold stdout」）
**参照:** research.md §5.7、`H/executable_run-guard.sh`（`RUN_GUARD_TIMEOUT` は整数秒、本番の既定 20 秒）

fake の bun は `sleep 30 &` の直後に子の PID をファイルに書く。ラッパーのタイムアウト（1 秒）までにそこへ届かないと、PID ファイルが作られずに ENOENT で落ちる。完了基準の 10 回中 1 回、`test:perf` 3 回中 1 回、この形で落ちた。

- [ ] **Step 1**: 両方のテストの `RUN_GUARD_TIMEOUT: "1"` を `RUN_GUARD_TIMEOUT: "5"` にし、その行の直前にコメントを 1 行足す: `// The fake bun must start and record its child before the timeout fires; 1 s raced that under load.`。本番の既定値（20 秒）とラッパーは変えない。perf の対の上限 `elapsed < 10_000` は変えない（spec K6。タイムアウト 5 秒に対して 2 倍の余裕）
- [ ] **Step 2**: 2 つのファイルを `RUN` し、全件 PASS。1 本あたり約 5 秒かかる（結果だけを assert し、unit 側は経過時間を assert しない）
- [ ] **Step 3**: unit / perf ともに、同じファイルの「blocks with exit 2 when the hook exceeds the timeout」（`RUN_GUARD_TIMEOUT=1` と `exec sleep 30`）は PID ファイルを使わず、終了コードと文言だけを見るので、競争は無い。変えない

### T4: 配置を検査するテスト（K9, R7, K11）

**Files:** 新規 `H/tests/unit/test-layout.test.ts`、編集 `H/tests/unit/bash-parser.test.ts`（plan-2 T3 の「runs every test process with the patient budget from the preload」を消す。ここへ移すため）
**参照:** `H/tests/unit/bash-parser.test.ts:560-577`（ファイルを走査する既存の検査の前例）

```ts
import { ok, strictEqual } from "node:assert";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getParseBudgetMs } from "../../lib/bash-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, "..");
const claudeDir = join(here, "..", "..", "..");
const self = fileURLToPath(import.meta.url);

// Built by concatenation so this file does not match its own searches.
const SETTER = "setParse" + "BudgetMs";
const ELAPSED = new RegExp("performance" + "\\.now\\(\\)\\s*-");

function walk(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    // lstat: do not follow symlinks, so a link loop cannot hang the walk.
    if (lstatSync(path).isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

describe("test layout (spec K9)", () => {
  it("keeps every *.test.ts directly under tests/unit or tests/perf", () => {
    const misplaced = walk(testsDir, () => false)
      .filter((path) => path.endsWith(".test.ts"))
      .map((path) => relative(testsDir, path))
      .filter((rel) => !/^(unit|perf)\/[^/]+\.test\.ts$/.test(rel));
    strictEqual(misplaced.join("\n"), "");
  });

  it("has at least one perf test", () => {
    ok(readdirSync(join(testsDir, "perf")).some((n) => n.endsWith(".test.ts")));
  });

  it("keeps wall-clock elapsed assertions out of tests/unit", () => {
    const offenders = readdirSync(here)
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => join(here, n))
      .filter((path) => path !== self)
      .filter((path) => ELAPSED.test(readFileSync(path, "utf8")))
      .map((path) => relative(testsDir, path));
    strictEqual(offenders.join("\n"), "");
  });

  it("runs every test process with the patient parse budget from the preload", () => {
    strictEqual(getParseBudgetMs(), 10_000);
  });

  it("keeps tests/support and tests/perf independent of tests/unit (spec K5)", () => {
    const offenders = ["support", "perf"]
      .flatMap((sub) => walk(join(testsDir, sub), () => false))
      .filter((path) => /\.(m?[jt]s|c[jt]s|tsx)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes("../unit/"))
      .map((path) => relative(testsDir, path));
    strictEqual(offenders.join("\n"), "");
  });
});

describe("parse budget setter stays test-only (spec R7)", () => {
  it("is referenced outside tests only by its definition", () => {
    const hits: string[] = [];
    // Skip by path prefix, not substring, so a production dir that merely
    // contains "tests" in its name is still scanned.
    const skip = (path: string) => {
      const rel = relative(claudeDir, path);
      return (
        rel === join("hooks", "tests") ||
        rel.startsWith(join("hooks", "tests") + "/") ||
        rel.split("/").includes("node_modules")
      );
    };
    const files = walk(claudeDir, skip).filter((path) =>
      /\.(m?[jt]s|c[jt]s|tsx)$/.test(path),
    );
    for (const path of files) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes(SETTER)) {
            hits.push(
              `${relative(claudeDir, path)}:${index + 1}: ${line.trim()}`,
            );
          }
        });
    }
    strictEqual(hits.length, 1, hits.join("\n"));
    ok(
      hits[0]?.startsWith(join("hooks", "lib", "bash-parser.ts")) &&
        hits[0].includes(`export function ${SETTER}(`),
      hits.join("\n"),
    );
  });
});
```

`claudeDir` は `H/` の 1 つ上の `home/dot_claude/`。spec R7 の走査範囲（`home/dot_claude/` の `.ts` / `.mjs` / `.js`、`node_modules/` とパス接頭辞 `hooks/tests/` を除く）を含み、拡張子は `.mts` / `.cts` / `.cjs` / `.tsx` まで広げる。`hooks/tests/` 以下（preload、`support/parse-budget.ts`、`perf/parse-budget.test.ts`）の呼び出しは、パス接頭辞で除外されるので数えない。

この検査は「うっかり本番コードから呼ぶ」ことの検知が目的で、意図的な回避（識別子を文字列で組み立てて動的に参照するなど）は防がない。spec R7 の目的（誤って呼ぶ経路の検知）にはこれで足りる。

- [ ] **Step 1**: 上のファイルを作り、bash-parser.test.ts から preload の検査の `it` を消す
- [ ] **Step 2**: `RUN H/tests/unit/test-layout.test.ts`。期待: T3 の完了後なので全件 PASS（T3 の前に実行すると「keeps wall-clock elapsed assertions out of tests/unit」が、まだ残る unit ファイルを挙げて FAIL する。これを T3 の完了確認の Red として使ってよい。ただし `tests/perf/` がまだ無いので、「has at least one perf test」と K5 の依存の検査は ENOENT で落ちる。これは想定どおりで、T3 の完了後に消える）
- [ ] **Step 3**: 検査が実際に働くことを一時的な変更で確かめる（確認後に戻す）: `H/tests/unit/` に `zz-probe.test.ts`（中身 `const t = performance.now() - 0;`）を置くと 3 件目が FAIL する。`H/tests/` 直下に `probe.test.ts` を置くと 1 件目が FAIL する。どちらも確認後に削除する

### T5: scripts と CI の配線（K5, K6, K7）

- [ ] **Step 1**: `package.json` の scripts を変える

```json
"test": "node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/*.test.ts tests/tailnet-ssh.test.mjs",
"test:perf": "node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test --test-concurrency=1 home/dot_claude/hooks/tests/perf/*.test.ts",
"check": "npm run test && npm run test:perf && npm run typecheck && npm run lint",
```

- [ ] **Step 2**: `.github/workflows/ci-typescript.yml` の `Run tests` step の直後に足す

```yaml
# Wall-clock assertions (ReDoS guards, wrapper timing) live here so that
# the completion gate and pre-commit, which run `test`, never race them.
- name: Run perf tests
  run: bun run test:perf
```

- [ ] **Step 3**: `bun run lint:actions` が通る（actionlint / zizmor）

### T6: README の最小限の更新

- [ ] **Step 1**: `H/tests/README_TESTING.md` の「## テスト実行方法」の直前に次の節を足す

```markdown
## node:test のスイート（unit / perf）

- `bun run test`: `tests/unit/*.test.ts` を並列に実行する。completion gate と pre-commit が実行するのはこれだけで、経過時間を assert するテストは置かない（`tests/unit/test-layout.test.ts` が検査する）
- `bun run test:perf`: `tests/perf/*.test.ts` をファイルごとに直列で実行する。ReDoS などの線形時間ガードと、ラッパーの実時間の検証を置く。CI（`ci-typescript.yml`）と `bun run check` が実行する
- unit と perf が共有する helper は `tests/support/` に置く（`*.test.ts` にしない）
- テストのプロセスでは bash-parser の解析予算が 10 秒になる（`preload-test-env.mjs`）。本番の 100 ms で測るテストは `tests/perf/parse-budget.test.ts` に置く
```

- [ ] **Step 2**: `H/tests/unit/README.md` の「## Running Tests」節のコマンド（存在しない `npm run test:unit` と `run-tests.sh`）を、`bun run test`（全件）と `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`（単一ファイル）に置き換え、`tests/README_TESTING.md` の上記の節への参照を 1 行足す。それ以外の古い記述は今回は直さない（範囲外）
- [ ] **Step 3**: `.skills/update-auto-approve/SKILL.md` の表の Test 行（:17）の直後に、次の 1 行を足す: `| Test (perf) | home/dot_claude/hooks/tests/perf/permission-auto-approve.test.ts | 線形時間のガード。単一ファイルの実行では走らないので、変更後は bun run test:perf も実行する |`（表の列の書式は既存の行に合わせる）

見送った指摘（plan-3 Round 1）:

- CI の paths フィルタに `home/dot_claude/hooks/executable_*.sh` と `home/dot_claude/hooks/tests/**/*.mjs` を足す案は、spec R5 で範囲外と決めた既存の穴なので、今回は変えない。完了報告で別件として伝える
- 過去の plan 文書（`docs/plans/approval-ask/` など）にある `tests/unit/test-helpers.ts` のパスは、当時の記録なので書き換えない
- 経過時間の検査に `Date.now() -` を加える案は、spec K9 で限界として受け入れ済み（今の unit の `Date.now() -` は日付の fixture）

### T7: 確認とコミット

- [ ] **Step 1（R1）**: `bun run test` と `bun run test:perf` の `ℹ tests` の和が `BEFORE + 15` であること。内訳は、(c) で perf に新設する 6 件、(b) の対 4 件、test-layout.test.ts の 6 件から、bash-parser.test.ts から移した preload の検査 1 件を引いた 5 件
- [ ] **Step 2（R1）**: `bun run test:perf` の出力に、表の (a) のテスト名（ループで生成されるものはその展開後の名前）がすべて含まれる。unit の出力には含まれない
- [ ] **Step 3**: `bun run test:perf` を 3 回実行し、3 回とも失敗 0 件。失敗した場合は閾値を変えず、どのテストがどれだけかかったかを報告する（spec K6）
- [ ] **Step 4（spec の完了基準）**: 負荷を足さずに `bun run test` を 10 回続けて実行し、10 回とも失敗 0 件
- [ ] **Step 5**: `bun run typecheck`、`bun run lint` が成功する
- [ ] **Step 6**: コミット（`/commit` を使う。test-helpers の移動と helper の切り出し（T1・T2）、perf の分離（T3〜T6）で 2 コミットに分ける）

## ISO 25010 具体テストケース

### 信頼性（成熟性）

- **入力**: 負荷を足さずに `bun run test` を 10 回 → **期待**: 10 回とも `ℹ fail 0`
- **入力**: `bun run test:perf` を 3 回 → **期待**: 3 回とも `ℹ fail 0`

### 機能適合性（機能正確性）

- **入力**: `H/tests/` 直下に `probe.test.ts` を置く → **期待**: test-layout の「keeps every *.test.ts directly under tests/unit or tests/perf」が FAIL し、`probe.test.ts` を挙げる
- **入力**: `H/tests/unit/` に `performance.now() - 0` を含む `zz-probe.test.ts` を置く → **期待**: 「keeps wall-clock elapsed assertions out of tests/unit」が FAIL し、そのファイルを挙げる
- **入力**: `H/implementations/` のどこかに setter の識別子を書く（確認しない。検査のロジックは `hits.length === 1` と定義行の照合） → **期待**: R7 の `it` が FAIL する
- **入力**: unit + perf の `ℹ tests` の和 → **期待**: `BEFORE + 15`
- **入力**: `H/tests/perf/` のファイルに `from "../unit/test-helpers.ts"` を書く（確かめるだけで戻す）→ **期待**: test-layout の「keeps tests/support and tests/perf independent of tests/unit」が FAIL する

### 保守性（試験性）

- **入力**: completion gate（`${pm} run test`）と pre-commit（`bun run test`）→ **期待**: `tests/perf/` のテストを実行しない（`ℹ tests` に perf の件数が含まれない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: `RULES` が `readOnlyVerbsByCategory()` を呼ぶのに、plan はその関数を unit に残すとしていて、helper が作れない。T3 Step 1 の (a) の行数は 19 ではなく 17。表の網羅・R1 の計算・test-helpers の移動・test-layout のパス計算は正しい

### scope-justification-reviewer

- verdict: pass
- 主指摘: test-helpers の移動は K5 の帰結で scope creep ではない。(a) の行数の誤り、(b) の unit 側から経過時間の行が消えていることの確認、表の (b) は「移す」ではなく「新設」であることを明記すべき

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存方向は健全。perf ファイルがモジュール読み込み時に予算を書き換えるのではなく、`before` で保存・`after` で戻すべき。support / perf から `../unit/` を import しないことを検査するとよい

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: R7 の走査は、除外が部分文字列一致で、拡張子も `.mts` などを含まない。ラッパー（`executable_*.sh`）と preload（`.mjs`）だけを変えた PR では CI が走らない（既存の穴だが、perf に移すことで影響が増す）

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: `test` の名前と呼び出し元の契約は保たれる。`.skills/update-auto-approve/SKILL.md` が単一ファイルの実行を案内しており、perf に移る線形時間の検査が走らないことを書くべき。過去の plan 文書にある test-helpers のパスは古くなる

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: linear-match-equivalence の切り出しは漏れなし。R1 の `BEFORE + 15` は正しい。module のトップレベルの `before` / `after` はファイル全体に効く（Node v24 で確認）。unit は `ORIGINAL_SOURCES` のために `NM` も import する、T3 の前の test-layout は ENOENT も出す → 反映済み

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: R7 の走査の修正は妥当。paths フィルタの変更を見送るのは spec R5 に沿っていて許容。preload（`.mjs`）もフィルタ外である点を、別件の報告に含める。`walk` は `lstatSync` の方がよい → 反映済み

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9ad406345f9d42b30cc99b197be876333bda698856275f2155d576af89fa8711; design-hash=861435a3bc49a817e40329c5b38b1f65b125f1d6d6b999b7d19a408d86a67bee; round=1; parent-spec-hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; at=2026-10-05T23:12:03.455Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+data-contract-evolution-evaluator -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-05T23:14:25.146Z -->
<!-- intent-triage: adopted=3; excluded=0; at=2026-10-05T23:18:49.386Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: `RUN_GUARD_TIMEOUT=5` は整数秒・最小 1 の条件を満たす。ラッパーはプロセスツリーごと kill するので、assert は値に依存しない。perf の上限 10 秒には 5 秒に対して約 2 倍の余裕が残る

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=f47f7bb6bc789a06fdf65cfe14cd9314c4670fa5fb32fb521e5f79f5777e5160; design-hash=b273f4cf35434e4a174fdaeec6c6b04d6da7917a20ec2d1e5e86b23b3f7af18e; round=2; parent-spec-hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; at=2026-10-05T23:19:50.546Z; reviewers=logic-validator+security-vulnerability-analyzer -->

<!-- auto-review: verdict=pass; hash=f72436a0a0c584d2910e0bb691fdeca2bbae3cb534e1740cd31e31eeb2c1ea4d; design-hash=657c90c3b6b11d0e485c9f6e0ed87c17ba9840498de4c286ebdd7afdd60694e9; round=3; parent-spec-hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; at=2026-10-06T03:02:10.557Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=0; excluded=0; at=2026-10-06T03:02:10.589Z -->
