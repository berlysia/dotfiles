# Plan 1: ラウンド上限の機構化と prose 変更での追加レビュアー停止

親 spec: `spec.md`（K1〜K3）。本 plan は spec の全 Key Decision を 1 本で実装する。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/workflow-files.ts
home/dot_claude/hooks/tests/unit/workflow-files.test.ts

# 編集
home/dot_claude/hooks/lib/workflow-marker.ts
home/dot_claude/hooks/cli/workflow.ts
home/dot_claude/hooks/lib/workflow-review-core.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/rules/workflow.md
.skills/document-workflow-reference/SKILL.md
docs/decisions/0015-document-workflow-operator-ergonomics.md

# テスト
home/dot_claude/hooks/tests/unit/workflow-marker.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts
```

テストの実行: 1 ファイルは `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`（repo root から）、全体は `bun run test`、型は `bun run typecheck`。以下 `T=node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test` と略記する。

## Tasks

### T1: `## Files` パーサを lib に切り出し、prose 判定を足す（spec K2）

**Files:**

- 新規: `home/dot_claude/hooks/lib/workflow-files.ts`
- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:501-547`（`parseFilesSection` の本体を lib 呼び出し + realpath 解決に置換）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-files.test.ts`
- 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:433`（唯一の呼び出し元。戻り値の意味＝絶対パス配列は変えない）

- [ ] **Step 1: 失敗するテストを書く**（fixture は不要。入力は文字列リテラル）

```ts
#!/usr/bin/env node --test
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProseOnlyChange,
  parseFilesPaths,
} from "../../lib/workflow-files.ts";

const doc = (block: string) =>
  `# Plan\n\n## Files\n\n\`\`\`\n${block}\n\`\`\`\n\n## Tasks\n`;

describe("workflow-files: parseFilesPaths", () => {
  it("returns raw relative paths, skipping # comments and blank lines", () => {
    deepStrictEqual(
      parseFilesPaths(doc("# 編集\na/b.ts\n\n.skills/x/SKILL.md")),
      ["a/b.ts", ".skills/x/SKILL.md"],
    );
  });
  it("drops a block that contains a line with internal whitespace", () => {
    deepStrictEqual(parseFilesPaths(doc("a/b.ts\nfoo bar.md")), []);
  });
  it("returns [] when there is no ## Files section", () => {
    deepStrictEqual(parseFilesPaths("# Spec\n\n## Goal\nx\n"), []);
  });
});

describe("workflow-files: isProseOnlyChange", () => {
  it("true when every path is prose (.md/.mdx/.markdown/.txt/.rst/.adoc)", () => {
    strictEqual(
      isProseOnlyChange(
        doc(".skills/a/SKILL.md\nhome/dot_claude/rules/x.md\nnotes.txt"),
      ),
      true,
    );
  });
  it("strips a trailing .tmpl before judging", () => {
    strictEqual(
      isProseOnlyChange(doc("home/dot_claude/templates/context.md.tmpl")),
      true,
    );
    strictEqual(
      isProseOnlyChange(doc("home/.chezmoiscripts/run.sh.tmpl")),
      false,
    );
  });
  it("false when any path is code", () => {
    strictEqual(
      isProseOnlyChange(doc("a/SKILL.md\nhome/dot_claude/hooks/lib/x.ts")),
      false,
    );
  });
  it("false when Files is missing or empty (falls back to keyword selection)", () => {
    strictEqual(isProseOnlyChange("# Spec\n\n## Goal\nx\n"), false);
    strictEqual(isProseOnlyChange(doc("# only a comment")), false);
  });
});
```

- [ ] **Step 2: 実行して失敗を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-files.test.ts` → 期待: FAIL（`Cannot find module '../../lib/workflow-files.ts'`）

- [ ] **Step 3: 最小実装**

````ts
// home/dot_claude/hooks/lib/workflow-files.ts
/**
 * `## Files` section parsing shared by document-workflow-guard (which owns
 * the realpath resolution) and review selection (which only needs the raw
 * paths). One parser so the two never disagree on what a plan lists.
 */

const PROSE_EXTENSIONS = [".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc"];

/**
 * Raw project-relative paths from the fenced code blocks under `## Files`.
 * `#` lines and blank lines are skipped. A block containing any line with
 * internal whitespace is dropped whole (conservative: a malformed block must
 * not partially authorize writes in the guard).
 */
export function parseFilesPaths(planContent: string): string[] {
  const sections = planContent.split(/^##\s+/m);
  const filesSection = sections.find((s) =>
    /^Files\s*$/m.test(s.split("\n")[0] ?? ""),
  );
  if (!filesSection) return [];
  const sectionBody = filesSection.replace(/^Files\s*\n/, "");
  const collected: string[] = [];
  for (const match of sectionBody.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
    const block = match[1];
    if (block === undefined) continue;
    const blockPaths: string[] = [];
    let blockValid = true;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (/\s/.test(line)) {
        blockValid = false;
        break;
      }
      blockPaths.push(line);
    }
    if (blockValid) collected.push(...blockPaths);
  }
  return collected;
}

/**
 * True when `## Files` lists at least one path and every path is prose.
 * Code-quality reviewers (security, resilience, ...) have nothing to review
 * in such a change. Missing/empty Files returns false so the caller falls
 * back to keyword selection (spec.md never has Files).
 */
export function isProseOnlyChange(planContent: string): boolean {
  const paths = parseFilesPaths(planContent);
  if (paths.length === 0) return false;
  return paths.every((p) => {
    const lower = p.toLowerCase().replace(/\.tmpl$/, "");
    return PROSE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}
````

guard 側は `parseFilesSection` の本体を次に置き換える（関数名・シグネチャ・戻り値は不変）:

```ts
function parseFilesSection(planContent: string, cwd: string): string[] {
  return parseFilesPaths(planContent).map((p) => resolve(cwd, expandTilde(p)));
}
```

`import { parseFilesPaths } from "../lib/workflow-files.ts";` を guard の import 群に足す。

- [ ] **Step 4: 実行して通過を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-files.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts` → 期待: 全 PASS（guard テストは無変更で通る＝spec R7 の受入条件）

- [ ] **Step 5: コミット** — `refactor(hooks): share the ## Files parser and add prose-only detection`

### T2: 最後の pass marker のラウンド番号を読む関数を足す（spec K1）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-marker.ts`（`parseLatestAutoReviewMarker` の後に追加）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-marker.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-marker.ts:28`（`REVIEW_MARKER_REGEX`、同ファイル内で再利用）、`:47-89`（キー分解の書式。未知キーを無視する挙動は変えない）

`AutoReviewMarker` 型には `round` を足さない（既存テストが `deepStrictEqual` で 4 フィールドの完全一致を見ているため、型を広げると既存テストの期待値変更が要る）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { lastPassMarkerRound } from "../../lib/workflow-marker.ts";

test("lastPassMarkerRound returns round= of the last verdict=pass marker", () => {
  const content = [
    "<!-- auto-review: verdict=pass; hash=1; design-hash=a; round=3; at=x -->",
    "<!-- auto-review: verdict=needs-work; hash=2; design-hash=b; round=4; at=y -->",
  ].join("\n");
  strictEqual(lastPassMarkerRound(content), 3);
});

test("lastPassMarkerRound returns 0 without a pass marker or when the pass marker has no round=", () => {
  strictEqual(
    lastPassMarkerRound(
      "<!-- auto-review: verdict=needs-work; hash=2; round=2 -->",
    ),
    0,
  );
  strictEqual(
    lastPassMarkerRound(
      "<!-- auto-review: verdict=pass; hash=1; design-hash=a -->",
    ),
    0,
  );
  strictEqual(lastPassMarkerRound("no markers"), 0);
});
```

（`strictEqual` は既存 import に無ければ `node:assert/strict` から足す）

- [ ] **Step 2: 失敗を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-marker.test.ts` → 期待: FAIL（`lastPassMarkerRound` is not exported）

- [ ] **Step 3: 最小実装**

```ts
/**
 * `round=` of the last `verdict=pass` marker, or 0 when there is none (or it
 * predates the `round=` field). `workflow-cli round` counts the rounds of the
 * current review cycle from here, so a re-review after approval gets a fresh
 * budget while unstamped `round` calls keep counting.
 */
export function lastPassMarkerRound(content: string): number {
  const markers = content.match(REVIEW_MARKER_REGEX) ?? [];
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i] ?? "";
    if (!/\bverdict=pass\b/.test(marker)) continue;
    const round = /\bround=(\d+)/.exec(marker);
    return round?.[1] ? Number.parseInt(round[1], 10) : 0;
  }
  return 0;
}
```

- [ ] **Step 4: 通過を確認** — 同コマンド → 期待: PASS（既存 test も PASS）

- [ ] **Step 5: コミット**（T3 とまとめてよい）

### T3: stamp が marker に `round=` を書く（spec K1）

**Files:**

- 編集: `home/dot_claude/hooks/cli/workflow.ts:415-433`（`buildMarkerLine` に `round: number` を追加し `design-hash` の直後、`parent-spec-hash` の前に `round=${round}` を出す）、`:529`（呼び出しに `round: currentRound` を渡す。`currentRound` は `:461` で算出済み）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`

- [ ] **Step 1: 失敗するテストを書く**（`describe("workflow-cli: stamp")` 内。既存 `seedWorkflow` を使う）

```ts
it("writes round=<current round> into the marker", () => {
  const { wf, ledger } = seedWorkflow({
    doc: "plan-1.md",
    round: 2,
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
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(
    readFileSync(join(wf, "plan-1.md"), "utf-8"),
    /<!-- auto-review: verdict=pass; hash=[0-9a-f]{64}; design-hash=[^;]+; round=2;/,
  );
});
```

注: `seedWorkflow` は各ラウンドの verdict 行を空欄で書くため、round 2 の stamp が delta 判定で必須 reviewer を要求しても ledgerSlugs で満たされる。Step 2 で ledger 不足による失敗が出たら、失敗理由が「round= が無い」ではないので ledgerSlugs を必須集合に合わせる。

- [ ] **Step 2: 失敗を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-cli.test.ts` → 期待: 新テストのみ FAIL（marker に `round=` が無い）

- [ ] **Step 3: 実装** — `buildMarkerLine` の parts を `[verdict, hash, design-hash, round=${fields.round}]` の順にし、以降は既存どおり `parent-spec-hash`（plan-N のみ）→ `at` → `reviewers`

- [ ] **Step 4: 通過を確認** — 同コマンド → 期待: 全 PASS（既存 stamp テストの `/verdict=pass; hash=[0-9a-f]{64};/` と `/parent-spec-hash=[0-9a-f]{64}/` は位置を固定していないので通る）

- [ ] **Step 5: コミット** — `feat(workflow-cli): record the round number in the auto-review marker`

### T4: `round` がレビュー 1 周あたり 3 ラウンドを超えるのを拒否する（spec K1）

**Files:**

- 編集: `home/dot_claude/hooks/cli/workflow.ts:106`（`BOOLEAN_FLAGS` に `"extend"` を追加）、`:261-325`（`cmdRound`: `currentRound` 算出直後に判定を挿入）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
- 参照: `home/dot_claude/hooks/lib/workflow-marker.ts`（T2 の `lastPassMarkerRound`）

- [ ] **Step 1: 失敗するテストを書く**（`describe("workflow-cli: round")` 内）

```ts
const ROUND_DEPS = (wf: string) => ({
  cwd: wf,
  wfDir: wf,
  sessionId: "test-ses",
  now: NOW,
});

it("refuses a 4th round in the same review cycle", () => {
  const { wf } = seedWorkflow({ doc: "plan-1.md", round: 3, ledgerSlugs: [] });
  const r = runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf));
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /round budget \(3\)/);
  assert.match(r.stderr, /--extend --reason/);
  assert.doesNotMatch(readFileSync(join(wf, "plan-1.md"), "utf-8"), /Round 4/);
});

it("allows round 3 (2 rounds so far in the cycle)", () => {
  const { wf } = seedWorkflow({ doc: "plan-1.md", round: 2, ledgerSlugs: [] });
  assert.equal(
    runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf)).exitCode,
    0,
  );
});

it("starts a fresh budget after a pass marker with round=", () => {
  const { wf } = seedWorkflow({ doc: "plan-1.md", round: 3, ledgerSlugs: [] });
  const p = join(wf, "plan-1.md");
  writeFileSync(
    p,
    `${readFileSync(p, "utf-8")}\n<!-- auto-review: verdict=pass; hash=x; design-hash=y; round=3; at=z; reviewers=a -->\n`,
  );
  assert.equal(
    runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf)).exitCode,
    0,
  );
});

it("--extend without --reason is refused", () => {
  const { wf } = seedWorkflow({ doc: "plan-1.md", round: 3, ledgerSlugs: [] });
  const r = runWorkflowCli(["round", "plan-1.md", "--extend"], ROUND_DEPS(wf));
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--reason/);
});

it("--extend --reason proceeds, logs the extension, and composes with --full", () => {
  const { wf } = seedWorkflow({ doc: "plan-1.md", round: 3, ledgerSlugs: [] });
  const r = runWorkflowCli(
    [
      "round",
      "plan-1.md",
      "--extend",
      "--reason",
      "user: continue once",
      "--full",
    ],
    ROUND_DEPS(wf),
  );
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout, /extended beyond round budget \(3\)/);
  assert.match(
    readFileSync(join(wf, "plan-1.md"), "utf-8"),
    /## Reviewer Outputs \(Round 4\)/,
  );
  const log = readFileSync(join(wf, "round-extensions.log"), "utf-8");
  assert.match(log, /^2026-.*\tplan-1\.md\t4\tuser: continue once$/m);
});
```

（`NOW` は既存テストファイルの定数。`writeFileSync` / `readFileSync` / `join` は既存 import に無ければ足す。`NOW` の年が 2026 でない場合は log の正規表現を `^\S+\tplan-1\.md\t4\t...` にする）

- [ ] **Step 2: 失敗を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-cli.test.ts` → 期待: 「refuses」「--extend without --reason」「--extend --reason」の 3 件が FAIL、他は PASS

- [ ] **Step 3: 実装**（`cmdRound` の `currentRound` / `nextRound` 算出直後、roundPlan 算出の前）

上限値は `lib/workflow-review-core.ts` に `export const ROUND_BUDGET = 3;`（`MAX_ADDITIONAL_REVIEWERS` の隣、`:53` 付近）として 1 か所で定義し、CLI は既存の `from "../lib/workflow-review-core.ts"` import（`cli/workflow.ts:47`）に `ROUND_BUDGET` を足して使う。T5 の予算行も同じ定数を使う（文言の `(3)` は `${ROUND_BUDGET}` で埋める）。

```ts
const roundsInCycle = currentRound - lastPassMarkerRound(oldContent);
const extending = flags["extend"] === "true";
if (extending && (flags["reason"] ?? "").trim() === "") {
  return err('--extend requires --reason "<the human\'s instruction>"');
}
if (roundsInCycle >= ROUND_BUDGET && !extending) {
  return err(
    `refusing: ${docName} has used its round budget (${ROUND_BUDGET}) since the last pass. Present the Executive Summary with the unresolved findings and ask the human for direction. Only if the human tells you to continue, re-run with --extend --reason "<their instruction>".`,
  );
}
```

書込成功後（`appendRoundBaseline` の後）:

```ts
let extensionNote = "";
if (roundsInCycle >= ROUND_BUDGET && extending) {
  appendFileSync(
    join(wfDir, "round-extensions.log"),
    `${deps.now.toISOString()}\t${docName}\t${nextRound}\t${(flags["reason"] ?? "").trim()}\n`,
  );
  extensionNote = `extended beyond round budget (${ROUND_BUDGET})\n`;
}
```

`ok(...)` の stdout 末尾に `extensionNote` を連結する。`appendFileSync` / `join` を import に足す（既存 import を確認して重複させない）。予算内で `--extend` が付いた場合はログを書かない（上限を超えていないため）。

- [ ] **Step 4: 通過を確認** — 同コマンド → 期待: 全 PASS

- [ ] **Step 5: コミット** — `feat(workflow-cli): refuse rounds beyond the per-cycle budget unless extended`

### T5: 推奨文を prose 判定と周カウントに揃える（spec K1・K2）

**Files:**

- 編集: `home/dot_claude/hooks/lib/workflow-review-core.ts:437-467`（`listRecommendedReviewers` の full 分岐）、`:587-593`（予算行）、`buildRecommendation` 内の推奨列挙の直後（skip 行）
- テスト: `home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

````ts
const proseFiles =
  "## Files\n\n```\n.skills/pr-description/SKILL.md\n```\n\n## Tasks\npermission timeout モジュール\n";
const codeFiles =
  "## Files\n\n```\nhome/dot_claude/hooks/lib/x.ts\n```\n\n## Tasks\npermission timeout モジュール\n";

describe("workflow-review-core: prose-only change", () => {
  it("recommends no catalog reviewers and says why", () => {
    const result = buildRecommendation("/tmp/wf/plan.md", null, proseFiles);
    ok(!result.includes("security-sentinel"));
    ok(!result.includes("resilience-analyzer"));
    ok(
      result.includes(
        "Additional reviewers: skipped (all ## Files entries are prose)",
      ),
    );
    ok(result.includes("1. subagent_type: logic-validator"));
  });
  it("keeps keyword selection when Files lists code", () => {
    const result = buildRecommendation("/tmp/wf/plan.md", null, codeFiles);
    ok(result.includes("security-sentinel"));
    ok(!result.includes("Additional reviewers: skipped"));
  });
});

describe("workflow-review-core: round budget line", () => {
  const rounds = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `## Reviewer Outputs (Round ${i + 1})\n`,
    ).join("\n");
  it("mentions --extend once the cycle reaches 3 rounds", () => {
    const content = `## Goal\nx\n${rounds(3)}\n<!-- auto-review: verdict=needs-work; hash=1; round=3 -->\n`;
    ok(
      buildRecommendation("/tmp/wf/spec.md", null, content).includes(
        "--extend --reason",
      ),
    );
  });
  it("is silent when the cycle restarted after a pass at round 3", () => {
    const content = `## Goal\nx\n${rounds(4)}\n<!-- auto-review: verdict=pass; hash=1; round=3 -->\n<!-- auto-review: verdict=needs-work; hash=2; round=4 -->\n`;
    ok(
      !buildRecommendation("/tmp/wf/spec.md", null, content).includes(
        "Round budget reached",
      ),
    );
  });
});
````

- [ ] **Step 2: 失敗を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts` → 期待: 「recommends no catalog reviewers」「mentions --extend」「is silent when the cycle restarted」が FAIL

- [ ] **Step 3: 実装**
  - `listRecommendedReviewers` の full 分岐: `const additional = isProseOnlyChange(planContent) ? [] : selectReviewers(planContent).map(...)`
  - `buildRecommendation`: 推奨列挙（`...recommended.map(...)`）の直後で、`roundPlan.kind === "full" && isProseOnlyChange(planContent)` なら `"", "Additional reviewers: skipped (all ## Files entries are prose). If this plan changes code, list those paths in ## Files."` を push
  - 予算行: 条件を `roundCount - lastPassMarkerRound(planContent) >= ROUND_BUDGET && marker?.verdict !== "pass"` に変え（`ROUND_BUDGET` は T4 で本ファイルに定義した定数）、文言を `Round budget reached (${ROUND_BUDGET}). \`workflow-cli round\` will refuse the next round. Present the Executive Summary with unresolved findings and ask the human for direction. Only if the human tells you to continue, run \`workflow-cli round <doc> --extend --reason "<their instruction>"\`.` にする
  - import: `isProseOnlyChange` を `./workflow-files.ts` から、`lastPassMarkerRound` を `./workflow-marker.ts` から（依存方向は lib → lib で、ADR 上の implementations → lib 一方向を保つ）

- [ ] **Step 4: 通過を確認** — `$T home/dot_claude/hooks/tests/unit/workflow-review-core.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts` → 期待: 全 PASS

- [ ] **Step 5: コミット** — `feat(hooks): skip catalog reviewers for prose-only plans and align the round budget notice`

### T6: 文書を機構に揃える（spec K3）

**Files:**

- 編集: `home/dot_claude/rules/workflow.md:35-38`（step 5）
- 編集: `.skills/document-workflow-reference/SKILL.md:129-149`（`workflow-cli` サブコマンド節）
- 編集: `docs/decisions/0015-document-workflow-operator-ergonomics.md:71-80`（既存 Amendment の後、References の前）
- 参照: `home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts:19`（workflow.md ≤ 12KB、SSoT marker 4 つ、`workflow-cli` / `document-workflow-reference` の言及を維持）

- [ ] **Step 1**: workflow.md は現在 12232 bytes で予算 12288 まで 56 bytes しか無い（実測）。追記の前に既存 2 行を圧縮して 153 bytes 空ける（言い換えのみで規則は変えない）:
  - 54 行目（成果物は Edit / Write で書く）を次に置換: `- **ワークフロー成果物の書き込みは Edit / Write ツールで行う**。Bash の heredoc の中身（\`->\` / \`<hash>\` / \`eval\` 等）は guard が書き込みと誤検出しうる。Edit / Write はツール種別で判定されるので誤検出がなく、\`plan-review-automation\` も確実に発火する。`
  - 78 行目（SSoT の説明）を次に置換: `これらは Agent tool の subagent_type で、Skill ではない。SSoT は \`lib/workflow-review-core.ts\` の \`SPEC_REVIEWERS\` / \`PLAN_REVIEWERS\` で、上の区間と CI で同期される。`
  - 38 行目（5.2）の直後に 1 行（193 bytes）追加: `   - **5.3 予算**: pass 後 3 round で \`round\` は拒否。続行は人間の指示時のみ \`--extend --reason "<指示>"\`。\`## Files\` が prose のみなら追加レビュアーなし。`
  - 期待サイズ: 12232 − 153 + 193 = 12272 bytes（≤ 12288）。詳細（周の数え方、log 書式、拡張子一覧）は Step 2 で SKILL.md に置き、workflow.md には書かない
- [ ] **Step 2**: SKILL.md の `round` の説明に `--extend --reason`、周のカウント（`round=` と最後の pass marker）、`round-extensions.log` の書式 `<ISO8601>\t<doc>\t<round>\t<reason>` を追記。prose 判定（拡張子一覧と `.tmpl` の扱い、spec.md は対象外）を追記
- [ ] **Step 3**: ADR-0015 に `## Amendment (2026-09-28): ラウンド予算を機構に移し、prose 変更では追加レビュアーを付けない` を追加。内容: 観測（N=7 セッション 9 文書、R4 以降の新規指摘 0/4、3/9 文書が文言上の予算を超過、prose だけの plan に architecture / security / resilience が推奨された再生結果）、決定（spec K1・K2 の要約）、受容リスク（`--extend` の指示元と偽 pass stamp は prompt 統制、再評価トリガー各 1 件）、見送り（カタログの未インストール参照と追加レビュアー blocker の扱いは別件）
- [ ] **Step 4**: `$T home/dot_claude/hooks/tests/unit/workflow-md-budget.test.ts home/dot_claude/hooks/tests/unit/plan-review-automation.test.ts` → 期待: 全 PASS。`wc -c home/dot_claude/rules/workflow.md` ≤ 12288
- [ ] **Step 5: コミット** — `docs(workflow): document the round budget and prose-only reviewer selection`

### T7: 全体検証と展開

- [ ] **Step 1**: `bun run test` → 期待: 失敗 0（変更前の全体件数 + 本 plan の追加件数）
- [ ] **Step 2**: `bun run typecheck` → 期待: エラー 0
- [ ] **Step 3**: `bun run lint` → 期待: エラー 0（format 差分があれば `bun run format` 相当で直して再実行）
- [ ] **Step 4**: `chezmoi apply` の実行はユーザーに依頼する（`~/.claude/` への展開は人間が確認して行う）

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: Round 3 まで Reviewer Outputs があり pass marker 無しの plan-1.md に `round` → **期待**: exit 1、stderr に `round budget (3)` と `--extend --reason`、文書に `Round 4` が挿入されない
- **入力**: Round 2 まで → `round` → **期待**: exit 0、Round 3 挿入
- **入力**: Round 3 まで + `verdict=pass; ...; round=3` marker → `round` → **期待**: exit 0（新しい周の 1 ラウンド目）
- **入力**: Round 3 まで → `round --extend`（reason 無し）→ **期待**: exit 1、stderr に `--reason`
- **入力**: Round 3 まで → `round --extend --reason "user: continue once" --full` → **期待**: exit 0、Round 4 挿入、stdout に `extended beyond round budget (3)`、`round-extensions.log` に `<ISO>\tplan-1.md\t4\tuser: continue once` の 1 行
- **入力**: Round 2 の plan-1.md に `stamp --verdict pass` → **期待**: marker に `design-hash=...; round=2;` が含まれる
- **入力**: `## Files` が `.skills/pr-description/SKILL.md` のみ、本文に `permission timeout モジュール` を含む plan.md → **期待**: 推奨に `security-sentinel` / `resilience-analyzer` が無く、`Additional reviewers: skipped` 行と必須 4 名がある
- **入力**: 同じ本文で Files が `home/dot_claude/hooks/lib/x.ts` → **期待**: `security-sentinel` が推奨に含まれ、skip 行は無い
- **入力**: Files が `context.md.tmpl` のみ → **期待**: prose（true）。`run.sh.tmpl` → code（false）

### 保守性（修正性）

- **入力**: guard の既存テスト一式（`document-workflow-guard.test.ts`）を無変更で実行 → **期待**: 全 PASS（Files パーサ切り出しで guard の判定が変わらない）
- **入力**: 既存の marker パーサテスト（`workflow-marker.test.ts` の既存 test）を無変更で実行 → **期待**: 全 PASS（`round=` 追加で `parseLatestAutoReviewMarker` の戻り値が変わらない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T6 の追記で workflow.md が 12KB 予算を約 329 bytes 超過する（現 12232 bytes、余裕 56）。行番号・テストの fail→pass 理由・guard 挙動同一性・依存方向は実コードと整合

### scope-justification-reviewer

- verdict: pass
- 主指摘: 全タスクが spec K1〜K3 に対応し Files と一致。軽微: 上限値 3 が CLI と review-core に二重定義（`ROUND_BUDGET` 共有に反映）

<!-- auto-review: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: コピー上で置換を再現し 12232 − 87 − 66 + 193 = 12272 bytes（≤ 12288）を実測確認。言い換えで規則の欠落なし、SSoT 区間と必須言及は維持。`ROUND_BUDGET` の cli → lib import に循環なし

### scope-justification-reviewer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=dde3229732d06c67d2b298c8a06121a7ba199f8a4815a546ed502ae97b8040a2; design-hash=c481284bdaea8ad8a495dac4a5e1b09d548dcf28da1a6a6fbcc6283ec5bdd519; parent-spec-hash=566b3b7283def8b508e631c67fd5e68a199b5e67ad3af7514db7675fbc5992ae; at=2026-09-28T03:38:43.996Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=2; excluded=0; at=2026-09-28T03:38:44.013Z -->

<!-- auto-review: verdict=pass; hash=92061589baff1b1fa9f09cf9327b25929e2855c2a381a543e98a2db9ad6ac5ad; design-hash=c481284bdaea8ad8a495dac4a5e1b09d548dcf28da1a6a6fbcc6283ec5bdd519; parent-spec-hash=566b3b7283def8b508e631c67fd5e68a199b5e67ad3af7514db7675fbc5992ae; at=2026-09-28T03:40:47.999Z; reviewers=logic-validator -->
<!-- intent-triage: adopted=1; excluded=0; at=2026-09-28T03:40:48.017Z -->
