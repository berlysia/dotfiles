<!-- spec-ref: spec.md -->

# Plan 2: bash-parser の予算注入 (Execution layer)

spec の K11 を実装する。perf の分離（K5〜K9）は plan-3 で扱う。plan-1 の完了（`tests/support/` の作成を含む）を前提にする。

共通事項:

- テストは repo ルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>` を実行する（以下 `RUN <file>`）。パスは `home/dot_claude/hooks/` からの相対で書く（以下 `H/`）
- 本番の予算 100ms は変えない。本番コードは setter を呼ばない
- R7 の検査（plan-3 で実装）が成り立つよう、`H/lib/bash-parser.ts` の中では、setter の識別子を定義行以外に書かない（JSDoc、コメント、エラー文にも書かない）
- 経過時間の assert（`performance.now() - start < N`）の扱い: T4 で予算 0 に包む 3 件（bash-parser :646 の `< 1000`、:670 の `< 50`、document-workflow-guard :762 の `< 1000`）からは、この plan で外す。予算 0 の下ではもう本番の予算を測っておらず、残すと壁時計だけに依存する assert になるため。本番の予算で同じ操作の経過時間を測る `it` は、plan-3 で perf に新設する（spec K8(b)）。それ以外の経過時間の assert は、plan-3 で perf に移すまで unit に残る
- preload が効いていることの検査は、TDD の Red として T3 で bash-parser.test.ts に置く。plan-3 はこれを `test-layout.test.ts` に移し、1 か所にする（spec K11 の配置）
- サブプロセスへは届かない: preload が効くのは `node --test` の子プロセスの中だけ。テストが bun で起動したフックは本番の 100ms のまま動く。該当は run-guard.test.ts:266 の 1 件で、`rm -rf node_modules` に `deny` を期待している。予算を超えて give-up しても結果は同じ `deny` なので変えない（spec K11）
- 比較を `>` から `>=` に変える案（予算 0 を「必ず切る」と定義どおりにする）は採らない。本番の判定を変えるため。予算 0 で切れることは、解析にかかる時間（最短で約 3.3µs）が `performance.now()` の刻み（約 40ns）より十分大きいことで成り立つ（plan-2 Round 1 の resilience の測定）

## Files

```
# 新規作成
home/dot_claude/hooks/tests/support/parse-budget.ts

# 編集
home/dot_claude/hooks/lib/bash-parser.ts
home/dot_claude/hooks/tests/preload-test-env.mjs

# テスト
home/dot_claude/hooks/tests/unit/bash-parser.test.ts
home/dot_claude/hooks/tests/unit/auto-approve.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
```

## Tasks

### T1: 予算の setter と getter（K11）

**Files:**

- 編集: `H/lib/bash-parser.ts:126-129, :215`
- テスト: `H/tests/unit/bash-parser.test.ts`（import 部と、`describe("parser limits (Issue #235)")` の直前に新しい describe）
- 参照: `H/lib/bash-parser.ts:120-146`（予算とプロセス全体の状態）、`:197-236`（`parseBounded`）

- [ ] **Step 1: 失敗するテストを書く**

import に `DEFAULT_PARSE_BUDGET_MS`, `getParseBudgetMs`, `setParseBudgetMs` を足し（既存の `../../lib/bash-parser.ts` からの import に追加）、`withParseBudget`（T2 で作る `../support/parse-budget.ts`）はこの Task では使わない。

```ts
describe("parse budget (spec K11)", () => {
  it("keeps the production default at 100 ms", () => {
    strictEqual(DEFAULT_PARSE_BUDGET_MS, 100);
  });

  it("rejects a budget that is negative or not finite", () => {
    const before = getParseBudgetMs();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      throws(() => setParseBudgetMs(bad), RangeError);
    }
    strictEqual(getParseBudgetMs(), before);
  });

  it("applies a set budget to the next parse", async () => {
    const before = getParseBudgetMs();
    setParseBudgetMs(0);
    try {
      // Budget 0 cuts any parse, even a short one. The input is unique to
      // this test because a cut input stays cut for the whole process.
      strictEqual(await parseForCollect("echo budget-zero-unique"), null);
    } finally {
      setParseBudgetMs(before);
    }
    strictEqual(getParseBudgetMs(), before);
  });
});
```

`throws` を `node:assert` の import に足す。`parseForCollect` が既に import されていることを確認する（:652 のテストが使っている）。

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/bash-parser.test.ts`。期待: `DEFAULT_PARSE_BUDGET_MS` などが export されていないため、import の解決でファイル全体が失敗する
- [ ] **Step 3: 最小実装**

:126-129 の予算のコメントと定数を次の内容に置き換える（:125 の `MAX_META_SCAN_CHARS` は触らない。コメントの前半 3 行は既存の文のまま）。

```ts
// A backstop inside the length limit: tree-sitter's error recovery is
// superlinear on some malformed inputs. Wall clock, so load can trip it; the
// only outcome is a deny.
export const DEFAULT_PARSE_BUDGET_MS = 100;
// Tests replace the budget through the setter below (a patient value for the
// whole run, 0 around a parse they mean to cut). Production code never calls
// it, and a test-layout check under tests/unit/ enforces that.
let parseBudgetMs = DEFAULT_PARSE_BUDGET_MS;

export function setParseBudgetMs(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`parse budget must be a finite number >= 0: ${ms}`);
  }
  parseBudgetMs = ms;
}

export function getParseBudgetMs(): number {
  return parseBudgetMs;
}
```

:215 の `const overBudget = () => performance.now() - start > PARSE_BUDGET_MS;` を `const overBudget = () => performance.now() - start > parseBudgetMs;` にする。`GIVE_UP_REASONS.time` の「100 ms」の文言は変えない（本番の値を説明する文。spec K11）。

- [ ] **Step 4: 通過を確認する** — `RUN H/tests/unit/bash-parser.test.ts`。期待: 新しい 3 件は PASS。既存の give-up 系（:637-668）はこの時点では本番の 100ms のまま動く（preload は T3 で変える）
- [ ] **Step 5**: `bun run typecheck` で 0 エラー、`grep -c "setParseBudgetMs" H/lib/bash-parser.ts` が `1`

### T2: 予算を一時的に差し替える helper

**Files:**

- 新規: `H/tests/support/parse-budget.ts`
- 参照: `H/tests/support/fake-git.ts`（plan-1 T0、同じディレクトリの前例）

```ts
import { getParseBudgetMs, setParseBudgetMs } from "../../lib/bash-parser.ts";

/**
 * Runs `fn` with the parse budget set to `ms`, then restores the previous
 * budget even when `fn` throws, so a failed assertion cannot leave 0 for the
 * tests after it in the same file. The budget is process-wide: calls must not
 * overlap (no Promise.all, no concurrent tests in one file).
 */
export async function withParseBudget<T>(
  ms: number,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = getParseBudgetMs();
  setParseBudgetMs(ms);
  try {
    return await fn();
  } finally {
    setParseBudgetMs(previous);
  }
}
```

- [ ] **Step 1**: 上のファイルを作成する
- [ ] **Step 2**: `bun run lint:oxlint` が通る

### T3: preload で全テストプロセスの予算を 10_000 にする

**Files:**

- 編集: `H/tests/preload-test-env.mjs`（末尾）
- 参照: `H/lib/bash-parser.ts:1099`（静的 import は型だけ）、`:260-269`（web-tree-sitter は動的 import）

- [ ] **Step 1: 失敗するテストを書く** — T1 の describe に 1 件足す

```ts
it("runs every test process with the patient budget from the preload", () => {
  strictEqual(getParseBudgetMs(), 10_000);
});
```

- [ ] **Step 2: 失敗を確認する** — `RUN H/tests/unit/bash-parser.test.ts`。期待: `100 !== 10000` で FAIL
- [ ] **Step 3: 実装** — preload の末尾（`CLAUDE_LOGS_DIR` の設定の後）に足す

```js
// lib/bash-parser.ts gives up on a parse after 100ms of wall clock. Under a
// loaded run that trips on ordinary commands and flips allow into deny, so
// every test process gets a patient budget. Tests that mean to cut a parse
// set 0 around that call (tests/support/parse-budget.ts). Imported last: the
// module has no static runtime imports, so loading it here initialises
// neither tree-sitter nor logging.
const { setParseBudgetMs } = await import("../lib/bash-parser.ts");
setParseBudgetMs(10_000);
```

- [ ] **Step 4: 通過を確認する** — 同じコマンドで、追加した 1 件は PASS。既存の give-up 系は、予算 10_000 の下では病的な入力の解析が最後まで進む（`>` × 20000 で約 2.9 秒、`(a) ` × 5000 で約 1.1 秒。plan-2 Round 1 の resilience の測定）。そのため「gives up within the time budget」の 2 件は `parsingMethod` が `"fallback"` にならず FAIL する。:652・:663 も 1 回目が `null` にならず FAIL する。実際の結果を記録してから T4 で直す。T3 と T4 は同じコミットにする（T3 だけの状態では、解析が数秒かかるテストが残るため）

### T4: give-up に依存する 6 件を予算 0 で決定化する

**Files:**

- テスト: `H/tests/unit/bash-parser.test.ts:637-672`、`H/tests/unit/auto-approve.test.ts:368-382`、`H/tests/unit/document-workflow-guard.test.ts:754-767`
- 参照: research.md §5.5（6 件の一覧）、spec K11（予算 0 は切りたい解析の間だけ）

各ファイルの import に `import { withParseBudget } from "../support/parse-budget.ts";` を足す。

1. bash-parser.test.ts「gives up within the time budget on ${name}」（:637-650、2 件）: 解析を予算 0 で包み、経過時間の 2 行（`const start = ...` と `ok(performance.now() - start < 1000);`）を外す。`it` の本体は次のとおり

```ts
it(`gives up within the time budget on ${name}`, async () => {
  const mark = parserGiveUpMark();
  const result = await withParseBudget(0, () =>
    extractCommandsStructured(command),
  );
  strictEqual(result.parsingMethod, "fallback");
  ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
});
```

2. bash-parser.test.ts「keeps the parser usable after a cancelled parse」（:652-661）: 1 回目だけを予算 0 にする。2 回目の `echo after-limit-c` は preload の予算で解析させる

```ts
it("keeps the parser usable after a cancelled parse", async () => {
  strictEqual(
    await withParseBudget(0, () =>
      parseForCollect(`echo limit-c ${">".repeat(20000)}`),
    ),
    null,
  );
  deepStrictEqual(await extractCommandsStructured("echo after-limit-c"), {
    individualCommands: ["echo after-limit-c"],
    originalCommand: null,
    parsingMethod: "tree-sitter",
  });
});
```

3. bash-parser.test.ts「does not parse an input again after giving up on it」（:663-672）: 1 回目だけを予算 0 にする。2 回目は preload の予算でも、切った入力の記録（`timedOutInputs`）によって give-up する。これがこのテストの検証対象

経過時間の 2 行（`const start = ...` と `ok(performance.now() - start < 50);`）は外す。`it` の本体は次のとおり

```ts
it("does not parse an input again after giving up on it", async () => {
  const command = `echo limit-d ${">".repeat(20000)}`;
  strictEqual(await withParseBudget(0, () => parseForCollect(command)), null);
  const mark = parserGiveUpMark();
  strictEqual(await parseForCollect(command), null);
  ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
});
```

4. auto-approve.test.ts「denies when a fragment's re-parse gives up during classification」（:368）: `classifyBashDeny` の中の `parseForCollect` だけを予算 0 にする。外側の `ls -la` の解析は preload の予算で通す（全体を 0 にすると、狙いの経路を通らずに deny になる）

```ts
classifyBashDeny: async () => {
  await withParseBudget(0, () =>
    parseForCollect(`echo aa-limit ${">".repeat(20000)}`),
  );
  return { type: "clear" };
},
```

5. document-workflow-guard.test.ts「denies a write hidden behind an input the parser gives up on」（:754-767）: コマンド全体の give-up が検証対象なので、`invokeRun` 全体を予算 0 で包む

経過時間の 2 行（`const start = performance.now();` と `ok(performance.now() - start < 1000);`）を外し、`await invokeRun(hook, context);` を次の行に置き換える。

```ts
await withParseBudget(0, () => invokeRun(hook, context));
```

- [ ] **Step 1**: 上の 5 か所（6 件）を書き換える
- [ ] **Step 2: 通過を確認する** — 3 ファイルを `RUN` し、全件 PASS
- [ ] **Step 3**: 各ファイルで give-up 用の入力（`limit-a`〜`limit-d`、`aa-limit`、`budget-zero-unique`、document-workflow-guard の `>` × 20000 の入力）が、そのファイルの中で 1 か所にしか現れないことを grep で確かめる（切った入力は以後どの予算でも give-up するため）

### T5: 確認とコミット

- [ ] **Step 1**: `bun run test` を実行し、失敗 0 件。plan-2 の前と比べて所要が 10 秒以上伸びていないこと（予算 10_000 の下で、病的な入力の解析が長引くテストが残っていないかの確認）。伸びていたら、どのテストかを特定して報告する
- [ ] **Step 2**: `bun run typecheck`、`bun run lint` が成功する
- [ ] **Step 3**: ISO の手順で、plan-2 で触れた 3 テストファイルと deny-node-modules.test.ts（飽和負荷で :145 / :301 が落ちていた。research.md §5.5）を、負荷を足さずに 3 回実行する。合格基準は 3 回とも失敗 0 件。ただし、plan-3 で perf に移すまで unit に残る経過時間の assert（4 ファイルの中で `performance.now() -` を含む行: bash-parser.test.ts の :604 と :722、deny-node-modules.test.ts の :298-300・:316・:328-330）そのものが失敗の原因である場合だけは除外し、記録して plan-3 に引き継ぐ。同じ `it` でも、判定（`assertAsk` / `assertSuccess` など）の行で落ちた場合は除外しない。除外しない失敗が出たら、原因を特定して報告する。deny-node-modules :291（`cp` × 7000、約 28,000 文字で解析まで進む）も、予算の注入で直る対象に含まれる
- [ ] **Step 4**: コミット（`/commit` を使う）

## ISO 25010 具体テストケース

負荷の手順: 負荷を足さない（spec の ISO 25010、research.md §5.6）。`RUN` に複数のファイルを渡すと、各ファイルが並列の子プロセスで走る。

### 信頼性（成熟性）

- **入力**: bash-parser / auto-approve / document-workflow-guard / deny-node-modules の 4 テストファイルを `RUN` で 3 回実行 → **期待**: 3 回とも `ℹ fail 0`
- **入力**: 変更前のコードで同じ負荷（実施済み、research.md §5.5）→ **期待**: deny-node-modules の「should allow read-only commands」(:145) が `success` ではなく deny で失敗する（前提の確認）

### 機能適合性（機能正確性）

- **入力**: `DEFAULT_PARSE_BUDGET_MS` → **期待**: `100`
- **入力**: `setParseBudgetMs(-1)` / `NaN` / `Infinity` → **期待**: いずれも `RangeError`、予算は変わらない
- **入力**: 予算 0 で `parseForCollect("echo budget-zero-unique")` → **期待**: `null`（give-up）。その後、予算は元の値に戻っている
- **入力**: テストプロセスで `getParseBudgetMs()` → **期待**: `10000`（preload が効いている）
- **入力**: auto-approve の `processBashTool({ command: "ls -la" })`、断片の再解析だけ予算 0 → **期待**: `commands` の type が `["deny"]`
- **入力**: document-workflow-guard の `>` × 20000 を含むコマンドを予算 0 で実行 → **期待**: deny、理由に `within 100 ms` を含む

### 保守性（試験性）

- **入力**: `withParseBudget(0, fn)` の `fn` が throw する → **期待**: 予算は呼び出し前の値に戻る（`finally`）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: 予算 0・preload・import の主張はコードと一致し、T4 が漏らしている give-up 依存のテストは無い。置き換え範囲は :125-129 ではなく :126-129。T3 Step 4 の「FAIL か遅くなる」は曖昧なので、実際の結果を書くべき

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全 Task が K11 に対応し drift は無い。サブプロセスの例外（run-guard :266）を plan に明記すべき。preload の検査を plan-2 と plan-3 のどちらに置くかを決めておく

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: preload とテストは同じ解決 URL でモジュールを共有する。予算を複製・再 export している利用元は無い。サブプロセスで起動したフックには preload が届かないことを書く

### resilience-analyzer

- verdict: needs-work
- 主指摘: 予算 0 の give-up は実用上決定的（解析 3.3µs 対 時計の刻み約 40ns）。plan-2 の飽和負荷の確認（T5 Step 3）で、plan-3 まで残る経過時間の assert（:670 の `< 50` など）が落ちうる。`withParseBudget` は重なる呼び出しに安全でないことを書く。T3 と T4 は同じコミットにする

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: 行番号と除外の一覧は正確。経過時間の行を外しても未使用変数や lint エラーは残らない。T1 のコメントが plan-3 まで存在しないファイルを名指ししている → 反映済み

### resilience-analyzer

- verdict: pass
- 主指摘: Round 1 の 4 点はすべて解消。perf 側の対（本番の予算での経過時間）と preload の検査の移設は、plan-3 が確実に引き取る必要がある

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=7a96ff8928c982564d991c1244df85bc11544b8a74c5378527a6bb0da0dfdfd2; design-hash=3dc81af28dbfa2b3874686e3bd465197c3454746bb1cfb21a686cedd41fe33ca; round=1; parent-spec-hash=36a179d137aa3116e9ecbb5ddb950d4815896d431fee0fe3f28f2ab8139f2766; at=2026-10-05T22:09:31.800Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+resilience-analyzer -->
<!-- intent-triage: adopted=9; excluded=0; at=2026-10-05T22:09:31.887Z -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: T5 Step 3 と ISO の手順は新しい基準に揃っている。残る「飽和」の記述は変更前の観測の記録で、基準ではない

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=pass; hash=193cfba037ba624507b3d669f7fcffcf78526a2dacb16e41714bfae8257480d0; design-hash=ddb5df4ae09cd7ad688a27d5fedd40ed542f9aa282021a7374f9d9f66830537f; round=2; parent-spec-hash=36a179d137aa3116e9ecbb5ddb950d4815896d431fee0fe3f28f2ab8139f2766; at=2026-10-05T22:15:06.554Z; reviewers=logic-validator+resilience-analyzer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-10-05T22:15:06.611Z -->

<!-- auto-review: verdict=pass; hash=e06eea1b7ad83ef60496e70e854e7002937f64b7b1519bc12f0f6188abd179a0; design-hash=58da2b820a9a24660599fcf725dee44d708e0c73efae47899fe7dac0595b6068; round=3; parent-spec-hash=08fcc6597c6f756dee0437c64d84e0501f1d214545bde2f2b74a0a57714fe9d0; at=2026-10-05T22:58:18.669Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-10-05T22:58:18.771Z -->
