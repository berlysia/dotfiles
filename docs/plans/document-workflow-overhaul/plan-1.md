<!-- spec-ref: spec.md -->

# Plan 1: lib 層の抽出と guard 診断化 (Execution layer)

spec の K1（core 抽出）/ K4（診断・marker parser 一本化、正規化不変）を実装する。K2/K3/K5 以降の新 hook・CLI が依存する土台。他 plan より先に承認・実装する。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/workflow-marker.ts
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/tests/unit/workflow-marker.test.ts
home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts

# 編集
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/plan-review-automation.ts
home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts
home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/test-helpers.ts
```

T4 の Step 3 で、`document-workflow-guard.test.ts` にローカル定義されている `createWorkflowRepo` / `pendingWorkflowRepo` を `test-helpers.ts` に移して export する（plan-2 / plan-3 の新テストが import するため。architecture plan Round 1）。既存 guard テストは新 import 元に差し替える。

## Tasks

### T1: `lib/workflow-marker.ts` に marker parser と status 正規表現を集約する

**Files:**

- 新規: `home/dot_claude/hooks/lib/workflow-marker.ts`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-marker.test.ts`
- 参照: `document-workflow-guard.ts:781-820`（`extractLatestAutoReviewMarker`、`parent-spec-hash` を hyphen-aware で分離）
- 参照: `plan-review-automation.ts:630-666`（`extractLatestReviewMarker`、`design-hash` を分離）
- 参照: `document-workflow-guard.ts:16-18`（`PLAN_STATUS_REGEX` / `REVIEW_STATUS_REGEX` / `APPROVAL_STATUS_REGEX`、ハイフン必須・厳密形）

- [ ] **Step 1: 失敗するテストを書く**

`parseLatestAutoReviewMarker(content)` が全 marker を走査して最後の 1 つを返し、`verdict` / `hash` / `designHash` / `parentSpecHash` を key 衝突なく分離すること、STRICT 判定用の 3 regex が厳密形（`- Plan Status: complete`）のみ一致しハイフン無しに不一致であることを固定する。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseLatestAutoReviewMarker,
  STRICT_PLAN_STATUS,
  STRICT_REVIEW_STATUS,
  STRICT_APPROVAL_STATUS,
} from "../../lib/workflow-marker.ts";

test("parseLatestAutoReviewMarker takes the last marker and splits hyphenated keys", () => {
  const content = [
    "<!-- auto-review: verdict=needs-work; hash=111; design-hash=aaa -->",
    "<!-- auto-review: verdict=pass; hash=222; design-hash=bbb; parent-spec-hash=ccc; at=2026-02-19T00:00:00.000Z -->",
  ].join("\n");
  assert.deepStrictEqual(parseLatestAutoReviewMarker(content), {
    verdict: "pass",
    hash: "222",
    designHash: "bbb",
    parentSpecHash: "ccc",
  });
});

test("strict status regexes require the hyphen and reject annotations", () => {
  assert.equal(STRICT_REVIEW_STATUS.test("- Review Status: pass"), true);
  assert.equal(STRICT_REVIEW_STATUS.test("Review Status: pass"), false);
  assert.equal(
    STRICT_REVIEW_STATUS.test("- Review Status: pass (note)"),
    false,
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-marker.test.ts`
期待: FAIL "Cannot find module '../../lib/workflow-marker.ts'"

- [ ] **Step 3: 最小実装を書く**

guard 側の marker 走査（全マッチの最後を採る、`key=value;` を hyphen-aware key regex で分割）を移植する。`parseLatestAutoReviewMarker` は両 hook の union（`designHash` と `parentSpecHash` の両方）を返す。STRICT 3 定数は `document-workflow-guard.ts:16-18` の値をそのままエクスポートする。診断用の寛容版 `LENIENT_STATUS_LINE = /^\s*-?\s*(Plan|Review|Approval) Status:.*$/gm` も併せて置く（判定には使わない、表示専用）。

```ts
export const STRICT_PLAN_STATUS = /^- Plan Status:\s*complete\s*$/m;
export const STRICT_REVIEW_STATUS = /^- Review Status:\s*pass\s*$/m;
export const STRICT_APPROVAL_STATUS = /^- Approval Status:\s*approved\s*$/m;
export const LENIENT_STATUS_LINE =
  /^\s*-?\s*(Plan|Review|Approval) Status:.*$/gm;
const MARKER = /<!--\s*auto-review:\s*(.*?)\s*-->/g;

export interface AutoReviewMarker {
  verdict: string | null;
  hash: string | null;
  designHash: string | null;
  parentSpecHash: string | null;
}

export function parseLatestAutoReviewMarker(
  content: string,
): AutoReviewMarker | null {
  const all = [...content.matchAll(MARKER)];
  if (all.length === 0) return null;
  const body = all[all.length - 1][1];
  const get = (key: string): string | null => {
    const m = body.match(new RegExp(`(?:^|;)\\s*${key}=([^;]+)`));
    return m ? m[1].trim() : null;
  };
  return {
    verdict: get("verdict"),
    hash: get("hash"),
    designHash: get("design-hash"),
    parentSpecHash: get("parent-spec-hash"),
  };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-marker.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-marker.ts home/dot_claude/hooks/tests/unit/workflow-marker.test.ts
git commit -m "feat(hooks): centralize auto-review marker parsing in a shared lib"
```

### T2: guard と plan-review の marker 走査を `workflow-marker` に差し替える

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:16-18,781-820`
- 編集: `home/dot_claude/hooks/implementations/plan-review-automation.ts:630-666`
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`（marker 解析ケース、既存）
- 参照: `home/dot_claude/hooks/lib/workflow-marker.ts`（T1 で新設）

- [ ] **Step 1: 失敗するテストを書く**

guard の `document-workflow-guard.test.ts` の既存 marker ケース（`extractLatestAutoReviewMarker parses ...`）が、内部関数ではなく `workflow-marker` の `parseLatestAutoReviewMarker` を経由しても同結果になることを固定する。guard の private `extractLatestAutoReviewMarker` / `plan-review-automation.ts` の `extractLatestReviewMarker` を re-export ラッパにし、既存テストの import を壊さない。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractLatestAutoReviewMarker } from "../../implementations/document-workflow-guard.ts";

test("guard marker extraction delegates to shared parser", () => {
  const c =
    "<!-- auto-review: verdict=pass; hash=222; parent-spec-hash=ccc -->";
  assert.deepStrictEqual(extractLatestAutoReviewMarker(c), {
    verdict: "pass",
    hash: "222",
    designHash: null,
    parentSpecHash: "ccc",
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | head -50`
期待: 既存 marker ケースの戻り値形状差分で FAIL（`designHash` key 追加分）

- [ ] **Step 3: 最小実装を書く**

`document-workflow-guard.ts:16-18` の 3 regex を `workflow-marker` の `STRICT_*` の re-export に置換。`:781-820` の走査本体を削除し `export const extractLatestAutoReviewMarker = parseLatestAutoReviewMarker;` にする。`plan-review-automation.ts:630-666` も同様に `extractLatestReviewMarker = parseLatestAutoReviewMarker` へ。判定ロジック（`hasApprovedPlan` 等、`document-workflow-guard.ts:304-328,344-418`）は `verdict`/`hash`/`parentSpecHash` のみ読み `designHash` を読まないため、戻り形状に `designHash` が増えても allow/deny 判定は不変（logic-validator plan Round 1 で確認済み）。フィールド名を新形（`designHash`/`parentSpecHash`）に合わせる以外は不変。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts 2>&1 | tail -20`
期待: PASS（両ファイル全ケース）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/implementations/plan-review-automation.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "refactor(hooks): consume shared marker parser in guard and plan-review"
```

### T3: `lib/workflow-gate.ts` に診断関数を作る

**Files:**

- 新規: `home/dot_claude/hooks/lib/workflow-gate.ts`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-gate.test.ts`
- 参照: `document-workflow-guard.ts:305-329`（`hasApprovedPlan`: 3 status + marker verdict + hash 一致）
- 参照: `document-workflow-guard.ts:344-418`（`checkTarget`: 二層の spec + plan-N + parent-spec-hash）
- 参照: `home/dot_claude/hooks/lib/workflow-marker.ts`（STRICT / LENIENT / parse、T1）
- 参照: `home/dot_claude/hooks/lib/document-hash.ts:88-93`（`computeDocumentHash`、不変）

- [ ] **Step 1: 失敗するテストを書く**

`diagnoseGate(wfDir, targetPath)` が、各条件の pass/fail、fail 時に見つかった status 行（LENIENT で拾い最大 3 行）、期待厳密形、次アクション文字列を返すことを固定する。fixture は temp dir に spec.md/plan.md を書いて渡す。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseGate } from "../../lib/workflow-gate.ts";

test("diagnoseGate reports hyphen-less Review Status as the failing line", () => {
  const wf = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(
    join(wf, "plan.md"),
    [
      "- Plan Status: complete",
      "Review Status: pass",
      "- Approval Status: approved",
    ].join("\n"),
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  assert.equal(d.conditions.reviewStatus.ok, false);
  assert.match(
    d.conditions.reviewStatus.foundLine ?? "",
    /Review Status: pass/,
  );
  assert.match(d.nextAction, /workflow-cli/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-gate.test.ts`
期待: FAIL "Cannot find module '../../lib/workflow-gate.ts'"

- [ ] **Step 3: 最小実装を書く**

single-layer / two-layer を判定し、各条件を `{ ok, foundLine?, expected }` で返す。判定は STRICT（`workflow-marker`）、表示行は LENIENT で拾って `sanitizeForDisplay`（最大 3 行）。`nextAction` は不成立条件に応じて `workflow-cli status|round|stamp` か「人間が Approval Status を approved に」を返す。hash 比較は `computeDocumentHash`（不変）を使う。

```ts
import { computeDocumentHash, SPEC_NORMALIZERS } from "./document-hash.ts";
import {
  STRICT_PLAN_STATUS,
  STRICT_REVIEW_STATUS,
  STRICT_APPROVAL_STATUS,
  LENIENT_STATUS_LINE,
  parseLatestAutoReviewMarker,
} from "./workflow-marker.ts";
import { sanitizeForDisplay } from "./sanitize-display.ts";

export interface GateCondition {
  ok: boolean;
  foundLine?: string;
  expected: string;
}
export interface GateDiagnosis {
  active: boolean;
  twoLayer: boolean;
  conditions: Record<string, GateCondition>;
  nextAction: string;
}

function findLine(
  content: string,
  field: "Plan" | "Review" | "Approval",
): string | undefined {
  const lines = content.match(LENIENT_STATUS_LINE) ?? [];
  const hit = lines.find((l) => l.includes(`${field} Status:`));
  return hit ? sanitizeForDisplay(hit.trim()) : undefined;
}
// diagnoseGate: read plan.md/spec.md under wfDir, evaluate STRICT regexes + marker hash,
// build conditions map and nextAction. (single-layer shown; two-layer mirrors checkTarget)
export function diagnoseGate(wfDir: string, targetPath: string): GateDiagnosis {
  // ...evaluate as in hasApprovedPlan/checkTarget, but never deny — only describe
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-gate.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
git commit -m "feat(hooks): add workflow-gate diagnosis shared by guard and CLI"
```

### T4: guard の deny 文を `diagnoseGate` の出力に差し替える

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:97-102,160,200`
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-gate.ts`（T3）
- 参照: `lib/context-helpers.ts:53-55`（`createDenyResponse`）

- [ ] **Step 1: 失敗するテストを書く**

pending 状態の repo で実装ファイルへの書込を deny したとき、deny reason に「不成立条件名」「見つかった status 行」「`workflow-cli` を含む次アクション」が入ることを固定する。判定結果（allow/deny の別）は現状と不変であることも確認する。

```ts
test("deny reason names the failing condition and next action", async () => {
  const repo = createWorkflowRepo(pendingWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/a.ts",
    content: "x",
  });
  await invokeRun(hook, context);
  context.assertDeny();
  const reason =
    context.jsonCalls.at(-1)?.output?.hookSpecificOutput
      ?.permissionDecisionReason ?? "";
  assert.match(reason, /Review Status/);
  assert.match(reason, /workflow-cli/);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | head -40`
期待: 現行の固定文には `workflow-cli` が無いため FAIL

- [ ] **Step 3: 最小実装を書く**

`:97-102` の固定 deny 文生成を、deny 経路（`:160` Bash / `:200` non-Bash）で `diagnoseGate(wfDir, targetPath)` を呼びその整形結果を `permissionDecisionReason` に載せる形へ変更する。allow/deny の分岐条件（`checkTarget` の戻り）は一切変えない。診断は理由文の生成にのみ使う。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts 2>&1 | tail -20`
期待: PASS（既存 allow/deny ケース + 新 reason ケース）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): make guard deny reasons diagnostic instead of fixed text"
```

### T5: `lib/workflow-review-core.ts` に plan-review の判定部を抽出し parity を固定する

**Files:**

- 新規: `home/dot_claude/hooks/lib/workflow-review-core.ts`
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
- 編集: `home/dot_claude/hooks/implementations/plan-review-automation.ts:60-249,262-406,414-551`
- 編集: `home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts:15-105`
- 編集: `home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts:30`（roster import を lib に付け替え）
- 参照: `plan-review-automation.ts:296-301`（`canSkip`）, `:290-293`（cache co-location）
- 参照: `plan-review-automation.test.ts:630-714`（SSoT drift テスト、import 元変更が必要）
- 参照: `home/dot_claude/hooks/lib/workflow-paths.ts:136-154`（`resolveWorkflowPaths`）

- [ ] **Step 1: 失敗するテスト（parity fixture）を書く**

refactor 前の `buildRecommendation` / `canSkip` / placeholder 走査の出力を、代表 3 入力（draft の spec / complete の spec / plan-1）で golden 文字列として記録し、抽出後の core 関数が byte 一致で返すことを固定する（R8）。roster 定数 `SPEC_REVIEWERS` / `PLAN_REVIEWERS` を lib から import して drift テストが通ることも固定する。

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SPEC_REVIEWERS,
  PLAN_REVIEWERS,
  buildRecommendation,
  canSkip,
} from "../../lib/workflow-review-core.ts";

const GOLDEN_SPEC_DRAFT = `[plan-review-automation] spec.md was updated. Run sub-agent reviews before approval.\n...`; // 現行出力を貼る

test("buildRecommendation output is byte-identical after extraction (spec draft)", () => {
  assert.equal(
    buildRecommendation({ docType: "spec" /* fixture args */ }),
    GOLDEN_SPEC_DRAFT,
  );
});

test("SSoT rosters exported from lib match the 4 / 2 slugs", () => {
  assert.deepStrictEqual(
    SPEC_REVIEWERS.map((r) => r.slug),
    [
      "logic-validator",
      "scope-justification-reviewer",
      "decision-quality-reviewer",
      "greenfield-perspective-reviewer",
    ],
  );
  assert.deepStrictEqual(
    PLAN_REVIEWERS.map((r) => r.slug),
    ["logic-validator", "scope-justification-reviewer"],
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`
期待: FAIL "Cannot find module '../../lib/workflow-review-core.ts'"

- [ ] **Step 3: 最小実装を書く**

`SPEC_REVIEWERS` / `PLAN_REVIEWERS` / `REVIEWER_CATALOG` / cache 入出力 / cache パス解決（`resolveWorkflowPaths(dirname(planPath))`）/ `buildRecommendation` / `buildSummaryReminder` / placeholder 走査を `workflow-review-core.ts` へ移動。`canSkip` は現状 `plan-review-automation.ts:296-301` のインライン式（`(existingMarker?.hash === planHash && ...) || cache?.planHash === planHash`）なので、まず `export function canSkip(cache, planHash, marker): boolean` の**名前付きエクスポート関数**に切り出してから core へ移す（plan-2 T1/T2 がこの 3 引数シグネチャで呼ぶ前提、logic-validator plan Round 1）。`plan-review-automation.ts` と `spec-plan-placeholder-scan.ts` は core を呼ぶ薄い殻にする。core からの re-export で `plan-review-automation.ts` の既存 export（テストが import 済み）を維持。`plan-review-automation.test.ts:30` と drift テストの import 元を lib に変更。この T5 では出力仕様（cache キー・pointer 化・round）は変えない。cache 形状の per-doc 化は plan-2 T1 で行う。parity は pure 関数の golden に加え、**hook レベル**でも固定する: refactor 前 HEAD の `plan-review-automation` を context 経由で実行して additionalContext を捕捉し golden 化、抽出後の hook 出力が byte 一致することを assert する（spec R8 が名指す「Write/Edit hook の emitted additionalContext」経路、architecture plan Round 1）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `node --test home/dot_claude/hooks/tests/unit/ 2>&1 | tail -25`
期待: PASS（core parity + drift + guard + plan-review 全ケース）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-review-core.ts home/dot_claude/hooks/implementations/plan-review-automation.ts home/dot_claude/hooks/implementations/spec-plan-placeholder-scan.ts home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts
git commit -m "refactor(hooks): extract plan-review judgment into workflow-review-core with parity tests"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: `- Plan Status: complete` / `Review Status: pass`（ハイフン無し）/ `- Approval Status: approved` の plan.md で実装ファイル書込 → **期待**: deny 継続（判定不変）かつ reason に `Review Status: pass` の found line と `workflow-cli` を含む
- **入力**: `- Review Status: pass`（厳密形）+ verdict=pass marker + hash 一致 → **期待**: allow（既存判定不変）

### 保守性（試験性・リグレッション）

- **入力**: refactor 前後の `buildRecommendation`（spec draft / spec complete / plan-1 の 3 fixture）→ **期待**: golden 文字列と byte 一致
- **入力**: lib から import した `SPEC_REVIEWERS` / `PLAN_REVIEWERS` の slug 配列 → **期待**: それぞれ `[4 slugs]` / `[2 slugs]`、drift テスト緑
- **入力**: 既存の全 `node --test home/dot_claude/hooks/tests/unit/` → **期待**: 全 PASS（marker 形状変更の追随を含む）

## Reviewer Outputs (Round 1)

3 プラン一括の plan 層レビュー。plan-1 該当分。

### logic-validator

- verdict: needs-work → 反映済み
- 主指摘: `canSkip` はインライン式なので T5 で名前付き export 関数（3 引数）に切り出してから core へ（反映）。plan-1 T2 の marker 戻り形状に `designHash` が増えても guard 判定は不変と確認（T2 Step 3 に明記）

### scope-justification-reviewer

- verdict: pass（plan-1 分）
- 主指摘: 全タスクが K1/K4 に対応、orphan なし。Files セクションは guard parser 準拠

### architecture-strategist

- verdict: needs-work → 反映済み
- 主指摘: `createWorkflowRepo` / `pendingWorkflowRepo` は guard テストのローカル定義なので T4 で `test-helpers.ts` に export（反映、Files に追加）。parity は hook レベルの additionalContext byte 一致まで固定（T5 に明記）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

<!-- auto-review: verdict=pass; hash=d2c3efcf75245c052fe8762bbc72f2ab0990bd7a20b775555bfc794894384ec0; design-hash=793b8be91d8d49da9184630cde19574b4d65f3dbe362186738d8690c75abbc97; parent-spec-hash=ea7e535f7a83e4d2e5002cfdd698d69a3472a2f61275ae613634f156a54d68c6; at=2026-09-10T04:45:00Z; reviewers=logic-validator+scope-justification-reviewer+architecture-strategist+security-sentinel+performance-oracle -->
<!-- intent-triage: adopted=6; excluded=0; at=2026-09-10T04:45:00Z -->
