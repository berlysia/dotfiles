<!-- spec-ref: spec.md -->

# Plan: plan-N 事前委任の記録と gate (Execution layer)

spec.md の K1 から K5 を実装する。
spec の記述を、この plan で次のように具体化する。

- K2 の `ctx` は「Scope の行」ではなく spec.md の本文を持つ。Scope は使う箇所で解析する。
- K5 の「両方挙げた場合は `approved` を採る」は、T5 の冒頭に書いた規則で実装する。
- K5 の許可の戻り値の `basis` は、`workflow-cli status <path>` の文言にも出す（T5）。委任で通ることを利用者が後から追える、という K7 の趣旨による。
- R3 の「解析できない Bash は現状どおり deny される」は、guard のインタプリタ書き込みの検査を、人間が承認した plan-N があるときだけ外すことで満たす（T5）。
- K7 の `workflow-cli status` の表示のうち、plan-N ごとの印は T6 に入れる。`summarizePlans` が `classifyPlan` を読む変更の一部だからである。「委任が有効か」の行は plan-2 が足す。

plan-2 へ送る論点が 1 つある。
事後検知の tripwire は、実装フェーズに入ると止まる。
委任だけで実装フェーズに入った場合も止まるが、その plan-N を人間は見ていない。
この状態の見せ方は、通知を扱う plan-2 で決める。

この plan の完了時点では、委任を記録する経路（K6 の 2 問目）がまだ無い。
したがって利用者から見た動きは変わらず、gate が委任を読めるようになるだけである。

コードの参照は `home/dot_claude/` からの相対で書く。
`## Files` とコマンドのパスは、リポジトリの直下からの相対で書く。

## Files

```
# 編集
home/dot_claude/hooks/lib/workflow-approval.ts
home/dot_claude/hooks/lib/workflow-files.ts
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/workflow-bash-sync.ts
home/dot_claude/hooks/cli/workflow.ts

# テスト
home/dot_claude/hooks/tests/support/test-helpers.ts
home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
home/dot_claude/hooks/tests/unit/workflow-files.test.ts
home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
```

## Tasks

テストは `node:test` と `node:assert` で書く。
1 ファイルだけ走らせるコマンドは次の形である。以下 `RUN <file>` と略す。

```bash
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/<file>
```

作業は `git-worktree-create feat/plan-delegation` で作った worktree の中で行う。
コミットは各タスクの最後に 1 つ作る。

### T1: 承認記録に `delegate` を足す

**Files:**

- 編集: `hooks/lib/workflow-approval.ts:62-71`、`:135-155`
- テスト: `hooks/tests/unit/workflow-approval.test.ts`
- 参照: `hooks/lib/workflow-approval.ts:96`（`appendApproval` は record をそのまま JSON にする）

- [ ] **Step 1: 失敗するテストを書く**

既存の `describe` の中、`uses only the last line for each document` のテストの後に足す。
`H1`、`H2`、`APPROVALS_LOG` は同ファイルの既存の定数と import を使う。

```ts
it("keeps delegate only when it is the known value", () => {
  const wf = mkdtempSync(join(tmpdir(), "approvals-"));
  appendApproval(wf, {
    doc: "spec.md",
    hash: H1,
    session: "s",
    at: "t1",
    via: "ask",
    delegate: "plans-in-scope",
  });
  assert.equal(
    readLatestApprovals(wf).latest.get("spec.md")?.delegate,
    "plans-in-scope",
  );

  appendFileSync(
    join(wf, APPROVALS_LOG),
    `${JSON.stringify({ v: 1, doc: "spec.md", hash: H1, session: "s", at: "t2", delegate: "everything" })}\n`,
  );
  const r = readLatestApprovals(wf);
  assert.equal(r.latest.get("spec.md")?.delegate, undefined);
  assert.equal(r.latest.get("spec.md")?.at, "t2");
  assert.equal(r.ignoredLines, 0);
});

it("a later line without delegate turns the delegation off", () => {
  const wf = mkdtempSync(join(tmpdir(), "approvals-"));
  appendApproval(wf, {
    doc: "spec.md",
    hash: H1,
    session: "s",
    at: "t1",
    delegate: "plans-in-scope",
  });
  appendApproval(wf, { doc: "spec.md", hash: H1, session: "s", at: "t2" });
  assert.equal(
    readLatestApprovals(wf).latest.get("spec.md")?.delegate,
    undefined,
  );
});
```

`appendFileSync` が未 import なら `node:fs` の import に足す。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-approval.test.ts`
期待: FAIL。型検査を通す前なので、1 つ目のテストが `undefined !== 'plans-in-scope'` で落ちる。

- [ ] **Step 3: 最小実装を書く**

```ts
/** What a spec.md approval hands over. Only spec.md lines carry it. */
export type ApprovalDelegate = "plans-in-scope";

export interface ApprovalRecord {
  doc: string;
  hash: string;
  session: string;
  at: string;
  via?: ApprovalVia;
  delegate?: ApprovalDelegate;
}
```

`parseRecord` の分割代入に `delegate` を足し、`via` の行の次に 1 行足す。

```ts
if (delegate === "plans-in-scope") record.delegate = delegate;
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-approval.test.ts`
期待: PASS。既存の `appends one JSON line per approval` も通る（`delegate` が無い record の出力は変わらない）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-approval.ts home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
git commit -m "feat(hooks): let a spec.md approval record carry a delegation"
```

### T2: `## Scope` を解析する

**Files:**

- 編集: `hooks/lib/workflow-files.ts:20-45`
- テスト: `hooks/tests/unit/workflow-files.test.ts`
- 参照: `hooks/lib/workflow-files.ts:20-45`（`parseFilesPaths`。空白を含むブロックは丸ごと捨てる）

- [ ] **Step 1: 失敗するテストを書く**

ファイル末尾に足す。import に `parseScope` と `MAX_SCOPE_ENTRIES` を足す。

````ts
describe("parseScope", () => {
  const spec = (block: string) =>
    `# Spec\n\n## Scope\n\n\`\`\`\n${block}\n\`\`\`\n\n## Key Decisions\n`;

  it("returns the entries of a valid Scope", () => {
    deepStrictEqual(parseScope(spec("src/\nlib/a.ts")), {
      valid: true,
      entries: ["src/", "lib/a.ts"],
    });
  });

  it("is invalid without a Scope section or with no entry", () => {
    deepStrictEqual(parseScope("# Spec\n\n## Key Decisions\n"), {
      valid: false,
      reason: "empty",
    });
    deepStrictEqual(parseScope(spec("# only a comment")), {
      valid: false,
      reason: "empty",
    });
  });

  it("one bad entry invalidates the whole Scope", () => {
    for (const bad of ["/etc/", "~/x/", "src/../lib/", "./", "/"]) {
      deepStrictEqual(parseScope(spec(`src/\n${bad}`)), {
        valid: false,
        reason: "invalid-entry",
      });
    }
  });

  it("allows MAX_SCOPE_ENTRIES entries and rejects one more", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i}/`).join("\n");
    strictEqual(MAX_SCOPE_ENTRIES, 16);
    strictEqual(parseScope(spec(rows(16))).valid, true);
    deepStrictEqual(parseScope(spec(rows(17))), {
      valid: false,
      reason: "too-many",
    });
  });

  it("does not read ## Files as Scope", () => {
    deepStrictEqual(parseScope("## Files\n\n```\nsrc/a.ts\n```\n"), {
      valid: false,
      reason: "empty",
    });
  });
});
````

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-files.test.ts`
期待: FAIL with "does not provide an export named 'parseScope'"

- [ ] **Step 3: 最小実装を書く**

`parseFilesPaths` の本体を、見出し名を引数に取る非公開の関数へ移す。

````ts
function parseSectionPaths(content: string, heading: string): string[] {
  const sections = content.split(/^##\s+/m);
  const section = sections.find(
    (s) => (s.split("\n")[0] ?? "").trim() === heading,
  );
  if (!section) return [];
  const body = section.slice(section.indexOf("\n") + 1);
  const collected: string[] = [];
  for (const match of body.matchAll(/^```[^\n]*\n([\s\S]*?)\n```/gm)) {
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

export function parseFilesPaths(planContent: string): string[] {
  return parseSectionPaths(planContent, "Files");
}

/** The question from `workflow-cli ask-approval` shows every entry, so the count is capped. */
export const MAX_SCOPE_ENTRIES = 16;

export type ScopeParse =
  | { valid: true; entries: string[] }
  | { valid: false; reason: "empty" | "too-many" | "invalid-entry" };

/**
 * spec.md's `## Scope`: the paths a delegated plan-N.md may write. An entry
 * ending in `/` is a directory, any other entry a file. One entry that could
 * reach outside the checkout invalidates the whole section.
 */
export function parseScope(specContent: string): ScopeParse {
  const entries = parseSectionPaths(specContent, "Scope");
  if (entries.length === 0) return { valid: false, reason: "empty" };
  if (entries.length > MAX_SCOPE_ENTRIES)
    return { valid: false, reason: "too-many" };
  const escapes = (entry: string) =>
    entry.startsWith("/") ||
    entry.startsWith("~") ||
    entry === "./" ||
    entry.split("/").includes("..");
  return entries.some(escapes)
    ? { valid: false, reason: "invalid-entry" }
    : { valid: true, entries };
}
````

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-files.test.ts`
期待: PASS。既存の `parseFilesPaths` の `describe` も全件通る。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-files.ts home/dot_claude/hooks/tests/unit/workflow-files.test.ts
git commit -m "feat(hooks): parse spec.md's Scope section"
```

### T3: 保護対象の判定と Scope の照合

**Files:**

- 編集: `hooks/lib/workflow-files.ts`（T2 の後ろに足す）
- テスト: `hooks/tests/unit/workflow-files.test.ts`
- 参照: `hooks/lib/workflow-files.ts:108-124`（`listsTarget` の解決の手順）
- 参照: `hooks/lib/path-containment.ts:94-116`（`resolveWithMissingTail` が null を返す条件）

- [ ] **Step 1: 失敗するテストを書く**

import に `isProtectedPath`、`planFilesWithinScope`、`targetWithinScope` を足す。
`node:fs` の import に `symlinkSync` を足す。

````ts
describe("isProtectedPath", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-prot-")));
  const file = (rel: string) => isProtectedPath(join(root, rel), root, "file");

  it("classifies file paths by the rules of spec K4", () => {
    const cases: [string, boolean][] = [
      ["docs/decisions/0001-x.md", true],
      ["docs/plans/x.md", false],
      [".skills/foo/SKILL.md", true],
      [".github/workflows/ci.yml", true],
      [".github/CODEOWNERS", false],
      ["home/dot_claude/hooks/lib/a.ts", true],
      ["a/.claude/b.json", true],
      ["HOME/DOT_CLAUDE/x.ts", true],
      ["lib/CLAUDE.md", true],
      ["home/dot_codex/AGENTS.md", true],
      ["CONTEXT.md", true],
      ["templates/context.md.tmpl", true],
      ["src/dot_claude", false],
      ["src/claude.ts", false],
      ["lib2/a.ts", false],
    ];
    for (const [rel, expected] of cases) {
      strictEqual(file(rel), expected, rel);
    }
  });

  it("counts the last segment for a directory entry", () => {
    strictEqual(
      isProtectedPath(join(root, "home/dot_claude"), root, "dir"),
      true,
    );
    strictEqual(isProtectedPath(join(root, "src"), root, "dir"), false);
  });

  it("follows a symlink before judging", () => {
    mkdirSync(join(root, "home", "dot_claude"), { recursive: true });
    symlinkSync(join(root, "home", "dot_claude"), join(root, "home", "x"));
    strictEqual(file("home/x/a.ts"), true);
  });

  it("returns null when the path cannot be resolved", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    strictEqual(file("dangling/a.ts"), null);
  });

  it("returns null, not false, when a symlink leads out of the checkout", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wf-outside-")));
    symlinkSync(outside, join(root, "ext"));
    strictEqual(file("ext/settings.json"), null);
  });

  it("is false for the checkout root itself", () => {
    strictEqual(isProtectedPath(root, root, "dir"), false);
  });
});

describe("planFilesWithinScope", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-scope-")));
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const plan = (block: string) => `## Files\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const verdict = (scope: string, files: string) =>
    planFilesWithinScope(plan(files), spec(scope), root);

  it("accepts files under a directory entry and an exact file entry", () => {
    deepStrictEqual(verdict("src/\nlib/a.ts", "src/x/new.ts\nlib/a.ts"), {
      ok: true,
    });
  });

  it("does not treat lib/ as a prefix of lib2/", () => {
    deepStrictEqual(verdict("lib/", "lib2/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("is case-sensitive for Scope, unlike the protected-path rule", () => {
    deepStrictEqual(verdict("src/", "SRC/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("rejects one file outside the Scope", () => {
    deepStrictEqual(verdict("src/", "src/a.ts\nother/b.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("rejects absolute, ~ and .. entries in Files", () => {
    deepStrictEqual(verdict("src/", `${root}/src/a.ts`), {
      ok: false,
      reason: "outside-scope",
    });
    deepStrictEqual(verdict("src/", "~/src/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
    deepStrictEqual(verdict("src/", "src/sub/../a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("does not delegate a file reached through a symlink that leaves the checkout", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wf-outside-")));
    symlinkSync(outside, join(root, "ext"));
    deepStrictEqual(verdict("ext/", "ext/settings.json"), {
      ok: false,
      reason: "unresolvable",
    });
  });

  it("rejects a protected file even when the Scope covers it", () => {
    deepStrictEqual(verdict("home/", "home/dot_claude/hooks/a.ts"), {
      ok: false,
      reason: "protected",
    });
  });

  it("reports an empty Files section and an invalid Scope", () => {
    deepStrictEqual(planFilesWithinScope("# no files\n", spec("src/"), root), {
      ok: false,
      reason: "no-files",
    });
    deepStrictEqual(verdict("/etc/", "src/a.ts"), {
      ok: false,
      reason: "scope-invalid",
    });
  });

  it("reports a Files entry that cannot be resolved", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    deepStrictEqual(verdict("dangling/", "dangling/a.ts"), {
      ok: false,
      reason: "unresolvable",
    });
  });
});

describe("targetWithinScope", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-target-")));
  const spec = "## Scope\n\n```\nsrc/\nhome/\n```\n";

  it("is true inside the Scope and false outside or under a protected path", () => {
    strictEqual(targetWithinScope(spec, join(root, "src", "b.ts"), root), true);
    strictEqual(
      targetWithinScope(spec, join(root, "other", "c.ts"), root),
      false,
    );
    strictEqual(
      targetWithinScope(spec, join(root, "home", "dot_claude", "x.ts"), root),
      false,
    );
  });

  it("resolves the Scope against the worktree the target lives in", () => {
    const worktree = addWorktree(root, "b");
    strictEqual(
      targetWithinScope(spec, join(worktree, "src", "b.ts"), root),
      true,
    );
  });
});
````

`addWorktree` は同ファイルの既存の関数である。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-files.test.ts`
期待: FAIL with "does not provide an export named 'isProtectedPath'"

- [ ] **Step 3: 最小実装を書く**

```ts
const PROTECTED_LEADING: readonly (readonly string[])[] = [
  ["docs", "decisions"],
  [".skills"],
  [".github", "workflows"],
];
const PROTECTED_DIR_NAMES = new Set([".claude", "dot_claude"]);
const PROTECTED_FILE_NAMES = new Set(["claude.md", "agents.md", "context.md"]);

/**
 * Whether a path is one a delegated plan-N.md may never write: the approval
 * mechanism, the decision records and the instructions the model follows.
 * Judged on the resolved path relative to its checkout, without case, so a
 * symlink or a differently-cased spelling does not get around it. null when
 * the path cannot be resolved; the caller must not treat that as "not
 * protected".
 */
export function isProtectedPath(
  absolute: string,
  projectRoot: string,
  kind: "file" | "dir",
): boolean | null {
  const real = resolveWithMissingTail(resolve(absolute));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (real === null || realRoot === null) return null;
  const toplevel = findRepoToplevel(real, realRoot);
  if (real === toplevel) return false;
  // Resolved out of the checkout (a symlink to somewhere else): the rules
  // below are about paths inside it, so this is "cannot tell", not "no".
  if (!real.startsWith(`${toplevel}/`)) return null;
  const segments = real
    .slice(toplevel.length + 1)
    .toLowerCase()
    .split("/");
  if (
    PROTECTED_LEADING.some((prefix) =>
      prefix.every((s, i) => segments[i] === s),
    )
  ) {
    return true;
  }
  const dirSegments = kind === "dir" ? segments : segments.slice(0, -1);
  if (dirSegments.some((s) => PROTECTED_DIR_NAMES.has(s))) return true;
  if (kind === "dir") return false;
  return PROTECTED_FILE_NAMES.has(
    (segments.at(-1) ?? "").replace(/\.tmpl$/, ""),
  );
}

function scopeContains(
  entries: readonly string[],
  realTarget: string,
  base: string,
): boolean {
  return entries.some((entry) => {
    const real = resolveWithMissingTail(resolve(base, entry));
    if (real === null) return false;
    return entry.endsWith("/")
      ? realTarget.startsWith(`${real}/`)
      : realTarget === real;
  });
}

export type ScopeVerdict =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "scope-invalid"
        | "no-files"
        | "outside-scope"
        | "protected"
        | "unresolvable";
    };

/** Whether every `## Files` entry of a plan-N.md lies within spec.md's `## Scope` and none is protected. */
export function planFilesWithinScope(
  planContent: string,
  specContent: string,
  projectRoot: string,
): ScopeVerdict {
  const scope = parseScope(specContent);
  if (!scope.valid) return { ok: false, reason: "scope-invalid" };
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realRoot === null) return { ok: false, reason: "unresolvable" };
  const files = parseFilesPaths(planContent);
  if (files.length === 0) return { ok: false, reason: "no-files" };
  for (const entry of files) {
    // `resolve` would fold `..` lexically, which is not the path the kernel
    // opens when a component before it is a symlink.
    if (
      entry.startsWith("/") ||
      entry.startsWith("~") ||
      entry.split("/").includes("..")
    ) {
      return { ok: false, reason: "outside-scope" };
    }
    const real = resolveWithMissingTail(resolve(realRoot, entry));
    if (real === null) return { ok: false, reason: "unresolvable" };
    const isProtected = isProtectedPath(real, realRoot, "file");
    if (isProtected === null) return { ok: false, reason: "unresolvable" };
    if (isProtected) return { ok: false, reason: "protected" };
    if (!scopeContains(scope.entries, real, realRoot)) {
      return { ok: false, reason: "outside-scope" };
    }
  }
  return { ok: true };
}

/** Whether one write target lies within spec.md's `## Scope` and is not protected. */
export function targetWithinScope(
  specContent: string,
  target: string,
  projectRoot: string,
): boolean {
  const scope = parseScope(specContent);
  if (!scope.valid) return false;
  const realTarget = resolveWithMissingTail(resolve(target));
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realTarget === null || realRoot === null) return false;
  if (isProtectedPath(realTarget, realRoot, "file") !== false) return false;
  return scopeContains(
    scope.entries,
    realTarget,
    findRepoToplevel(realTarget, realRoot),
  );
}
```

plan-N の Files は、セッションのプロジェクトルートを基準に解決する。
worktree でも相対パスの構造は同じなので、包含の結果は変わらない。
書き込み対象（`targetWithinScope`）は、`listsTarget` と同じく対象の属する checkout を基準にする。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-files.test.ts`
期待: PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-files.ts home/dot_claude/hooks/tests/unit/workflow-files.test.ts
git commit -m "feat(hooks): judge protected paths and Scope containment"
```

### T4: `resolveSpecContext` と `classifyPlan`

**Files:**

- 編集: `hooks/lib/workflow-gate.ts`（`parentSpecMatches` の後ろ、`:255` の次に足す）
- 編集: `hooks/tests/support/test-helpers.ts:631-698`
- テスト: `hooks/tests/unit/workflow-gate.test.ts`
- 参照: `hooks/lib/workflow-gate.ts:511-522`（`documentConditionRows` の名前と順序）
- 参照: `hooks/lib/workflow-gate.ts:537-568`（`summarizePlans` の現在の `blockedBy` の決め方）

- [ ] **Step 1: 失敗するテストを書く**

まず `test-helpers.ts` に足す。`buildPlanContent` の後ろに置く。

````ts
/** A spec.md body with a `## Scope` section, in the shape `buildPlanContent` produces. */
export function buildSpecWithScope(
  options: WorkflowRepoOptions,
  scope: string[],
): string {
  const reviewStatus = options.review?.verdict ?? "pending";
  const scopeBlock = ["## Scope", "", "```", ...scope, "```"].join("\n");
  const approval = [
    "## Approval",
    `- Plan Status: ${options.planStatus}`,
    `- Review Status: ${reviewStatus}`,
    `- Approval Status: ${options.approvalStatus}`,
  ].join("\n");
  const base = `${scopeBlock}\n\n${approval}`;
  if (!options.review) return base;
  const hash = options.review.hashOverride ?? computeWorkflowRepoPlanHash(base);
  return `${base}\n\n<!-- auto-review: verdict=${options.review.verdict}; hash=${hash}; at=2026-02-19T00:00:00.000Z; reviewers=logic-validator -->`;
}
````

`recordApprovalsForTest`（`:682-698`）を、次の関数で丸ごと置き換える。
変わるのは第 2 引数と、`appendApproval` に渡す `delegate` だけである。
承認行が `approved` でない文書は記録しないので、`delegateSpec` が効くのは spec.md が承認済みのときだけである。

```ts
export function recordApprovalsForTest(
  wfDir: string,
  options: { delegateSpec?: boolean } = {},
): void {
  for (const name of readdirSync(wfDir)) {
    if (
      name !== "spec.md" &&
      name !== "plan.md" &&
      !/^plan-[0-9]+\.md$/.test(name)
    )
      continue;
    const content = readFileSync(join(wfDir, name), "utf-8");
    if (!STRICT_APPROVAL_STATUS.test(content)) continue;
    appendApproval(wfDir, {
      doc: name,
      hash: computeWorkflowRepoPlanHash(content),
      session: TEST_SESSION_ID,
      at: "2026-10-02T00:00:00.000Z",
      ...(options.delegateSpec && name === "spec.md"
        ? { delegate: "plans-in-scope" as const }
        : {}),
    });
  }
}
```

次に `workflow-gate.test.ts` に足す。
import に `classifyPlan`、`resolveSpecContext`、`buildSpecWithScope` を足す。

```ts
interface DelegPlan {
  name: string;
  files: string[];
  approved?: boolean;
}

function delegatedRepo(
  scope: string[],
  plans: DelegPlan[],
  options: { delegate?: boolean } = {},
) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-deleg-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  const spec = buildSpecWithScope(approvedWorkflowRepo(), scope);
  writeFileSync(join(wf, "spec.md"), spec);
  for (const plan of plans) {
    const base = approvedWorkflowRepo();
    writeFileSync(
      join(wf, plan.name),
      buildPlanNContent(
        plan.approved ? base : { ...base, approvalStatus: "pending" },
        plan.files,
        computeWorkflowRepoPlanHash(spec),
      ),
    );
  }
  recordApprovalsForTest(wf, { delegateSpec: options.delegate ?? true });
  return { repo, wf };
}

test("classifyPlan: a reviewed plan within the Scope is delegated", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const ctx = resolveSpecContext(wf, repo);
  equal(ctx.delegation !== null, true);
  equal(classifyPlan(join(wf, "plan-1.md"), ctx).kind, "delegated");
});

test("classifyPlan: without the delegate flag the plan waits for approval", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    {
      delegate: false,
    },
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind, "blocked");
  equal(c.kind === "blocked" && c.blockedBy, "Approval Status");
});

test("classifyPlan: a human-approved plan is approved, with or without delegation", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["other/a.ts"], approved: true }],
  );
  equal(
    classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo)).kind,
    "approved",
  );
});

test("classifyPlan: outside the Scope or on a protected path falls back to approval", () => {
  const { repo, wf } = delegatedRepo(
    ["src/", "home/"],
    [
      { name: "plan-1.md", files: ["other/a.ts"] },
      { name: "plan-2.md", files: ["home/dot_claude/x.ts"] },
    ],
  );
  const ctx = resolveSpecContext(wf, repo);
  const c1 = classifyPlan(join(wf, "plan-1.md"), ctx);
  const c2 = classifyPlan(join(wf, "plan-2.md"), ctx);
  equal(
    c1.kind === "blocked" && c1.blockedBy,
    "Approval Status (delegation: outside-scope)",
  );
  equal(
    c2.kind === "blocked" && c2.blockedBy,
    "Approval Status (delegation: protected)",
  );
});

test("classifyPlan: a plan that has not passed review is never delegated", () => {
  const { repo, wf } = delegatedRepo(["src/"], []);
  const spec = readFileSync(join(wf, "spec.md"), "utf-8");
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      pendingWorkflowRepo(),
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
    ),
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind, "blocked");
  ok(c.kind === "blocked" && !c.blockedBy.startsWith("Approval"));
});

test("resolveSpecContext: delegation is off when the spec.md approval line is pending", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const specPath = join(wf, "spec.md");
  writeFileSync(
    specPath,
    readFileSync(specPath, "utf-8").replace(
      "- Approval Status: approved",
      "- Approval Status: pending",
    ),
  );
  equal(resolveSpecContext(wf, repo).delegation, null);
});

test("resolveSpecContext: delegation is off once the spec.md body changes", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const specPath = join(wf, "spec.md");
  writeFileSync(
    specPath,
    readFileSync(specPath, "utf-8").replace("src/", "src/\nlib/"),
  );
  const ctx = resolveSpecContext(wf, repo);
  equal(ctx.delegation, null);
  const c = classifyPlan(join(wf, "plan-1.md"), ctx);
  equal(c.kind === "blocked" && c.blockedBy, "Approval Status");
});

test("resolveSpecContext: delegation is off when approvals.log cannot be read", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  unlinkSync(join(wf, "approvals.log"));
  mkdirSync(join(wf, "approvals.log"));
  equal(resolveSpecContext(wf, repo).delegation, null);
});

test("classifyPlan: a plan without parent-spec-hash is not delegated", () => {
  const { repo, wf } = delegatedRepo(["src/"], []);
  const spec = readFileSync(join(wf, "spec.md"), "utf-8");
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
      true,
    ),
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind === "blocked" && c.blockedBy, "parent-spec-hash");
});

test("resolveSpecContext: delegation is off when the Scope is invalid or the root is unknown", () => {
  const { repo, wf } = delegatedRepo(
    ["/etc/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  equal(resolveSpecContext(wf, repo).delegation, null);
  const valid = delegatedRepo(["src/"], []);
  equal(resolveSpecContext(valid.wf, undefined).delegation, null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-gate.test.ts`
期待: FAIL with "does not provide an export named 'classifyPlan'"

- [ ] **Step 3: 最小実装を書く**

`workflow-files.ts` からの import を `listsTarget, parseScope, planFilesWithinScope` にする。

```ts
export interface SpecContext {
  /** null when spec.md cannot be read. */
  specHash: string | null;
  specContent: string;
  /** Present when the user's approval of the current spec.md delegates its plan-N.md. */
  delegation: { projectRoot: string } | null;
}

/**
 * Read spec.md once for every plan-N.md decision. Delegation holds only while
 * spec.md itself clears the gate, so reverting its Approval line turns it off
 * even though the ledger line stays.
 */
export function resolveSpecContext(
  wfDir: string,
  projectRoot: string | undefined,
): SpecContext {
  const specPath = resolveWorkflowPaths(wfDir).spec;
  let specContent: string;
  try {
    specContent = readFileSync(specPath, "utf-8");
  } catch {
    return { specHash: null, specContent: "", delegation: null };
  }
  const specHash = computeDocumentHash(specContent, SPEC_NORMALIZERS);
  const ledger = readLatestApprovals(wfDir);
  const delegated =
    !ledger.readError &&
    ledger.latest.get(basename(specPath))?.delegate === "plans-in-scope" &&
    isDocumentApproved(evaluateDocument(specPath)) &&
    parseScope(specContent).valid;
  return {
    specHash,
    specContent,
    delegation: delegated && projectRoot !== undefined ? { projectRoot } : null,
  };
}

export type PlanClass =
  | { kind: "approved" }
  | { kind: "delegated"; planHash: string }
  | { kind: "blocked"; blockedBy: string };

const APPROVAL_ROWS = new Set(["Approval Status", "approval"]);

/**
 * The one place that decides whether a plan-N.md clears: approved by the
 * user, cleared by the spec's delegation, or blocked by its first unmet
 * condition. Callers check spec.md's own approval separately.
 */
export function classifyPlan(planPath: string, ctx: SpecContext): PlanClass {
  const diagnosis = evaluateDocument(planPath);
  let content = "";
  try {
    content = readFileSync(planPath, "utf-8");
  } catch {
    content = "";
  }
  const parentOk =
    ctx.specHash !== null && parentSpecMatches(content, ctx.specHash);
  const rows = documentConditionRows(diagnosis);
  const unmet = rows.find(([, condition]) => !condition.ok);
  if (!unmet) {
    return parentOk
      ? { kind: "approved" }
      : { kind: "blocked", blockedBy: "parent-spec-hash" };
  }
  if (ctx.delegation === null || !diagnosis.exists) {
    return { kind: "blocked", blockedBy: unmet[0] };
  }
  const unmetReview = rows.find(
    ([name, condition]) => !APPROVAL_ROWS.has(name) && !condition.ok,
  );
  if (unmetReview) return { kind: "blocked", blockedBy: unmetReview[0] };
  if (!parentOk) return { kind: "blocked", blockedBy: "parent-spec-hash" };
  const verdict = planFilesWithinScope(
    content,
    ctx.specContent,
    ctx.delegation.projectRoot,
  );
  if (!verdict.ok) {
    return {
      kind: "blocked",
      blockedBy: `${unmet[0]} (delegation: ${verdict.reason})`,
    };
  }
  return {
    kind: "delegated",
    planHash: computeDocumentHash(content, SPEC_NORMALIZERS),
  };
}
```

`documentConditionRows` は関数宣言なので、定義より前から呼べる。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-gate.test.ts`
期待: PASS。既存のテストは変えていないので全件通る。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/tests/support/test-helpers.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
git commit -m "feat(hooks): classify a plan-N.md as approved, delegated or blocked"
```

### T5: 書き込みの判定と実装フェーズの判定を `classifyPlan` に寄せる

**Files:**

- 編集: `hooks/lib/workflow-gate.ts:289-328`、`:361-368`、`:394-451`、`:490-507`
- 編集: `hooks/implementations/document-workflow-guard.ts:227`、`:327-330`、`:395-403`
- 編集: `hooks/implementations/workflow-bash-sync.ts:121`
- テスト: `hooks/tests/unit/workflow-gate.test.ts`、`hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `hooks/lib/workflow-gate.ts:425-444`（現在は、対象を挙げる最初の plan-N だけで許可か deny を決める）

`workflow-bash-sync.ts` の変更は引数の追加だけである。
既存のテスト（`workflow-bash-sync.test.ts`）は変えず、回帰の確認として実行する。
`relaxable` の値は gate のテストで確かめ、guard を通した挙動は guard のテスト 1 件で確かめる。

現在の挙動を保つため、対象を挙げる最初の plan-N で結果を決める規則は変えない。
例外は 1 つで、最初の plan-N が `delegated` のときだけ、後ろに `approved` の plan-N があればそちらを採る。
これは spec K5 の「両方挙げた場合は `approved` を採る」の具体化である。
結果は次の表になる。

| 対象を挙げる plan-N の並び                | 結果                           |
| ----------------------------------------- | ------------------------------ |
| `approved` が最初                         | 許可（`approved`）。現在と同じ |
| `blocked` が最初                          | deny。後ろは見ない。現在と同じ |
| `delegated` が最初、後ろに `approved`     | 許可（`approved`）             |
| `delegated` が最初、後ろは `blocked` だけ | 許可（`delegated`）            |

4 行目は、委任で通る plan-N が対象を挙げていれば、通らない別の plan-N が同じ対象を挙げていても許可する、という意味である。

guard の Bash 経路（`:264-296`）も `no-plan-owner` を読む。
この経路は `isBlocked` を通った評価だけを警告に回すので、`isBlocked` の変更で足りる。
コードは変えず、`RUN document-workflow-guard.test.ts` で確かめる。

- [ ] **Step 1: 失敗するテストを書く**

`workflow-gate.test.ts` に足す。import に `implementationPhaseBasis` と `formatTargetEvaluation` を足す。

```ts
test("evaluateTarget: a delegated plan allows its listed target and says so", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  equal(e.kind, "allow");
  ok(e.kind === "allow" && e.basis === "delegated");
  ok(
    e.kind === "allow" && e.basis === "delegated" && e.planName === "plan-1.md",
  );
  ok(
    e.kind === "allow" &&
      e.basis === "delegated" &&
      /^[0-9a-f]{64}$/.test(e.planHash),
  );
  ok(
    e.kind === "allow" &&
      e.basis === "delegated" &&
      /^[0-9a-f]{64}$/.test(e.specHash),
  );
});

test("evaluateTarget: without delegation the same plan denies", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    {
      delegate: false,
    },
  );
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("evaluateTarget: a human-approved plan allows with basis approved", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "approved");
});

test("evaluateTarget: an approved plan wins over a delegated one for the same target", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["src/a.ts"], approved: true },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "approved");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-2.md"));
});

test("evaluateTarget: a delegated first plan allows even when a later plan listing the target is blocked", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/x.ts", "src/a.ts"] },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "delegated");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-1.md"));
});

test("formatTargetEvaluation: says when a write clears by delegation", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  match(
    formatTargetEvaluation(e, "src/a.ts", "spec.md"),
    /allowed by `plan-1\.md` through the spec's delegation/,
  );
  const approved = twoLayerRepo(["src/a.ts"]);
  const a = evaluateTarget({
    wfDir: approved.wf,
    target: join(approved.repo, "src", "a.ts"),
    projectRoot: approved.repo,
  });
  ok(!/delegation/.test(formatTargetEvaluation(a, "src/a.ts", "spec.md")));
});

test("evaluateTarget: a blocked first plan still denies, as before", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["other/x.ts", "src/a.ts"] },
      { name: "plan-2.md", files: ["src/a.ts"], approved: true },
    ],
  );
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("off-plan under delegation only: relaxed inside the Scope, denied outside", () => {
  const { repo, wf } = delegatedRepo(
    ["src/", "home/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const at = (rel: string) =>
    evaluateTarget({ wfDir: wf, target: join(repo, rel), projectRoot: repo });
  const inside = at("src/b.ts");
  const outside = at("other/c.ts");
  const protectedPath = at("home/dot_claude/x.ts");
  ok(
    inside.kind === "no-plan-owner" &&
      inside.implementationPhase &&
      inside.relaxable,
  );
  ok(
    outside.kind === "no-plan-owner" &&
      outside.implementationPhase &&
      !outside.relaxable,
  );
  ok(protectedPath.kind === "no-plan-owner" && !protectedPath.relaxable);
  ok(
    outside.kind === "no-plan-owner" &&
      /## Scope/.test(outside.diagnosis.note ?? ""),
  );
});

test("off-plan with a human-approved plan: relaxed everywhere, as before", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["lib/z.ts"], approved: true },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "other", "c.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "no-plan-owner" && e.relaxable);
});

test("implementationPhaseBasis: none, delegated-only, approved", () => {
  const basisOf = (r: { repo: string; wf: string }) =>
    implementationPhaseBasis(r.wf, resolveWorkflowPaths(r.wf), true, r.repo);
  equal(
    basisOf(
      delegatedRepo(["src/"], [{ name: "plan-1.md", files: ["src/a.ts"] }], {
        delegate: false,
      }),
    ),
    "none",
  );
  equal(
    basisOf(
      delegatedRepo(["src/"], [{ name: "plan-1.md", files: ["src/a.ts"] }]),
    ),
    "delegated-only",
  );
  equal(
    basisOf(
      delegatedRepo(
        ["src/"],
        [
          { name: "plan-1.md", files: ["src/a.ts"] },
          { name: "plan-2.md", files: ["lib/z.ts"], approved: true },
        ],
      ),
    ),
    "approved",
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-gate.test.ts`
期待: FAIL with "does not provide an export named 'implementationPhaseBasis'"

- [ ] **Step 3: 最小実装を書く**

`TargetEvaluation` を次の形にする。

```ts
export type TargetEvaluation =
  | { kind: "inactive" }
  | { kind: "allow"; owner: string; basis: "approved" }
  | {
      kind: "allow";
      owner: string;
      /** Cleared by the spec's delegation, not by the user's approval of this plan. */
      basis: "delegated";
      planName: string;
      planHash: string;
      specHash: string;
    }
  | {
      kind: "no-plan-owner";
      implementationPhase: boolean;
      /** Whether the guard may let the write through with a warning. */
      relaxable: boolean;
      diagnosis: GateDiagnosis;
    }
  | { kind: "deny"; diagnosis: GateDiagnosis };
```

`isImplementationPhase` を次の 2 関数に置き換える。

```ts
export type PhaseBasis = "none" | "approved" | "delegated-only";

/** What the implementation phase rests on: a plan the user approved, or only delegated ones. */
export function implementationPhaseBasis(
  wfDir: string,
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
  twoLayer: boolean,
  projectRoot: string,
  /** Pass the context already resolved for this decision so spec.md is read once. */
  ctx: SpecContext = resolveSpecContext(wfDir, projectRoot),
): PhaseBasis {
  if (!researchExists(wfPaths)) return "none";
  if (!twoLayer) {
    return isDocumentApproved(evaluateDocument(wfPaths.plan))
      ? "approved"
      : "none";
  }
  if (!isDocumentApproved(evaluateDocument(wfPaths.spec))) return "none";
  let delegated = false;
  for (const planPath of findPlanNumberedFiles(wfDir)) {
    const { kind } = classifyPlan(planPath, ctx);
    if (kind === "approved") return "approved";
    if (kind === "delegated") delegated = true;
  }
  return delegated ? "delegated-only" : "none";
}

export function isImplementationPhase(
  wfDir: string,
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
  twoLayer: boolean,
  projectRoot: string,
): boolean {
  return (
    implementationPhaseBasis(wfDir, wfPaths, twoLayer, projectRoot) !== "none"
  );
}
```

既存の doc コメントは `isImplementationPhase` に残す。

`evaluateTarget` は、単層の許可に `basis: "approved"` を足す。
spec.md の承認を確かめた後（現在の `:415` 以降）を次の形にする。

```ts
const ctx = resolveSpecContext(query.wfDir, query.projectRoot);
if (ctx.specHash === null) {
  return deny();
}

let delegatedOwner: { path: string; planHash: string } | undefined;
for (const planPath of findPlanNumberedFiles(query.wfDir)) {
  let planContent: string;
  try {
    planContent = readFileSync(planPath, "utf-8");
  } catch {
    continue;
  }
  if (!listsTarget(planContent, query.target, query.projectRoot)) {
    continue;
  }
  const planClass = classifyPlan(planPath, ctx);
  if (planClass.kind === "approved") {
    return { kind: "allow", owner: planPath, basis: "approved" };
  }
  if (planClass.kind === "blocked") {
    // The first plan listing the target decides, as before. A blocked
    // plan after a delegated one is passed over while looking for a plan
    // the user approved.
    if (delegatedOwner === undefined) return deny();
    continue;
  }
  delegatedOwner ??= { path: planPath, planHash: planClass.planHash };
}
if (delegatedOwner !== undefined) {
  return {
    kind: "allow",
    owner: delegatedOwner.path,
    basis: "delegated",
    planName: basename(delegatedOwner.path),
    planHash: delegatedOwner.planHash,
    specHash: ctx.specHash,
  };
}

const basis = implementationPhaseBasis(
  query.wfDir,
  wfPaths,
  true,
  query.projectRoot,
  ctx,
);
const relaxable =
  basis === "approved" ||
  (basis === "delegated-only" &&
    targetWithinScope(ctx.specContent, query.target, query.projectRoot));
const diagnosis = diagnoseGate(query.wfDir, query.label ?? query.target);
if (basis === "delegated-only" && !relaxable) {
  diagnosis.note = `Only delegated plan-N.md files are in effect, and \`${sanitizeForDisplay(query.label ?? query.target)}\` is outside spec.md's ## Scope or under a protected path. List it in a plan-N.md and have the user approve that plan.`;
}
return {
  kind: "no-plan-owner",
  implementationPhase: basis !== "none",
  relaxable,
  diagnosis,
};
```

`workflow-files.ts` からの import に `targetWithinScope` を足す。

`formatTargetEvaluation` の `no-plan-owner` の分岐も変える。
条件を `evaluation.implementationPhase` から `evaluation.relaxable` にする。
`allow` の分岐は、委任で通る場合にそう分かる文にする。

```ts
    case "allow":
      return evaluation.basis === "delegated"
        ? `Document workflow gate: \`${targetLabel}\` is allowed by \`${basename(evaluation.owner)}\` through the spec's delegation (the user has not approved this plan itself).`
        : `Document workflow gate: \`${targetLabel}\` is allowed by \`${basename(evaluation.owner)}\`.`;
```

guard は次の 3 か所を変える。
`workflow-gate.ts` からの import は、`isImplementationPhase` を `implementationPhaseBasis` に替える。
`:227` の `gateClosed` は、インタプリタ経由の書き込みの検査を残すかどうかを決める値である。
この検査は、人間が承認した plan-N があるときだけ外す。
委任だけで実装フェーズに入った場合は残す。
spec の R3 が「解析できない Bash は現状どおり deny される」としているためである。

```ts
// :227
// The interpreter-write check opens only on a plan the user approved: an
// inline script's targets are not matched against the Scope or the protected
// paths, so delegation alone must not lift it.
const gateClosed =
  implementationPhaseBasis(wfDir, wfPaths, twoLayer, projectRoot) !== "approved";

// :327-330
if (evaluation.kind === "no-plan-owner" && evaluation.relaxable) {

// :395-403 isBlocked
return (
  evaluation.kind === "deny" ||
  (evaluation.kind === "no-plan-owner" && !evaluation.relaxable)
);
```

`workflow-bash-sync.ts:121` は第 4 引数に `projectRoot` を足す（同ファイルの `:95` で得ている）。

`document-workflow-guard.test.ts` に、guard を通したテストを 1 つ足す。
`still checks an interpreter heredoc body before plan approval (F3b)` のテスト（`:1369-1377`）の後に置く。
`hook`、`envHelper`、`createPreToolUseContextFor`、`invokeRun`、`TEST_WORKFLOW_DIR` は、その `describe` で使える既存のものである。
`test-helpers.ts` からの import に `buildSpecWithScope` を足す。
`computePlanHash` は同ファイルが `computeWorkflowRepoPlanHash` に付けている既存の別名である。

```ts
it("keeps the interpreter-write check while only delegated plans are in effect", async () => {
  const repo = mkdtempSync(join(tmpdir(), "document-workflow-guard-deleg-"));
  const wf = join(repo, TEST_WORKFLOW_DIR);
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "research");
  const spec = buildSpecWithScope(approvedWorkflowRepo(), ["src/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["src/a.ts"],
      computePlanHash(spec),
    ),
  );
  recordApprovalsForTest(wf, { delegateSpec: true });
  envHelper.set("CLAUDE_TEST_CWD", repo);

  const write = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/a.ts",
    content: "const a = 1;",
  });
  await invokeRun(hook, write);
  write.assertSuccess({});

  const offPlanOutside = createPreToolUseContextFor(hook, "Write", {
    file_path: "other/c.ts",
    content: "const c = 1;",
  });
  await invokeRun(hook, offPlanOutside);
  offPlanOutside.assertDeny();

  const interpreter = createPreToolUseContextFor(hook, "Bash", {
    command: `python3 - <<'EOF'\nopen('src/a.ts', 'w').write('x')\nEOF`,
  });
  await invokeRun(hook, interpreter);
  interpreter.assertDeny();
});
```

このテストは Step 1 で書き、Step 2 では 1 つ目の `assertSuccess` で落ちる（委任をまだ読まないため）。

既存のテストは `workflow-gate.test.ts` の 3 か所を直す。

```ts
// :429 単層。projectRoot は使われないので wfDir を渡す
isImplementationPhase(single, resolveWorkflowPaths(single), false, single),

// :433-436 二層。twoLayerRepo の repo を受け取って渡す
const { repo, wf } = twoLayerRepo(["src/a.ts"]);
equal(isImplementationPhase(wf, resolveWorkflowPaths(wf), true, repo), true);
unlinkSync(join(wf, "research.md"));
equal(isImplementationPhase(wf, resolveWorkflowPaths(wf), true, repo), false);

// :271 の次の行に足す
equal(e.kind === "no-plan-owner" && e.relaxable, true);

// :509 guard の isBlocked と同じ条件にする
(e.kind === "no-plan-owner" && !e.relaxable);
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-gate.test.ts`、`RUN document-workflow-guard.test.ts`、`RUN workflow-bash-sync.test.ts`、`RUN workflow-cli.test.ts`、`bun run typecheck`
期待: 5 つとも PASS（typecheck はエラー 0 件）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/implementations/workflow-bash-sync.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): let a delegated plan-N.md clear the write gate within the spec's Scope"
```

### T6: 表示と承認候補を `classifyPlan` に寄せる

**Files:**

- 編集: `hooks/lib/workflow-gate.ts:175-223`、`:524-568`、`:666-677`
- 編集: `hooks/cli/workflow.ts:371`、`:379-383`、`:960`
- テスト: `hooks/tests/unit/workflow-gate.test.ts`、`workflow-cli.test.ts`
- 参照: `hooks/lib/workflow-approval-record.ts:236`（`listApprovalCandidates` の呼び出し元）
- 参照: `hooks/implementations/approval-recorder.ts:106`（同上）

`listApprovalCandidates`、`summarizePlans`、`diagnoseGate` には、省略できる引数 `projectRoot` を足す。
省略した呼び出しは、委任を考慮しない現在の結果を返す。
`workflow-approval-record.ts:236` と `approval-recorder.ts:106` は、この plan では変えない。
前者は plan-2 が 2 問形式へ作り直す箇所で、そのときに引数を渡す。
後者は利用者の発話の経路で、委任で通る plan-N を利用者が名指しで承認しても、その plan-N が `approved` になるだけである。

- [ ] **Step 1: 失敗するテストを書く**

`workflow-gate.test.ts` に足す。import に `summarizePlans` を足す。

```ts
test("summarizePlans: marks a delegated plan and keeps blockedBy for the rest", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/b.ts"] },
      { name: "plan-3.md", files: ["lib/c.ts"], approved: true },
    ],
  );
  const byName = new Map(summarizePlans(wf, repo).map((p) => [p.name, p]));
  equal(byName.get("plan-1.md")?.via, "delegation");
  equal(byName.get("plan-1.md")?.blockedBy, undefined);
  equal(
    byName.get("plan-2.md")?.blockedBy,
    "Approval Status (delegation: outside-scope)",
  );
  equal(byName.get("plan-3.md")?.via, undefined);
  equal(byName.get("plan-3.md")?.blockedBy, undefined);
});

test("summarizePlans: without a project root it reports as before", () => {
  const { wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  equal(summarizePlans(wf)[0]?.blockedBy, "Approval Status");
});

test("listApprovalCandidates: a delegated plan is not asked about", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/b.ts"] },
    ],
  );
  equal(listApprovalCandidates(wf, repo).join(","), "plan-2.md");
  equal(listApprovalCandidates(wf).join(","), "plan-1.md,plan-2.md");
});

test("diagnoseGate: under delegation it does not tell the user to approve each plan", () => {
  const on = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const off = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    { delegate: false },
  );
  const delegated = diagnoseGate(on.wf, "x", on.repo);
  match(delegated.note ?? "", /delegates its plan-N\.md/);
  ok(!/must also be/.test(delegated.note ?? ""));
  ok(!/approve plan-N\.md/.test(delegated.nextAction));
  match(delegated.nextAction, /workflow-cli status/);

  for (const d of [
    diagnoseGate(off.wf, "x", off.repo),
    diagnoseGate(on.wf, "x"),
  ]) {
    match(d.note ?? "", /must also be/);
    match(d.nextAction, /approve plan-N\.md/);
  }
});
```

`workflow-cli.test.ts` には、`status without a target lists each plan-N.md ...` のテスト（`:1234-1268`）の後に 1 つ足す。
`statusRepo`、`NOW`、各ヘルパーは同ファイルの既存のものを使う。
import に `buildSpecWithScope` を足す。

```ts
it("status marks a plan-N.md that clears by delegation", () => {
  const { repo, wf } = statusRepo();
  const spec = buildSpecWithScope(approvedWorkflowRepo(), ["src/"]);
  const specHash = computeWorkflowRepoPlanHash(spec);
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["src/a.ts"],
      specHash,
    ),
  );
  writeFileSync(
    join(wf, "plan-2.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["other/b.ts"],
      specHash,
    ),
  );
  recordApprovalsForTest(wf, { delegateSpec: true });
  const r = runWorkflowCli(["status"], {
    cwd: repo,
    wfDir: wf,
    sessionId: "test-ses",
    wfDirSource: "derived",
    now: NOW,
  });
  const planLines = r.stdout
    .split("\n")
    .filter((line) => line.startsWith("plan: "));
  assert.deepEqual(planLines, [
    "plan: plan-1.md ✓ (delegated)",
    "plan: plan-2.md ✗ Approval Status (delegation: outside-scope)",
  ]);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-gate.test.ts`
期待: FAIL。`summarizePlans` の 1 つ目のテストが `undefined !== 'delegation'` で落ちる。

- [ ] **Step 3: 最小実装を書く**

```ts
export interface PlanSummary {
  /** `plan-N.md`. */
  name: string;
  /** The first condition the plan does not meet; absent when it clears. */
  blockedBy?: string;
  /** Present when the plan clears by the spec's delegation rather than its own approval. */
  via?: "delegation";
}

export function summarizePlans(
  wfDir: string,
  projectRoot?: string,
): PlanSummary[] {
  const ctx = resolveSpecContext(wfDir, projectRoot);
  const planNumber = (path: string) =>
    Number(/([0-9]+)\.md$/.exec(path)?.[1] ?? 0);
  return findPlanNumberedFiles(wfDir)
    .sort((a, b) => planNumber(a) - planNumber(b))
    .map((planPath): PlanSummary => {
      const name = basename(planPath);
      const planClass = classifyPlan(planPath, ctx);
      if (planClass.kind === "blocked")
        return { name, blockedBy: planClass.blockedBy };
      return planClass.kind === "delegated"
        ? { name, via: "delegation" }
        : { name };
    });
}
```

`listApprovalCandidates` は引数を足し、フィルタに条件を 1 つ足す。

```ts
export function listApprovalCandidates(
  wfDir: string,
  projectRoot?: string,
): string[] {
  const names = ["spec.md", "plan.md"].filter((name) =>
    existsSync(resolve(wfDir, name)),
  );
  const planNumbered = findPlanNumberedFiles(wfDir).map((path) =>
    basename(path),
  );
  const ctx = resolveSpecContext(wfDir, projectRoot);
  return [...names, ...planNumbered].filter((name) => {
    const r = evaluateApprovalReadiness(wfDir, name);
    if (!r.ready || r.alreadyApproved) return false;
    return !(
      PLAN_NUMBERED_FILENAME_REGEX.test(name) &&
      classifyPlan(resolve(wfDir, name), ctx).kind === "delegated"
    );
  });
}
```

`diagnoseGate` は第 3 引数 `projectRoot?: string` を足す。
委任が有効なときは、plan-N の個別承認を求める文を、委任の条件を述べる文に置き換える。
`specOk` を求めた直後に次を足す。

```ts
const delegating =
  specOk && resolveSpecContext(wfDir, projectRoot).delegation !== null;
```

`note` を作る分岐（`:191-193`）を次の形にする。
委任が無いときの文は、現在の `:192` の文と 1 文字も変えない。

```ts
if (specOk && hasResearch) {
  note = delegating
    ? `spec.md is approved and delegates its plan-N.md. The plan-N.md whose ## Files section lists \`${sanitizeForDisplay(targetPath)}\` clears without its own approval once it is complete + Review Status: pass, its marker's parent-spec-hash equals the current spec.md hash, and every ## Files entry lies within spec.md's ## Scope and touches no protected path. A plan-N.md that does not meet this needs the user's approval.`
    : `spec.md is approved. The plan-N.md whose ## Files section lists \`${sanitizeForDisplay(targetPath)}\` must also be complete + Review Status: pass + approved by the user, either by choosing it in the question from \`workflow-cli ask-approval\` or by saying \`approve plan-N.md\` in the conversation (approvals.log then records its current hash), with an auto-review marker whose parent-spec-hash equals the current spec.md hash.`;
}
```

`nextAction` の `else if (specOk)` の分岐（`:215-217`）も同じ条件で分ける。
委任が無いときの文は、現在の `:217` の文と 1 文字も変えない。

```ts
  } else if (specOk) {
    nextAction = delegating
      ? "`workflow-cli status` で各 plan-N.md の状態を見る。`✓ (delegated)` は委任で通っている。`✗` はその行が示す条件を満たす。委任の条件から外れる plan-N.md は、`workflow-cli ask-approval` で利用者の承認を得る。"
      : "`workflow-cli ask-approval` で承認の質問を出すか、会話で `approve plan-N.md`（対象を列挙している plan）と打つ。`workflow-cli status <path>` で、どの plan が対象を列挙しているかと、足りない条件を確かめる。";
```

`evaluateTarget` の中の `diagnoseGate` の 2 つの呼び出しには、第 3 引数に `query.projectRoot` を渡す。

`cli/workflow.ts` は次の 3 か所を変える。

```ts
// :371
const diagnosis = diagnoseGate(wfDir, primary, deps.cwd);

// :379-383
for (const plan of summarizePlans(wfDir, deps.cwd)) {
  const mark = plan.blockedBy
    ? `✗ ${plan.blockedBy}`
    : plan.via === "delegation"
      ? "✓ (delegated)"
      : "✓";
  lines.push(`plan: ${plan.name} ${mark}`);
}

// :960
const ready = listApprovalCandidates(wfDir, deps.cwd).flatMap((name) => {
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-gate.test.ts`、`RUN workflow-cli.test.ts`、`bun run typecheck`
期待: 3 つとも PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/cli/workflow.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
git commit -m "feat(hooks): show delegated plans in status and leave them out of the approval question"
```

### T7: 全体の検査

**Files:**

- 参照: リポジトリ直下の `package.json` の `scripts`（`test`、`typecheck`、`lint`）

- [ ] **Step 1: 整形してから、全テスト、型検査、lint を実行する**

実行: `bun run format`、`bun run test`、`bun run typecheck`、`bun run lint`
期待: 4 つとも終了コード 0。`bun run format` が書き換えたファイルがあれば、T6 までのコミットとは別に `style(hooks): format` として 1 つコミットする。

`tsconfig` はテストのディレクトリを型検査の対象から外している。
テストとヘルパーの型は `bun run typecheck` では確かめられないので、テストの実行結果で確かめる。

- [ ] **Step 2: 未使用の export が無いことを確かめる**

実行: `bunx knip`
期待: 他のファイルの実装から使う export（`parseScope`、`planFilesWithinScope`、`targetWithinScope`、`implementationPhaseBasis`、`isImplementationPhase`）は、未使用として報告されない。

次の 4 つは、実装からの利用が同じファイルの中だけである: `MAX_SCOPE_ENTRIES`、`isProtectedPath`、`resolveSpecContext`、`classifyPlan`。
knip がテストからの import を利用に数えるかは、実行するまで分からない。
knip がこの 4 つを未使用と報告した場合は、export を残し、報告された名前を完了報告に書く。
`MAX_SCOPE_ENTRIES` と `isProtectedPath` は plan-2 の質問の生成が使う。
`resolveSpecContext` と `classifyPlan` は plan-2 の記録側が使う。
この 4 つ以外が報告された場合は、その export を使う箇所の書き漏れなので、該当タスクの Step 3 と突き合わせて直す。

## ISO 25010 具体テストケース

### セキュリティ

- **入力**: 委任ありの spec、Scope は `src/`、未承認の plan-1 の Files は `src/a.ts`。spec.md の承認行を `pending` に書き換える → **期待**: `resolveSpecContext(...).delegation` が `null`（T4）
- **入力**: Scope は `home/`、plan-N の Files は `home/dot_claude/hooks/a.ts` → **期待**: `planFilesWithinScope` が `{ ok: false, reason: "protected" }`（T3）
- **入力**: `home/x` が `home/dot_claude` への symlink、対象は `home/x/a.ts` → **期待**: `isProtectedPath` が `true`（T3）
- **入力**: 対象は `HOME/DOT_CLAUDE/x.ts` → **期待**: `isProtectedPath` が `true`（T3）
- **入力**: 委任だけで実装フェーズに入った状態で、どの plan にも無い `other/c.ts` へ書く → **期待**: `evaluateTarget` が `no-plan-owner` で `relaxable` は `false`（T5）
- **入力**: `approvals.log` の spec.md の行が `delegate: "everything"` → **期待**: `readLatestApprovals` の `delegate` が `undefined`（T1）
- **入力**: 委任だけで実装フェーズに入った状態で、Bash の `python3 - <<'EOF'` が `src/a.ts` に書く → **期待**: guard が deny する（T5）

### 機能適合性

- **入力**: 委任あり、Scope は `src/`、未承認でレビュー済みの plan-1 の Files は `src/a.ts`、対象は `src/a.ts` → **期待**: `allow`、`basis` は `delegated`、`planName` は `plan-1.md`（T5）
- **入力**: 同じ構成で `delegate` なし → **期待**: `deny`（T5）
- **入力**: 委任ありで承認済みの spec.md の Scope に 1 行足す（本文の hash が変わる） → **期待**: `delegation` が `null`、plan-1 は `blocked` で `blockedBy` は `Approval Status`（T4）
- **入力**: `src/a.ts` を、委任で通る plan-1 と、Scope 外の Files を含む未承認の plan-2 が挙げる → **期待**: `allow`、`basis` は `delegated`、`owner` は plan-1.md（T5）
- **入力**: Files の行が `src/sub/../a.ts` → **期待**: `{ ok: false, reason: "outside-scope" }`（T3）
- **入力**: `src/a.ts` を、委任で通る plan-1 と人間が承認した plan-2 の両方が挙げる → **期待**: `allow`、`basis` は `approved`、`owner` は plan-2.md（T5）
- **入力**: Scope の行が 16 行 → **期待**: `parseScope` が `valid: true`。17 行 → **期待**: `{ valid: false, reason: "too-many" }`（T2）
- **入力**: Scope は `lib/`、Files は `lib2/a.ts` → **期待**: `{ ok: false, reason: "outside-scope" }`（T3）

### 信頼性

- **入力**: Scope に `/etc/` の行がある spec、`delegate` あり → **期待**: `delegation` が `null`（T4）
- **入力**: `approvals.log` が dir で読めない → **期待**: `delegation` が `null`（T4）
- **入力**: `parent-spec-hash` の無い marker を持つ plan-N、委任あり → **期待**: `classifyPlan` が `blocked`、`blockedBy` は `parent-spec-hash`（T4）
- **入力**: repo 内の `ext` が repo 外の dir への symlink、対象は `ext/settings.json` → **期待**: `isProtectedPath` が `null`、`planFilesWithinScope` が `unresolvable`（T3）
- **入力**: Files の行が、先の無い symlink の下を指す → **期待**: `{ ok: false, reason: "unresolvable" }`（T3）
- **入力**: レビューを通っていない plan-N（Review Status が `pending`）、委任あり → **期待**: `classifyPlan` が `blocked` で、`blockedBy` は `Approval` で始まらない（T4）
- **入力**: `projectRoot` を渡さない `resolveSpecContext` → **期待**: `delegation` が `null`（T4）

### 使用性

- **入力**: 委任で通る plan-1 がある wfDir で `workflow-cli status` → **期待**: 出力に `plan: plan-1.md ✓ (delegated)` の行がある（T6）
- **入力**: Scope 外で委任が効かない plan-2 → **期待**: `summarizePlans` の `blockedBy` が `Approval Status (delegation: outside-scope)`（T6）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 書かれたテストは書かれた実装で通る。`isProtectedPath` が checkout の外へ解決されたパスを「保護対象でない」と返すので、repo 内の symlink 経由で外の dir が委任で通る。`diagnoseGate` が委任の plan-N にも個別承認を案内し続ける。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: spec が挙げたテスト観点（spec の改訂後、`approvals.log` が読めない、`parent-spec-hash` が無い）が無い。`evaluateTarget` の規則が spec K5 の文言より細かいのに、その具体化が明記されていない。コマンドが bun と合わない。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: 依存方向と `classifyPlan` への一本化は成立。guard の Bash 経路の読み手が変更箇所に無い。`formatTargetEvaluation` の許可の文言が委任を示さない。1 回の判定で spec を複数回読む。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の 6 点は解消。追加・変更したテストを手で追い、書かれた実装で落ちるものは無い。`implementationPhaseBasis` の既定引数は単層でも spec.md を読もうとするが、例外にはならない。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 5 点は解消し、spec に無い変更は入っていない。`formatTargetEvaluation` の文言の根拠を具体化の一覧に足す。knip の期待が 2 通り書かれていて揺れる。

### architecture-boundary-analyzer

- verdict: needs-work
- 主指摘: guard のインタプリタ書き込みの検査は `!isImplementationPhase` で外れる。委任だけの実装フェーズでも外れ、Scope とも保護対象とも照合されない書き込みが通る。人間が承認した plan-N があるときだけ外す。

<!-- auto-review: verdict=needs-work; hash=07835e9123fa6d97a721f36eb57765ba341b4985c3ad4aaece111687cd44e1e8; design-hash=a988359940e2b82acab436335a2fe78d4807e379a2d79c98de87d539f6489d54; round=1; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T04:34:03.518Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: `gateClosed` が真のとき、インタプリタ heredoc は既存テストと同じ経路で deny になる。人間が承認した plan-N があるときの挙動は変わらない。追加した guard のテストが使う名前は、置く `describe` で使える。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: Round 2 の指摘は解消。実装フェーズの判定を読む実装コードは 7 か所で、plan が扱っていない緩和は無い。tripwire だけが委任でも止まり、plan-2 へ送る論点として明記済み。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=191e37e5cd79f2fe363fddbbe7975b15eb8b6d7de13340a8b2f2c887706b5624; design-hash=0a0b80a7206993830b13c815db7f3e3710128d7cbf5748ceba551b1c4927a41a; round=2; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T04:38:31.079Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer -->

<!-- auto-review: verdict=pass; hash=392dab3ce0661f58432512fd0c8558dcdae96336a39517cd2f2818106e5ec8e2; design-hash=43f3c054d6882484d88434d78a30102a4c8bf397301b4032e4eae25596b952bb; round=3; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T04:40:13.394Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer -->
<!-- intent-triage: adopted=21; excluded=0; at=2026-10-06T04:40:13.412Z -->
