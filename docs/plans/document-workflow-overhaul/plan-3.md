<!-- spec-ref: spec.md -->

# Plan 3: workflow CLI・レビュー経済・stop gate・文書整理 (Execution layer)

spec の K5（CLI + reviewer 台帳）/ K6（pointer 化）/ K7（announce-then-stop）/ K8（rules 分離）/ K9（矛盾解消）/ K10（発火ゲート）を実装する。plan-1（lib 層）と plan-2（Bash 対称化）の承認・実装後に着手する。CLI は plan-1 の `workflow-gate` / `workflow-marker` と plan-2 の per-doc cache に依存する。

## Files

```
# 新規作成
home/dot_claude/hooks/cli/workflow.ts
home/dot_claude/hooks/implementations/reviewer-run-recorder.ts
home/dot_local/bin/executable_workflow-cli
.skills/document-workflow-reference/SKILL.md
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts

# 編集
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/implementations/plan-review-automation.ts
home/dot_claude/hooks/implementations/spec-plan-self-audit.ts
home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts
home/dot_claude/hooks/implementations/resume-incomplete-work.ts
home/dot_claude/hooks/implementations/block-plan-mode.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/rules/workflow.md
home/dot_claude/.settings.hooks.json.tmpl
home/dot_claude/.settings.permissions.json
home/dot_claude/agents/logic-validator.md
home/dot_claude/agents/scope-justification-reviewer.md
home/dot_claude/agents/decision-quality-reviewer.md
home/dot_claude/agents/test-quality-evaluator.md
home/dot_claude/hooks/tests/unit/resume-incomplete-work.test.ts
home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts
home/dot_claude/hooks/tests/unit/test-helpers.ts
docs/scripts/workflow-session-audit.mjs
```

**テスト scaffolding（architecture / logic plan Round 1）**: T2/T5 が使う `seedWorkflow`（doc + round + ledgerSlugs を用意）と `seedCache` を `test-helpers.ts` に新設する。T6 は `createStopContextFor(hook, {last_assistant_message, stop_hook_active})` を `test-helpers.ts` に**必ず**追加する（既存の `createStopContext` は `stop_hook_active` のみで `last_assistant_message` を運ばないため）。

## Tasks

### T1: `reviewer-run-recorder.ts`（PostToolUse Agent）で reviewer 実行台帳を書く

**Files:**

- 新規: `home/dot_claude/hooks/implementations/reviewer-run-recorder.ts`
- テスト: `home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts`
- 編集: `home/dot_claude/.settings.hooks.json.tmpl`（PostToolUse に matcher `Agent` で登録、async 可）
- 編集: `home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts`（新実体を検知）
- 参照: `lib/workflow-resolve.ts:84-89`（`resolveWorkflowDir`）
- 参照: `permission-llm-evaluator.ts:124`（subagent_type がペイロードにある実例）
- 参照: `lib/workflow-fs.ts:18-32`（`realpathInsideWorkflowDir`、O_NOFOLLOW 書込の実装元）

- [ ] **Step 1: 失敗するテストを書く**

reviewer subagent（`tool_input.subagent_type` が reviewer slug）の Agent 呼出で `<wfDir>/reviewer-runs.log` に `{sessionId, subagent_type, at}` を 1 行追記し、非 reviewer（`Explore` / `general-purpose`）は無視、200 行で古い行を落とすことを固定する。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import hook, {
  REVIEWER_SLUGS,
} from "../../implementations/reviewer-run-recorder.ts";
import { createPostToolUseContextFor, invokeRun } from "./test-helpers.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("records a reviewer Agent run to the ledger", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPostToolUseContextFor(hook, "Agent", {
    subagent_type: "logic-validator",
  });
  await invokeRun(hook, ctx);
  const log = readFileSync(
    join(repo, ".tmp/sessions/test-ses/reviewer-runs.log"),
    "utf8",
  );
  assert.match(log, /logic-validator/);
});

test("ignores non-reviewer subagents", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPostToolUseContextFor(hook, "Agent", {
    subagent_type: "Explore",
  });
  await invokeRun(hook, ctx);
  assert.equal(
    existsSync(join(repo, ".tmp/sessions/test-ses/reviewer-runs.log")),
    false,
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts`
期待: FAIL "Cannot find module '../../implementations/reviewer-run-recorder.ts'"

- [ ] **Step 3: 最小実装を書く**

`defineHook({trigger:{PostToolUse:true}, ...})`。`tool_input.subagent_type` を読み、bare slug に正規化（`compound-engineering:review:` prefix を剥がす）した結果が `REVIEWER_SLUGS`（SPEC + PLAN の全 slug + catalog slug）に含まれる場合のみ、`resolveWorkflowDir` の wfDir に `<sessionId>\t<subagent_type>\t<ISO now>` を追記（`O_NOFOLLOW|O_CREAT|O_WRONLY|O_APPEND`、200 行 FIFO）。含まれなければ即 success。wfDir unresolvable なら即 success。`.settings.hooks.json.tmpl` に matcher `Agent` で登録し drift テストを通す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts 2>&1 | tail -15`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/reviewer-run-recorder.ts home/dot_claude/hooks/tests/unit/reviewer-run-recorder.test.ts home/dot_claude/.settings.hooks.json.tmpl
git commit -m "feat(hooks): record reviewer subagent runs to a per-session ledger"
```

### T2: `workflow.ts` CLI の `runWorkflowCli` 純関数（status / round / stamp / triage）

**Files:**

- 新規: `home/dot_claude/hooks/cli/workflow.ts`
- 新規: `home/dot_local/bin/executable_workflow-cli`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
- 編集: `home/dot_claude/.settings.permissions.json`（`Bash(workflow-cli *)` を allow）
- 参照: `home/dot_claude/hooks/lib/workflow-gate.ts`（`diagnoseGate`、plan-1 T3）
- 参照: `home/dot_claude/hooks/lib/workflow-marker.ts`（`parseLatestAutoReviewMarker` / STRICT、plan-1 T1）
- 参照: `lib/document-hash.ts:88-116`（`computeDocumentHash` / `computeDesignHash`）
- 参照: `lib/workflow-fs.ts:68-87`（`isStrictlyUnderProjectSubdir`）
- 参照: `lib/workflow-paths.ts:193-225`（`SESSION_ID_REGEX` / `deriveDefaultWorkflowDir`）

- [ ] **Step 1: 失敗するテストを書く**

`runWorkflowCli(argv, {cwd, wfDir, sessionId, now, ledgerPath})` について: (a) `status` が `diagnoseGate` 整形 + tripwire 状態を返す。(b) `round plan-1.md` が `## Reviewer Outputs (Round N)` 骨格を marker 直前に挿入し N を既存 +1 にする。(c) `stamp plan-1.md --verdict pass --reviewers a+b` は台帳に必須 reviewer が揃わなければ非 0 を返し文書を変えない。(d) 揃っていれば `- Review Status: pass`（厳密形）を書き marker を追記する。(e) 引数 diff が `Approval Status` 行に触れると中断。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runWorkflowCli } from "../../cli/workflow.ts";

test("stamp fails when the ledger lacks a mandatory reviewer", () => {
  const { wf, ledger } = seedWorkflow({
    doc: "plan-1.md",
    round: 1,
    ledgerSlugs: ["logic-validator"],
  }); // scope missing
  const r = runWorkflowCli(
    [
      "stamp",
      "plan-1.md",
      "--verdict",
      "pass",
      "--reviewers",
      "logic-validator+scope-justification-reviewer",
    ],
    { cwd: wf, wfDir: wf, sessionId: "test-ses", now: NOW, ledgerPath: ledger },
  );
  assert.notEqual(r.exitCode, 0);
  assert.match(r.stderr, /scope-justification-reviewer/);
});

test("stamp writes strict Review Status and appends a marker when the ledger is complete", () => {
  const { wf, ledger } = seedWorkflow({
    doc: "plan-1.md",
    round: 1,
    ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
  });
  const r = runWorkflowCli(
    [
      "stamp",
      "plan-1.md",
      "--verdict",
      "pass",
      "--reviewers",
      "logic-validator+scope-justification-reviewer",
    ],
    { cwd: wf, wfDir: wf, sessionId: "test-ses", now: NOW, ledgerPath: ledger },
  );
  assert.equal(r.exitCode, 0);
  const doc = readFileSync(join(wf, "plan-1.md"), "utf8");
  assert.match(doc, /^- Review Status: pass$/m);
  assert.match(doc, /<!-- auto-review: verdict=pass; hash=[0-9a-f]{64};/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
期待: FAIL "Cannot find module '../../cli/workflow.ts'"

- [ ] **Step 3: 最小実装を書く**

`runWorkflowCli(argv, deps)` を純関数として実装（`process.exit` せず `{exitCode, stdout, stderr}` を返す。薄い CLI エントリが `runWorkflowCli(process.argv.slice(2), realDeps)` を呼び exit する）。`stamp`: 対象層（`plan-*` は PLAN、それ以外は SPEC）の必須 slug を決め、ledger を読み baseline 時刻以降に全 slug（bare 正規化）が揃うか確認 → 揃わなければ非 0 + 不足 slug を stderr → 揃えば。**baseline 時刻は wfDir mtime を使わない**（dir mtime は cache/baseline/ledger 自体の書込で前進し、早期の正当な reviewer 実行を弾くため。logic plan Round 1）。代わりに `round` 実行時に `<wfDir>/.round-baseline`（現 round 番号と ISO 時刻を追記）を書き、`stamp` はその「現 round の baseline 時刻」以降の ledger エントリを見る。Round 1 の baseline は最初の `round` 実行時刻（`round` を通らず直接 `stamp` した場合は wfDir 作成時刻に fallback し、その旨を stderr で告知）。 `computeDocumentHash` / `computeDesignHash` / parent-spec-hash（plan なら現 spec.md hash）を計算し、STRICT 形の `- Review Status: <v>` を書き、marker を追記。`round`: 現 round 数 +1 の Reviewer Outputs 骨格を marker 直前に挿入。`triage`: intent-triage marker を書く。全コマンドで Approval 行に触れる diff は中断。`executable_workflow-cli` は `#!/usr/bin/env -S bun run --silent` で `cli/workflow.ts` を呼ぶ 3 行 wrapper。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/cli/workflow.ts home/dot_local/bin/executable_workflow-cli home/dot_claude/hooks/tests/unit/workflow-cli.test.ts home/dot_claude/.settings.permissions.json
git commit -m "feat(hooks): add workflow-cli that writes bookkeeping and verifies reviewer runs"
```

### T3: guard の Bash 分類器が `workflow-cli` を wfDir 文書書込として認識する

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:610-690`
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `document-workflow-guard.ts:246-249`（`isDocumentPath`、wfDir 内 md は gate によらず allow）

- [ ] **Step 1: 失敗するテストを書く**

`workflow-cli stamp plan-1.md ...` の Bash 呼出が、guard に「wfDir 内 plan-1.md への書込」と分類され、結果は allow（文書は gate によらず書込可）になることを固定する。分類の明示により「ungated で素通り」ではなく「文書書込として認識した上で allow」になる。

```ts
test("classifies workflow-cli invocation as a wfDir document write and allows it", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createPreToolUseContextFor(hook, "Bash", {
    command:
      "workflow-cli stamp plan-1.md --verdict pass --reviewers logic-validator",
  });
  await invokeRun(hook, ctx);
  ctx.assertSuccess();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | head -30`
期待: 現状 `workflow-cli` は未知コマンドで write-like 判定されず、分類の明示アサーションで FAIL

- [ ] **Step 3: 最小実装を書く**

`analyzeSingleCommand` に `workflow-cli`（および `bun <...>/cli/workflow.ts`）のケースを追加: 第 2 引数（`round|stamp|triage`）に続く `plan-N.md` / `spec.md` を wfDir 文書 target として扱う。`isDocumentPath` 経由で allow に落ちる（判定変更なし、分類だけ明示）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | tail -15`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): classify workflow-cli calls as workflow-document writes"
```

### T4: レビュー推奨を pointer 化する（K6）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts`（`buildRecommendation` / `canSkip` の pointer 分岐）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
- 参照: `lib/document-hash.ts:20-37`（`stripReviewerOutputsSections`、round 見出し数の読取に流用）
- 参照: `plan-review-automation.ts:414-511`（現 `buildRecommendation` 全文）

- [ ] **Step 1: 失敗するテストを書く**

同一 round 内で hash だけ変わった 2 回目の呼出が全文でなく pointer（≤ 160B、`workflow-cli` を含む）を返し、round 見出し数が増えた最初の呼出は全文を返すことを固定する。

```ts
test("second change within the same round yields a short pointer", () => {
  const doc = specWithRounds(1); // one Reviewer Outputs (Round 1) heading
  const first = buildRecommendation({
    doc,
    docType: "spec",
    cache: { fullTextEmittedForRound: 0 },
  });
  assert.ok(first.length > 400); // full text
  const second = buildRecommendation({
    doc,
    docType: "spec",
    cache: { fullTextEmittedForRound: 1 },
  });
  assert.ok(Buffer.byteLength(second, "utf8") <= 160);
  assert.match(second, /workflow-cli/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: FAIL（現状は常に全文）

- [ ] **Step 3: 最小実装を書く**

`buildRecommendation` に、現 round 数（文書の `## Reviewer Outputs (Round N)` 見出し数）と cache の `fullTextEmittedForRound` を比較し、等しければ pointer 文字列（`[plan-review-automation] <doc> changed (hash <8桁>); Round <N+1>: 前回の推奨のまま。reviewer 実行後 workflow-cli round/stamp`）を返す分岐を追加。round が増えた初回は全文を返し `fullTextEmittedForRound` を更新。round ≥ 2 は「前 round で needs-work/blocker の reviewer のみ + diff」、round ≥ 3 かつ verdict ≠ pass は「予算到達、人間へ」を全文に含める。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-review-core.ts home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
git commit -m "feat(hooks): emit a pointer instead of the full review recommendation within a round"
```

### T5: self-audit / placeholder-scan を文書状態でゲートする（K10）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/spec-plan-self-audit.ts:24-88`
- 編集: `home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts:31-105`
- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts`（`isCompleteAndChanged(wfDir, docName, postContent)` を追加）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
- 参照: `spec-plan-self-audit.ts:59`（checklist 注入点）

- [ ] **Step 1: 失敗するテストを書く**

`isCompleteAndChanged` が、書込後内容に厳密形 `- Plan Status: complete` があり per-doc cache から hash が変わったときだけ true を返すこと、draft では false を返すことを固定する。

```ts
test("gate fires only when the post-write doc is complete and hash changed", () => {
  const wf = seedCache("spec.md", "oldhash");
  assert.equal(
    isCompleteAndChanged(wf, "spec.md", "- Plan Status: complete\nbody-v2"),
    true,
  );
  assert.equal(
    isCompleteAndChanged(wf, "spec.md", "- Plan Status: draft\nbody-v2"),
    false,
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: FAIL "isCompleteAndChanged is not a function"

- [ ] **Step 3: 最小実装を書く**

core に `isCompleteAndChanged(wfDir, docName, postContent)` を追加（`STRICT_PLAN_STATUS` に一致 && `computeDocumentHash(postContent)` != cache）。self-audit は Write の `content` / Edit の `new_string` を適用した「書込後内容」を合成して判定（PreToolUse だが post 内容は tool_input から作れる）。placeholder-scan（PostToolUse）は実ファイル内容で判定。false なら即 success（注入なし）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/ 2>&1 | tail -15`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/spec-plan-self-audit.ts home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts home/dot_claude/hooks/lib/workflow-review-core.ts home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
git commit -m "feat(hooks): gate self-audit and placeholder-scan on complete-and-changed docs"
```

### T6: announce-then-stop を resume-incomplete-work に足す（K7）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/resume-incomplete-work.ts:58-113`
- テスト: `home/dot_claude/hooks/tests/unit/resume-incomplete-work.test.ts`（**新規作成** — 既存テストなし、code-map 記載）
- 参照: `resume-incomplete-work.ts:22-56`（`getRetryCount` / `incrementRetryCount` / `resetRetryCount`）
- 参照: `resume-incomplete-work.ts:87`（allow 経路）

- [ ] **Step 1: 失敗するテストを書く**

(a) wfDir に research.md があり末尾行が「レビューを走らせます。」で待ち語なしなら `decision: block`。(b) 「承認をお願いします」なら allow。(c) `stop_hook_active` 真なら常に allow。fixture の counter file はテスト後に消す。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import hook from "../../implementations/resume-incomplete-work.ts";

test("blocks a Stop that only announces an action", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo()); // research.md present
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createStopContextFor(hook, {
    last_assistant_message: "では round 3 のレビューを走らせます。",
    stop_hook_active: false,
  });
  await invokeRun(hook, ctx);
  const out = ctx.jsonCalls.at(-1)?.output;
  assert.equal(out?.decision, "block");
});

test("allows a Stop that says it is waiting for approval", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const ctx = createStopContextFor(hook, {
    last_assistant_message: "承認をお願いします。",
    stop_hook_active: false,
  });
  await invokeRun(hook, ctx);
  ctx.assertSuccess();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/resume-incomplete-work.test.ts`
期待: FAIL（announce 分岐未実装、`createStopContextFor` ヘルパを test-helpers に足す必要があれば同 Step で追加）

- [ ] **Step 3: 最小実装を書く**

`MIN_MESSAGE_LENGTH` allow 経路の直前に分岐: research.md があり、末尾非空行が宣言語尾 regex（`(走らせ|実行し|反映し|直し|進め|着手し|書き|開始し|回し|起動し|更新し)ます[。.!]?$` or `^(I('ll| will)|Let me) .*\.$`）に一致し、末尾非空行に待ち語（`承認|approve|待ち|判断を` or 行末 `[?？]`）が無ければ、既存カウンタ範囲で `decision: block`。`stop_hook_active` 真なら allow。`test-helpers.ts` に `createStopContextFor` が無ければ追加。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/resume-incomplete-work.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/resume-incomplete-work.ts home/dot_claude/hooks/tests/unit/resume-incomplete-work.test.ts home/dot_claude/hooks/tests/unit/test-helpers.ts
git commit -m "feat(hooks): block Stop turns that only announce an action mid-workflow"
```

### T7: 文書矛盾の解消（K9a / K9b）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts`（`REVIEWER_CATALOG` に code-simplicity-reviewer）
- 編集: `home/dot_claude/hooks/implementations/block-plan-mode.ts:43-55`（6 step 列挙 → 1 行 + wfDir）
- 編集: `home/dot_claude/hooks/implementations/spec-plan-self-audit.ts:11`（`(P9)` 除去）
- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:489-501`（`$` 含む未展開トークンを `raw-token` 明示）
- 編集: `home/dot_claude/agents/{logic-validator,scope-justification-reviewer,decision-quality-reviewer,test-quality-evaluator}.md`（Prompt Hygiene 節）
- 編集: `home/dot_claude/rules/workflow.md:396`（verdict 語彙を pass/needs-work/blocker に）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
- 参照: `plan-review-automation.ts:115-249`（`REVIEWER_CATALOG` 現 7 件）
- 参照: `home/dot_claude/agents/greenfield-perspective-reviewer.md:103-109`（Prompt Hygiene の雛形）

- [ ] **Step 1: 失敗するテストを書く**

`REVIEWER_CATALOG` が `code-simplicity-reviewer`（subagentType `compound-engineering:review:code-simplicity-reviewer`）を含み、keyword `簡素化` / `YAGNI` で選定されることを固定する。

`selectReviewers` は実装上 `selectReviewers(planContent: string): ReviewerRule[]` の**単一引数**（`plan-review-automation.ts:733`、catalog は層非依存）。層引数は足さない（logic plan Round 1）。

```ts
test("selects code-simplicity-reviewer for simplification keywords", () => {
  const sel = selectReviewers("この計画は YAGNI 観点で簡素化の余地がある");
  assert.ok(
    sel.some(
      (r) =>
        r.subagentType ===
        "compound-engineering:review:code-simplicity-reviewer",
    ),
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: FAIL（catalog に未登録）

- [ ] **Step 3: 最小実装を書く**

catalog に code-simplicity-reviewer を追加（keywords: 簡素化 / simplif / YAGNI / dead code / 削除）。`block-plan-mode.ts` の 6 step 列挙を「Document Workflow に従う（`~/.claude/rules/workflow.md` 参照）」1 行 + resolved wfDir 提示に置換。self-audit の header から `(P9)` を除去。`appendOffPlanLog` で target に `$` が含まれれば `raw-token:<token>` として記録。4 reviewer agent 定義末尾に greenfield と同型の Prompt Hygiene 節を追加。`workflow.md:396` の `verdict=<pass/fail/needs-revision>` を `verdict=<pass/needs-work/blocker>` に修正。`stop-reflection.ts` は Stop 到達先の実機確認が未完のため本 plan では触らない（spec K9a の条件）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/ 2>&1 | tail -15`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-review-core.ts home/dot_claude/hooks/implementations/block-plan-mode.ts home/dot_claude/hooks/implementations/spec-plan-self-audit.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/agents/ home/dot_claude/rules/workflow.md home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
git commit -m "fix(hooks): resolve verdict-vocab, catalog, block-plan-mode, and prompt-hygiene drifts"
```

### T8: workflow.md を operator guide に絞り reference skill を作る（K8）

**Files:**

- 編集: `home/dot_claude/rules/workflow.md`（≤ 12KB の operator guide に再構成）
- 新規: `.skills/document-workflow-reference/SKILL.md`（機構仕様の受け皿）
- 新規: `docs/scripts/workflow-session-audit.mjs`（K8 受入基準の集計スクリプト、チェックイン）
- 参照: `home/dot_claude/rules/workflow.md:237-278`（S3 手順 + SSoT 区間、移設対象と残置対象）
- 参照: `home/.chezmoiscripts/run_after_sync-skills.sh.tmpl:7,37`（`.skills/` → `~/.claude/skills/` 同期）
- 参照: `plan-review-automation.test.ts:630-714`（SSoT 区間は guide に残す必要）

- [ ] **Step 1: 失敗するテストを書く**

`workflow.md` が 12KB 以下で、SSoT marker 区間（`<!-- ssot:spec-reviewers:start -->` 等）を保持し、CLI 手順（`workflow-cli`）とターン終端規則を含むことを固定する。移設先 skill の存在も確認する。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, statSync, existsSync } from "node:fs";

test("workflow.md is an operator guide within budget and keeps SSoT markers", () => {
  const p = "home/dot_claude/rules/workflow.md";
  assert.ok(statSync(p).size <= 12 * 1024, "workflow.md must be <= 12KB");
  const c = readFileSync(p, "utf8");
  for (const m of [
    "ssot:spec-reviewers:start",
    "ssot:spec-reviewers:end",
    "ssot:plan-reviewers:start",
    "ssot:plan-reviewers:end",
  ]) {
    assert.ok(c.includes(m), `missing ${m}`);
  }
  assert.match(c, /workflow-cli/);
  assert.ok(existsSync(".skills/document-workflow-reference/SKILL.md"));
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts`（新規ファイル名。テストは同 Step で作る）
期待: FAIL（現 workflow.md は 36KB、skill 未作成）

- [ ] **Step 3: 最小実装を書く**

`workflow.md` を operator guide（routing 表 / 8 step と各 step の CLI / ターン終端規則 / No Placeholders / SSoT 付き reviewer 一覧 / 人間承認 / Executive Summary 雛形 / Scope Guard / 完了規約）に再構成。DOCUMENT_WORKFLOW_DIR 引き継ぎ・S3 移行手順・carry-forward 責務分離・mechanical-lane 詳細・起動軸図・ISO 25010 選択ガイド・hash 3 種の意味を `.skills/document-workflow-reference/SKILL.md` に移す。guide の各 step に「詳細は /document-workflow-reference」を付す。`docs/scripts/workflow-session-audit.mjs` に欠落集計（Reviewer Outputs / intent-triage の有無、注入量）を実装。drift テストの参照パスは workflow.md のままなので SSoT 区間は必ず残す。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts 2>&1 | tail -15`
期待: PASS（budget + SSoT drift 両方）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/rules/workflow.md .skills/document-workflow-reference/SKILL.md docs/scripts/workflow-session-audit.mjs home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts
git commit -m "docs(workflow): split workflow.md into an operator guide and a reference skill"
```

### T9: 全 hook のスモークと chezmoi apply の検証

**Files:**

- 参照: `home/dot_claude/package.json`（`test` / `typecheck` scripts）
- 参照: `home/.chezmoiscripts/`（apply 後に hooks を配置するスクリプト）

- [ ] **Step 1: 全テスト + typecheck**

実行: `cd home/dot_claude && bun run test 2>&1 | tail -30 && bun run typecheck 2>&1 | head -20`
期待: 全 PASS、型エラー 0

- [ ] **Step 2: drift テスト個別確認**

実行: `node --test home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts`
期待: PASS（新 hook 2 本登録済み、SSoT 区間保持）

- [ ] **Step 3: apply dry-run**

実行: `chezmoi diff 2>&1 | head -40`
期待: 新 hook・CLI・wrapper・skill・permission の差分が出て、想定外の削除が無い

- [ ] **Step 4: apply とスモーク**

実行: `chezmoi apply && workflow-cli status --wf-dir .tmp/sessions/0e299d39 2>&1 | head -20`
期待: apply 成功、`workflow-cli` が PATH で解決し status を出す

- [ ] **Step 5: コミット（必要なら apply 由来の追従のみ）**

```bash
git add -A && git commit -m "chore(hooks): verify full suite and apply for the workflow overhaul"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: ledger に logic-validator のみ、`workflow-cli stamp plan-1.md --verdict pass --reviewers logic-validator+scope-justification-reviewer` → **期待**: 非 0 終了、stderr に `scope-justification-reviewer`、文書不変
- **入力**: ledger に両 slug（正規化後）、同コマンド → **期待**: 0 終了、`- Review Status: pass`（厳密形）と `hash=<64 hex>` marker 追記
- **入力**: `workflow-cli` の diff が `Approval Status` 行に触れる → **期待**: 中断（非 0）

### 性能効率性（資源効率性）

- **入力**: 同一 round 内の 2 回目の文書変更 → **期待**: 注入が pointer（`Buffer.byteLength` ≤ 160）
- **入力**: `## Reviewer Outputs (Round 2)` が増えた初回の変更 → **期待**: 全文推奨

### 信頼性（回復性）

- **入力**: 末尾行「反映します。」+ research.md あり + `stop_hook_active` false → **期待**: `decision: block`
- **入力**: 同上 + `stop_hook_active` true → **期待**: allow

### 使用性（学習性）

- **入力**: `statSync("home/dot_claude/rules/workflow.md").size` → **期待**: ≤ 12288 bytes、SSoT 4 marker と `workflow-cli` を含む

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work → 反映済み
- 主指摘: `stamp` の baseline を wfDir mtime でなく `round` が書く `.round-baseline` に（反映、T2）。`selectReviewers` は単一引数の実シグネチャに（反映、T7）。T1 の citation は実機確認 artifact 指す（spec K5 の確認済み claim に準拠）

### scope-justification-reviewer

- verdict: needs-work → 反映済み
- 主指摘: T3/T4/T5/T7/T8 が触るテストファイル（`document-workflow-guard.test.ts` / `workflow-review-core.test.ts` / `workflow-md-budget.test.ts`）を top-level Files に追加（反映）。K9b の Prompt Hygiene 対象 4 agent を明記

### architecture-strategist

- verdict: needs-work → 反映済み
- 主指摘: `REVIEWER_SLUGS` は core の `SPEC_REVIEWERS`/`PLAN_REVIEWERS`/`REVIEWER_CATALOG` から導出（第 3 コピーを作らない、T1 に反映）。`seedWorkflow`/`seedCache`/`createStopContextFor` の authoring step を Files 注記に追加。`runWorkflowCli` は純関数で spawn 不要

### data-integrity-guardian

- verdict: pass（plan-3 分）
- 主指摘: ledger は append-only + session_id + 200 行 cap。`.round-baseline` 導入で reviewer 実行時刻の判定が dir mtime の副作用から独立

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

<!-- auto-review: verdict=pass; hash=69fa3d2d5f55c66d0faacd36cde8a8f725becd8739c5cd9001bed4f29b14b881; design-hash=dd1488e74ac6960e941c5766cea225dcc3ca064145e72bd7d9276c8ef7bdf50c; parent-spec-hash=ea7e535f7a83e4d2e5002cfdd698d69a3472a2f61275ae613634f156a54d68c6; at=2026-09-10T04:52:00Z; reviewers=logic-validator+scope-justification-reviewer+architecture-strategist+security-sentinel+data-integrity-guardian -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-09-10T04:52:00Z -->
