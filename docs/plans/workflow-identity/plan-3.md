<!-- spec-ref: spec.md -->

# Plan: gate の判定を workflow-gate に一本化し、`## Files` を対象の checkout 基準で照合する (Execution layer)

spec K6 → K2（#209-2）。H = `home/dot_claude/hooks`。plan-2 の実装（commit 1139133 まで）を前提にする。

## 方針と範囲

- T1（K6）は挙動を変えない移設にする。guard の `hasApprovedPlan` / `checkTarget` / `isContentApproved` / `findPlanNumberedFiles` / `parseFilesSection` / `readWorkflowState` / `isWorkflowActiveForTesting` を gate に移し、guard からは消す。判定の部品（`STRICT_*` 正規表現、`computeDocumentHash`、`parseLatestAutoReviewMarker`）は guard と gate が既に共有しているので、移設で判定の中身は変わらない
  - 移設前後の同値性: guard の `hasApprovedPlan` と gate の `hasApprovedDocument` は同じ 5 条件（3 つの status 行、verdict pass、marker hash = 計算した hash）を同じ部品で見る。読み込みに失敗したとき、前者は false、後者は空文字列として評価して 5 条件が成り立たないので、結果は同じ
  - T1 の `evaluateTarget` は `## Files` の相対エントリを `filesBase`（guard はツール cwd を渡す）で解決する。現行の `parseFilesSection(planContent, cwd)` と同じ基準で、T2 でこの引数を消して K2 の照合に置き換える
  - 判定（allow / deny / off-plan の緩和）は変えない。表示で変わる点は 1 つだけ: Bash の書き込み先が複数あり deny するとき、診断の note に出す対象を「先頭の対象」から「最初に止まった対象」に変える。note に出す文字列は、これまでどおり呼び出し側の生の入力（`TargetQuery.label`）にし、解決後の絶対パスにはしない。既存テストは note の文言を検査していない（`grep -n "plan-N.md whose\|is blocked" H/tests/unit/document-workflow-guard.test.ts` で確認済み）
  - `evaluateTarget` の戻り値は spec の Architecture 節の形（deny に `conditions` と `nextAction`）ではなく、既存の `GateDiagnosis`（両方を含む）をそのまま持たせる。`formatGateDiagnosis` と CLI が既にこの型を使っているため。allow には、どの文書が許可したかを示す `owner` を足す（T3 の表示に使う）
  - `readWorkflowState` と `isWorkflowActive` も gate に移す。spec の戻り値の `inactive` を gate が判定するのに必要で、guard に残すと gate が guard に依存する。session.ts の手元の複製（spec K5 の理由で import しない）はそのまま残し、ドリフト検査（session.test.ts）の比較相手を gate の関数に替える
- T2（K2）は `## Files` の照合の基準を変える。対象の realpath（`resolveWithMissingTail`）から上へ辿り、最初に `.git` を持つ dir を toplevel 候補とする。候補がプロジェクト root（realpath）と一致するか、候補の `.git` がファイルで `gitdir:` が `<root>/.git/worktrees/` の下を指すときだけ採用する。どちらでもなければ root を使う。相対エントリはその toplevel で、絶対・`~/` のエントリはそのまま、どちらも `resolveWithMissingTail` で realpath にしてから対象の realpath と比べる。git は spawn しない
  - 辿るのは root まで（root に着いたら root を返す）。root の外の祖先の `.git`（例: ホームの dotfiles）を候補にしない
  - 対象の realpath が求まらない（途中にリンク先の存在しない symlink がある）ときは、どの plan にも一致しない（`listsTarget` が false）。two-layer の実装フェーズでは off-plan の緩和（warn + `off-plan-writes.log`）で通り、記録が残る。専用の deny は spec に無いので足さない
- T3（K6 の後半）は `workflow-cli status <path>` を `evaluateTarget` の結果の表示にする。引数なしの `status` は現行どおり主文書の診断を出す
  - guard は `evaluateTarget` の前に 2 つの近道（wfDir の中の `.md` は文書なので通す、プロジェクトの外は通す）を持つ。これが gate に無いと、`status <wfDir>/notes.md` や `status /tmp/x` は guard が通すのに「blocked」と表示する。T3 で 2 つの判定を gate の `classifyExemption` に移し、guard と CLI の両方がこれを呼ぶ。guard の Bash 側の「全対象が同じ近道に当たるときだけ通す」という集合の扱いは guard に残す
  - これは K6 の具体化で、逸脱ではない。spec の `evaluateTarget` の形には近道が無いが、近道を `evaluateTarget` の中に入れると、Bash の集合の扱い（混在なら各対象を gate に問う）を 1 対象ずつの判定で表せなくなるので、外に置く
  - `status <path>` の `<path>` は、これまで wfDir 基準で解決していた（`status plan-1.md` は文書の意味になる）。K6 で「渡されたパスに対する判定」に変えるので、CLI の cwd 基準で解決する。文書側の参照は reference skill の 1 行だけ（`git grep -n "workflow-cli status"` で確認済み）
  - CLI の root は plan-4（K3）まで `deps.cwd`（`process.cwd()`）のまま。plan-4 で `getProjectRoot()` に変わる
- テストの fixture は、two-layer の plan-N.md を作る `buildPlanNContent` を guard のテストから test-helpers に移して、gate と guard のテストで共有する
- 運用上の注意: plan-2〜plan-5 の実装が終わるまで `chezmoi apply` しない（plan-2 と同じ）

## 受け入れるリスク

- realpath の比較にしたので、対象パスの途中にある symlink を辿った先で照合する。`## Files` に symlink 側のパスだけを書いた場合、リンク先のファイルへの書き込みはそのエントリに一致する（同じファイルなので意図どおり）。逆に、symlink 経由で別の場所を指すエントリは、リンク先で比べられる
- `gitdir:` が `<root>/.git/worktrees/` の下を指すかどうかだけで同じリポジトリと判断する。その dir に人が手で `.git` ファイルを書けば偽装できるが、不注意な逸脱を止める脅威モデル（ADR-0013 Consequences 4）では扱わない
- bare リポジトリと submodule の worktree は (a)(b) のどちらにも合致せず root 基準に落ちる。plan-1 と同じく対象外
- T2 で、相対エントリの基準が「ツール cwd」から「対象の checkout（本体なら root）」に変わる。本番で Bash が root のサブディレクトリに `cd` していると、これまでは `<cwd>/src/a.ts` に解決していたエントリが `<root>/src/a.ts` に解決される。`## Files` は repo 相対で書く規約（spec K2）なので、これは修正にあたる。テストでは `getProjectRoot()` とツール cwd がどちらも `CLAUDE_TEST_CWD` を読むので、この差は既存テストに現れない
- CLI の root は plan-4 まで `deps.cwd`。サブディレクトリで `workflow-cli status <path>` を実行すると、guard と違う root で K2 の照合をすることがある。plan-4 で `getProjectRoot()` に揃う

## Files

```
# 編集
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/lib/workflow-files.ts
home/dot_claude/hooks/lib/workflow-fs.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/session.ts
home/dot_claude/hooks/cli/workflow.ts
.skills/document-workflow-reference/SKILL.md

# テスト
home/dot_claude/hooks/tests/unit/test-helpers.ts
home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
home/dot_claude/hooks/tests/unit/workflow-files.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/session.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
```

## Tasks

テストの実行は、リポジトリ（worktree）のルートで `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test <file>`。着手前に `bun run test` の pass 数を控える（plan-2 完了時点で tests 2270 / pass 2254 / fail 0 / skipped 16）。

### T1: gate に `evaluateDocument` / `evaluateTarget` を作り、guard の判定を移す（判定は不変）

**Files:**

- 編集: `H/lib/workflow-gate.ts`（全体。`diagnoseDocument` → `evaluateDocument` に改名して export、`evaluateTarget` などを追加）
- 編集: `H/implementations/document-workflow-guard.ts:3-37`（import と定数）、`:66-79`（`WorkflowState`）、`:117-270`（run 本体の判定）、`:361-549`（移設する関数）、`:1036-1048`（`computePlanHash` / `extractLatestAutoReviewMarker`）
- テスト: `H/tests/unit/test-helpers.ts`（`buildPlanNContent` を追加）、`H/tests/unit/workflow-gate.test.ts`、`H/tests/unit/document-workflow-guard.test.ts:873-898`（ローカルの `buildPlanNContent` を消して import）、`H/tests/unit/session.test.ts:20, :545, :558`（import 元の変更）
- 編集: `H/implementations/session.ts:38-52`（手元の複製の docstring だけ。比較相手が gate に移ったことを書く）
- 参照: `H/tests/unit/document-workflow-guard.test.ts:846-1110`（two-layer の既存テスト。移設後も全件そのまま通ること）

- [ ] **Step 1: fixture を移し、失敗するテストを書く**

test-helpers.ts に、guard のテスト :873-898 の関数を export として移す（中身は同じ。`computePlanHash` は同ファイルの `computeWorkflowRepoPlanHash`）:

````ts
/** A plan-N.md with a `## Files` block, as the two-layer gate reads it. */
export function buildPlanNContent(
  options: WorkflowRepoOptions,
  filesSection: string[],
  parentSpecHash: string,
  omitParentSpecHash = false,
): string {
  const reviewStatus = options.review?.verdict ?? "pending";
  const filesBlock = ["## Files", "", "```", ...filesSection, "```"].join("\n");
  const approval = [
    "## Approval",
    `- Plan Status: ${options.planStatus}`,
    `- Review Status: ${reviewStatus}`,
    `- Approval Status: ${options.approvalStatus}`,
  ].join("\n");
  const baseContent = `${filesBlock}\n\n${approval}`;
  if (!options.review) {
    return baseContent;
  }
  const hash =
    options.review.hashOverride ?? computeWorkflowRepoPlanHash(baseContent);
  const parentField = omitParentSpecHash
    ? ""
    : ` parent-spec-hash=${parentSpecHash};`;
  return `${baseContent}\n\n<!-- auto-review: verdict=${options.review.verdict}; hash=${hash};${parentField} at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`;
}
````

guard のテストはローカル定義を消し、呼び出し（:911-916）を test-helpers の関数に向ける。

workflow-gate.test.ts に追加する:

```ts
import { realpathSync } from "node:fs";
import {
  approvedWorkflowRepo,
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  pendingWorkflowRepo,
} from "./test-helpers.ts";
import { evaluateTarget } from "../../lib/workflow-gate.ts";

/** <repo>/.tmp/sessions/x with research.md, an approved spec.md and plan-1.md listing `files`. */
function twoLayerRepo(files: string[], omitParentSpecHash = false) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-2layer-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  const spec = buildPlanContent(approvedWorkflowRepo());
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      approvedWorkflowRepo(),
      files,
      computeWorkflowRepoPlanHash(spec),
      omitParentSpecHash,
    ),
  );
  return { repo, wf };
}

test("evaluateTarget: inactive without research.md or plan.md", () => {
  const wf = freshWf();
  equal(
    evaluateTarget({ wfDir: wf, target: join(wf, "a.ts"), filesBase: wf }).kind,
    "inactive",
  );
});

test("evaluateTarget: single-layer approved plan allows and names plan.md", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  const e = evaluateTarget({
    wfDir: wf,
    target: "/r/src/a.ts",
    filesBase: "/r",
  });
  equal(e.kind, "allow");
  equal(e.kind === "allow" && e.owner, join(wf, "plan.md"));
});

test("evaluateTarget: an approved plan without research.md still denies", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  equal(
    evaluateTarget({ wfDir: wf, target: "/r/src/a.ts", filesBase: "/r" }).kind,
    "deny",
  );
});

test("evaluateTarget: single-layer pending plan denies with a diagnosis", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  const e = evaluateTarget({
    wfDir: wf,
    target: "/r/src/a.ts",
    filesBase: "/r",
  });
  equal(e.kind, "deny");
  ok(e.kind === "deny" && !e.diagnosis.primary.conditions.approvalStatus.ok);
});

test("evaluateTarget: two-layer allows a listed target and names its plan-N.md", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    filesBase: repo,
  });
  equal(e.kind, "allow");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-1.md"));
});

test("evaluateTarget: two-layer unlisted target is no-plan-owner during implementation", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "b.ts"),
    filesBase: repo,
  });
  equal(e.kind, "no-plan-owner");
  equal(e.kind === "no-plan-owner" && e.implementationPhase, true);
});

test("evaluateTarget: a plan-N.md without parent-spec-hash denies its listed target", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"], true);
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      filesBase: repo,
    }).kind,
    "deny",
  );
});
```

（既存の import 行に足す形でまとめる。`freshWf` は同ファイルの既存関数）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-gate.test.ts`
期待: `evaluateTarget` が export されていないので、ファイル全体が `SyntaxError: The requested module ... does not provide an export named 'evaluateTarget'` で失敗する

- [ ] **Step 3: gate に移設し、guard から呼ぶ**

workflow-gate.ts:

- import に `readFileSync` は既にある。`parseFilesPaths`（`./workflow-files.ts`）と `expandTilde`（`./path-utils.ts`）を足す
- `diagnoseDocument` を `evaluateDocument` に改名して export する（`diagnoseGate` / `hasApprovedDocument` の呼び出しも改名）。`hasApprovedDocument(path)` を `isDocumentApproved(d: DocumentDiagnosis): boolean` に変えて export する（中身は同じ 5 条件の AND と `d.exists`）。`isImplementationPhase` 内の 3 か所は `isDocumentApproved(evaluateDocument(path))` にする
- guard から次を移す（中身は変えない）:

```ts
export interface WorkflowState {
  mode?: string;
  approved?: boolean;
}

export function readWorkflowState(statePath: string): WorkflowState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
  } catch {
    return null;
  }
}

/**
 * A workflow is active once workflow-state.json says so or plan.md /
 * research.md exists. session.ts keeps a local copy for its startup summary
 * (spec K5 of the overhaul); session.test.ts checks the two for drift.
 */
export function isWorkflowActive(
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
  state: WorkflowState | null,
): boolean {
  if (state?.mode === "document-workflow") {
    return true;
  }
  return existsSync(wfPaths.plan) || existsSync(wfPaths.research);
}
```

- 判定の本体を足す:

```ts
export type TargetEvaluation =
  | { kind: "inactive" }
  | { kind: "allow"; owner: string }
  | {
      kind: "no-plan-owner";
      implementationPhase: boolean;
      diagnosis: GateDiagnosis;
    }
  | { kind: "deny"; diagnosis: GateDiagnosis };

export interface TargetQuery {
  wfDir: string;
  /** Absolute path of the file being written. */
  target: string;
  /** Base for relative `## Files` entries (the guard passes its tool cwd). */
  filesBase: string;
  /** The target as the caller shows it in a diagnosis (raw tool input); defaults to `target`. */
  label?: string;
}

/**
 * The gate's decision for one write target, shared by the guard and
 * `workflow-cli status <path>` so the two cannot disagree on a gated
 * target (#209-2). The guard's shortcuts for workflow documents and paths
 * outside the project run before this (classifyExemption, T3).
 * - allow: single-layer plan.md approved, or the plan-N.md listing the
 *   target approved with parent-spec-hash equal to the current spec.md hash.
 * - no-plan-owner: two-layer, spec.md approved, no plan-N.md lists the
 *   target. The guard relaxes it to warn + off-plan log during
 *   implementation phase.
 * - deny: anything else (no research.md, a document not approved, hash
 *   drift, parent-spec-hash missing or stale).
 */
export function evaluateTarget(query: TargetQuery): TargetEvaluation {
  const wfPaths = resolveWorkflowPaths(query.wfDir);
  if (!isWorkflowActive(wfPaths, readWorkflowState(wfPaths.state))) {
    return { kind: "inactive" };
  }
  const deny = (): TargetEvaluation => ({
    kind: "deny",
    diagnosis: diagnoseGate(query.wfDir, query.label ?? query.target),
  });
  if (!existsSync(wfPaths.research)) {
    return deny();
  }
  if (!existsSync(wfPaths.spec)) {
    return isDocumentApproved(evaluateDocument(wfPaths.plan))
      ? { kind: "allow", owner: wfPaths.plan }
      : deny();
  }

  if (!isDocumentApproved(evaluateDocument(wfPaths.spec))) {
    return deny();
  }
  let specHash: string;
  try {
    specHash = computeDocumentHash(
      readFileSync(wfPaths.spec, "utf-8"),
      SPEC_NORMALIZERS,
    );
  } catch {
    return deny();
  }

  for (const planPath of findPlanNumberedFiles(query.wfDir)) {
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      continue;
    }
    const listed = parseFilesPaths(planContent).map((entry) =>
      resolve(query.filesBase, expandTilde(entry)),
    );
    if (!listed.includes(query.target)) {
      continue;
    }
    if (!isDocumentApproved(evaluateDocument(planPath))) {
      return deny();
    }
    // A missing parent-spec-hash is a conservative deny: the plan cannot
    // prove which spec it was approved against.
    const marker = parseLatestAutoReviewMarker(planContent);
    if (
      !marker ||
      marker.parentSpecHash === null ||
      marker.parentSpecHash !== specHash
    ) {
      return deny();
    }
    return { kind: "allow", owner: planPath };
  }

  return {
    kind: "no-plan-owner",
    implementationPhase: isImplementationPhase(query.wfDir, wfPaths, true),
    diagnosis: diagnoseGate(query.wfDir, query.label ?? query.target),
  };
}
```

（`findPlanNumberedFiles` の docstring のうち「guard の private copy から複製した」の段落は、guard 側の複製が消えるので「gate の判定と `isImplementationPhase` が使う plan-N.md の列挙」に書き換える。workflow-bash-sync.ts:235 にも別の複製があるが、本 plan の範囲外なので触らない）

document-workflow-guard.ts:

- run の :117-119 を `isWorkflowActive(wfPaths, readWorkflowState(wfPaths.state))` に替える（gate から import）
- :124-133 のうち `researched`、`denyReasonSingle`、`denyReasonTwoLayer`、`denyReason` を消す。`docLabel` を 1 か所で定義する: `const docLabel = \`${wfDirLabel}/${twoLayer ? "spec.md" : "plan.md"}\`;`
- Bash の判定（:162-220）を次に置き換える（:143-160 の分析と 2 つの近道はそのまま）:

```ts
// Classified as write-like with zero targets means "could not tell
// what it writes", not "writes nothing" (research.md §10.14).
let reasonForThisCall = emptyTargetDenyReason;
if (analysis.targets.length > 0) {
  const evaluations = analysis.targets.map((target) =>
    evaluateTarget({
      wfDir,
      target: resolve(cwd, expandTilde(target)),
      filesBase: cwd,
      label: target,
    }),
  );
  const blockedIndex = evaluations.findIndex(isBlocked);
  if (blockedIndex === -1) {
    evaluations.forEach((evaluation, i) => {
      if (evaluation.kind !== "no-plan-owner") return;
      const target = analysis.targets[i] ?? "";
      console.error(
        `[document-workflow-guard][off-plan] Bash target \`${target}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
      );
      appendOffPlanLog(wfDir, "Bash", target);
    });
    return context.success({});
  }
  const blocked = evaluations[blockedIndex];
  if (blocked && isBlocked(blocked)) {
    reasonForThisCall = formatGateDiagnosis(
      blocked.diagnosis,
      sanitizeForDisplay(analysis.targets[blockedIndex] ?? ""),
      docLabel,
    );
  }
}

if (warnOnly) {
  console.error(`[document-workflow-guard][would-block] Bash: ${command}`);
  return context.success({});
}
return context.json(createDenyResponse(withScratchHint(reasonForThisCall)));
```

- Write / Edit の判定（:236-270）を次に置き換える（:223-234 はそのまま）:

```ts
const evaluation = evaluateTarget({
  wfDir,
  target: resolve(cwd, expandTilde(targetPath)),
  filesBase: cwd,
  label: targetPath,
});
if (evaluation.kind === "allow" || evaluation.kind === "inactive") {
  return context.success({});
}
if (evaluation.kind === "no-plan-owner" && evaluation.implementationPhase) {
  console.error(
    `[document-workflow-guard][off-plan] ${tool_name} target \`${targetPath}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
  );
  appendOffPlanLog(wfDir, tool_name, targetPath);
  return context.success({});
}

if (warnOnly) {
  console.error(
    `[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`,
  );
  return context.success({});
}

return context.json(
  createDenyResponse(
    withScratchHint(
      formatGateDiagnosis(
        evaluation.diagnosis,
        sanitizeForDisplay(targetPath),
        docLabel,
      ),
    ),
  ),
);
```

- ファイル末尾近くに型ガードを足す:

```ts
/** A target the gate does not let through, even under off-plan relaxation. */
function isBlocked(
  evaluation: TargetEvaluation,
): evaluation is Extract<TargetEvaluation, { kind: "deny" | "no-plan-owner" }> {
  return (
    evaluation.kind === "deny" ||
    (evaluation.kind === "no-plan-owner" && !evaluation.implementationPhase)
  );
}
```

- 消すもの: `WorkflowState`（:71-74）、`readWorkflowState`、`isWorkflowActiveForTesting`、`hasApprovedPlan`、`TargetDecision`、`checkTarget`、`isContentApproved`、`findPlanNumberedFiles`、`parseFilesSection`、`computePlanHash`、`extractLatestAutoReviewMarker`、定数 `PLAN_STATUS_REGEX` / `REVIEW_STATUS_REGEX` / `APPROVAL_STATUS_REGEX` / `PLAN_NUMBERED_FILENAME_REGEX`、使われなくなる import と型（`readdirSync`、`readFileSync`（移す関数でしか使っていない）、`type WorkflowPaths`（:303）、`computeDocumentHash` / `SPEC_NORMALIZERS`、`parseFilesPaths`、`workflow-marker` からの 5 つ、`diagnoseGate`）。消した後に `bun run typecheck` と `bun run lint` で未使用が残っていないことを確かめる
- import に `evaluateTarget`、`isWorkflowActive`、`readWorkflowState`、`type TargetEvaluation` を足す

session.test.ts: :20 の import を `import { isWorkflowActive } from "../../lib/workflow-gate.ts";` にし、:545 と :558 の呼び出し名を `isWorkflowActive` にする。

session.ts :38-52 の docstring の第 2 段落を次にする（関数本体は変えない）:

```ts
 * Deliberately a local copy of `isWorkflowActive` in lib/workflow-gate.ts
 * rather than an import: importing it would make the observer depend on the
 * module it exists to observe (spec K5). The copy is kept honest by a drift
 * test (session.test.ts) that runs both against one fixture table.
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて `document-workflow-guard.test.ts` と `session.test.ts` を同じ形で実行し、最後に `bun run test`、`bun run typecheck`、`bun run lint`
期待: workflow-gate.test.ts は既存 5 件 + 新規 7 件 = 12 件 PASS。guard と session のテストは変更前と同じ件数ですべて PASS（guard のテストは fixture の import 元が変わっただけ）。`bun run test` の pass は着手前 + 7、fail 0。typecheck と lint のエラー 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/test-helpers.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts home/dot_claude/hooks/tests/unit/session.test.ts
git commit -m "refactor(hooks): move the gate decision into workflow-gate"
```

### T2: `## Files` の相対エントリを、対象が属する checkout 基準で照合する（K2）

**Files:**

- 編集: `H/lib/workflow-fs.ts:109`（`resolveWithMissingTail` を export する）
- 編集: `H/lib/workflow-files.ts`（`findRepoToplevel` と `listsTarget` を追加）
- 編集: `H/lib/workflow-gate.ts`（`TargetQuery` の `filesBase` を `projectRoot` に替え、照合を `listsTarget` にする）
- 編集: `H/implementations/document-workflow-guard.ts`（T1 で足した `evaluateTarget` の 2 か所の呼び出し）
- テスト: `H/tests/unit/workflow-files.test.ts`、`H/tests/unit/workflow-gate.test.ts`（T1 の新規テストの引数）、`H/tests/unit/document-workflow-guard.test.ts`（two-layer の describe に 1 件）

- [ ] **Step 1: 失敗するテストを書く**

workflow-files.test.ts に追加する。git の構造は fixture で作り、git は呼ばない:

```ts
// Merge into the file's existing imports (one import per module).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoToplevel, listsTarget } from "../../lib/workflow-files.ts";

/**
 * <root>/.git/ (a real git dir), a linked worktree at <root>/.git/worktree/<name>
 * whose .git file points at <root>/.git/worktrees/<name>, as git lays it out.
 */
function repoWithWorktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-files-")));
  return { root, worktree: addWorktree(root, "b") };
}

function addWorktree(root: string, name: string): string {
  mkdirSync(join(root, ".git", "worktrees", name), { recursive: true });
  const worktree = join(root, ".git", "worktree", name);
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(
    join(worktree, ".git"),
    `gitdir: ${join(root, ".git", "worktrees", name)}\n`,
  );
  return worktree;
}

describe("workflow-files: findRepoToplevel (spec K2)", () => {
  it("returns the project root for a file in the main checkout", () => {
    const { root } = repoWithWorktree();
    strictEqual(findRepoToplevel(join(root, "src", "a.ts"), root), root);
  });

  it("returns a linked worktree of the same repository", () => {
    const { root, worktree } = repoWithWorktree();
    strictEqual(
      findRepoToplevel(join(worktree, "src", "a.ts"), root),
      worktree,
    );
  });

  it("accepts a relative gitdir, resolved from the worktree dir", () => {
    const { root, worktree } = repoWithWorktree();
    writeFileSync(join(worktree, ".git"), "gitdir: ../../worktrees/b\n");
    strictEqual(
      findRepoToplevel(join(worktree, "src", "a.ts"), root),
      worktree,
    );
  });

  it("falls back to the root for a nested clone with its own .git dir", () => {
    const { root } = repoWithWorktree();
    mkdirSync(join(root, "vendor", "x", ".git"), { recursive: true });
    strictEqual(
      findRepoToplevel(join(root, "vendor", "x", "src", "a.ts"), root),
      root,
    );
  });

  it("rejects a sibling worktree when the session root is itself a worktree", () => {
    const { root, worktree: b } = repoWithWorktree();
    const c = addWorktree(root, "c");
    // b is the session root. Its .git is a file, so no gitdir can point under
    // <b>/.git/worktrees/; c's gitdir points under <root>/.git/worktrees/.
    strictEqual(findRepoToplevel(join(c, "src", "a.ts"), b), b);
    strictEqual(listsTarget(doc("src/a.ts"), join(c, "src", "a.ts"), b), false);
  });

  it("does not look above the project root", () => {
    const { root } = repoWithWorktree();
    const inner = join(root, "pkg");
    mkdirSync(inner);
    strictEqual(findRepoToplevel(join(inner, "a.ts"), inner), inner);
  });
});

describe("workflow-files: listsTarget (spec K2)", () => {
  const plan = (block: string) => doc(block);

  it("matches a relative entry against the worktree the target lives in", () => {
    const { root, worktree } = repoWithWorktree();
    strictEqual(
      listsTarget(plan("src/a.ts"), join(worktree, "src", "a.ts"), root),
      true,
    );
    strictEqual(
      listsTarget(plan("src/a.ts"), join(root, "src", "a.ts"), root),
      true,
    );
  });

  it("does not match the same relative path in a nested clone", () => {
    const { root } = repoWithWorktree();
    mkdirSync(join(root, "vendor", "x", ".git"), { recursive: true });
    strictEqual(
      listsTarget(
        plan("src/a.ts"),
        join(root, "vendor", "x", "src", "a.ts"),
        root,
      ),
      false,
    );
  });

  it("compares absolute entries by realpath", () => {
    const { root } = repoWithWorktree();
    strictEqual(
      listsTarget(
        plan(join(root, "src", "a.ts")),
        join(root, "src", "a.ts"),
        root,
      ),
      true,
    );
  });
});
```

（`doc` は同ファイルの既存ヘルパー）

guard のテストの two-layer describe（`createTwoLayerRepo` がある describe）に追加する。`existsSync` を `node:fs` の import に足す:

```ts
it("matches a Files entry against the linked worktree the target lives in (spec K2)", async () => {
  const { repo } = createTwoLayerRepo({
    spec: approvedWorkflowRepo(),
    plans: [
      {
        filename: "plan-1.md",
        options: approvedWorkflowRepo(),
        filesSection: ["src/a.ts"],
      },
    ],
  });
  mkdirSync(join(repo, ".git", "worktrees", "b"), { recursive: true });
  const worktree = join(repo, ".git", "worktree", "b");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(
    join(worktree, ".git"),
    `gitdir: ${join(repo, ".git", "worktrees", "b")}\n`,
  );
  envHelper.set("CLAUDE_TEST_CWD", repo);

  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: join(worktree, "src", "a.ts"),
    content: "x",
  });
  await invokeRun(hook, context);
  context.assertSuccess({});
  ok(
    !existsSync(join(repo, TEST_WORKFLOW_DIR, "off-plan-writes.log")),
    "the worktree target was treated as off-plan",
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: workflow-files.test.ts と document-workflow-guard.test.ts を Tasks 冒頭の形で実行
期待: workflow-files.test.ts は `findRepoToplevel` の export が無いのでファイル全体が SyntaxError で失敗。guard の新規 1 件は、`## Files` がツール cwd（= `repo`）基準で `<repo>/src/a.ts` に解決されて一致せず、実装フェーズの緩和で通るが `off-plan-writes.log` が作られて FAIL

- [ ] **Step 3: 最小実装を書く**

workflow-fs.ts: `function resolveWithMissingTail` に `export` を付ける（docstring の前提「絶対パスで `resolve` 済み」はそのまま）。

workflow-files.ts（冒頭の docstring の「guard (which owns the realpath resolution)」を「workflow-gate (which matches entries against a target)」に直す）:

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";
import { resolveWithMissingTail } from "./workflow-fs.ts";

/**
 * The checkout a target belongs to, for resolving relative `## Files`
 * entries (spec K2). Walks up from the target to the first dir holding
 * `.git`, and accepts it only when it is the project root or a linked
 * worktree of the same repository (its `.git` file points under
 * `<root>/.git/worktrees/`, where git keeps worktree metadata -- not
 * `<root>/.git/worktree/`, where this repo's convention puts the checkouts).
 * Anything else -- a nested clone, another repository, a sibling worktree
 * when the session itself started in a worktree -- falls back to the root,
 * so the same relative path elsewhere never matches. Both arguments are
 * realpaths; the walk stops at the root.
 */
export function findRepoToplevel(realTarget: string, realRoot: string): string {
  let dir = realTarget;
  for (;;) {
    if (dir === realRoot) return realRoot;
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      return isWorktreeOf(dir, dotGit, realRoot) ? dir : realRoot;
    }
    const parent = dirname(dir);
    if (parent === dir) return realRoot;
    dir = parent;
  }
}

function isWorktreeOf(dir: string, dotGit: string, realRoot: string): boolean {
  try {
    if (!statSync(dotGit).isFile()) return false;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
    if (!match?.[1]) return false;
    const gitdir = resolveWithMissingTail(resolve(dir, match[1]));
    return gitdir !== null && gitdir.startsWith(`${realRoot}/.git/worktrees/`);
  } catch {
    return false;
  }
}

/**
 * Whether the plan's `## Files` lists the target. Relative entries resolve
 * against the target's checkout (findRepoToplevel); absolute and `~/`
 * entries stand as written. Every side is compared as a realpath so a
 * lexical path is never compared with a physical one (workflow-resolve.ts
 * keeps the same rule). Returns false when the target or the root has no
 * realpath (a dangling symlink on the way).
 */
export function listsTarget(
  planContent: string,
  target: string,
  projectRoot: string,
): boolean {
  const realTarget = resolveWithMissingTail(resolve(target));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realTarget === null || realRoot === null) return false;
  const toplevel = findRepoToplevel(realTarget, realRoot);
  return parseFilesPaths(planContent).some((entry) => {
    const expanded = expandTilde(entry);
    const absolute = expanded.startsWith("/")
      ? resolve(expanded)
      : resolve(toplevel, expanded);
    return resolveWithMissingTail(absolute) === realTarget;
  });
}
```

workflow-gate.ts:

- `TargetQuery` を `{ projectRoot: string; wfDir: string; target: string; label?: string }` にする（`filesBase` を消す。他のフィールドの docstring はそのまま）
- ループ内の `listed` の 3 行と `includes` を `if (!listsTarget(planContent, query.target, query.projectRoot)) { continue; }` にする。`parseFilesPaths` と `expandTilde` の import を消し、`listsTarget` を import する
- 対象の realpath が求まらないときの専用の分岐は足さない（`listsTarget` が false を返し、どの plan にも一致しない）

document-workflow-guard.ts: T1 の 2 か所の `evaluateTarget` 呼び出しの `filesBase: cwd` を `projectRoot` に替える（`target` と `label` はそのまま）。

workflow-gate.test.ts: T1 で足した 7 件の `filesBase: X` を `projectRoot: X` に替える。

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 の 2 ファイルと workflow-gate.test.ts、続けて `bun run test`、`bun run typecheck`、`bun run lint`
期待: workflow-files.test.ts は既存分 + 新規 9 件 PASS。guard の新規 1 件 PASS、既存の two-layer テスト（`file_path: "src/a.ts"`、`CLAUDE_TEST_CWD` が `/var/folders/...` の一時 dir）も全件 PASS（対象とエントリの両方を realpath にするので `/private/var` で一致する）。`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-fs.ts home/dot_claude/hooks/lib/workflow-files.ts home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/workflow-files.test.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "fix(hooks): match plan Files entries against the target's checkout"
```

### T3: `workflow-cli status <path>` が guard と同じ判定を表示する

**Files:**

- 編集: `H/lib/workflow-gate.ts`（`classifyExemption` と `formatTargetEvaluation` を追加）
- 編集: `H/implementations/document-workflow-guard.ts:154-160, :228-234`（2 つの近道を `classifyExemption` に替える）、`:321-359`（`isDocumentPath` / `areAllTargetsDocumentPaths` / `isOutsideProject` / `areAllTargetsOutsideProject` を消す）
- 編集: `H/cli/workflow.ts:221-250`（`cmdStatus`）
- 編集: `.skills/document-workflow-reference/SKILL.md:133`（`status` の説明）
- テスト: `H/tests/unit/workflow-cli.test.ts:1078-1095`（"workflow-cli: status" の describe に追加）
- 参照: `H/tests/unit/document-workflow-guard.test.ts`（文書パスとプロジェクト外の既存テスト。置き換え後もそのまま通ること）

- [ ] **Step 1: 失敗するテストを書く**

```ts
function statusRepo(): { repo: string; wf: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cli-status-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  return { repo, wf };
}

function status(repo: string, wf: string, path: string) {
  return runWorkflowCli(["status", path], {
    cwd: repo,
    wfDir: wf,
    sessionId: "test-ses",
    now: NOW,
  });
}

it("status <path> names plan.md when an approved single-layer plan allows the target", () => {
  const { repo, wf } = statusRepo();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  const r = status(repo, wf, "src/a.ts");
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /src\/a\.ts` is allowed by `plan\.md`/);
});

it("status <path> shows the blocking diagnosis while the plan is pending", () => {
  const { repo, wf } = statusRepo();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  const r = status(repo, wf, "src/a.ts");
  assert.match(r.stdout, /src\/a\.ts` is blocked/);
  assert.match(r.stdout, /✗ Approval Status/);
});

it("status <path> names the owning plan-N.md, or reports an unlisted target, in two-layer mode", () => {
  const { repo, wf } = statusRepo();
  const spec = buildPlanContent(approvedWorkflowRepo());
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      approvedWorkflowRepo(),
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
    ),
  );
  assert.match(
    status(repo, wf, "src/a.ts").stdout,
    /src\/a\.ts` is allowed by `plan-1\.md`/,
  );
  assert.match(
    status(repo, wf, "src/b.ts").stdout,
    /no plan-N\.md lists `.*src\/b\.ts`/,
  );
});

it("status <path> reports the guard's shortcuts as not gated", () => {
  const { repo, wf } = statusRepo();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  assert.match(
    status(repo, wf, join(wf, "notes.md")).stdout,
    /is not gated \(a workflow document\)/,
  );
  assert.match(
    status(repo, wf, "/etc/hosts").stdout,
    /is not gated \(outside the project\)/,
  );
});
```

（`buildPlanContent` / `buildPlanNContent` / `computeWorkflowRepoPlanHash` / `approvedWorkflowRepo` / `pendingWorkflowRepo` を `./test-helpers.ts` から、`mkdirSync` / `mkdtempSync` / `realpathSync` / `writeFileSync` を `node:fs` から、`tmpdir` を `node:os` から、既存の import に足す）

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/workflow-cli.test.ts`
期待: 新規 1・3・4 件目が FAIL（現行は `<path>` を wfDir 基準で解決し、主文書の診断を `is blocked` で始めて出すだけで、許可した文書名も近道も表示しない）。2 件目は変更前でも PASS しうる（負例の固定）

- [ ] **Step 3: 最小実装を書く**

workflow-gate.ts に追加する（`basename` を `node:path` の import に足す）:

```ts
export type Exemption = "workflow-document" | "outside-project";

/**
 * Targets the guard lets through before asking the gate: markdown under the
 * workflow dir is a workflow document, never implementation (it is
 * session-scoped scratch under .tmp/), and paths outside the project are not
 * this workflow's business. `target` is absolute and lexical, compared with
 * the lexical projectRoot / wfDir the hooks resolve.
 */
export function classifyExemption(
  target: string,
  projectRoot: string,
  wfDir: string,
): Exemption | null {
  if (target.startsWith(`${wfDir}/`) && target.endsWith(".md")) {
    return "workflow-document";
  }
  if (!target.startsWith(`${projectRoot}/`) && target !== projectRoot) {
    return "outside-project";
  }
  return null;
}

/** One line (or the full diagnosis) for `workflow-cli status <path>`. */
export function formatTargetEvaluation(
  evaluation: TargetEvaluation,
  targetLabel: string,
  docLabel: string,
): string {
  switch (evaluation.kind) {
    case "inactive":
      return `Document workflow: inactive (no research.md or plan.md in the workflow dir); \`${targetLabel}\` is not gated.`;
    case "allow":
      return `Document workflow gate: \`${targetLabel}\` is allowed by \`${basename(evaluation.owner)}\`.`;
    case "no-plan-owner":
      if (evaluation.implementationPhase) {
        return `Document workflow gate: no plan-N.md lists \`${targetLabel}\`; a write is allowed with a warning and recorded in off-plan-writes.log (implementation phase).`;
      }
      return formatGateDiagnosis(evaluation.diagnosis, targetLabel, docLabel);
    case "deny":
      return formatGateDiagnosis(evaluation.diagnosis, targetLabel, docLabel);
  }
}
```

（`isDocumentPath` の docstring にあった「文書を個別のファイル名で列挙しない理由」と「wfDir の中の `.md` 以外は gate に残す理由」の 2 段落は、`classifyExemption` の docstring の後ろにそのまま移す）

document-workflow-guard.ts:

- run の中、`wfDir` を決めた直後に `const exemptionOf = (path: string) => classifyExemption(resolve(cwd, expandTilde(path)), projectRoot, wfDir);` を置く
- Bash の 2 つの近道（:154-160）を次にする（「全対象が同じ近道に当たるときだけ通す」集合の扱いは変えない）:

```ts
const targetCount = analysis.targets.length;
if (
  targetCount > 0 &&
  analysis.targets.every((t) => exemptionOf(t) === "workflow-document")
) {
  return context.success({});
}
if (
  targetCount > 0 &&
  analysis.targets.every((t) => exemptionOf(t) === "outside-project")
) {
  return context.success({});
}
```

- Write / Edit の 2 つの近道（:228-234）を `if (exemptionOf(targetPath) !== null) { return context.success({}); }` にする
- `isDocumentPath` / `areAllTargetsDocumentPaths` / `isOutsideProject` / `areAllTargetsOutsideProject` を消し、`classifyExemption` を import に足す。guard の :922 付近のコメント「isDocumentPath then allows it」を `classifyExemption` に書き換える（`grep -n isDocumentPath` で実装側に名前が残っていないことを確かめる。テストの describe 名 :1238 / :1268 の `isDocumentPath:` は挙動の説明なので残す）
- 同値性: wfDir は root の下にあるので、文書パスが「プロジェクトの外」に当たることはない。判定の順序と集合の扱いは置き換え前と同じ

cli/workflow.ts の `cmdStatus` の :231-239 を置き換える（`expandTilde` を `../lib/path-utils.ts`、`classifyExemption` / `evaluateTarget` / `formatTargetEvaluation` を `../lib/workflow-gate.ts`、`sanitizeForDisplay` を `../lib/sanitize-display.ts` から import。既にあるものは足さない）:

```ts
const targetArg = positional[0];
const docLabel = twoLayer ? "spec.md" : "plan.md";
const lines: string[] = [];
if (targetArg) {
  // The decision the guard makes for a write to this path (#209-2): its
  // shortcuts first, then the gate. The path is relative to where the CLI
  // runs, like any shell argument.
  const target = resolve(deps.cwd, expandTilde(targetArg));
  const label = sanitizeForDisplay(target);
  const exemption = classifyExemption(target, deps.cwd, wfDir);
  lines.push(
    exemption
      ? `Document workflow gate: \`${label}\` is not gated (${exemption === "workflow-document" ? "a workflow document" : "outside the project"}).`
      : formatTargetEvaluation(
          evaluateTarget({ projectRoot: deps.cwd, wfDir, target }),
          label,
          docLabel,
        ),
  );
} else {
  const primary = twoLayer ? wfPaths.spec : wfPaths.plan;
  lines.push(
    formatGateDiagnosis(diagnoseGate(wfDir, primary), primary, docLabel),
  );
}
```

（続く tripwire の行の追加はそのまま。`lines` の初期化を上に移したので、元の `const lines = [...]` は消す）

SKILL.md :133 を次にする:

```
- `workflow-cli status [<path>] [--wf-dir <dir>]`: 引数なしは主文書（plan.md / spec.md）の gate 診断と tripwire 状態。`<path>` を渡すと、そのファイルへの Write / Edit に guard が下す判定（近道で対象外、許可している文書名、off-plan、止まるなら診断）を表示する。`<path>` は CLI を実行した dir 基準。Bash の書き込みのように対象が複数あるときの集合の扱いは表示しない。
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じ。続けて document-workflow-guard.test.ts、`bun run test`、`bun run typecheck`、`bun run lint`
期待: workflow-cli.test.ts の新規 4 件と既存の status テスト PASS。guard のテストは件数を変えずに全件 PASS。`bun run test` の fail 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/cli/workflow.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts .skills/document-workflow-reference/SKILL.md
git commit -m "feat(workflow-cli): show the guard's decision for a path in status"
```

## ISO 25010 具体テストケース

### 機能適合性（正確性）

- **入力**: 移設前の guard の既存テスト一式（単層・二層・Bash・off-plan） → **期待**: T1 の後も同じ件数ですべて PASS（判定を変えない移設であることの確認）
- **入力**: two-layer、plan-1 の `## Files` に `src/a.ts`、`<repo>/.git/worktree/b/src/a.ts` への Write（`b/.git` が `<repo>/.git/worktrees/b` を指す） → **期待**: allow、`off-plan-writes.log` は作られない（T2）
- **入力**: 同じ plan で `<repo>/vendor/x/src/a.ts`（`vendor/x/.git` はディレクトリ） → **期待**: `listsTarget` は false（T2）
- **入力**: session root が worktree `b` のとき、兄弟 worktree `c` のファイル → **期待**: `findRepoToplevel` は `b` を返し、`c` 基準では照合しない（T2）
- **入力**: `workflow-cli status src/a.ts`（単層、plan.md 承認済み） → **期待**: `` `<repo>/src/a.ts` is allowed by `plan.md` ``（T3）
- **入力**: two-layer で `status src/a.ts`（plan-1 が列挙）と `status src/b.ts`（列挙なし） → **期待**: 前者は `allowed by plan-1.md`、後者は `no plan-N.md lists`（T3）
- **入力**: `status <wfDir>/notes.md` と `status /etc/hosts` → **期待**: どちらも `is not gated`（guard の近道と一致）（T3）

### 性能効率性

- **入力**: K2 の toplevel 探索 → **期待**: git を spawn しない（`workflow-files.ts` が `node:child_process` を import していないことをコードレビューで確認）。探索は対象から root までの祖先の数だけ `existsSync` を呼ぶ

### セキュリティ（完全性）

- **入力**: 対象パスの途中にリンク先の存在しない symlink → **期待**: `listsTarget` は false。two-layer の実装フェーズでは off-plan として `off-plan-writes.log` に記録される（T2。専用の deny は足さない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T1 の判定の同値性は確認。宣言外の表示変更（note が解決後の絶対パスになる）→ `label` で生の入力を保つ。`status <path>` は guard の近道（wfDir の文書、プロジェクト外）を含まず食い違う → T3 で `classifyExemption` を gate に移して共有。兄弟 worktree の fixture が別リポジトリで空振り、gate テストの既存件数（5）、未使用 import（`readFileSync`、`WorkflowPaths`）、T2 の基準変更を受け入れるリスクに記載（いずれも反映済み）

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: リンク先の存在しない symlink の deny は spec に無い → 削除（`listsTarget` が false を返すだけにした）。兄弟 worktree の負例を同じリポジトリの 2 worktree で固定、`status <path>` の two-layer の例を追加、`readWorkflowState` / `isWorkflowActive` の移設理由と戻り値の形の差を明記（いずれも反映済み）

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 循環なし、判定は gate・緩和と表示は guard に分かれる。session.ts の複製の docstring が古くなる → Files に加えて書き換え（反映済み）。fs を使う照合を別モジュールに分ける案は、spec K2 が置き場所を `workflow-files.ts` と定めているので不採用

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: T3 の近道の置き換え（順序、空の対象、Bash の集合の扱い）は同値。各コミットがコンパイルでき、T3 の赤の主張も成り立つ。軽微: guard :922 のコメントに `isDocumentPath` が残る（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: `classifyExemption` の移設は K6 と #209-2（status を事前確認に使えない）に直結し、guard の私有関数 4 つも消える。軽微: K6 の具体化であることを方針に 1 文（反映済み）

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=ae214675fa2bd5bde584e5c390620fb4538d67887cb36b290ea71c4c8a942b80; design-hash=3f60685451b450bf04435c19a1a0c77bb9e62ca9e8f7791d8ec9b505f6163bfa; round=1; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:54:10.440Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer -->

<!-- auto-review: verdict=pass; hash=487dc4fdbf9c07d6f6cc5cb04190bb4c178d9272427ecce300a88906791032a2; design-hash=6d7e91f4ed892f35222f16f48a3409e2b5845802c95e752c515c5289742a4ec6; round=2; parent-spec-hash=4cee4ab13ef4a878444a81b6987973e04ea76a9c5639331cbd13104a470adb56; at=2026-10-02T05:56:17.325Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=14; excluded=0; at=2026-10-02T05:56:17.346Z -->
