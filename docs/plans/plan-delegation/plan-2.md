<!-- spec-ref: spec.md -->

# Plan: plan-N 事前委任の質問と通知 (Execution layer)

spec.md の K6 と K7 を実装する。
plan-1 で gate は委任を読めるようになった。
この plan で、委任を記録する経路（承認の質問の 2 問目）と、委任で通した書き込みの通知を足す。
この plan の完了で、利用者は spec の承認時に委任を選べるようになる。

コードの参照は `home/dot_claude/` からの相対で書く。
行番号は plan-1 の実装後（ブランチ `feat/plan-delegation` の `0a78a6b`）の位置である。
`## Files` とコマンドのパスは、リポジトリの直下からの相対で書く。

## spec との関係

spec の記述を、この plan で次のように具体化する。

- K6 の質問の生成は `hooks/lib/workflow-approval.ts` に置く。このファイルは node の組み込みだけに依存する（同ファイル `:13-14`）。保護対象の判定は呼び出し側が済ませ、行の一覧を引数で渡す。
- K6 の「生成側と記録側は同じ判定を呼ぶ」は、gate の `resolveDelegationOffer` を CLI と記録側の両方が呼ぶことで満たす。
- K7 の `delegation-uses.log` へのツールでの書き込みの deny は、Write / Edit / MultiEdit を対象にする。Bash は `approvals.log` と同じく対象外である（ADR-0023 が受容した限界）。

spec より厳しくする点が 3 つある。
どちらも、レビューで見つかった穴を塞ぐためである。
spec.md の本文は変えず、plan-3 が書く ADR-0028 に最終の内容を記録する。

- **Scope の行の文字、長さ、形を制限する**（K3 への追加）。行は ASCII の英数字と `._/@+-` だけで書き、1 行 120 文字までとする。`/` で区切った要素に、空の要素と `.` だけの要素を持たせない（`.//`、`./src/`、`a//b/` は無効）。これらは解決するとリポジトリの直下や別の dir を指し、見た目と範囲が食い違う。違反が 1 行でもあれば Scope 全体を無効とする。K6 の説明文は Scope の行をそのまま並べるので、ゼロ幅の文字や長大な行があると、利用者が範囲を読み違える。この制限に合わないパスを含む spec は、委任を使えず個別承認になる。
- **Scope の行は symlink を経由しないものに限る**（K3 への追加）。行を解決した結果が、行をそのまま連結したパスと違う場合、その行はどの対象にも当たらない。symlink を指す行は、リポジトリの直下や別の dir を覆える。承認の後で、Scope の中の dir を symlink に差し替える経路も、同じ条件で閉じる。
- **保護対象に `.git` と `.tmp/sessions` を足す**（K4 への追加）。Scope が workflow dir を覆うと、委任だけの実装フェーズで `approvals.log` や `delegation-uses.log` を Bash で書ける。`.git` は hook と設定を持つ。

spec に無い決定が 2 つある。
承認者に判断を求める点である。

- **委任だけの実装フェーズでは tripwire を動かし、Scope の内側で保護対象でない変更を報告から外す**（T7）。plan-1 が「見せ方は plan-2 で決める」と送った論点への答えである。比べた案は次の 3 つである。

| 案                                 | 結果                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| 止めたままにする（現状）           | guard を通らない書き込みを、人間が見ていない plan-N の実行中に誰も見ない |
| 動かし、Scope で絞らない           | 委任された正当な書き込みが Bash のたびに報告され、報告が読まれなくなる   |
| 動かし、Scope の内側を外す（採用） | 委任の範囲を超えた変更だけが報告される                                   |

採用案は、guard が委任だけのときインタプリタ書き込みの検査を残す（plan-1 の T5）のと同じ考え方である。人間が承認した plan-N がある場合は、現在どおり tripwire を止める。

- **Scope の内側で、どの plan-N にも無いファイルへの書き込みも、委任だけの実装フェーズでは利用者に知らせる**（T6）。この書き込みは off-plan の緩和で通り、現在は誰にも届かない標準エラーに出るだけである。K7 は「委任で通した書き込みを利用者が後から追える」ことを求めており、その対象に含める。知らせるのは、ファイルと spec の版の組ごとに 1 回である。書き込みのたびに出すと、T7 で退けた案と同じく読まれなくなる。

plan-3 は、上の 5 点（Scope の行の文字・長さ・形の制限、symlink を経由する行の除外、保護対象の追加、tripwire、off-plan の通知）を ADR-0028 に記録する。
spec.md は 7 日で消える場所にあり、spec の K3 と K4 の文言との違いを残せるのは ADR だけである。

## Files

```
# 編集
home/dot_claude/hooks/lib/workflow-approval.ts
home/dot_claude/hooks/lib/workflow-approval-record.ts
home/dot_claude/hooks/lib/workflow-files.ts
home/dot_claude/hooks/lib/workflow-gate.ts
home/dot_claude/hooks/lib/workflow-audit-log.ts
home/dot_claude/hooks/implementations/approval-answer-recorder.ts
home/dot_claude/hooks/implementations/approval-recorder.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts
home/dot_claude/hooks/implementations/workflow-bash-sync.ts
home/dot_claude/hooks/cli/workflow.ts

# テスト
home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
home/dot_claude/hooks/tests/unit/workflow-approval-record.test.ts
home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts
home/dot_claude/hooks/tests/unit/approval-recorder.test.ts
home/dot_claude/hooks/tests/unit/workflow-files.test.ts
home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
home/dot_claude/hooks/tests/unit/workflow-audit-log.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
```

## Tasks

テストは `node:test` と `node:assert` で書く。
1 ファイルだけ走らせるコマンドは次の形である。以下 `RUN <file>` と略す。

```bash
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/<file>
```

作業は plan-1 と同じ worktree（ブランチ `feat/plan-delegation`）で行う。
コミットは各タスクの最後に 1 つ作る。
ファイルの編集は Edit / Write で行い、Bash の `sed -i` や `cat >>` でソースを書き換えない。

### T1: Scope の行を絞り、委任の問いに出す行を求める

**Files:**

- 編集: `hooks/lib/workflow-files.ts:65-77`（`parseScope`）、`:158-162`（`PROTECTED_LEADING`）、`:206-218`（`scopeContains`）、末尾（`targetWithinScope` の後ろ）
- 編集: `hooks/lib/workflow-gate.ts`（`resolveSpecContext` の後ろに足す）
- テスト: `hooks/tests/unit/workflow-files.test.ts`、`hooks/tests/unit/workflow-gate.test.ts`
- 参照: `hooks/lib/workflow-files.ts` の `isProtectedPath`（`kind` が `"dir"` のとき最後の要素も見る）

- [ ] **Step 1: 失敗するテストを書く**

`workflow-files.test.ts` の `describe("parseScope", ...)` の中に足す。
`spec` はその `describe` の既存の関数である。

```ts
it("rejects entries with characters or lengths that could mislead the question", () => {
  const bad = [
    "src/​hidden/",
    "src/‮txt.exe",
    "ドキュメント/",
    "a,b/",
    "src/（委任の対象外）",
    `${"a".repeat(120)}/`,
  ];
  for (const entry of bad) {
    deepStrictEqual(parseScope(spec(`src/\n${entry}`)), {
      valid: false,
      reason: "invalid-entry",
    });
  }
  strictEqual(parseScope(spec(`${"a".repeat(119)}/`)).valid, true);
  strictEqual(parseScope(spec("pkg/@scope/a+b_c-d.e/")).valid, true);
});

it("rejects entries whose segments are empty or a lone dot", () => {
  for (const entry of [
    ".//",
    "././",
    "./src/",
    "src/./a/",
    "src//a/",
    ".",
    "src/.",
  ]) {
    deepStrictEqual(parseScope(spec(`lib/\n${entry}`)), {
      valid: false,
      reason: "invalid-entry",
    });
  }
  strictEqual(parseScope(spec(".config/\nsrc/.env.example\na.b/")).valid, true);
});
```

`describe("isProtectedPath", ...)` の中に足す。
`file` はその `describe` の既存の関数である。

```ts
it("protects the repository's own state and the workflow dirs", () => {
  strictEqual(file(".git/config"), true);
  strictEqual(file(".git/hooks/pre-commit"), true);
  strictEqual(file(".tmp/sessions/abcd1234/approvals.log"), true);
  strictEqual(file(".tmp/sessions/abcd1234/delegation-uses.log"), true);
  strictEqual(file(".tmp/docs/note.md"), false);
  strictEqual(file("src/.gitkeep"), false);
});
```

ファイルの末尾に足す。import に `scopeRowsForOffer` を足す。

```ts
describe("Scope entries that pass through a symlink", () => {
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const plan = (block: string) => `## Files\n\n\`\`\`\n${block}\n\`\`\`\n`;

  it("a link to the checkout root is not a Scope", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-link-")));
    mkdirSync(join(root, "src"));
    symlinkSync(root, join(root, "link"));
    deepStrictEqual(
      planFilesWithinScope(plan("link/src/a.ts"), spec("link/"), root),
      { ok: false, reason: "outside-scope" },
    );
    strictEqual(
      targetWithinScope(spec("link/"), join(root, "src", "a.ts"), root),
      false,
    );
    deepStrictEqual(scopeRowsForOffer(spec("src/\nlink/"), root), [
      { entry: "src/", protected: false },
      { entry: "link/", protected: true },
    ]);
  });

  it("an entry swapped for a symlink after approval stops matching", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-swap-")));
    mkdirSync(join(root, "src"));
    const scope = spec("src/gen/");
    strictEqual(
      targetWithinScope(scope, join(root, "src", "gen", "a.ts"), root),
      true,
    );
    symlinkSync(root, join(root, "src", "gen"));
    strictEqual(
      targetWithinScope(scope, join(root, "other", "x.ts"), root),
      false,
    );
    strictEqual(
      targetWithinScope(scope, join(root, "src", "gen", "a.ts"), root),
      false,
    );
  });
});

describe("scopeRowsForOffer", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-offer-")));
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;

  it("marks protected rows and keeps the order", () => {
    deepStrictEqual(
      scopeRowsForOffer(
        spec("src/\nhome/dot_claude/\nCONTEXT.md\nlib/a.ts"),
        root,
      ),
      [
        { entry: "src/", protected: false },
        { entry: "home/dot_claude/", protected: true },
        { entry: "CONTEXT.md", protected: true },
        { entry: "lib/a.ts", protected: false },
      ],
    );
  });

  it("is null when every row is protected or the Scope is invalid", () => {
    strictEqual(
      scopeRowsForOffer(spec("docs/decisions/\n.skills/"), root),
      null,
    );
    strictEqual(scopeRowsForOffer(spec(".tmp/sessions/"), root), null);
    strictEqual(scopeRowsForOffer(spec("/etc/"), root), null);
    strictEqual(scopeRowsForOffer("# no scope\n", root), null);
  });

  it("treats a row that cannot be resolved as protected", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    deepStrictEqual(scopeRowsForOffer(spec("src/\ndangling/"), root), [
      { entry: "src/", protected: false },
      { entry: "dangling/", protected: true },
    ]);
  });
});
```

`workflow-gate.test.ts` に足す。import に `resolveDelegationOffer` を足す。

```ts
test("resolveDelegationOffer: the rows of the current spec.md, or null without one", () => {
  const { repo, wf } = delegatedRepo(["src/", "home/dot_claude/"], []);
  equal(
    JSON.stringify(resolveDelegationOffer(wf, repo)),
    JSON.stringify([
      { entry: "src/", protected: false },
      { entry: "home/dot_claude/", protected: true },
    ]),
  );
  equal(resolveDelegationOffer(freshWf(), repo), null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-files.test.ts`
期待: FAIL with "does not provide an export named 'scopeRowsForOffer'"

- [ ] **Step 3: 最小実装を書く**

`MAX_SCOPE_ENTRIES` の定義の次に定数を 2 つ足す。

```ts
// The question from `workflow-cli ask-approval` shows each entry as written,
// so an entry may only use characters and a length that read unambiguously.
const SCOPE_ENTRY_PATTERN = /^[A-Za-z0-9._/@+-]+$/;
const MAX_SCOPE_ENTRY_LENGTH = 120;
```

`parseScope`（`:65-77`）の最後の部分を置き換える。

```ts
// 置き換え前
const escapes = (entry: string) =>
  entry.startsWith("/") ||
  entry.startsWith("~") ||
  entry === "./" ||
  entry.split("/").includes("..");
return entries.some(escapes)
  ? { valid: false, reason: "invalid-entry" }
  : { valid: true, entries };
// 置き換え後
const unsafe = (entry: string) => {
  if (entry.length > MAX_SCOPE_ENTRY_LENGTH) return true;
  if (!SCOPE_ENTRY_PATTERN.test(entry)) return true;
  // A directory entry ends in "/", which leaves one trailing empty
  // segment; every other segment must name something.
  const segments = entry.split("/");
  const named = entry.endsWith("/") ? segments.slice(0, -1) : segments;
  return (
    named.length === 0 || named.some((s) => s === "" || s === "." || s === "..")
  );
};
return entries.some(unsafe)
  ? { valid: false, reason: "invalid-entry" }
  : { valid: true, entries };
```

これまで個別に見ていた 4 つの形は、新しい検査に含まれる。
`/` で始まる行は最初の要素が空になる。`./` は要素が `.` になる。`..` を含む行は要素の検査に当たる。
`~` は `SCOPE_ENTRY_PATTERN` に無い。

`PROTECTED_LEADING`（`:158-162`）に 2 行足す。

```ts
const PROTECTED_LEADING: readonly (readonly string[])[] = [
  ["docs", "decisions"],
  [".skills"],
  [".github", "workflows"],
  [".git"],
  [".tmp", "sessions"],
];
```

`scopeContains`（`:206-218`）を、次の 2 つの関数で置き換える。

```ts
/**
 * A Scope entry's path, when no component of it is a symlink. A link could
 * point the entry at the checkout root or another directory, and a directory
 * inside the Scope could be swapped for one after the approval; either way
 * the entry would cover more than the user was shown. `base` is a realpath.
 */
function resolveScopeEntry(base: string, entry: string): string | null {
  const lexical = resolve(base, entry);
  return resolveWithMissingTail(lexical) === lexical ? lexical : null;
}

function scopeContains(
  entries: readonly string[],
  realTarget: string,
  base: string,
): boolean {
  return entries.some((entry) => {
    const real = resolveScopeEntry(base, entry);
    if (real === null) return false;
    return entry.endsWith("/")
      ? realTarget.startsWith(`${real}/`)
      : realTarget === real;
  });
}
```

`scopeContains` の 2 つの呼び出し元は、どちらも realpath を `base` に渡している（`planFilesWithinScope` は `realRoot`、`targetWithinScope` は `findRepoToplevel` の結果）。

`targetWithinScope` の後ろに足す。

```ts
export interface ScopeRow {
  entry: string;
  /** Delegation never covers this row (or it could not be resolved). */
  protected: boolean;
}

/**
 * The `## Scope` rows as the delegation question shows them. null when the
 * Scope is invalid or no row can be delegated: there is nothing to offer.
 */
export function scopeRowsForOffer(
  specContent: string,
  projectRoot: string,
): ScopeRow[] | null {
  const scope = parseScope(specContent);
  if (!scope.valid) return null;
  const realRoot = resolveWithMissingTail(resolve(projectRoot));
  if (realRoot === null) return null;
  const rows = scope.entries.map((entry) => ({
    entry,
    protected:
      resolveScopeEntry(realRoot, entry) === null ||
      isProtectedPath(
        resolve(realRoot, entry),
        realRoot,
        entry.endsWith("/") ? "dir" : "file",
      ) !== false,
  }));
  return rows.every((row) => row.protected) ? null : rows;
}
```

`workflow-gate.ts` は、`workflow-files.ts` からの import に `scopeRowsForOffer` と `type ScopeRow` を足し、次を足す。

```ts
/**
 * What `workflow-cli ask-approval` offers and the recorder verifies against:
 * both call this, so the question shown and the question expected cannot
 * differ.
 */
export function resolveDelegationOffer(
  wfDir: string,
  projectRoot: string,
): ScopeRow[] | null {
  let specContent: string;
  try {
    specContent = readFileSync(resolveWorkflowPaths(wfDir).spec, "utf-8");
  } catch {
    return null;
  }
  return scopeRowsForOffer(specContent, projectRoot);
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-files.test.ts`、`RUN workflow-gate.test.ts`
期待: 2 つとも PASS。plan-1 が足した `parseScope` と `isProtectedPath` のテストも通る（それらが使う行は ASCII で、`.git` と `.tmp/sessions` を含まない）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-files.ts home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/tests/unit/workflow-files.test.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts
git commit -m "feat(hooks): restrict Scope entries and work out the rows a delegation question shows"
```

### T2: 委任の質問を組み立てる

**Files:**

- 編集: `hooks/lib/workflow-approval.ts:171-229`
- テスト: `hooks/tests/unit/workflow-approval.test.ts`
- 参照: `hooks/lib/workflow-approval.ts:237-263`（`isApprovalLikeQuestion` は、質問の文が `Document Workflow の承認` で始まれば真を返す）

- [ ] **Step 1: 失敗するテストを書く**

`describe("approval question (spec K3/K4/K7)", ...)` の中、`isApprovalLikeQuestion holds for everything the builder produces` のテストの後に足す。
`spec` と `plan1` は、その `describe` の既存の定数である。
import に `DELEGATION_QUESTION_TEXT`、`DELEGATE_NO_DESCRIPTION`、`matchDelegationAnswer` を足す。

```ts
it("adds the delegation question after the approval question", () => {
  const rows = [
    { entry: "src/", protected: false },
    { entry: "home/dot_claude/", protected: true },
  ];
  const questions = buildApprovalQuestions([spec], rows);
  assert.equal(questions.length, 2);
  assert.deepEqual(questions[0], buildApprovalQuestions([spec])[0]);
  assert.deepEqual(questions[1], {
    question: DELEGATION_QUESTION_TEXT,
    header: "委任",
    multiSelect: false,
    options: [
      { label: "委任しない", description: DELEGATE_NO_DESCRIPTION },
      {
        label: "委任する",
        description:
          "Scope: src/, home/dot_claude/（委任の対象外）。レビューを通った plan-N.md は承認を待たずに実装へ進む",
      },
    ],
  });
  assert.equal(isApprovalLikeQuestion([questions[1]]), true);
});

it("refuses a delegation question without spec.md or without a row that can be delegated", () => {
  const delegable = [{ entry: "src/", protected: false }];
  assert.throws(() => buildApprovalQuestions([plan1], delegable));
  assert.throws(() =>
    buildApprovalQuestions(
      [spec],
      [{ entry: "home/dot_claude/", protected: true }],
    ),
  );
  assert.throws(() => buildApprovalQuestions([spec], []));
});

it("matchDelegationAnswer reads only the two labels", () => {
  assert.equal(matchDelegationAnswer("委任する"), "delegate");
  assert.equal(matchDelegationAnswer("委任しない"), "keep");
  assert.equal(matchDelegationAnswer("あとで"), "other");
  assert.equal(matchDelegationAnswer(["委任する"]), "other");
  assert.equal(matchDelegationAnswer(undefined), "other");
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-approval.test.ts`
期待: FAIL with "does not provide an export named 'DELEGATE_NO_DESCRIPTION'"

- [ ] **Step 3: 最小実装を書く**

定数を `MAX_DOCS_PER_QUESTION` の後ろに足す。
ファイルの外から使うのは `DELEGATION_QUESTION_TEXT` と `DELEGATE_NO_DESCRIPTION` だけなので、残りは export しない。

```ts
// The second question, asked only together with spec.md. Its text starts
// with APPROVAL_QUESTION_PREFIX so isApprovalLikeQuestion holds for it alone.
export const DELEGATION_QUESTION_TEXT =
  "Document Workflow の承認（委任）: spec.md の Scope に収まる plan-N.md を、個別の承認なしで実装へ進めますか";
export const DELEGATE_NO_DESCRIPTION = "plan-N.md は 1 つずつ承認する";
const DELEGATION_HEADER = "委任";
const DELEGATE_NO_LABEL = "委任しない";
const DELEGATE_YES_LABEL = "委任する";
const SCOPE_ROW_EXCLUDED = "（委任の対象外）";

/** One `## Scope` row as the caller judged it; this module does no file access. */
export interface DelegationScopeRow {
  entry: string;
  protected: boolean;
}
```

`ApprovalQuestion` の `multiSelect: true` を `multiSelect: boolean` にする。

`buildApprovalQuestions`（`:198-229`）を、次の関数で丸ごと置き換える。
検査（件数、名前、重複）と 1 問目の内容は現在と同じである。

```ts
/** Keeps the input order. Throws instead of silently truncating or fixing the list. */
export function buildApprovalQuestions(
  docs: readonly ApprovalDoc[],
  delegation?: readonly DelegationScopeRow[],
): ApprovalQuestion[] {
  if (docs.length < 1 || docs.length > MAX_DOCS_PER_QUESTION) {
    throw new Error(
      `approval question needs 1-${MAX_DOCS_PER_QUESTION} documents, got ${docs.length}`,
    );
  }
  const names = new Set<string>();
  for (const { name } of docs) {
    if (!WORKFLOW_DOC_NAME.test(name)) {
      throw new Error(`not a workflow document name: ${JSON.stringify(name)}`);
    }
    if (names.has(name)) throw new Error(`duplicate document: ${name}`);
    names.add(name);
  }
  const approval: ApprovalQuestion = {
    question: APPROVAL_QUESTION_TEXT,
    header: APPROVAL_HEADER,
    multiSelect: true,
    options: [
      ...docs.map(({ name, hash }) => ({
        label: name,
        description: `${HASH_PREFIX}${hash.slice(0, HASH_PREFIX_LENGTH)}`,
      })),
      { label: DECLINE_LABEL, description: DECLINE_DESCRIPTION },
    ],
  };
  if (delegation === undefined) return [approval];
  if (!names.has("spec.md")) {
    throw new Error(
      "the delegation question is asked only together with spec.md",
    );
  }
  return [approval, buildDelegationQuestion(delegation)];
}

function buildDelegationQuestion(
  rows: readonly DelegationScopeRow[],
): ApprovalQuestion {
  if (rows.length < 1 || rows.every((row) => row.protected)) {
    throw new Error(
      "the delegation question needs a Scope row that can be delegated",
    );
  }
  const listed = rows
    .map((row) =>
      row.protected ? `${row.entry}${SCOPE_ROW_EXCLUDED}` : row.entry,
    )
    .join(", ");
  return {
    question: DELEGATION_QUESTION_TEXT,
    header: DELEGATION_HEADER,
    multiSelect: false,
    options: [
      { label: DELEGATE_NO_LABEL, description: DELEGATE_NO_DESCRIPTION },
      {
        label: DELEGATE_YES_LABEL,
        description: `Scope: ${listed}。レビューを通った plan-N.md は承認を待たずに実装へ進む`,
      },
    ],
  };
}

export type DelegationAnswer = "delegate" | "keep" | "other";

/** The answer to the delegation question. Anything but the two labels is "other". */
export function matchDelegationAnswer(value: unknown): DelegationAnswer {
  if (value === DELEGATE_YES_LABEL) return "delegate";
  if (value === DELEGATE_NO_LABEL) return "keep";
  return "other";
}
```

T1 の文字の制限により、Scope の行は `,` も全角の括弧も含まない。
したがって `, ` での連結と「（委任の対象外）」の印は、行の中身と紛れない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-approval.test.ts`
期待: PASS。既存の `builds one multiSelect question with a decline option` も通る（第 2 引数なしの結果は変わらない）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-approval.ts home/dot_claude/hooks/tests/unit/workflow-approval.test.ts
git commit -m "feat(hooks): build the delegation question that follows a spec.md approval"
```

### T3: `ask-approval` が 2 問目を出し、`status` が委任の状態を出す

**Files:**

- 編集: `hooks/cli/workflow.ts:948-988`（`cmdAskApproval`）、`:390-396` の直後（`cmdStatus`）
- テスト: `hooks/tests/unit/workflow-cli.test.ts`
- 参照: `hooks/cli/workflow.ts:963`（候補の並びは `spec.md` が先頭なので、候補にあれば必ず質問に入る）
- 参照: `hooks/cli/workflow.ts:378`（`cmdStatus` の中の `twoLayer`。関数の中で定義済みの変数）

- [ ] **Step 1: 失敗するテストを書く**

`describe("workflow-cli: ask-approval and approval route", ...)` の中、`prints the question JSON for the waiting documents` のテストの後に足す。
`approvalRepo`、`run`、`REVIEWED` は、その `describe` の既存のものである。

```ts
it("adds the delegation question when spec.md has a Scope that can be delegated", () => {
  const { wf } = approvalRepo(0);
  const spec = buildSpecWithScope(REVIEWED, ["src/", "home/dot_claude/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  const r = run(["ask-approval"], wf);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    questions: buildApprovalQuestions(
      [{ name: "spec.md", hash: computeWorkflowRepoPlanHash(spec) }],
      [
        { entry: "src/", protected: false },
        { entry: "home/dot_claude/", protected: true },
      ],
    ),
  });
  assert.match(r.stderr, /2 問目は委任の選択/);
  assert.match(r.stderr, /project root: /);
});

it("asks only the approval question when spec.md is not among the documents", () => {
  const { wf } = approvalRepo(0);
  const spec = buildSpecWithScope(approvedWorkflowRepo(), ["lib/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      REVIEWED,
      ["src/p1.ts"],
      computeWorkflowRepoPlanHash(spec),
    ),
  );
  recordApprovalsForTest(wf);
  const r = run(["ask-approval"], wf);
  assert.equal(r.exitCode, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as {
    questions: { options: { label: string }[] }[];
  };
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0]?.options[0]?.label, "plan-1.md");
});

it("asks only the approval question when every Scope row is protected", () => {
  const { wf } = approvalRepo(0);
  writeFileSync(
    join(wf, "spec.md"),
    buildSpecWithScope(REVIEWED, ["home/dot_claude/"]),
  );
  const r = run(["ask-approval"], wf);
  assert.equal(
    (JSON.parse(r.stdout) as { questions: unknown[] }).questions.length,
    1,
  );
});
```

`status` の `describe` には、plan-1 が足した `status marks a plan-N.md that clears by delegation` のテストの後に足す。
`statusRepo` と `NOW` は既存のものである。

```ts
it("status says whether delegation is active", () => {
  const statusOf = (delegateSpec: boolean) => {
    const { repo, wf } = statusRepo();
    writeFileSync(
      join(wf, "spec.md"),
      buildSpecWithScope(approvedWorkflowRepo(), ["src/"]),
    );
    recordApprovalsForTest(wf, { delegateSpec });
    return runWorkflowCli(["status"], {
      cwd: repo,
      wfDir: wf,
      sessionId: "test-ses",
      wfDirSource: "derived",
      now: NOW,
    }).stdout;
  };
  assert.match(
    statusOf(true),
    /^delegation: active \(.*spec\.md.*Approval Status/m,
  );
  assert.match(statusOf(false), /^delegation: none$/m);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-cli.test.ts`
期待: FAIL。1 つ目のテストが、`questions` の長さの違い（実際は 1、期待は 2）で落ちる。

- [ ] **Step 3: 最小実装を書く**

`workflow-gate.ts` からの import に `resolveDelegationOffer` と `resolveSpecContext` を足す。

`cmdAskApproval` は、関数の最後の部分を置き換える。

```ts
// 置き換え前
if (warning) notes.push(warning);
return {
  exitCode: 0,
  stdout: `${JSON.stringify({ questions: buildApprovalQuestions(asked) })}\n`,
  stderr: `${notes.join("\n")}\n`,
};
// 置き換え後
const offer = asked.some(({ name }) => name === "spec.md")
  ? resolveDelegationOffer(wfDir, deps.cwd)
  : null;
if (offer !== null) {
  notes.push(
    "2 問目は委任の選択。1 問目で spec.md を選んだときだけ、その答えが記録される。2 問とも出力のまま AskUserQuestion に渡す。",
    // The recorder rebuilds the question from its own project root; a
    // mismatch shows up as a "malformed" reply, and this is where to look.
    `project root: ${deps.cwd}`,
  );
}
if (warning) notes.push(warning);
return {
  exitCode: 0,
  stdout: `${JSON.stringify({ questions: buildApprovalQuestions(asked, offer ?? undefined) })}\n`,
  stderr: `${notes.join("\n")}\n`,
};
```

`cmdStatus` は、tripwire の行を出す `if` / `else if` / `else`（`:390-396`）の直後に足す。

```ts
if (twoLayer) {
  lines.push(
    resolveSpecContext(wfDir, deps.cwd).delegation !== null
      ? `delegation: active (a plan-N.md within spec.md's ## Scope clears without its own approval; to revoke, set the \`- Approval Status:\` line of ${sanitizeForDisplay(resolve(wfDir, "spec.md"))} back to pending)`
      : "delegation: none",
  );
}
```

`sanitizeForDisplay` と `resolve` は同ファイルで import 済みである。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-cli.test.ts`
期待: PASS。既存の `ask-approval` のテストは、Scope の無い spec を使うので 1 問のまま通る。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/cli/workflow.ts home/dot_claude/hooks/tests/unit/workflow-cli.test.ts
git commit -m "feat(hooks): offer delegation in ask-approval and show it in status"
```

### T4: 記録側が 1 問または 2 問の応答を検証し、委任を記録する

**Files:**

- 編集: `hooks/lib/workflow-approval-record.ts:75-147`、`:199-291`
- 編集: `hooks/implementations/approval-answer-recorder.ts:138-144`
- 編集: `hooks/implementations/approval-recorder.ts:106`
- テスト: `hooks/tests/unit/workflow-approval-record.test.ts`、`hooks/tests/unit/approval-answer-recorder.test.ts`、`hooks/tests/unit/approval-recorder.test.ts`
- 参照: `hooks/lib/workflow-approval-record.ts:219`、`:228`、`:236`（質問が 1 つ、回答のキーが 1 つ、候補の列挙に projectRoot なし、の 3 点が現在の前提）

記録は現在と同じく全か無かである。
質問は現状から作り直し、応答の `questions` 全体と完全に一致したときだけ先へ進む。
したがって、2 問目を落とした応答、2 問目を足した応答、説明文を書き換えた応答は、どれも `malformed` になる。
委任は、1 問目で spec.md を選び、2 問目で「委任する」を選んだときだけ、spec.md の行に記録する。

- [ ] **Step 1: 失敗するテストを書く**

`workflow-approval-record.test.ts` の末尾に足す。
import に `DELEGATION_QUESTION_TEXT`（`workflow-approval.ts`）と `buildSpecWithScope`（`test-helpers.ts`）を足す。
`REVIEWED` は同ファイルの既存の定数である。

```ts
describe("workflow-approval-record: delegation question (spec K6)", () => {
  let repo: string;
  let wf: string;
  let specHash: string;
  const rows = [{ entry: "src/", protected: false }];

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-deleg-")));
    wf = join(repo, ".tmp", "sessions", "abcd1234");
    mkdirSync(wf, { recursive: true });
    const spec = buildSpecWithScope(REVIEWED, ["src/"]);
    specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(join(wf, "spec.md"), spec);
  });

  const response = (
    docAnswer: unknown,
    delegationAnswer?: unknown,
    withSecondQuestion = true,
  ): Record<string, unknown> => ({
    questions: buildApprovalQuestions(
      [{ name: "spec.md", hash: specHash }],
      withSecondQuestion ? rows : undefined,
    ),
    answers: {
      [APPROVAL_QUESTION_TEXT]: docAnswer,
      ...(delegationAnswer === undefined
        ? {}
        : { [DELEGATION_QUESTION_TEXT]: delegationAnswer }),
    },
  });
  const verify = (r: unknown) =>
    verifyAndRecordApprovalAnswer(wf, r, "sess", new Date(), repo);
  const lines = (): Record<string, unknown>[] => {
    const path = join(wf, "approvals.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("records the delegation on the spec.md line", () => {
    const r = verify(response("spec.md", "委任する"));
    assert.equal(r.kind, "recorded");
    assert.equal(r.kind === "recorded" && r.results[0]?.delegated, true);
    assert.deepEqual(
      lines().map((l) => [l.doc, l.hash, l.via, l.delegate]),
      [["spec.md", specHash, "ask", "plans-in-scope"]],
    );
  });

  it("records the approval without delegation when the user keeps per-plan approval", () => {
    const r = verify(response("spec.md", "委任しない"));
    assert.equal(r.kind, "recorded");
    assert.equal(r.kind === "recorded" && r.results[0]?.delegated, undefined);
    assert.deepEqual(
      lines().map((l) => l.delegate),
      [undefined],
    );
  });

  it("records nothing when the user declines, whatever the second answer", () => {
    assert.deepEqual(verify(response("承認しない", "委任する")), {
      kind: "decline",
    });
    assert.deepEqual(verify(response("承認しない", "あとで決める")), {
      kind: "decline",
    });
    assert.equal(lines().length, 0);
  });

  it("treats a typed second answer as a remark and records nothing", () => {
    const r = verify(response("spec.md", "あとで決める"));
    assert.deepEqual(r, { kind: "freeText", text: "あとで決める" });
    assert.equal(lines().length, 0);
  });

  const malformed: [string, () => unknown][] = [
    [
      "the second question was dropped",
      () => response("spec.md", undefined, false),
    ],
    ["the second answer is missing", () => response("spec.md")],
    [
      "the second answer is not a string",
      () => response("spec.md", ["委任する"]),
    ],
    [
      "the delegation description was edited",
      () => {
        const r = response("spec.md", "委任する");
        const questions = structuredClone(r.questions) as {
          options: { description: string }[];
        }[];
        const option = questions[1]?.options[1];
        if (option) option.description = "Scope: src/";
        return { ...r, questions };
      },
    ],
    [
      "the two delegation labels were swapped",
      () => {
        const r = response("spec.md", "委任しない");
        const questions = structuredClone(r.questions) as {
          options: unknown[];
        }[];
        questions[1]?.options.reverse();
        return { ...r, questions };
      },
    ],
    [
      "a third question was added",
      () => {
        const r = response("spec.md", "委任する");
        const questions = r.questions as unknown[];
        return { ...r, questions: [...questions, questions[1]] };
      },
    ],
  ];
  for (const [name, build] of malformed) {
    it(`malformed: ${name}`, () => {
      assert.deepEqual(verify(build()), { kind: "malformed" });
      assert.equal(lines().length, 0);
    });
  }

  it("is malformed without a project root, because the offer cannot be rebuilt", () => {
    assert.deepEqual(
      verifyAndRecordApprovalAnswer(
        wf,
        response("spec.md", "委任する"),
        "sess",
      ),
      { kind: "malformed" },
    );
    assert.equal(lines().length, 0);
  });

  it("reports a document that is not waiting before it looks at the answer keys", () => {
    const r = {
      questions: buildApprovalQuestions([
        { name: "spec.md", hash: specHash },
        { name: "plan-1.md", hash: specHash },
      ]),
      answers: { "some other text": "spec.md" },
    };
    assert.deepEqual(verify(r), { kind: "notCandidate", docs: ["plan-1.md"] });
    assert.equal(lines().length, 0);
  });

  it("is malformed when the Scope changed after the question was built", () => {
    const r = response("spec.md", "委任する");
    writeFileSync(
      join(wf, "spec.md"),
      buildSpecWithScope(REVIEWED, ["src/", "lib/"]),
    );
    assert.deepEqual(verify(r), { kind: "malformed" });
    assert.equal(lines().length, 0);
  });

  it("describes a delegated record", () => {
    const r = verify(response("spec.md", "委任する"));
    assert.ok(r.kind === "recorded" && r.results[0]);
    assert.match(
      describeRecordResult(r.results[0]),
      /spec\.md を hash=[0-9a-f]{12} で承認として記録した（Scope に収まる plan-N\.md を委任）/,
    );
  });
});
```

`existsSync` と `readFileSync` が未 import なら `node:fs` の import に足す。

`approval-answer-recorder.test.ts` には、`records the approved documents and reports them` のテストの後に足す。
import に `DELEGATION_QUESTION_TEXT` と `buildSpecWithScope` を足す。
`wf`、`fire`、`logText`、`REVIEWED` は同ファイルの既存のものである。

```ts
it("records the delegation chosen in the second question", async () => {
  const spec = buildSpecWithScope(REVIEWED, ["src/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  const questions = buildApprovalQuestions(
    [{ name: "spec.md", hash: computeWorkflowRepoPlanHash(spec) }],
    [{ entry: "src/", protected: false }],
  );
  const { output } = await fire({
    questions,
    answers: {
      [APPROVAL_QUESTION_TEXT]: "spec.md",
      [DELEGATION_QUESTION_TEXT]: "委任する",
    },
  });
  assert.ok(output);
  assert.match(output.systemMessage, /Scope に収まる plan-N\.md を委任/);
  assert.match(logText(), /"delegate":"plans-in-scope"/);
});
```

`approval-recorder.test.ts` には、`records nothing and asks for a name when two plans await approval` のテストの後に足す。
import に `buildSpecWithScope` を足す。`buildPlanNContent` と `recordApprovalsForTest` が未 import なら足す。
`wf`、`say`、`REVIEWED`、`APPROVED` は同ファイルの既存のものである。

```ts
it("a bare approval skips a plan that already clears by delegation", async () => {
  const spec = buildSpecWithScope(APPROVED, ["src/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  const specHash = computeWorkflowRepoPlanHash(spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(REVIEWED, ["src/a.ts"], specHash),
  );
  writeFileSync(
    join(wf, "plan-2.md"),
    buildPlanNContent(REVIEWED, ["other/b.ts"], specHash),
  );
  recordApprovalsForTest(wf, { delegateSpec: true });
  const { text } = await say("承認");
  assert.match(text, /plan-2\.md を hash=[0-9a-f]{12} で承認として記録/);
  const { latest } = readLatestApprovals(wf);
  assert.equal(latest.has("plan-1.md"), false);
  assert.equal(latest.get("spec.md")?.delegate, "plans-in-scope");
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-approval-record.test.ts`
期待: FAIL。`records the delegation on the spec.md line` が `'malformed' !== 'recorded'` で落ちる（現在は質問が 2 つだと `malformed`）。

- [ ] **Step 3: 最小実装を書く**

`workflow-approval-record.ts` の import を直す。
`./workflow-approval.ts` からの import に、`type ApprovalDelegate`、`type ApprovalQuestion`、`APPROVAL_QUESTION_TEXT`、`DELEGATION_QUESTION_TEXT`、`matchDelegationAnswer` を足す。
`./workflow-gate.ts` からの import に `resolveDelegationOffer` を足す。

`RecordResult` に項目を足す。

```ts
export interface RecordResult {
  doc: string;
  state: RecordState;
  hash: string;
  detail?: string;
  /** Present when this record also delegates the spec's plan-N.md. */
  delegated?: true;
}
```

`recordOne`（`:91-131`）は 3 か所を置き換える。それ以外の行は変えない。

1 つ目は引数である。`via: ApprovalVia,` の行の次に 1 行足す。

```ts
  via: ApprovalVia,
  delegate?: ApprovalDelegate,
): RecordResult {
```

2 つ目は `appendApproval` の呼び出し（`:102`）である。

```ts
// 置き換え前
appendApproval(wfDir, { doc, hash, session, at, via });
// 置き換え後
appendApproval(wfDir, {
  doc,
  hash,
  session,
  at,
  via,
  ...(delegate === undefined ? {} : { delegate }),
});
```

3 つ目は、`c.approvalRecord.ok && c.approvalStatus.ok` のときに返すオブジェクトである。
`detail` の行の次に 1 行足す。

```ts
        detail: rewritten ? "rewritten" : "already-approved",
        ...(delegate === undefined ? {} : { delegated: true as const }),
```

`describeRecordResult` の `recorded` の分岐を次の形にする。

```ts
    case "recorded":
      return `${doc} を hash=${hash.slice(0, 12)} で承認として記録した${
        result.delegated ? "（Scope に収まる plan-N.md を委任）" : ""
      }`;
```

`verifyAndRecordApprovalAnswer` を、次の関数で丸ごと置き換える。

```ts
export function verifyAndRecordApprovalAnswer(
  wfDir: string,
  toolResponse: unknown,
  session: string,
  now: Date = new Date(),
  projectRoot?: string,
): AnswerVerification {
  const r = isPlainObject(toolResponse) ? toolResponse : undefined;
  if (!isApprovalLikeQuestion(r?.questions)) return { kind: "notApproval" };
  if (r === undefined) return { kind: "notApproval" };
  if (Object.hasOwn(r, "afkTimeoutMs")) return { kind: "afk" };
  if (Object.hasOwn(r, "response")) {
    return typeof r.response === "string"
      ? { kind: "freeText", text: r.response }
      : { kind: "malformed" };
  }

  if (!Object.keys(r).every((k) => RESPONSE_KEYS.has(k))) {
    return { kind: "malformed" };
  }
  const { questions, answers, annotations } = r;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 2
  ) {
    return { kind: "malformed" };
  }
  const question = questions[0];
  if (!isPlainObject(question) || typeof question.question !== "string") {
    return { kind: "malformed" };
  }
  if (!isPlainObject(answers)) return { kind: "malformed" };

  const docNames = extractDocNames(question);
  if (docNames === null) return { kind: "malformed" };

  const candidates = new Set(listApprovalCandidates(wfDir, projectRoot));
  const missing = docNames.filter((d) => !candidates.has(d));
  if (missing.length > 0) return { kind: "notCandidate", docs: missing };

  const hashes = new Map(
    docNames.map((d) => [d, evaluateApprovalReadiness(wfDir, d).hash]),
  );
  // The same call `workflow-cli ask-approval` makes, so the offer expected
  // here is the offer that was shown.
  const offer =
    projectRoot !== undefined && docNames.includes("spec.md")
      ? resolveDelegationOffer(wfDir, projectRoot)
      : null;
  let rebuilt: ApprovalQuestion[];
  try {
    rebuilt = buildApprovalQuestions(
      docNames.map((name) => ({ name, hash: hashes.get(name) ?? "" })),
      offer ?? undefined,
    );
  } catch {
    return { kind: "malformed" };
  }
  if (!deepEqualIgnoringKeyOrder(rebuilt, questions)) {
    return { kind: "malformed" };
  }

  // One answer per question, keyed by the question text.
  const expectedKeys = rebuilt.map((q) => q.question);
  if (
    Object.keys(answers).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(answers, key))
  ) {
    return { kind: "malformed" };
  }
  const answer = answers[APPROVAL_QUESTION_TEXT];

  if (isPlainObject(annotations)) {
    for (const entry of Object.values(annotations)) {
      if (isPlainObject(entry) && typeof entry.notes === "string") {
        return { kind: "notes", notes: entry.notes };
      }
    }
  }
  if (!isAnswerValue(answer)) {
    return {
      kind: "answerShape",
      shape: describeAnswerShape(answer),
      docs: docNames,
    };
  }

  const matched = matchApprovalAnswer(rebuilt, answer);
  switch (matched.kind) {
    case "decline":
      return { kind: "decline" };
    case "freeText":
      return { kind: "freeText", text: matched.text };
    case "invalid":
      return { kind: "malformed" };
    case "approve": {
      // The delegation answer counts only once the approval itself stands.
      let delegate = false;
      if (rebuilt.length === 2) {
        const delegationAnswer = answers[DELEGATION_QUESTION_TEXT];
        if (typeof delegationAnswer !== "string") return { kind: "malformed" };
        const delegation = matchDelegationAnswer(delegationAnswer);
        if (delegation === "other") {
          return { kind: "freeText", text: delegationAnswer };
        }
        delegate = delegation === "delegate";
      }
      const at = now.toISOString();
      return {
        kind: "recorded",
        results: matched.docs.map((doc) =>
          recordOne(
            wfDir,
            doc,
            hashes.get(doc) ?? "",
            session,
            at,
            "ask",
            delegate && doc === "spec.md" ? "plans-in-scope" : undefined,
          ),
        ),
      };
    }
  }
}
```

作り直した質問と一致した後なので、1 問目の文は `APPROVAL_QUESTION_TEXT` に等しい。

現在の関数との違いは次の 6 点である。

- 第 5 引数 `projectRoot` を足した。
- 質問の数を 1 または 2 にした。
- 回答のキーの検査を、作り直した質問の文と突き合わせる形にし、作り直しの後へ移した。
- `listApprovalCandidates` に `projectRoot` を渡した。CLI と同じ候補になる。
- 2 問目の答えは、1 問目が承認と決まった後で読む。「承認しない」のときは 2 問目が何であっても `decline` を返す。
- spec.md の `recordOne` に `delegate` を渡した。

3 点目の結果、回答のキーが違い、かつ候補でない文書を挙げた応答は、`malformed` ではなく `notCandidate` になる。
どちらも何も記録しない。Step 1 の `reports a document that is not waiting before it looks at the answer keys` が、この組み合わせを確かめる。

`approval-answer-recorder.ts` は、`verifyAndRecordApprovalAnswer` の呼び出しに引数を 2 つ足す。

```ts
const reply = describeVerification(
  verifyAndRecordApprovalAnswer(
    resolution.dir,
    toolResponse,
    context.input.session_id,
    new Date(),
    getProjectRoot(),
  ),
);
```

`approval-recorder.ts`（発話の経路）は、候補の列挙を CLI と記録側に揃える。

```ts
// 置き換え前 (:106)
targets = listApprovalCandidates(wfDir);
// 置き換え後
targets = listApprovalCandidates(wfDir, getProjectRoot());
```

`getProjectRoot` は同ファイルで import 済みである（`:22`）。
`recordOne` の呼び出しは変えない。第 7 引数を渡さないので、発話では委任を記録しない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-approval-record.test.ts`、`RUN approval-answer-recorder.test.ts`、`RUN approval-recorder.test.ts`
期待: 3 つとも PASS。既存の `malformed: two questions`（同じ質問を 2 つ並べた応答）は、作り直した質問と一致しないので `malformed` のまま通る。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-approval-record.ts home/dot_claude/hooks/implementations/approval-answer-recorder.ts home/dot_claude/hooks/implementations/approval-recorder.ts home/dot_claude/hooks/tests/unit/workflow-approval-record.test.ts home/dot_claude/hooks/tests/unit/approval-answer-recorder.test.ts home/dot_claude/hooks/tests/unit/approval-recorder.test.ts
git commit -m "feat(hooks): record a delegation from the second approval question"
```

### T5: 委任で通した記録を残し、ツールでの書き込みを止める

**Files:**

- 編集: `hooks/lib/workflow-audit-log.ts`
- 編集: `hooks/implementations/document-workflow-guard.ts:1010-1015`
- テスト: `hooks/tests/unit/workflow-audit-log.test.ts`、`hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `hooks/lib/workflow-audit-log.ts:50-77`（`appendOffPlanLog`。失敗しても呼び出しを止めない）

重複を止めるキーは、plan-N の名前、plan-N の hash、spec の hash の 3 つである。
plan-N の hash は `parent-spec-hash` を含まない。
spec を改訂して委任し直した場合に、plan-N の本文が同じでも、もう一度知らせるためである。

- [ ] **Step 1: 失敗するテストを書く**

`workflow-audit-log.test.ts` の `describe` の中に足す。
import を `appendOffPlanLog, DELEGATION_USES_LOG, recordDelegatedOffPlanWrite, recordDelegationUse` にし、`node:fs` の import に `mkdirSync` を足す。

```ts
it("recordDelegationUse reports the first use of a plan version under a spec version once", () => {
  const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
  const use = {
    planName: "plan-1.md",
    planHash: "a".repeat(64),
    specHash: "b".repeat(64),
  };
  assert.deepEqual(recordDelegationUse(wf, use), {
    first: true,
    written: true,
  });
  assert.deepEqual(recordDelegationUse(wf, use), {
    first: false,
    written: true,
  });
  assert.equal(
    recordDelegationUse(wf, { ...use, planHash: "c".repeat(64) }).first,
    true,
  );
  assert.equal(
    recordDelegationUse(wf, { ...use, specHash: "d".repeat(64) }).first,
    true,
  );
  const content = readFileSync(join(wf, DELEGATION_USES_LOG), "utf-8");
  assert.equal(content.trimEnd().split("\n").length, 3);
  assert.match(
    content,
    /\tplan="plan-1\.md"\tplan-hash=a{64}\tspec-hash=b{64}\trevoke="[^"]+"\n/,
  );
});

it("recordDelegatedOffPlanWrite reports a target once per spec version", () => {
  const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
  const write = { target: "/repo/src/b.ts", specHash: "b".repeat(64) };
  assert.deepEqual(recordDelegatedOffPlanWrite(wf, write), {
    first: true,
    written: true,
  });
  assert.deepEqual(recordDelegatedOffPlanWrite(wf, write), {
    first: false,
    written: true,
  });
  assert.equal(
    recordDelegatedOffPlanWrite(wf, { ...write, target: "/repo/lib/b.ts" })
      .first,
    true,
  );
  assert.equal(
    recordDelegatedOffPlanWrite(wf, { ...write, specHash: "d".repeat(64) })
      .first,
    true,
  );
  assert.match(
    readFileSync(join(wf, DELEGATION_USES_LOG), "utf-8"),
    /\toff-plan="\/repo\/src\/b\.ts"\tspec-hash=b{64}\trevoke="[^"]+"\n/,
  );
});

it("recordDelegationUse says so when the log cannot be written", () => {
  const wf = mkdtempSync(join(tmpdir(), "audit-log-"));
  mkdirSync(join(wf, DELEGATION_USES_LOG));
  const use = {
    planName: "plan-1.md",
    planHash: "a".repeat(64),
    specHash: "b".repeat(64),
  };
  assert.deepEqual(recordDelegationUse(wf, use), {
    first: true,
    written: false,
  });
  assert.deepEqual(recordDelegationUse(wf, use), {
    first: true,
    written: false,
  });
});
```

`document-workflow-guard.test.ts` には、plan-1 が足した `keeps the interpreter-write check while only delegated plans are in effect` のテストの後に足す。

```ts
it("refuses a tool write to delegation-uses.log", async () => {
  const repo = createWorkflowRepo(approvedWorkflowRepo());
  envHelper.set("CLAUDE_TEST_CWD", repo);
  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: join(repo, TEST_WORKFLOW_DIR, "delegation-uses.log"),
    content: "x",
  });
  await invokeRun(hook, context);
  context.assertDeny();
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-audit-log.test.ts`
期待: FAIL with "does not provide an export named 'DELEGATION_USES_LOG'"

- [ ] **Step 3: 最小実装を書く**

`workflow-audit-log.ts` の `node:fs` の import に `readFileSync` を足す。
追記の部分を非公開の関数に出し、`appendOffPlanLog` はそれを呼ぶ形にする。

```ts
/** One `write` on an O_APPEND | O_NOFOLLOW descriptor. Best-effort: false when it could not be written. */
function appendAuditLine(
  wfDir: string,
  fileName: string,
  line: string,
): boolean {
  try {
    const fd = openSync(
      resolve(wfDir, fileName),
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function appendOffPlanLog(
  wfDir: string,
  toolName: string,
  target: string,
): void {
  const pathField = UNEXPANDED_TOKEN_REGEX.test(target)
    ? `raw-token:${JSON.stringify(target)}`
    : JSON.stringify(target);
  appendAuditLine(
    wfDir,
    "off-plan-writes.log",
    `${new Date().toISOString()}\ttool=${toolName}\tpath=${pathField}\n`,
  );
}

export const DELEGATION_USES_LOG = "delegation-uses.log";
/** How the user takes a delegation back; kept on every line so it is found where the use is. */
const DELEGATION_REVOKE =
  "set the `- Approval Status:` line of spec.md back to pending";

export interface DelegationUse {
  planName: string;
  planHash: string;
  specHash: string;
}

export interface DelegationUseRecord {
  /** This plan version had not been recorded under this spec version. */
  first: boolean;
  /** The line is in the log (already there, or just written). */
  written: boolean;
}

/**
 * Append one line under `key` unless a line with that key is already there.
 * A log that cannot be read counts as "not recorded": a repeated notice is
 * the lesser failure, and `written` lets the caller say the record could not
 * be kept.
 */
function recordOnce(wfDir: string, key: string): DelegationUseRecord {
  try {
    const fd = openSync(
      resolve(wfDir, DELEGATION_USES_LOG),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      if (readFileSync(fd, "utf-8").includes(key)) {
        return { first: false, written: true };
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Missing or unreadable: record and report.
  }
  const written = appendAuditLine(
    wfDir,
    DELEGATION_USES_LOG,
    `${new Date().toISOString()}${key}revoke=${JSON.stringify(DELEGATION_REVOKE)}\n`,
  );
  return { first: true, written };
}

/**
 * Record that a write cleared by the spec's delegation, once per plan-N.md
 * version under a spec.md version.
 */
export function recordDelegationUse(
  wfDir: string,
  use: DelegationUse,
): DelegationUseRecord {
  return recordOnce(
    wfDir,
    `\tplan=${JSON.stringify(use.planName)}\tplan-hash=${use.planHash}\tspec-hash=${use.specHash}\t`,
  );
}

export interface DelegatedOffPlanWrite {
  /** The write target as an absolute path, so the key does not depend on the tool's cwd. */
  target: string;
  specHash: string;
}

/**
 * Record a write that no plan-N.md lists and that was let through while only
 * delegated plans were in effect, once per target under a spec.md version.
 */
export function recordDelegatedOffPlanWrite(
  wfDir: string,
  write: DelegatedOffPlanWrite,
): DelegationUseRecord {
  return recordOnce(
    wfDir,
    `\toff-plan=${JSON.stringify(write.target)}\tspec-hash=${write.specHash}\t`,
  );
}
```

`appendOffPlanLog` の既存の doc コメントは、その関数の直前に残す。
読み戻しと追記は 1 つの操作ではない。
並列の呼び出しが同時に「未記録」と読むと、通知が 2 回出る。これは受容する。

guard は、`workflow-audit-log.ts` からの import に `DELEGATION_USES_LOG` を足す。
`judgeApprovalWrite` の `approvals.log` の分岐（`:1010-1015`）の直後に、同じ形の分岐を足す。

```ts
if (
  basename(realTarget).toLowerCase() === DELEGATION_USES_LOG &&
  isUnder(realTarget, realSessions)
) {
  return `${DELEGATION_USES_LOG} is written only by document-workflow-guard when a write clears by the spec's delegation; tool writes to it are refused.`;
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-audit-log.test.ts`、`RUN document-workflow-guard.test.ts`
期待: 2 つとも PASS。既存の `records a plain path target as path=<JSON>` も通る。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-audit-log.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/workflow-audit-log.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): keep a guarded record of writes that clear by delegation"
```

### T6: 委任に基づく書き込みを利用者に知らせる

**Files:**

- 編集: `hooks/lib/workflow-gate.ts:476-482`、`:592-597`（`no-plan-owner` に実装フェーズの根拠を載せる）
- 編集: `hooks/implementations/document-workflow-guard.ts:282-293`（Bash の経路）、`:330-339`（Write / Edit の経路）
- テスト: `hooks/tests/unit/workflow-gate.test.ts`、`hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `hooks/implementations/document-workflow-guard.ts:119-125`（許可のまま `systemMessage` を出す既存の形。`hookSpecificOutput` を付けない）

知らせるのは次の 2 つである。

- 委任で通る plan-N の対象への、最初の書き込み。plan-N の版と spec の版の組ごとに 1 回。
- 委任だけの実装フェーズで、Scope の内側にあり、どの plan-N にも無いファイルへの書き込み。ファイルと spec の版の組ごとに 1 回。

記録は PreToolUse の時点で行う。
後続の権限の確認でその書き込みが実行されなかった場合も、記録と通知は残る。
知らせる回数が増える側の誤りなので、受容する。

- [ ] **Step 1: 失敗するテストを書く**

`workflow-gate.test.ts` に足す。

```ts
test("no-plan-owner carries what the implementation phase rests on", () => {
  const delegated = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: delegated.wf,
    target: join(delegated.repo, "src", "b.ts"),
    projectRoot: delegated.repo,
  });
  ok(e.kind === "no-plan-owner" && e.phaseBasis === "delegated-only");
  ok(e.kind === "no-plan-owner" && /^[0-9a-f]{64}$/.test(e.specHash));

  const approved = twoLayerRepo(["src/a.ts"]);
  const a = evaluateTarget({
    wfDir: approved.wf,
    target: join(approved.repo, "src", "b.ts"),
    projectRoot: approved.repo,
  });
  ok(a.kind === "no-plan-owner" && a.phaseBasis === "approved");
});
```

`document-workflow-guard.test.ts` は、plan-1 が足した `keeps the interpreter-write check while only delegated plans are in effect` のテストを、次の 4 つで置き換える。
repo を作る部分を関数に出し、最初の書き込みの確かめ方を通知に合わせる。

```ts
function delegatedGuardRepo(): string {
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
  return repo;
}

it("tells the user once when a Write first clears by delegation", async () => {
  const repo = delegatedGuardRepo();
  const first = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/a.ts",
    content: "const a = 1;",
  });
  await invokeRun(hook, first);
  const notice = first.jsonCalls[0].systemMessage;
  ok(/plan-1\.md \(hash=[0-9a-f]{12}\)/.test(notice), notice);
  ok(
    /spec\.md の `- Approval Status:` の行を pending に戻す/.test(notice),
    notice,
  );
  ok(/記録: .*delegation-uses\.log/.test(notice), notice);
  strictEqual(first.jsonCalls[0].hookSpecificOutput, undefined);
  ok(
    /\tplan="plan-1\.md"\t/.test(
      readFileSync(
        join(repo, TEST_WORKFLOW_DIR, "delegation-uses.log"),
        "utf-8",
      ),
    ),
  );

  const second = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/a.ts",
    content: "const a = 2;",
  });
  await invokeRun(hook, second);
  second.assertSuccess({});
});

it("tells the user when a Bash write first clears by delegation", async () => {
  delegatedGuardRepo();
  const context = createPreToolUseContextFor(hook, "Bash", {
    command: "echo x > src/a.ts",
  });
  await invokeRun(hook, context);
  const notice = context.jsonCalls[0].systemMessage;
  ok(/plan-1\.md \(hash=[0-9a-f]{12}\)/.test(notice), notice);
  strictEqual(context.jsonCalls[0].hookSpecificOutput, undefined);
});

it("tells the user about an off-plan write inside the Scope under delegation alone", async () => {
  delegatedGuardRepo();
  const context = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/b.ts",
    content: "const b = 1;",
  });
  await invokeRun(hook, context);
  const notice = context.jsonCalls[0].systemMessage;
  ok(/src\/b\.ts/.test(notice), notice);
  ok(/off-plan-writes\.log/.test(notice), notice);
  strictEqual(context.jsonCalls[0].hookSpecificOutput, undefined);

  const again = createPreToolUseContextFor(hook, "Write", {
    file_path: "src/b.ts",
    content: "const b = 2;",
  });
  await invokeRun(hook, again);
  again.assertSuccess({});
});

it("keeps the Scope limit and the interpreter-write check while only delegated plans are in effect", async () => {
  delegatedGuardRepo();
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

`readFileSync` が未 import なら `node:fs` の import に足す。
`delegatedGuardRepo` は、4 つのテストと同じ `describe` の中、最初のテストの直前に置く。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN document-workflow-guard.test.ts`
期待: FAIL。`tells the user once when a Write first clears by delegation` が、`first.jsonCalls[0]` が `undefined` であることによる TypeError で落ちる（現在は通知を出さず `success` を返す）。

- [ ] **Step 3: 最小実装を書く**

`workflow-gate.ts` の `TargetEvaluation` の `no-plan-owner`（`:476-482`）に 2 項目足す。

```ts
  | {
      kind: "no-plan-owner";
      implementationPhase: boolean;
      /** What the implementation phase rests on, so the caller can tell a delegated-only relaxation apart. */
      phaseBasis: PhaseBasis;
      /** The spec.md version this was decided against. */
      specHash: string;
      /** Whether the guard may let the write through with a warning. */
      relaxable: boolean;
      diagnosis: GateDiagnosis;
    }
```

`evaluateTarget` の最後の `return`（`:592-597`）に 2 行足す。
この位置では、`ctx.specHash` が `null` の場合を先に deny で返しているので、`ctx.specHash` は文字列である。

```ts
return {
  kind: "no-plan-owner",
  implementationPhase: basis !== "none",
  phaseBasis: basis,
  specHash: ctx.specHash,
  relaxable,
  diagnosis,
};
```

guard の `workflow-audit-log.ts` からの import に `recordDelegationUse` と `recordDelegatedOffPlanWrite` を足す。
`isBlocked` の後ろに関数を 2 つ足す。

```ts
/**
 * A write that clears by the spec's delegation is one the user did not
 * approve plan by plan. Say so the first time each plan-N.md version is used
 * under a spec.md version, with how to take the delegation back. null when
 * there is nothing new to say.
 */
function delegationNotice(
  wfDir: string,
  wfDirLabel: string,
  evaluations: readonly TargetEvaluation[],
): string | null {
  const used: string[] = [];
  let unrecorded = false;
  for (const evaluation of evaluations) {
    if (evaluation.kind !== "allow" || evaluation.basis !== "delegated") {
      continue;
    }
    const record = recordDelegationUse(wfDir, evaluation);
    if (!record.first) continue;
    if (!record.written) unrecorded = true;
    used.push(
      `${evaluation.planName} (hash=${evaluation.planHash.slice(0, 12)})`,
    );
  }
  if (used.length === 0) return null;
  const logLabel = `${wfDirLabel}/${DELEGATION_USES_LOG}`;
  const recordLabel = unrecorded
    ? `記録できなかった（${logLabel} に書けない。この通知は書き込みのたびに出る）`
    : `記録: ${logLabel}`;
  return `[document-workflow-guard] 委任で通した最初の書き込み: ${used.join(", ")}。この plan は利用者が個別に承認していない（spec.md の委任による）。取り消すには ${wfDirLabel}/spec.md の \`- Approval Status:\` の行を pending に戻す。${recordLabel}`;
}

interface DelegatedOffPlan {
  /** Absolute path: the key for "already said", independent of the tool's cwd. */
  target: string;
  /** The target as the tool call named it, for display. */
  label: string;
  specHash: string;
}

/**
 * Under delegation alone, a write no plan-N.md lists rests on no plan the
 * user saw. Say so once per target under a spec.md version; every such write
 * is still in off-plan-writes.log.
 */
function delegatedOffPlanNotice(
  wfDir: string,
  wfDirLabel: string,
  writes: readonly DelegatedOffPlan[],
): string | null {
  const fresh = writes.filter(
    ({ target, specHash }) =>
      recordDelegatedOffPlanWrite(wfDir, { target, specHash }).first,
  );
  if (fresh.length === 0) return null;
  return `[document-workflow-guard] どの plan-N.md にも無いファイルへの書き込みを、委任だけの実装フェーズで通した: ${fresh.map(({ label }) => sanitizeForDisplay(label)).join(", ")}（spec.md の Scope の内側）。利用者が承認した plan に基づかない書き込みである。同じファイルへの以後の書き込みは知らせない。記録: ${wfDirLabel}/off-plan-writes.log`;
}
```

同じ Bash の呼び出しが、同じ plan-N の対象を 2 つ書く場合、1 つ目で記録されるので 2 つ目は `first` が偽になり、名前は 1 回だけ並ぶ。

Write / Edit の経路（`:330-339`）を次の形にする。

```ts
if (evaluation.kind === "allow" || evaluation.kind === "inactive") {
  const notice = delegationNotice(wfDir, wfDirLabel, [evaluation]);
  return notice === null
    ? context.success({})
    : context.json({
        event: "PreToolUse",
        output: { systemMessage: notice },
      });
}
if (evaluation.kind === "no-plan-owner" && evaluation.relaxable) {
  console.error(
    `[document-workflow-guard][off-plan] ${tool_name} target \`${targetPath}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
  );
  appendOffPlanLog(wfDir, tool_name, targetPath);
  const notice = delegatedOffPlanNotice(
    wfDir,
    wfDirLabel,
    evaluation.phaseBasis === "delegated-only"
      ? [
          {
            target: resolve(cwd, expandTilde(targetPath)),
            label: targetPath,
            specHash: evaluation.specHash,
          },
        ]
      : [],
  );
  return notice === null
    ? context.success({})
    : context.json({
        event: "PreToolUse",
        output: { systemMessage: notice },
      });
}
```

`console.error` の文と `appendOffPlanLog` の呼び出しは、現在の `:334-337` と同じである。

Bash の経路は、`blockedIndex === -1` の分岐（`:283-293`）を次の形にする。

```ts
if (blockedIndex === -1) {
  const delegatedOffPlan: DelegatedOffPlan[] = [];
  evaluations.forEach((evaluation, i) => {
    if (evaluation.kind !== "no-plan-owner") return;
    const target = analysis.targets[i] ?? "";
    console.error(
      `[document-workflow-guard][off-plan] Bash target \`${target}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
    );
    appendOffPlanLog(wfDir, "Bash", target);
    if (evaluation.phaseBasis === "delegated-only") {
      delegatedOffPlan.push({
        target: resolve(cwd, expandTilde(target)),
        label: target,
        specHash: evaluation.specHash,
      });
    }
  });
  // The first-use notice comes first so the off-plan one cannot bury it.
  const notices = [
    delegationNotice(wfDir, wfDirLabel, evaluations),
    delegatedOffPlanNotice(wfDir, wfDirLabel, delegatedOffPlan),
  ].filter((notice): notice is string => notice !== null);
  return notices.length === 0
    ? context.success({})
    : context.json({
        event: "PreToolUse",
        output: { systemMessage: notices.join("\n") },
      });
}
```

`console.error` の文と `appendOffPlanLog` の呼び出しは、現在の `:287-290` と同じである。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-gate.test.ts`、`RUN document-workflow-guard.test.ts`、`bun run typecheck`
期待: 3 つとも PASS。人間が承認した plan-N がある場合の off-plan の書き込みは、`phaseBasis` が `approved` なので、現在どおり通知なしで成功する。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/workflow-gate.ts home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/workflow-gate.test.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "feat(hooks): tell the user about writes that rest on delegation alone"
```

### T7: 委任だけの実装フェーズでは tripwire を Scope の外に向ける

**Files:**

- 編集: `hooks/implementations/workflow-bash-sync.ts:49`、`:120-128`、`:280-353`
- テスト: `hooks/tests/unit/workflow-bash-sync.test.ts`
- 参照: `hooks/implementations/workflow-bash-sync.ts:18-23`（tripwire は、gate が閉じたセッションが guard を通らずに行った変更を見つける）
- 参照: `hooks/implementations/document-workflow-guard.ts:228-239`（guard は委任だけのときインタプリタ書き込みの検査を残す）
- 参照: `hooks/lib/workflow-files.ts` の `targetWithinScope`（保護対象のパスには偽を返す）

この決定の理由と、比べた案は「spec との関係」に書いた。
Scope の内側にあっても、保護対象のパスの変更は報告に残る。
`targetWithinScope` が保護対象に偽を返すためである。

gate が判定に使った spec と、Scope の照合に使う spec を同じにする。
`resolveSpecContext` を 1 回呼び、その結果を `implementationPhaseBasis` と照合の両方に渡す。

- [ ] **Step 1: 失敗するテストを書く**

`does not run the tripwire for an approved plan with research.md (implementation phase)` のテストと同じ `describe` の中、そのテストの後に足す。
`node:fs` の import に `mkdirSync` を足す。
`test-helpers.ts` からの import に `buildPlanNContent`、`buildSpecWithScope`、`computeWorkflowRepoPlanHash` を足す。

```ts
it("reports changes outside the Scope, and protected ones inside it, while only delegated plans are in effect", async () => {
  const repo = createGitWorkflowRepo(approvedWorkflowRepo());
  const wf = join(repo, deriveDefaultWorkflowDir(TEST_SESSION_ID));
  unlinkSync(join(wf, "plan.md"));
  const spec = buildSpecWithScope(approvedWorkflowRepo(), ["src/", "home/"]);
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
    ),
  );
  recordApprovalsForTest(wf, { delegateSpec: true });
  envHelper.set("CLAUDE_TEST_CWD", repo);

  const arm = createPostToolUseContextFor(hook, "Bash", { command: "true" });
  await invokeRun(hook, arm);

  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  mkdirSync(join(repo, "other"));
  writeFileSync(join(repo, "other", "leaked.ts"), "export const x = 1;\n");
  mkdirSync(join(repo, "home", "dot_claude"), { recursive: true });
  writeFileSync(
    join(repo, "home", "dot_claude", "x.ts"),
    "export const y = 1;\n",
  );
  const ctx = createPostToolUseContextFor(hook, "Bash", { command: "true" });
  await invokeRun(hook, ctx);

  const tripwire =
    additionalContextOf(ctx)
      .split("\n\n---\n\n")
      .find((section) => section.includes("tripwire")) ?? "";
  match(tripwire, /outside spec\.md's ## Scope/);
  match(tripwire, /other\/leaked\.ts/);
  match(tripwire, /home\/dot_claude\/x\.ts/);
  ok(!/src\/a\.ts/.test(tripwire), tripwire);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `RUN workflow-bash-sync.test.ts`
期待: FAIL。`match(tripwire, /outside spec\.md's ## Scope/)` が落ちる（現在は委任だけの実装フェーズで tripwire を呼ばない）。

- [ ] **Step 3: 最小実装を書く**

`:49` の import を次の形にする。

```ts
import {
  implementationPhaseBasis,
  resolveSpecContext,
} from "../lib/workflow-gate.ts";
import { targetWithinScope } from "../lib/workflow-files.ts";
```

`:120-128` を次の形にする。

```ts
const twoLayer = existsSync(wfPaths.spec);
// The tripwire rests only on a plan the user approved. Under
// delegation alone it keeps watching, and treats changes inside the
// spec's Scope as the delegated plans' own. One context serves both
// the phase decision and the Scope match, so they read the same spec.
const ctx = resolveSpecContext(wfDir, projectRoot);
const basis = implementationPhaseBasis(
  wfDir,
  wfPaths,
  twoLayer,
  projectRoot,
  ctx,
);
if (basis !== "approved") {
  const tripwireMessage = await checkTripwire(
    wfDir,
    cwd,
    getEnv().tripwireGitTimeoutMs,
    basis === "delegated-only"
      ? (absolutePath) =>
          targetWithinScope(ctx.specContent, absolutePath, projectRoot)
      : undefined,
  );
  if (tripwireMessage) sections.push(tripwireMessage);
}
```

`checkTripwire`（`:280-353`）は 3 か所を置き換える。それ以外の行は変えない。

1 つ目は引数である。`timeoutMs: number,` の行の次に 1 行足す。

```ts
  timeoutMs: number,
  isExpected?: (absolutePath: string) => boolean,
): Promise<string | null> {
```

2 つ目は `outside` を求める文である。

```ts
// 置き換え前
const outside = changedRelPaths.filter(
  (relPath) => !isUnderWfDir(resolve(cwd, relPath), wfDir),
);
// 置き換え後
const outside = changedRelPaths.filter((relPath) => {
  const absolutePath = resolve(cwd, relPath);
  return (
    !isUnderWfDir(absolutePath, wfDir) && !(isExpected?.(absolutePath) ?? false)
  );
});
```

3 つ目は関数の最後の `return` である。

```ts
// 置き換え前
return `[workflow-bash-sync] tripwire: gate-closed repo changes outside the workflow dir were detected and recorded in \`off-plan-writes.log\`:\n${shown.join("\n")}${moreLine}`;
// 置き換え後
const heading =
  isExpected === undefined
    ? "tripwire: gate-closed repo changes outside the workflow dir were detected and recorded in `off-plan-writes.log`:"
    : "tripwire: repo changes outside spec.md's ## Scope were detected while only delegated plans are in effect, and recorded in `off-plan-writes.log`:";
return `[workflow-bash-sync] ${heading}\n${shown.join("\n")}${moreLine}`;
```

`isExpected` を渡さない場合のメッセージは、現在の文と 1 文字も変えない。

`isImplementationPhase` は、この変更で実装からの利用が無くなる。
`workflow-gate.ts` の export は残す（gate のテストが使っている）。

git が失敗またはタイムアウトしたときの扱い（`.tripwire-disabled` を書き、以降は走らない）は変えない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `RUN workflow-bash-sync.test.ts`
期待: PASS。既存の `does not run the tripwire for an approved plan with research.md` も通る（`basis` が `approved` なので呼ばれない）。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/workflow-bash-sync.ts home/dot_claude/hooks/tests/unit/workflow-bash-sync.test.ts
git commit -m "feat(hooks): keep the tripwire on changes outside the Scope under delegation alone"
```

### T8: 全体の検査

**Files:**

- 参照: リポジトリ直下の `package.json` の `scripts`（`format`、`test`、`typecheck`、`lint`）
- 参照: リポジトリ直下の `knip.json`（entry は `hooks/implementations/*.ts` と `scripts/*.ts`）

- [ ] **Step 1: 整形してから、全テスト、型検査、lint を実行する**

実行: `bun run format`、`bun run test`、`bun run typecheck`、`bun run lint`
期待: 4 つとも終了コード 0。`bun run format` が書き換えたファイルがあれば、`style(hooks): format` として 1 つコミットする。

- [ ] **Step 2: 未使用の export を確かめる**

実行: `bunx knip`

knip の終了コードは合格条件にしない。
plan-1 の完了時点で、この変更と関係ないファイルの報告が既にあり、終了コードは 1 である。
確かめるのは、この plan が足した、または使い方を変えた export の扱いである。

| export                                             | 報告された場合の対処                                                |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `ApprovalDelegate`                                 | T4 で使うので報告されないはず。報告されたら T4 の import を確かめる |
| `isImplementationPhase`                            | T7 で実装からの利用が無くなる。export を残し、完了報告に書く        |
| `DELEGATE_NO_DESCRIPTION`                          | テストだけが使う。export を残し、完了報告に書く                     |
| `DelegationScopeRow`、`DelegationAnswer`           | 型。export を残し、完了報告に書く                                   |
| `ScopeRow`、`DelegationUse`、`DelegationUseRecord` | 型。export を残し、完了報告に書く                                   |
| `DelegatedOffPlanWrite`                            | 型。export を残し、完了報告に書く                                   |
| 上記以外の、この plan が足した export              | 使う箇所の書き漏れ。該当タスクの Step 3 と突き合わせて直す          |

`isImplementationPhase` を削除するかどうかは plan-3 で決める。
型は、export した関数の引数や戻り値に現れるので残す。

## ISO 25010 具体テストケース

spec の「ISO 25010 次元選択」の 4 特性に対応する。

### セキュリティ

spec: model が委任を自分で成立させられないこと、Scope の外と保護対象へ書けないこと。

- **入力**: 2 問の質問のうち 2 問目を落とした応答（1 問目で spec.md を選択） → **期待**: `malformed`、`approvals.log` は 0 行（T4）
- **入力**: 2 問目の「委任する」の説明文を `Scope: src/` に書き換えた応答 → **期待**: `malformed`、0 行（T4）
- **入力**: 2 問目の 2 つの選択肢の順を入れ替えた応答 → **期待**: `malformed`、0 行（T4）
- **入力**: 質問を組み立てた後で spec.md の Scope に 1 行足し、元の質問のまま応答 → **期待**: `malformed`、0 行（T4）
- **入力**: `projectRoot` を渡さずに 2 問の応答を検証 → **期待**: `malformed`、0 行（T4）
- **入力**: Scope の行が `src/​hidden/`、`ドキュメント/`、121 文字の行 → **期待**: `parseScope` が `{ valid: false, reason: "invalid-entry" }`（T1）
- **入力**: Scope の行が `.//`、`././`、`./src/`、`src//a/`、`.` → **期待**: `parseScope` が `{ valid: false, reason: "invalid-entry" }`（T1）
- **入力**: 対象が `.tmp/sessions/abcd1234/delegation-uses.log`、`.git/config` → **期待**: `isProtectedPath` が `true`（T1）
- **入力**: `link` がリポジトリの直下への symlink で、Scope が `link/`、Files が `link/src/a.ts` → **期待**: `planFilesWithinScope` が `{ ok: false, reason: "outside-scope" }`、`scopeRowsForOffer` の `link/` は `protected: true`（T1）
- **入力**: Scope が `src/gen/`。承認の後で `src/gen` をリポジトリの直下への symlink に差し替え、対象は `other/x.ts` → **期待**: `targetWithinScope` が `false`（T1）
- **入力**: Write で `<wfDir>/delegation-uses.log` に書く → **期待**: guard が deny（T5）
- **入力**: 委任だけの実装フェーズで、Scope 外の `other/leaked.ts` と、Scope 内で保護対象の `home/dot_claude/x.ts` が書き換わる → **期待**: tripwire の報告に両方があり、Scope 内の `src/a.ts` は無い（T7）

### 機能適合性

spec: 委任あり・なし、Scope 内・外、保護対象の有無の各組み合わせで、判定が設計と一致すること。

- **入力**: Scope が `src/` と `home/dot_claude/` の spec.md が承認待ち → **期待**: `ask-approval` の質問が 2 つで、2 問目の説明文は `Scope: src/, home/dot_claude/（委任の対象外）。…`（T2、T3）
- **入力**: 1 問目で spec.md、2 問目で「委任する」 → **期待**: `approvals.log` の行は `["spec.md", <hash>, "ask", "plans-in-scope"]`（T4）
- **入力**: 1 問目で spec.md、2 問目で「委任しない」 → **期待**: 行の `delegate` は `undefined`（T4）
- **入力**: 1 問目が「承認しない」、2 問目が「委任する」または自由入力 → **期待**: `decline`、0 行（T4）
- **入力**: spec.md が承認済みで、候補が plan-1.md だけ → **期待**: 質問は 1 つ（T3）
- **入力**: Scope の全行が保護対象 → **期待**: 質問は 1 つ（T1、T3）
- **入力**: 委任ありで、委任で通る plan-1 と Scope 外の plan-2 が承認待ちのとき、利用者が `承認` と打つ → **期待**: plan-2.md だけが記録され、plan-1.md の行は無い（T4）

### 信頼性

spec: 読めない・無効な場合に、閉じる側へ倒れること。

- **入力**: `delegation-uses.log` が dir で書けない → **期待**: `recordDelegationUse` は 2 回とも `{ first: true, written: false }`（T5）
- **入力**: Scope の行が、先の無い symlink を指す → **期待**: その行は `protected: true`（T1）
- **入力**: 2 問目の答えが文字列でない（配列）、1 問目は spec.md → **期待**: `malformed`、0 行（T4）
- **入力**: 同じ plan-N の版で、spec の hash だけが違う → **期待**: `recordDelegationUse` の `first` が `true`（T5）

### 使用性

spec: 委任の問い、通知、`status` の表示から、利用者が委任の状態と取り消し方を読み取れること。

- **入力**: 委任で通る plan-1 の対象へ、最初の Write → **期待**: `systemMessage` に `plan-1.md (hash=<12 桁>)`、「spec.md の `- Approval Status:` の行を pending に戻す」、記録先があり、`hookSpecificOutput` は無い（T6）
- **入力**: 同じ plan-1 の対象へ、2 回目の Write → **期待**: 通知なしで成功（T6）
- **入力**: 委任で通る plan-1 の対象へ、Bash の `echo x > src/a.ts` → **期待**: `systemMessage` に `plan-1.md (hash=<12 桁>)`（T6）
- **入力**: 委任だけの実装フェーズで、Scope 内でどの plan-N にも無い `src/b.ts` へ Write → **期待**: `systemMessage` に `src/b.ts` と `off-plan-writes.log`。同じファイルへの 2 回目は通知なしで成功（T6）
- **入力**: 委任ありの二層の wfDir で `workflow-cli status` → **期待**: `delegation: active` で始まり、`spec.md` と `Approval Status` を含む行がある。委任なしでは `delegation: none`（T3）
- **入力**: 2 問目に自由入力「あとで決める」、1 問目は spec.md → **期待**: `freeText` で本文は「あとで決める」、0 行（T4）
- **入力**: Scope が有効な spec.md で `ask-approval` → **期待**: 標準エラーに `project root: ` で始まる行（T3）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: 書かれたテストが落ちる箇所も、既存テストを壊す箇所も無い（`malformed` の表 17 件を個別に追った）。T8 の knip の期待は、ファイル内だけで使う export を「書き漏れ」と誤認させる。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T7 の tripwire の変更は spec に無く、止めたままにする案や Scope で絞らない案との比較が無い。CLI の置き換え範囲が一意でない。ISO のケースと spec の 4 特性の対応が明示されていない。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: 依存方向に循環は無い。tripwire が spec.md を gate とは別に読む。発話の経路だけ候補の列挙にプロジェクトルートを渡していない。CLI と hook のルートが食い違うと原因の分からない `malformed` になる。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 委任の行を model が成立させる経路は開かない。Scope の行の文字と長さに制限が無く、説明文を紛らわしくできる。Scope が workflow dir や `.git/` を覆うと、通知の記録を Bash で書ける。通知の重複抑止のキーに spec の hash が無い。

### resilience-analyzer

- verdict: pass
- 主指摘: 承認に関わる側は失敗時に閉じ、監査の記録は呼び出しを止めない。記録に失敗しても通知が記録先を示す。Scope 内で plan-N に無いファイルへの書き込みには委任の通知が出ない。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: 変更点を worktree のコードと既存テストで追い、落ちるテストも壊れる既存テストも無い。T8 の表が、テストだけが使う export を扱っていない。`delegationNotice` の中で `record` という名前が重なる。

### scope-justification-reviewer

- verdict: pass
- 主指摘: Round 1 の 5 点は解消。spec を改訂せず plan-2 で決める進め方は妥当（範囲を狭めるか、通知を足すだけ）。ADR-0028 に 4 点を記録する義務を plan-2 に書く。off-plan の通知が毎回出るのは、T7 で退けた案と同じ失敗の形。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: `.//` や `././` の行が文字の制限を通り、リポジトリ全体を覆う。質問には見慣れない 1 行だけが出る。off-plan の通知に重複抑止が無く、最初の委任の通知が埋もれる。委任の記録条件は緩んでおらず、model が成立させる経路は増えていない。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=6017f93c3ddfee66e354b383c769df9bc7ccb71e133f1197565633b2bf70ccb0; design-hash=762586c1810988da1593ea5b6ed2c343829c364377b923ba33ca0f5c17e0366a; round=1; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T05:12:47.651Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+security-vulnerability-analyzer+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 変えた箇所を追い、指摘は無い。Scope の行の新しい検査で、既存テストの結果は変わらない。承認候補の列挙と型の絞り込みの 2 点は、読んでの推論で、実装後の検査で確定する。

### security-vulnerability-analyzer

- verdict: needs-work
- 主指摘: 要素ごとの検査を抜ける行は無い。symlink を指す Scope の行が、リポジトリ全体や別の dir を覆える（委任された実装の途中で symlink に差し替える経路を含む）。off-plan の通知のキーが作業 dir に依存する生の文字列で、別のファイルが同じキーになる。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=564fe1b27b0802448467ce400bff818b7ace4571e7b4ddb792b8786c1138aeb5; design-hash=13e5cc9bf8701cbd1b91f8802b7f5e45842e3551d5fc8ffadb9bb3f139cee278; round=2; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T05:26:42.258Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 4)

自己延長した周（予算 3 を超過）。延長の理由は `round-extensions.log` にある。

### logic-validator

- verdict: pass
- 主指摘: 指摘は無い。`resolveScopeEntry` を入れても、repo が realpath でないテストを含め、symlink の無い行では字面と解決が一致する。新しいテスト 2 件は変更前のコードで落ちる。

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: Round 3 の 2 件は解消し、新しい穴は無い。Bash の対象が `link/../x` の形だと通知のキーが別のファイルと重なりうるが、意図的な迂回の範囲（ADR-0023）。

### scope-justification-reviewer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

### resilience-analyzer

- verdict: pass (carried from Round 3)
- 主指摘: Round 3 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=33707f15d0be7a1e9fad6810f186cfd9ce66b5c04589ebeca9dc980194673a32; design-hash=60a81031a74677703b699a53a5400d39d7cb062f021e700358ffecc5457320b2; round=3; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T05:30:28.217Z; reviewers=logic-validator+security-vulnerability-analyzer -->

<!-- auto-review: verdict=pass; hash=5fd0c3c4f583b3e0428624a86649b451dffbe687fa1775b61c37d3be3bf8dad7; design-hash=cfddfa2ff393a408dd1e8f73d0cba7563e2fab952e501c0c7a121e0e2b0566e3; round=4; parent-spec-hash=aa725fce432b4962f1355381f0f885195b9f804a337aab50d3254fe8a89b2c95; at=2026-10-06T05:32:59.650Z; reviewers=logic-validator+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=32; excluded=0; at=2026-10-06T05:32:59.669Z -->
