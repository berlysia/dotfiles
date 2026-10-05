この文書のパスは作業時のもので、`.tmp/` と scratchpad は残っていない。

<!-- spec-ref: spec.md -->

# Plan: complexity-delta hook の実装 (Execution layer)

spec.md（hash `bb11a37c2f69`）の全体を、この 1 本で実装する。作業はワークツリー `.git/worktree/feat/complexity-delta-notice`（ブランチ `feat/complexity-delta-notice`）で行う。以下のパスはリポジトリ相対で、コマンドはワークツリーの直下で実行する。

テストは `node:test` で書き、1 ファイルを次の形で実行する（`package.json:13` の `test` から導いた）。

```
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/<名前>.test.ts
```

## spec の承認後に確かめた事実

- `cccc` はルートの外を指す symlink をたどらない（spec の R8 は解消。`research.md`「spec の承認後に確かめたこと」）
- 生成した 1 万ファイルで 35〜37 ミリ秒、3 万ファイルで 149〜156 ミリ秒（spec の R2 の実測。同上）
- `execFileSync` の例外の形は node と bun で同じだった。timeout は `code: "ETIMEDOUT"`、`maxBuffer` 超過は `code: "ENOBUFS"`、終了コード 2 は `status: 2`
- `systemMessage` がモデルの入力に入らないことは、`home/dot_claude/hooks/implementations/session.ts:286-291` のコメントに「Claude Code 2.1.234 の binary 実測」として記録がある
- `tsconfig.json` は `noUncheckedIndexedAccess` と `exactOptionalPropertyTypes` が有効

## 設計の補足（spec の範囲内で、実装の形を決めたもの）

- 状態ディレクトリと PATH は、入口の関数に引数で渡す。テストは `process.env.HOME` も `process.env.PATH` も書き換えず、一時ディレクトリを渡して実行する
- `cccc` の timeout も同じ引数で渡す（既定は 1000 ミリ秒）。テストは通常の場合に 10000、timeout を起こす場合に 200 を渡し、負荷の高い機械でも結果が変わらないようにする。本番の値は変わらない
- `Report.byKey` は `Map` にし、挿入の順序を保つ。鍵は必ず `<パス> :: ` で始まるので、オブジェクトの既定のプロパティ名（`__proto__` など）と一致することは無い
- 鍵は `<パス> :: <name:kind を " > " でつないだもの>`。名前に `>` や `:` を含む関数があると、別の関数と同じ鍵になりうる。その場合は同じ鍵の関数として K5 の対応づけに入り、1 つの鍵の中で取り違えが起きる。状態は壊れない。読みやすさを優先して、この形のままにする
- （spec の例との差）文面は、先頭に `[complexity-delta] Cognitive complexity rose this turn (>= 25, new or +5):` の 1 行を置き、その下に 1 件 1 行で並べる。spec の例は 1 件の行に接頭辞を付けた形だが、複数件のときに接頭辞を繰り返さないよう先頭行にまとめる。既存の hook の出力が英語なので英語にする
- ログの `notice` に書くのは、UI に 1 行ずつ出した該当（10 件まで）だけである。spec の「UI へ出した該当」に合わせる。10 件を超えた分の内容はログに残らない
- 状態を書いてからログを書く。書き込みに失敗したとき、ログにだけ「やめた」が残るのを避ける
- 状態の書き込みに失敗したときは、例外として入口の `catch` に届き、何も出さずに終わる。基準を消すための書き込みが失敗した場合は、前のプロンプトの基準がファイルに残る。spec の「前のプロンプトの基準は残さない」は、書けたときの規則として扱う。次のプロンプトの書き込みが通れば上書きされる
- spec の「計測から比較までで起きた例外は計測の失敗として扱う」は、`toBaseline` と `diffReports` の呼び出しを包んで実装する。検証を通った値からこの 2 つが例外を出す入力は作れないので、この経路のテストは書かない

## Files

```
# 新規作成
home/dot_claude/hooks/lib/complexity-delta.ts
home/dot_claude/hooks/implementations/complexity-delta.ts

# 編集
home/dot_claude/hooks/types/logging-types.ts
home/dot_claude/hooks/lib/centralized-logging.ts
home/dot_claude/.settings.hooks.json.tmpl

# テスト
home/dot_claude/hooks/tests/unit/complexity-logging.test.ts
home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts
home/dot_claude/hooks/tests/unit/complexity-delta.test.ts

# 文書（.tmp/sessions/deefa448/ と scratchpad からの写し）
docs/plans/complexity-delta/spec.md
docs/plans/complexity-delta/plan-1.md
docs/plans/complexity-delta/research.md
docs/plans/complexity-delta/replay.sh
docs/plans/complexity-delta/flat.jq
docs/plans/complexity-delta/probe.sh
```

## Tasks

### T0: ワークツリーの準備

**Files:**

- 参照: `package.json:13`（`test` の定義）

- [ ] **Step 1: 依存を入れる**

実行: `bun install`
期待: 終了コード 0。`home/dot_claude/node_modules/cc-hooks-ts` ができる

- [ ] **Step 2: 変更前のテストが通ることを確かめる**

実行: `bun run test`
期待: 失敗 0 件。失敗があれば、その名前を記録してから先へ進む（この plan の変更と区別するため）

### T1: ログの種類 `complexity` を足す

**Files:**

- 編集: `home/dot_claude/hooks/types/logging-types.ts:44-63`
- 編集: `home/dot_claude/hooks/lib/centralized-logging.ts:18-28`、`:220-237` の後、`:312-320` の後
- テスト: `home/dot_claude/hooks/tests/unit/complexity-logging.test.ts`
- 参照: `home/dot_claude/hooks/lib/centralized-logging.ts:56-78`（`getLogFilePath` が `${category}.jsonl` を作り、`writeLog` がローテーションまで受け持つ。種類ごとの分岐は無い）

- [ ] **Step 1: 失敗するテストを書く**

`CLAUDE_LOGS_DIR` は `tests/preload-test-env.mjs` が一時ディレクトリに設定する。fixture は使わない。

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { logComplexity } from "../../lib/centralized-logging.ts";
import type { ComplexityLogEntry } from "../../types/logging-types.ts";

function readEntries(sessionId: string): ComplexityLogEntry[] {
  const logDir = process.env.CLAUDE_LOGS_DIR;
  assert.ok(logDir, "run with --import tests/preload-test-env.mjs");
  return readFileSync(join(logDir, "complexity.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ComplexityLogEntry)
    .filter((entry) => entry.session_id === sessionId);
}

describe("logComplexity", () => {
  it("writes a notice with structured findings to complexity.jsonl", () => {
    logComplexity(
      {
        kind: "notice",
        root: "/repo",
        findings: [
          { path: "a.ts", line: 3, name: "f", before: 24, after: 44 },
          { path: "b.ts", line: null, name: "g", before: null, after: 30 },
        ],
      },
      "logging-notice",
    );
    const [entry] = readEntries("logging-notice");
    assert.ok(entry);
    assert.equal(entry.kind, "notice");
    assert.equal(entry.root, "/repo");
    assert.deepEqual(entry.findings, [
      { path: "a.ts", line: 3, name: "f", before: 24, after: 44 },
      { path: "b.ts", line: null, name: "g", before: null, after: 30 },
    ]);
    assert.ok(entry.timestamp);
  });

  it("writes a skip with reason, binary and recovery", () => {
    logComplexity(
      {
        kind: "skip",
        root: "/repo",
        reason: "cccc-not-found",
        recovery: "put cccc on PATH",
      },
      "logging-skip",
    );
    const [entry] = readEntries("logging-skip");
    assert.ok(entry);
    assert.equal(entry.reason, "cccc-not-found");
    assert.equal(entry.recovery, "put cccc on PATH");
    assert.equal("binary" in entry, false);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/complexity-logging.test.ts`
期待: FAIL。`logComplexity` が `centralized-logging.ts` に無いという SyntaxError

- [ ] **Step 3: 最小実装を書く**

`types/logging-types.ts` の `QualityLogEntry` の後に足し、`LogEntry` と `LogCategory` に加える。

```ts
interface ComplexityFindingLog {
  path: string;
  line: number | null;
  name: string;
  before: number | null;
  after: number;
}

export interface ComplexityLogEntry extends BaseLogEntry {
  kind: "notice" | "skip" | "disabled";
  root: string;
  reason?: "cccc-not-found" | "timeout" | "failed" | "schema" | "state";
  binary?: string;
  recovery?: string;
  findings?: ComplexityFindingLog[];
}

export type LogEntry =
  | EventLogEntry
  | CommandLogEntry
  | ToolLogEntry
  | DecisionLogEntry
  | QualityLogEntry
  | ComplexityLogEntry;

export type LogCategory =
  "events" | "commands" | "tools" | "decisions" | "quality" | "complexity";
```

`lib/centralized-logging.ts` の import に `ComplexityLogEntry` を足し、クラスの `logQuality` の後にメソッドを、ファイルの `logQuality` の後に関数を足す。

```ts
  logComplexity(
    fields: Omit<ComplexityLogEntry, keyof BaseLogEntry>,
    sessionId?: string,
  ): void {
    const entry: ComplexityLogEntry = {
      ...this.createBaseEntry(),
      ...fields,
      ...(sessionId && { session_id: sessionId }),
    };

    this.writeLog("complexity", entry);
  }
```

```ts
/**
 * 便利関数：複雑度の通知と計測の省略のログ
 */
export function logComplexity(
  fields: Omit<ComplexityLogEntry, keyof BaseLogEntry>,
  sessionId?: string,
): void {
  getLogger().logComplexity(fields, sessionId);
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じコマンド、続けて `bun run typecheck`
期待: 2 件 PASS。typecheck は終了コード 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/types/logging-types.ts home/dot_claude/hooks/lib/centralized-logging.ts home/dot_claude/hooks/tests/unit/complexity-logging.test.ts
git commit -m "feat(hooks): add a complexity log category"
```

### T2: `cccc` の出力の検証と平坦化

**Files:**

- 新規: `home/dot_claude/hooks/lib/complexity-delta.ts`
- テスト: `home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts`
- 参照: spec.md「計測」（必須と任意のフィールド、64 段、構文エラーの判定）
- 参照: `research.md`「cccc の仕様」（実際の出力の形、`<anonymous>`、同名メソッド）

- [ ] **Step 1: 失敗するテストを書く**

fixture は冒頭に inline で定義する。

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCcccOutput, toBaseline } from "../../lib/complexity-delta.ts";

type Fn = {
  name: unknown;
  kind?: unknown;
  line?: unknown;
  cognitive: unknown;
  children?: unknown;
};
const file = (path: string, functions: Fn[], extra: object = {}) => ({
  path,
  functions,
  ...extra,
});
const output = (files: unknown[], summary: object = {}) =>
  JSON.stringify({ files, summary });
const fn = (name: string, cognitive: number, line = 1, kind = "function") => ({
  name,
  kind,
  line,
  cognitive,
});

describe("parseCcccOutput", () => {
  it("flattens nested functions into parent-chain keys without line numbers", () => {
    const report = parseCcccOutput(
      output([
        file("./a.ts", [
          {
            ...fn("outer", 3, 10),
            children: [fn("<anonymous>", 7, 12, "arrow")],
          },
        ]),
      ]),
    );
    assert.ok(report);
    assert.deepEqual(
      [...report.byKey.keys()],
      ["a.ts :: outer:function", "a.ts :: outer:function > <anonymous>:arrow"],
    );
    assert.deepEqual(
      report.byKey.get("a.ts :: outer:function > <anonymous>:arrow"),
      [{ path: "a.ts", name: "<anonymous>", line: 12, cognitive: 7 }],
    );
  });

  it("collects same-key functions into one list", () => {
    const report = parseCcccOutput(
      output([
        file("./a.ts", [fn("run", 1, 1, "method"), fn("run", 3, 2, "method")]),
      ]),
    );
    assert.deepEqual(
      report?.byKey.get("a.ts :: run:method")?.map((m) => m.cognitive),
      [1, 3],
    );
  });

  it("treats a missing kind as empty, a non-integer line as null, and non-array children as none", () => {
    const report = parseCcccOutput(
      output([
        file("a.ts", [
          { name: "f", cognitive: 2, line: "x", children: "nope" },
        ]),
      ]),
    );
    assert.deepEqual(report?.byKey.get("a.ts :: f:"), [
      { path: "a.ts", name: "f", line: null, cognitive: 2 },
    ]);
  });

  it("marks parse-error files from either the file entry or the summary", () => {
    const report = parseCcccOutput(
      output(
        [
          file("./bad.ts", [], { parse_errors: ["Expected `,`"] }),
          file("./ok.ts", []),
        ],
        { parse_error_files: ["./other.ts", 7] },
      ),
    );
    assert.deepEqual(report?.parseErrorFiles, ["bad.ts", "other.ts"]);
  });

  it("returns null for anything that does not match the contract", () => {
    const cases: string[] = [
      "not json",
      "[]",
      JSON.stringify({ files: "x" }),
      output([{ path: 1, functions: [] }]),
      output([{ path: "a.ts", functions: "x" }]),
      output([file("a.ts", [{ name: 1, cognitive: 1 }])]),
      output([file("a.ts", [{ name: "f", cognitive: "1" }])]),
      output([file("a.ts", [{ name: "f", cognitive: Number.NaN }])]),
      output([file("a.ts", ["not an object"])]),
    ];
    for (const raw of cases) {
      assert.equal(parseCcccOutput(raw), null, raw);
    }
  });

  it("accepts 64 levels of nesting and rejects 65", () => {
    const nest = (depth: number): Fn =>
      depth === 1
        ? fn("leaf", 1)
        : { ...fn(`n${depth}`, 1), children: [nest(depth - 1)] };
    assert.ok(parseCcccOutput(output([file("a.ts", [nest(64)])])));
    assert.equal(parseCcccOutput(output([file("a.ts", [nest(65)])])), null);
  });

  it("turns a report into a baseline of values per key", () => {
    const report = parseCcccOutput(
      output([
        file("./a.ts", [fn("run", 1, 1, "method"), fn("run", 3, 2, "method")]),
      ]),
    );
    assert.ok(report);
    assert.deepEqual(toBaseline(report), {
      functions: { "a.ts :: run:method": [1, 3] },
      parseErrorFiles: [],
    });
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts`
期待: FAIL。`lib/complexity-delta.ts` が無いという ERR_MODULE_NOT_FOUND

- [ ] **Step 3: 最小実装を書く**

この Step で書くのは `parseCcccOutput`、`toBaseline` と、その型だけである。import は要らない。

```ts
const MAX_NESTING_DEPTH = 64;

type FunctionMetric = {
  path: string;
  name: string;
  line: number | null;
  cognitive: number;
};

/** One measurement of a tree. Keys are `<path> :: <parent chain of name:kind>`. */
export type Report = {
  byKey: Map<string, FunctionMetric[]>;
  parseErrorFiles: string[];
};

/** What survives between the prompt and the stop: values only, no line numbers. */
export type Baseline = {
  functions: Record<string, number[]>;
  parseErrorFiles: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Validates cccc's JSON and flattens it. Returns null for any input outside the
 * contract instead of throwing: the tool is updated by Renovate, and a shape
 * change must turn into a logged skip, not an exception in every project.
 */
export function parseCcccOutput(raw: string): Report | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || !Array.isArray(data.files)) return null;

  const byKey = new Map<string, FunctionMetric[]>();
  const parseErrorFiles = new Set<string>();

  const walk = (
    path: string,
    node: unknown,
    chain: readonly string[],
    depth: number,
  ): boolean => {
    if (depth > MAX_NESTING_DEPTH || !isRecord(node)) return false;
    const { name, cognitive } = node;
    if (typeof name !== "string") return false;
    if (typeof cognitive !== "number" || !Number.isFinite(cognitive))
      return false;
    const kind = typeof node.kind === "string" ? node.kind : "";
    const line =
      typeof node.line === "number" && Number.isInteger(node.line)
        ? node.line
        : null;
    const nextChain = [...chain, `${name}:${kind}`];
    const key = `${path} :: ${nextChain.join(" > ")}`;
    const metrics = byKey.get(key) ?? [];
    metrics.push({ path, name, line, cognitive });
    byKey.set(key, metrics);
    const children: unknown[] = Array.isArray(node.children)
      ? node.children
      : [];
    return children.every((child) => walk(path, child, nextChain, depth + 1));
  };

  for (const file of data.files as unknown[]) {
    if (!isRecord(file)) return null;
    if (typeof file.path !== "string" || !Array.isArray(file.functions))
      return null;
    const path = normalizePath(file.path);
    if (Array.isArray(file.parse_errors) && file.parse_errors.length > 0) {
      parseErrorFiles.add(path);
    }
    for (const node of file.functions as unknown[]) {
      if (!walk(path, node, [], 1)) return null;
    }
  }

  const { summary } = data;
  if (isRecord(summary) && Array.isArray(summary.parse_error_files)) {
    for (const path of summary.parse_error_files as unknown[]) {
      if (typeof path === "string") parseErrorFiles.add(normalizePath(path));
    }
  }

  return { byKey, parseErrorFiles: [...parseErrorFiles].sort() };
}

export function toBaseline(report: Report): Baseline {
  return {
    functions: Object.fromEntries(
      [...report.byKey].map(([key, metrics]) => [
        key,
        metrics.map((metric) => metric.cognitive),
      ]),
    ),
    parseErrorFiles: report.parseErrorFiles,
  };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: Step 2 と同じコマンド
期待: `parseCcccOutput` の 7 件が PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/complexity-delta.ts home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts
git commit -m "feat(hooks): validate and flatten cccc output"
```

### T3: 比較の規則

**Files:**

- 編集: `home/dot_claude/hooks/lib/complexity-delta.ts`
- テスト: `home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts`
- 参照: spec.md「比較の規則」（境界の例をそのままテストにする）

- [ ] **Step 1: 失敗するテストを書く**

T2 のテストファイルに足す。lib からの import を次の形に変える。

```ts
import {
  type Baseline,
  type Finding,
  diffReports,
  parseCcccOutput,
  toBaseline,
} from "../../lib/complexity-delta.ts";
```

```ts
const reportOf = (files: unknown[], summary: object = {}) => {
  const report = parseCcccOutput(output(files, summary));
  assert.ok(report);
  return report;
};
const baselineOf = (files: unknown[], summary: object = {}): Baseline =>
  toBaseline(reportOf(files, summary));
const diff = (before: unknown[], after: unknown[]): Finding[] =>
  diffReports(baselineOf(before), reportOf(after));

describe("diffReports", () => {
  const one = (cognitive: number, line = 1) => [
    file("a.ts", [fn("f", cognitive, line)]),
  ];

  it("applies the threshold and the minimum rise at their boundaries", () => {
    assert.deepEqual(diff(one(24), one(29, 7)), [
      { path: "a.ts", name: "f", line: 7, before: 24, after: 29 },
    ]);
    assert.deepEqual(diff(one(20), one(25)), [
      { path: "a.ts", name: "f", line: 1, before: 20, after: 25 },
    ]);
    assert.deepEqual(diff(one(21), one(25)), []);
    assert.deepEqual(diff(one(25), one(29)), []);
    assert.deepEqual(diff(one(19), one(24)), []);
  });

  it("reports an added function at 25 and not at 24", () => {
    assert.deepEqual(diff([file("a.ts", [])], one(25)), [
      { path: "a.ts", name: "f", line: 1, before: null, after: 25 },
    ]);
    assert.deepEqual(diff([file("a.ts", [])], one(24)), []);
  });

  it("reports every function of a file that the baseline does not have as added", () => {
    assert.deepEqual(diff([], one(40)), [
      { path: "a.ts", name: "f", line: 1, before: null, after: 40 },
    ]);
  });

  it("reports nothing for a function that was removed", () => {
    assert.deepEqual(diff(one(40), [file("a.ts", [])]), []);
  });

  it("cancels equal values before pairing, so an untouched sibling is not blamed", () => {
    const before = [
      file("a.ts", [fn("<anonymous>", 30, 1), fn("<anonymous>", 2, 2)]),
    ];
    const after = [
      file("a.ts", [
        fn("<anonymous>", 40, 1),
        fn("<anonymous>", 30, 5),
        fn("<anonymous>", 2, 6),
      ]),
    ];
    assert.deepEqual(diff(before, after), [
      { path: "a.ts", name: "<anonymous>", line: 1, before: null, after: 40 },
    ]);
  });

  it("pairs the remainder by descending rank", () => {
    const before = [file("a.ts", [fn("run", 30, 1), fn("run", 28, 2)])];
    const after = [file("a.ts", [fn("run", 33, 1), fn("run", 30, 2)])];
    assert.deepEqual(diff(before, after), [
      { path: "a.ts", name: "run", line: 1, before: 28, after: 33 },
    ]);
  });

  it("skips files that had a parse error in either measurement", () => {
    const broken = [file("a.ts", [], { parse_errors: ["x"] })];
    assert.deepEqual(diff(broken, one(40)), []);
    assert.deepEqual(
      diffReports(
        baselineOf(one(10)),
        reportOf([file("a.ts", [fn("f", 40)], { parse_errors: ["x"] })]),
      ),
      [],
    );
  });

  it("orders by rise, then path, name and line", () => {
    const before = [
      file("b.ts", [fn("g", 20), fn("h", 20)]),
      file("a.ts", [fn("z", 20), fn("k", 10)]),
    ];
    const after = [
      file("b.ts", [fn("g", 30, 9), fn("h", 30, 3)]),
      file("a.ts", [fn("z", 30, 4), fn("k", 40, 2)]),
    ];
    assert.deepEqual(
      diff(before, after).map((f) => `${f.path}:${f.name}`),
      ["a.ts:k", "a.ts:z", "b.ts:g", "b.ts:h"],
    );
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: T2 Step 2 と同じコマンド
期待: FAIL。`diffReports` が export されていないという SyntaxError

- [ ] **Step 3: 最小実装を書く**

`lib/complexity-delta.ts` に足す。定数は `MAX_NESTING_DEPTH` の前に、`Finding` は `Baseline` の後に置く。

```ts
// Thresholds come from replaying 150 commits of this repository's hooks; see
// docs/plans/complexity-delta/research.md before changing them.
const COGNITIVE_THRESHOLD = 25;
const MIN_RISE = 5;

export type Finding = {
  path: string;
  name: string;
  line: number | null;
  before: number | null;
  after: number;
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Findings for one key. Equal values are cancelled first so that an untouched
 * function never pairs with a changed one; what remains is paired by rank.
 */
function diffKey(
  before: readonly number[],
  current: readonly FunctionMetric[],
): Finding[] {
  const remainingBefore = [...before];
  const changed: FunctionMetric[] = [];
  for (const metric of current) {
    const index = remainingBefore.indexOf(metric.cognitive);
    if (index === -1) {
      changed.push(metric);
    } else {
      remainingBefore.splice(index, 1);
    }
  }
  remainingBefore.sort((a, b) => b - a);
  changed.sort(
    (a, b) => b.cognitive - a.cognitive || (a.line ?? 0) - (b.line ?? 0),
  );

  const findings: Finding[] = [];
  changed.forEach((metric, rank) => {
    const paired = remainingBefore[rank] ?? null;
    if (metric.cognitive < COGNITIVE_THRESHOLD) return;
    if (paired !== null && metric.cognitive - paired < MIN_RISE) return;
    findings.push({
      path: metric.path,
      name: metric.name,
      line: metric.line,
      before: paired,
      after: metric.cognitive,
    });
  });
  return findings;
}

export function diffReports(baseline: Baseline, current: Report): Finding[] {
  const skipped = new Set([
    ...baseline.parseErrorFiles,
    ...current.parseErrorFiles,
  ]);
  const findings: Finding[] = [];
  for (const [key, metrics] of current.byKey) {
    const compared = metrics.filter((metric) => !skipped.has(metric.path));
    if (compared.length === 0) continue;
    findings.push(...diffKey(baseline.functions[key] ?? [], compared));
  }
  const rise = (finding: Finding) => finding.after - (finding.before ?? 0);
  return findings.sort(
    (a, b) =>
      rise(b) - rise(a) ||
      compareText(a.path, b.path) ||
      compareText(a.name, b.name) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: T2 Step 2 と同じコマンド
期待: `diffReports` の 8 件を含めて 15 件が PASS

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/complexity-delta.ts home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts
git commit -m "feat(hooks): compare complexity snapshots per function"
```

### T4: 通知の文面と `cccc` の候補

**Files:**

- 編集: `home/dot_claude/hooks/lib/complexity-delta.ts`
- テスト: `home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts`
- 参照: `home/dot_claude/hooks/lib/sanitize-display.ts:61-87`（除く文字の集合と 256 文字の上限）
- 参照: spec.md「通知の文面」「計測」

- [ ] **Step 1: 失敗するテストを書く**

lib からの import に `formatNotice`、`hashNotice`、`isUsableCccc`、`listCcccCandidates`、`shownFindings` を足す。テストのソースには、制御文字も `\u` で始まるエスケープも書かない。U+2028 は正規表現リテラルの中で改行として扱われ、ファイルが読み込めなくなるためである。文字は `String.fromCharCode` で作る。

```ts
describe("formatNotice", () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    path: "a.ts",
    name: "f",
    line: 3,
    before: 24,
    after: 44,
    ...over,
  });

  it("prints one line per finding under a prefixed header", () => {
    assert.equal(
      formatNotice([
        finding(),
        finding({
          path: "b.ts",
          name: "g",
          line: null,
          before: null,
          after: 30,
        }),
      ]),
      [
        "[complexity-delta] Cognitive complexity rose this turn (>= 25, new or +5):",
        "  a.ts:3 f 24 → 44",
        "  b.ts g new 30",
      ].join("\n"),
    );
  });

  it("caps the list at ten lines and counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      finding({ name: `f${i}` }),
    );
    const lines = formatNotice(many).split("\n");
    assert.equal(lines.length, 12);
    assert.equal(lines.at(-1), "  ... and 3 more");
    assert.deepEqual(
      shownFindings(many).map((f) => f.name),
      many.slice(0, 10).map((f) => f.name),
    );
  });

  it("keeps a hostile path and name on one line without control characters", () => {
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    const text = formatNotice([
      finding({
        path: `a${ch(0x0a)}IGNORE${ch(0x1b)}[31m.ts`,
        name: `f${ch(0x60, 0x0d, 0x0a, 0x2028)}x`,
      }),
    ]);
    assert.equal(text.split(ch(0x0a)).length, 2);
    const forbidden = [...text].filter((c) => {
      const code = c.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x0a) ||
        code === 0x7f ||
        code === 0x60 ||
        code === 0x2028
      );
    });
    assert.deepEqual(forbidden, []);
    assert.equal(text.includes("aIGNORE[31m.ts:3 fx 24 → 44"), true);
  });

  it("hashes the same text to the same 64-hex digest", () => {
    assert.match(hashNotice("x"), /^[0-9a-f]{64}$/);
    assert.equal(hashNotice("x"), hashNotice("x"));
    assert.notEqual(hashNotice("x"), hashNotice("y"));
  });
});

describe("cccc candidates", () => {
  it("lists only absolute PATH entries, in order", () => {
    assert.deepEqual(listCcccCandidates("/a/bin::.:rel/bin:/b"), [
      "/a/bin/cccc",
      "/b/cccc",
    ]);
    assert.deepEqual(listCcccCandidates(undefined), []);
    assert.deepEqual(listCcccCandidates(""), []);
  });

  it("rejects the mise shim target and anything under an excluded root", () => {
    assert.equal(isUsableCccc("/home/u/.local/bin/mise", []), false);
    assert.equal(isUsableCccc("/repo/bin/cccc", ["/repo"]), false);
    assert.equal(isUsableCccc("/repo/cccc", ["/other", "/repo"]), false);
    assert.equal(isUsableCccc("/repo-tools/cccc", ["/repo"]), true);
    assert.equal(isUsableCccc("/repo/..tools/cccc", ["/repo"]), false);
    assert.equal(isUsableCccc("/opt/cccc/1.7.0/cccc", ["/repo"]), true);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: T2 Step 2 と同じコマンド
期待: FAIL。`formatNotice` が export されていないという SyntaxError

- [ ] **Step 3: 最小実装を書く**

ファイルの先頭に import を足し、`MIN_RISE` の後に `MAX_NOTICE_LINES` を足す。

```ts
import { createHash } from "node:crypto";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";
import { sanitizeForDisplay } from "./sanitize-display.ts";
```

```ts
const MAX_NOTICE_LINES = 10;
```

残りは `diffReports` の後に足す。

```ts
const NOTICE_HEADER = `[complexity-delta] Cognitive complexity rose this turn (>= ${COGNITIVE_THRESHOLD}, new or +${MIN_RISE}):`;

/** The findings that get a line of their own; the rest are only counted. */
export function shownFindings(findings: readonly Finding[]): Finding[] {
  return findings.slice(0, MAX_NOTICE_LINES);
}

/** The text shown in the UI. Paths and names come from the opened repository. */
export function formatNotice(findings: readonly Finding[]): string {
  const lines = shownFindings(findings).map((finding) => {
    const path = sanitizeForDisplay(finding.path);
    const where = finding.line === null ? path : `${path}:${finding.line}`;
    const change =
      finding.before === null
        ? `new ${finding.after}`
        : `${finding.before} → ${finding.after}`;
    return `  ${where} ${sanitizeForDisplay(finding.name)} ${change}`;
  });
  const rest = findings.length - lines.length;
  if (rest > 0) lines.push(`  ... and ${rest} more`);
  return [NOTICE_HEADER, ...lines].join("\n");
}

export function hashNotice(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `<entry>/cccc` for every absolute PATH entry. Relative and empty entries resolve against the opened repository, so they are dropped. */
export function listCcccCandidates(pathEnv: string | undefined): string[] {
  if (!pathEnv) return [];
  return pathEnv
    .split(delimiter)
    .filter((entry) => entry !== "" && isAbsolute(entry))
    .map((entry) => join(entry, "cccc"));
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/**
 * `realPath` is the resolved candidate. A mise shim resolves to the mise binary,
 * which may install tools declared by the opened repository; a binary inside the
 * repository is the repository's own.
 */
export function isUsableCccc(
  realPath: string,
  excludedRoots: readonly string[],
): boolean {
  if (basename(realPath) === "mise") return false;
  return !excludedRoots.some((root) => isInside(root, realPath));
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: T2 Step 2 と同じコマンド、続けて `bun run typecheck`
期待: 21 件（T2 の 7、T3 の 8、T4 の 6）が PASS。typecheck は終了コード 0（`tsconfig.json` は `**/tests/**` を除くので、テストの型は検査されない）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/complexity-delta.ts home/dot_claude/hooks/tests/unit/complexity-delta-lib.test.ts
git commit -m "feat(hooks): format complexity notices and pick a cccc binary"
```

### T5: hook の入口と登録

**Files:**

- 新規: `home/dot_claude/hooks/implementations/complexity-delta.ts`
- 編集: `home/dot_claude/.settings.hooks.json.tmpl:225-226`、`:301-302`
- テスト: `home/dot_claude/hooks/tests/unit/complexity-delta.test.ts`
- 参照: `home/dot_claude/hooks/implementations/completion-gate.ts:151-166`（2 つのイベントを 1 つの hook で受ける形）、`:218-247`（例外の扱いと末尾）
- 参照: `home/dot_claude/hooks/implementations/session.ts:286-298`（`systemMessage` だけを返す先例と、`event` が実行時の `hook_event_name` と結び付かないという注意）
- 参照: `home/dot_claude/hooks/lib/working-tree-fingerprint.ts:190-225`（一時ファイル、`wx`、0600、rename の手順）、`:227-241`（`pruneStaleBaselines`）
- 参照: `home/dot_claude/hooks/tests/unit/test-helpers.ts:94-139`（`MockHookContext`）、`:290-297`（`invokeRun`）、`:553-574`（`createStopContextFor`）、`:896-904`（`createUserPromptSubmitContext`）
- 参照: `home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts:11-20`（登録の書式。`implementations/` に置いたファイルは tmpl に登録しないとこのテストが落ちるので、同じ Task で登録する）

- [ ] **Step 1: 失敗するテストを書く**

偽の `cccc` は一時ディレクトリに置くシェルスクリプトで、`exec` で 1 つのプロセスに置き換える（`sleep` を子に残すと、kill の後も出力のパイプが閉じない）。状態ディレクトリと PATH は `createHook` に渡すので、`process.env` は書き換えない。

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createHook } from "../../implementations/complexity-delta.ts";
import type { ComplexityLogEntry } from "../../types/logging-types.ts";
import {
  createStopContextFor,
  createUserPromptSubmitContext,
  invokeRun,
} from "./test-helpers.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `complexity-delta-${label}-`));
  tempDirs.push(dir);
  return dir;
}

// Generous for every case that expects cccc to answer, so a loaded machine does
// not turn a normal run into a timeout. The timeout cases pass 200 instead.
const PATIENT_TIMEOUT_MS = 10_000;

function makeRepo(): string {
  const repo = makeTempDir("repo");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

type Fn = { name: string; kind: string; line: number; cognitive: number };
const fn = (name: string, cognitive: number, line = 1): Fn => ({
  name,
  kind: "function",
  line,
  cognitive,
});
const report = (functions: Fn[]) =>
  JSON.stringify({ files: [{ path: "./a.ts", functions }], summary: {} });

let sessionCounter = 0;

/** One repository, one fake cccc, one state directory. */
function setup(options: { binInsideRepo?: boolean; timeoutMs?: number } = {}) {
  const repo = makeRepo();
  const stateDir = join(makeTempDir("state"), "complexity-delta");
  const binDir = options.binInsideRepo ? join(repo, "bin") : makeTempDir("bin");
  mkdirSync(binDir, { recursive: true });
  const outputFile = join(makeTempDir("out"), "cccc.json");
  const callsFile = join(dirname(outputFile), "calls");
  const sessionId = `cd-${process.pid}-${++sessionCounter}`;
  // pathEnv is only where cccc is looked up; git is found through the real PATH.
  const hook = createHook(() => ({
    stateDir,
    pathEnv: binDir,
    ccccTimeoutMs: options.timeoutMs ?? PATIENT_TIMEOUT_MS,
  }));

  // Each call appends its arguments as one line, so the file doubles as a counter.
  const script = (body: string) => {
    writeFileSync(
      join(binDir, "cccc"),
      `#!/bin/sh\necho "$*" >> "${callsFile}"\n${body}\n`,
      { mode: 0o755 },
    );
  };
  const respond = (raw: string) => {
    writeFileSync(outputFile, raw);
    script(`exec cat "${outputFile}"`);
  };
  const callLines = () =>
    existsSync(callsFile)
      ? readFileSync(callsFile, "utf-8").trim().split("\n")
      : [];
  const calls = () => callLines().length;

  const prompt = async (cwd = repo) => {
    const ctx = createUserPromptSubmitContext("go");
    Object.assign(ctx.input, { cwd, session_id: sessionId });
    await invokeRun(hook, ctx);
    return ctx;
  };
  const stop = async (cwd = repo) => {
    const ctx = createStopContextFor(hook, { cwd, session_id: sessionId });
    await invokeRun(hook, ctx);
    return ctx;
  };
  const statePath = join(stateDir, `${sessionId}.json`);
  const state = () =>
    JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  const logs = (): ComplexityLogEntry[] => {
    const logDir = process.env.CLAUDE_LOGS_DIR;
    assert.ok(logDir, "run with --import tests/preload-test-env.mjs");
    const logFile = join(logDir, "complexity.jsonl");
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ComplexityLogEntry)
      .filter((entry) => entry.session_id === sessionId);
  };

  return {
    repo,
    stateDir,
    statePath,
    binDir,
    respond,
    script,
    calls,
    callLines,
    prompt,
    stop,
    state,
    logs,
  };
}

const message = (ctx: { jsonCalls: unknown[] }): string | undefined =>
  (ctx.jsonCalls[0] as { systemMessage?: string } | undefined)?.systemMessage;

describe("complexity-delta: notice", () => {
  it("shows a function that got worse between the prompt and the stop", async () => {
    const t = setup();
    t.respond(report([fn("f", 24, 3)]));
    const promptCtx = await t.prompt();
    assert.equal(promptCtx.jsonCalls.length, 0);
    assert.equal(promptCtx.successCalls.length, 1);

    t.respond(report([fn("f", 44, 5)]));
    const stopCtx = await t.stop();
    assert.equal(
      message(stopCtx),
      [
        "[complexity-delta] Cognitive complexity rose this turn (>= 25, new or +5):",
        "  a.ts:5 f 24 → 44",
      ].join("\n"),
    );
    assert.deepEqual(Object.keys(stopCtx.jsonCalls[0] as object), [
      "systemMessage",
    ]);

    const notices = t.logs().filter((entry) => entry.kind === "notice");
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0]?.findings, [
      { path: "a.ts", line: 5, name: "f", before: 24, after: 44 },
    ]);
  });

  it("stays silent on a second stop with the same findings and logs once", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    const second = await t.stop();
    assert.equal(second.jsonCalls.length, 0);
    assert.equal(t.logs().filter((entry) => entry.kind === "notice").length, 1);
  });

  it("shows again when the findings change within the turn", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    t.respond(report([fn("f", 50)]));
    assert.match(message(await t.stop()) ?? "", /f 24 → 50/);
  });

  it("clears the shown digest when the findings disappear, and on the next prompt", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    assert.match(String(t.state().shown), /^[0-9a-f]{64}$/);
    t.respond(report([fn("f", 24)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.state().shown, null);

    t.respond(report([fn("f", 44)]));
    await t.stop();
    await t.prompt();
    assert.equal(t.state().shown, null);
    t.respond(report([fn("f", 60)]));
    assert.match(message(await t.stop()) ?? "", /f 44 → 60/);
  });

  it("logs only the findings that got a line in the UI", async () => {
    const t = setup();
    t.respond(report([]));
    await t.prompt();
    t.respond(
      report(Array.from({ length: 13 }, (_, i) => fn(`f${i}`, 30, i + 1))),
    );
    const text = message(await t.stop()) ?? "";
    assert.equal(text.split("\n").at(-1), "  ... and 3 more");
    const [notice] = t.logs().filter((entry) => entry.kind === "notice");
    assert.equal(notice?.findings?.length, 10);
  });

  it("reads more than 1 MiB of cccc output", async () => {
    const t = setup();
    const many = Array.from({ length: 30000 }, (_, i) => fn(`f${i}`, 1, i + 1));
    assert.ok(report(many).length > 1024 * 1024);
    t.respond(report(many));
    await t.prompt();
    t.respond(report([...many, fn("big", 40, 99999)]));
    assert.match(message(await t.stop()) ?? "", /a\.ts:99999 big new 40/);
  });
});

describe("complexity-delta: when it does nothing", () => {
  it("ignores a stop without a baseline", async () => {
    const t = setup();
    t.respond(report([fn("f", 44)]));
    const ctx = await t.stop();
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(existsSync(t.statePath), false);
    assert.equal(t.calls(), 0);
  });

  it("ignores a directory outside git without creating state", async () => {
    const t = setup();
    const outside = makeTempDir("outside");
    await t.prompt(outside);
    await t.stop(outside);
    assert.equal(existsSync(t.stateDir), false);
    assert.equal(t.calls(), 0);
  });

  it("ignores a session id that is not a safe file name", async () => {
    const t = setup();
    t.respond(report([fn("f", 44)]));
    const hook = createHook(() => ({
      stateDir: t.stateDir,
      pathEnv: t.binDir,
      ccccTimeoutMs: PATIENT_TIMEOUT_MS,
    }));
    const ctx = createUserPromptSubmitContext("go");
    Object.assign(ctx.input, { cwd: t.repo, session_id: "../escape" });
    await invokeRun(hook, ctx);
    assert.equal(existsSync(t.stateDir), false);
  });

  it("does not compare when the stop happens in another repository", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    const before = readFileSync(t.statePath, "utf-8");
    t.respond(report([fn("f", 44)]));
    const ctx = await t.stop(makeRepo());
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(readFileSync(t.statePath, "utf-8"), before);
  });

  it("starts from a fresh state when the prompt happens in another repository", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    const firstRoot = t.state().root;
    await t.prompt(makeRepo());
    assert.equal(typeof t.state().root, "string");
    assert.notEqual(t.state().root, firstRoot);
    t.respond(report([fn("f", 44)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
  });

  it("treats a corrupt or wrong-version state file as no state and logs it", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    writeFileSync(t.statePath, JSON.stringify({ version: 2 }));
    t.respond(report([fn("f", 44)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
    writeFileSync(t.statePath, "{not json");
    await t.prompt();
    assert.equal(t.state().version, 1);
    assert.equal(
      t.logs().filter((entry) => entry.reason === "state").length,
      2,
    );
  });

  it("writes the state file as 0600 inside a 0700 directory", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(statSync(t.statePath).mode & 0o777, 0o600);
    assert.equal(statSync(t.stateDir).mode & 0o777, 0o700);
    assert.deepEqual(
      readdirSync(t.stateDir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

describe("complexity-delta: choosing the binary", () => {
  it("logs a skip with a recovery step when no cccc is on PATH", async () => {
    const t = setup();
    assert.equal((await t.prompt()).jsonCalls.length, 0);
    assert.equal(t.state().baseline, null);
    assert.equal((await t.stop()).jsonCalls.length, 0);
    const skips = t.logs().filter((entry) => entry.reason === "cccc-not-found");
    assert.equal(skips.length, 1);
    assert.match(skips[0]?.recovery ?? "", /mise install/);
  });

  it("does not run a cccc that lives inside the repository", async () => {
    const t = setup({ binInsideRepo: true });
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(t.calls(), 0);
    assert.equal(
      t.logs().some((entry) => entry.reason === "cccc-not-found"),
      true,
    );
  });

  it("does not run a cccc that resolves to a file named mise", async () => {
    const t = setup();
    const real = join(makeTempDir("mise"), "mise");
    writeFileSync(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(real, join(t.binDir, "cccc"));
    await t.prompt();
    assert.equal(
      t.logs().some((entry) => entry.reason === "cccc-not-found"),
      true,
    );
  });

  it("logs a failed measurement and drops the baseline when cccc exits non-zero", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.script("exit 2");
    await t.prompt();
    assert.equal(t.state().baseline, null);
    const failed = t.logs().filter((entry) => entry.reason === "failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0]?.binary ?? "", /cccc$/);
  });
});

describe("complexity-delta: giving up", () => {
  it("turns itself off after two consecutive timeouts and says so once", async () => {
    const t = setup({ timeoutMs: 200 });
    t.script("exec sleep 30");
    const first = await t.prompt();
    assert.equal(first.jsonCalls.length, 0);
    assert.equal(t.state().timeouts, 1);
    assert.equal(t.state().baseline, null);

    const second = await t.prompt();
    assert.match(
      message(second) ?? "",
      /^\[complexity-delta\] cccc exceeded 200ms twice/,
    );
    assert.equal((message(second) ?? "").includes(t.statePath), true);
    assert.equal(t.state().disabled, "timeout");
    const disabled = t.logs().filter((entry) => entry.kind === "disabled");
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0]?.recovery, t.statePath);

    const callsBefore = t.calls();
    const third = await t.prompt();
    assert.equal(third.jsonCalls.length, 0);
    assert.equal(t.calls(), callsBefore);
  });

  it("counts a stop timeout and resets the count on a success", async () => {
    const t = setup({ timeoutMs: 200 });
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.script("exec sleep 30");
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.state().timeouts, 1);
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(t.state().timeouts, 0);
    assert.equal(t.state().disabled, undefined);
  });

  it("turns itself off at once when the output has an unexpected shape", async () => {
    const t = setup();
    t.respond(JSON.stringify({ files: "changed" }));
    const ctx = await t.prompt();
    assert.match(message(ctx) ?? "", /did not match the expected shape/);
    assert.equal((message(ctx) ?? "").includes(join(t.binDir, "cccc")), true);
    assert.equal(t.state().disabled, "schema");
    assert.equal(
      t.logs().some((entry) => entry.reason === "schema"),
      true,
    );

    // Once off, a stop neither measures nor speaks.
    t.respond(report([fn("f", 44)]));
    const callsWhileOff = t.calls();
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.calls(), callsWhileOff);

    // Another repository starts from a fresh state.
    t.respond(report([fn("f", 24)]));
    await t.prompt(makeRepo());
    assert.equal(t.state().disabled, undefined);
    assert.equal(t.state().timeouts, 0);
  });

  it("turns itself off when a stop sees an unexpected shape, keeping the baseline", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond("[]");
    assert.match(
      message(await t.stop()) ?? "",
      /did not match the expected shape/,
    );
    assert.equal(t.state().disabled, "schema");
    assert.notEqual(t.state().baseline, null);
    const disabled = t.logs().filter((entry) => entry.kind === "disabled");
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0]?.recovery, t.statePath);
  });
});

describe("complexity-delta: housekeeping", () => {
  it("passes --no-config and the .git exclusion to cccc", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.deepEqual(t.callLines(), ["--no-config --exclude .git/** ."]);
  });

  it("removes state files older than seven days on a prompt, unless it is off", async () => {
    const t = setup();
    mkdirSync(t.stateDir, { recursive: true });
    const stale = join(t.stateDir, "stale.json");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const plantStale = () => {
      writeFileSync(stale, "{}");
      utimesSync(stale, eightDaysAgo, eightDaysAgo);
    };

    plantStale();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(existsSync(stale), false);

    t.respond("[]");
    await t.prompt();
    assert.equal(t.state().disabled, "schema");
    plantStale();
    await t.prompt();
    assert.equal(existsSync(stale), true);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/complexity-delta.test.ts`
期待: FAIL。`implementations/complexity-delta.ts` が無いという ERR_MODULE_NOT_FOUND

- [ ] **Step 3: 最小実装を書く**

`implementations/complexity-delta.ts`:

```ts
#!/usr/bin/env -S bun run --silent

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logComplexity } from "../lib/centralized-logging.ts";
import {
  type Baseline,
  type Report,
  diffReports,
  formatNotice,
  hashNotice,
  isUsableCccc,
  listCcccCandidates,
  parseCcccOutput,
  shownFindings,
  toBaseline,
} from "../lib/complexity-delta.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import { pruneStaleBaselines } from "../lib/working-tree-fingerprint.ts";

/**
 * Tells the user, at the end of a turn, which functions became markedly more
 * complex during it. Measures the whole repository with cccc at the prompt and
 * again at the stop, and compares the two in memory.
 *
 * Never blocks and never adds to the model's context: the notice goes out as a
 * systemMessage only. Paths and function names belong to the opened repository,
 * so they must not become model input on every turn.
 */

const DEFAULT_CCCC_TIMEOUT_MS = 1000;
const CCCC_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2000;
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONSECUTIVE_TIMEOUTS = 2;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECOVERY_NOT_FOUND =
  "Put a real cccc binary on PATH (with mise: `mise install`). mise shims are not used.";

type HookEnv = {
  stateDir: string;
  pathEnv: string | undefined;
  ccccTimeoutMs: number;
};

type DisabledReason = "timeout" | "schema";

/** Belongs to one repository root. A different root starts from a fresh state. */
type State = {
  version: 1;
  root: string;
  baseline: Baseline | null;
  /** SHA-256 of the notice already shown this turn, so a re-fired Stop does not repeat it. */
  shown: string | null;
  timeouts: number;
  disabled?: DisabledReason;
};

type Outcome =
  | { kind: "ok"; report: Report; binary: string }
  | { kind: "not-found" }
  | { kind: "timeout" | "schema" | "failed"; binary: string };

type Failure = Exclude<Outcome, { kind: "ok" }>;

type ComplexityLogFields = Parameters<typeof logComplexity>[0];

function defaultEnv(): HookEnv {
  return {
    stateDir: join(getHomeDir(), ".claude", "state", "complexity-delta"),
    pathEnv: process.env.PATH,
    ccccTimeoutMs: DEFAULT_CCCC_TIMEOUT_MS,
  };
}

function freshState(root: string): State {
  return { version: 1, root, baseline: null, shown: null, timeouts: 0 };
}

function isBaseline(value: unknown): value is Baseline {
  if (typeof value !== "object" || value === null) return false;
  const { functions, parseErrorFiles } = value as Record<string, unknown>;
  if (
    typeof functions !== "object" ||
    functions === null ||
    Array.isArray(functions)
  ) {
    return false;
  }
  if (!Array.isArray(parseErrorFiles)) return false;
  if (!parseErrorFiles.every((path) => typeof path === "string")) return false;
  return Object.values(functions).every(
    (values) =>
      Array.isArray(values) && values.every((n) => typeof n === "number"),
  );
}

function isState(value: unknown): value is State {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    state.version === 1 &&
    typeof state.root === "string" &&
    (state.baseline === null || isBaseline(state.baseline)) &&
    (state.shown === null || typeof state.shown === "string") &&
    typeof state.timeouts === "number" &&
    Number.isInteger(state.timeouts) &&
    state.timeouts >= 0 &&
    (state.disabled === undefined ||
      state.disabled === "timeout" ||
      state.disabled === "schema")
  );
}

type ReadResult =
  { kind: "ok"; state: State } | { kind: "missing" } | { kind: "invalid" };

function readState(statePath: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isState(parsed)
      ? { kind: "ok", state: parsed }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function writeState(statePath: string, state: State): void {
  const stateDir = dirname(statePath);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    // rename replaces a symlink at statePath instead of writing through it.
    renameSync(tmpPath, statePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // nothing to clean up
    }
    throw error;
  }
}

function resolveRoot(cwd: string): string | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return root === "" ? null : root;
  } catch {
    return null;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveCccc(env: HookEnv, root: string, cwd: string): string | null {
  const excludedRoots = [root, cwd]
    .map(realpathOrNull)
    .filter((path): path is string => path !== null);
  for (const candidate of listCcccCandidates(env.pathEnv)) {
    const realPath = realpathOrNull(candidate);
    if (realPath !== null && isUsableCccc(realPath, excludedRoots))
      return realPath;
  }
  return null;
}

function measure(env: HookEnv, root: string, cwd: string): Outcome {
  const binary = resolveCccc(env, root, cwd);
  if (binary === null) return { kind: "not-found" };
  let stdout: string;
  try {
    stdout = execFileSync(
      binary,
      ["--no-config", "--exclude", ".git/**", "."],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: env.ccccTimeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: CCCC_MAX_BUFFER,
      },
    );
  } catch (error) {
    const timedOut = (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { kind: timedOut ? "timeout" : "failed", binary };
  }
  const report = parseCcccOutput(stdout);
  return report === null
    ? { kind: "schema", binary }
    : { kind: "ok", report, binary };
}

/** Anything thrown between measuring and comparing counts as a failed measurement. */
function attempt<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

type Call = {
  env: HookEnv;
  root: string;
  cwd: string;
  statePath: string;
  sessionId: string;
};

type Step = { state: State; logs: ComplexityLogFields[]; message?: string };

/**
 * What a measurement that produced no report does to the state, what to log,
 * and what to say. Pure: the caller writes the state first and logs afterwards,
 * so a failed write never leaves a "turned off" record with nothing behind it.
 */
function planFailure(state: State, failure: Failure, call: Call): Step {
  const { root } = state;
  const { statePath } = call;
  if (failure.kind === "not-found") {
    return {
      state: { ...state, timeouts: 0 },
      logs: [
        {
          kind: "skip",
          root,
          reason: "cccc-not-found",
          recovery: RECOVERY_NOT_FOUND,
        },
      ],
    };
  }
  const { binary } = failure;
  const skip: ComplexityLogFields = {
    kind: "skip",
    root,
    reason: failure.kind,
    binary,
  };
  if (failure.kind === "failed") {
    return { state: { ...state, timeouts: 0 }, logs: [skip] };
  }
  if (failure.kind === "schema") {
    return {
      state: { ...state, timeouts: 0, disabled: "schema" },
      logs: [
        skip,
        {
          kind: "disabled",
          root,
          reason: "schema",
          binary,
          recovery: statePath,
        },
      ],
      message: `[complexity-delta] cccc output did not match the expected shape (binary: ${binary}). Complexity checks are off for this repository in this session. State file: ${statePath}`,
    };
  }
  const timeouts = state.timeouts + 1;
  if (timeouts < MAX_CONSECUTIVE_TIMEOUTS) {
    return { state: { ...state, timeouts }, logs: [skip] };
  }
  return {
    state: { ...state, timeouts, disabled: "timeout" },
    logs: [
      skip,
      {
        kind: "disabled",
        root,
        reason: "timeout",
        binary,
        recovery: statePath,
      },
    ],
    message: `[complexity-delta] cccc exceeded ${call.env.ccccTimeoutMs}ms twice in a row. Complexity checks are off for this repository in this session. State file: ${statePath}`,
  };
}

function commit(step: Step, call: Call): string | undefined {
  writeState(call.statePath, step.state);
  for (const fields of step.logs) logComplexity(fields, call.sessionId);
  return step.message;
}

function onPrompt(call: Call): string | undefined {
  const { env, root, cwd, statePath, sessionId } = call;
  const read = readState(statePath);
  if (read.kind === "invalid") {
    logComplexity({ kind: "skip", root, reason: "state" }, sessionId);
  }
  const state =
    read.kind === "ok" && read.state.root === root
      ? read.state
      : freshState(root);
  if (state.disabled !== undefined) return undefined;

  pruneStaleBaselines(env.stateDir, STATE_MAX_AGE_MS);

  const turnStart: State = { ...state, shown: null };
  const outcome = measure(env, root, cwd);
  if (outcome.kind === "ok") {
    const baseline = attempt(() => toBaseline(outcome.report));
    if (baseline !== null) {
      return commit(
        { state: { ...turnStart, baseline, timeouts: 0 }, logs: [] },
        call,
      );
    }
  }
  const failure: Failure =
    outcome.kind === "ok"
      ? { kind: "failed", binary: outcome.binary }
      : outcome;
  // A stale baseline would turn several turns of change into this turn's finding.
  return commit(
    planFailure({ ...turnStart, baseline: null }, failure, call),
    call,
  );
}

function onStop(call: Call): string | undefined {
  const { env, root, cwd, statePath, sessionId } = call;
  const read = readState(statePath);
  if (read.kind === "invalid") {
    logComplexity({ kind: "skip", root, reason: "state" }, sessionId);
  }
  if (read.kind !== "ok") return undefined;
  const { state } = read;
  const { baseline } = state;
  if (
    state.root !== root ||
    state.disabled !== undefined ||
    baseline === null
  ) {
    return undefined;
  }

  const outcome = measure(env, root, cwd);
  const notice =
    outcome.kind === "ok"
      ? attempt(() => {
          const findings = diffReports(baseline, outcome.report);
          return { findings, text: formatNotice(findings) };
        })
      : null;
  if (outcome.kind !== "ok" || notice === null) {
    const failure: Failure =
      outcome.kind === "ok"
        ? { kind: "failed", binary: outcome.binary }
        : outcome;
    return commit(planFailure(state, failure, call), call);
  }

  const { findings, text } = notice;
  if (findings.length === 0) {
    return commit(
      { state: { ...state, timeouts: 0, shown: null }, logs: [] },
      call,
    );
  }
  const digest = hashNotice(text);
  if (digest === state.shown) {
    return commit({ state: { ...state, timeouts: 0 }, logs: [] }, call);
  }
  return commit(
    {
      state: { ...state, timeouts: 0, shown: digest },
      logs: [{ kind: "notice", root, findings: shownFindings(findings) }],
      message: text,
    },
    call,
  );
}

export function createHook(getEnv: () => HookEnv = defaultEnv) {
  return defineHook({
    trigger: { Stop: true, UserPromptSubmit: true },
    run: (context) => {
      try {
        const { cwd, session_id: sessionId } = context.input;
        if (!SESSION_ID_PATTERN.test(sessionId)) return context.success({});
        const root = resolveRoot(cwd);
        if (root === null) return context.success({});

        const env = getEnv();
        const call: Call = {
          env,
          root,
          cwd,
          statePath: join(env.stateDir, `${sessionId}.json`),
          sessionId,
        };
        // context.json's `event` is only type-checked against the trigger; it is
        // not tied to the runtime event, so branch on the input explicitly.
        if (context.input.hook_event_name === "UserPromptSubmit") {
          const message = onPrompt(call);
          return message === undefined
            ? context.success({})
            : context.json({
                event: "UserPromptSubmit",
                output: { systemMessage: message },
              });
        }
        const message = onStop(call);
        return message === undefined
          ? context.success({})
          : context.json({ event: "Stop", output: { systemMessage: message } });
      } catch (error) {
        console.error(`[complexity-delta] Error: ${error}`);
        return context.success({});
      }
    },
  });
}

const hook = createHook();

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
```

`.settings.hooks.json.tmpl` の Stop の並びに、`compaction-testament.ts` の項目（`:223-226`）の直後へ足す。

```
        {
          "type": "command",
          "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/complexity-delta.ts"
        },
```

UserPromptSubmit の並びは、`completion-gate.ts` の項目（`:299-302`）の閉じ括弧の後にカンマを足し、その後へ足す。

```
        {
          "type": "command",
          "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/completion-gate.ts"
        },
        {
          "type": "command",
          "command": "bun {{ .chezmoi.homeDir }}/.claude/hooks/implementations/complexity-delta.ts"
        }
```

- [ ] **Step 4: テストを実行して通過を確認**

実行:

```
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/complexity-delta.test.ts
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/hook-target-drift.test.ts
bun run typecheck
```

期待: `complexity-delta.test.ts` の 23 件が PASS（内訳は notice 6、when it does nothing 7、choosing the binary 4、giving up 4、housekeeping 2）。`hook-target-drift.test.ts` は全件 PASS。typecheck は終了コード 0

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/complexity-delta.ts home/dot_claude/hooks/tests/unit/complexity-delta.test.ts home/dot_claude/.settings.hooks.json.tmpl
git commit -m "feat(hooks): notify when a function's complexity rises during a turn"
```

### T6: 全体の検査と、本物の `cccc` での確認

**Files:**

- 参照: `package.json:31`（`check` は test、typecheck、lint の連結）
- 参照: `knip.json:5-8`（`hooks/implementations/*.ts` は entry。設定の変更は要らない）

- [ ] **Step 1: 全体の検査**

実行: `bun run test`、`bun run typecheck`、`bun run lint:oxlint`、`bun run format:check`
期待: test は T0 Step 2 で記録した失敗のほかに失敗が無い。typecheck と lint:oxlint は終了コード 0。format:check が落ちたら `bun run format` を実行し、差分がこの plan の Files の中だけであることを `git status --short` で確かめる

- [ ] **Step 2: 本物の `cccc` の出力が検証を通ることを確かめる**

実行:

```
cccc --no-config --exclude '.git/**' . | bun -e 'import { parseCcccOutput } from "./home/dot_claude/hooks/lib/complexity-delta.ts"; import { readFileSync } from "node:fs"; const r = parseCcccOutput(readFileSync(0, "utf-8")); console.log(r === null ? "null" : `keys=${r.byKey.size} parseErrors=${r.parseErrorFiles.length}`);'
```

期待: `keys=` の後が 1000 以上の数（`research.md` の実測は 199 ファイル 4430 関数）。`null` が出たら、検証の規則と `cccc` 1.7.0 の実際の出力が合っていない。実装を止め、合わない箇所を報告する

- [ ] **Step 2b: 未使用の export が無いことを確かめる**

実行: `bunx knip --no-progress`
期待: `lib/complexity-delta.ts`、`implementations/complexity-delta.ts`、`types/logging-types.ts`、`lib/centralized-logging.ts` についての指摘が無い。ほかのファイルへの既存の指摘は、この plan では直さない

- [ ] **Step 3: bun で入口を実行し、出力の形を確かめる**

状態は `~/.claude/state/complexity-delta/plan1-smoke.json` に書かれる（7 日で掃除される）。ログは `CLAUDE_LOGS_DIR` で一時ディレクトリへ向ける。一時ディレクトリは `mktemp -d` が出したパスをそのまま書く。

```
mktemp -d
printf '{"hook_event_name":"UserPromptSubmit","cwd":"%s","session_id":"plan1-smoke","transcript_path":"/dev/null","prompt":"x"}' "$PWD" | CLAUDE_LOGS_DIR=<mktemp が出したパス> bun home/dot_claude/hooks/implementations/complexity-delta.ts; echo "exit=$?"
printf '{"hook_event_name":"Stop","cwd":"%s","session_id":"plan1-smoke","transcript_path":"/dev/null","stop_hook_active":false}' "$PWD" | CLAUDE_LOGS_DIR=<mktemp が出したパス> bun home/dot_claude/hooks/implementations/complexity-delta.ts; echo "exit=$?"
jq -c '{version, root, shown, timeouts, disabled, keys: (.baseline.functions | length)}' ~/.claude/state/complexity-delta/plan1-smoke.json
```

期待: 2 回とも `exit=0` で、標準出力は空（変更していないので該当は無い）。`jq` の出力は `version` が 1、`root` がワークツリーのパス、`shown` が `null`、`timeouts` が 0、`disabled` が `null`、`keys` が 1000 以上

- [ ] **Step 4: 修正があればコミット**

Step 1 で整形の差分が出た場合だけ:

```bash
git add -u
git commit -m "style(hooks): format the complexity-delta sources"
```

### T7: 文書を `docs/plans/` へ写す

**Files:**

- 新規: `docs/plans/complexity-delta/spec.md`、`plan-1.md`、`research.md`、`replay.sh`、`flat.jq`、`probe.sh`
- 参照: `docs/plans/shellcheck-zero/`（`plan.md` と `research.md` を 1 つのディレクトリに置く先例）
- 参照: `~/.claude/rules/workflow.md`「Session Artifact Retention」（`.tmp/sessions/` は 7 日で消える）

- [ ] **Step 1: 写す**

写す元は、リポジトリ本体の `/home/berlysia/.local/share/chezmoi/.tmp/sessions/deefa448/` の `spec.md`、`plan-1.md`、`research.md` と、scratchpad の `replay/replay.sh`、`replay/flat.jq`、`scale/probe.sh`。写す先はワークツリーの `docs/plans/complexity-delta/`。元のファイルは変えない（hash が動くと承認が外れる）。

- [ ] **Step 2: 写しの中の参照を直す**

写しの `spec.md` と `research.md` だけを直す。根拠として指している先を、一緒に写したファイルに向け直すためである。

- `.tmp/sessions/deefa448/research.md` を `research.md` に置き換える
- 「scratchpad の `replay/replay.sh`」を `replay.sh` に、「scratchpad の `scale/probe.sh`」を `probe.sh` に置き換える

次のものは直さない。

- `research.md` が経緯として挙げる、消える前提のパス（`.tmp/docs/cccc-task-completion-check.md`、`.tmp/sessions/b72ce94a/`）。調べた時点の出どころの記録である
- `plan-1.md` の写し。手順の中のパスは実行した時点のものなので、先頭に「この文書のパスは作業時のもので、`.tmp/` と scratchpad は残っていない」と 1 行足すだけにする
- `spec.md` と `plan-1.md` の末尾の `## Approval` 以降（レビューの帳簿と marker）。経過の記録として残す

- [ ] **Step 3: 向け直した参照が残っていないことを確かめる**

実行: `grep -n 'sessions/deefa448\|scratchpad の' docs/plans/complexity-delta/spec.md docs/plans/complexity-delta/research.md`
期待: 出力が無い

- [ ] **Step 4: 検査**

実行: `bun run lint:shell`、`bun run format:check`
期待: どちらも終了コード 0。`replay.sh` か `probe.sh` に指摘が出たら、その指摘を直す（動作は変えない）

- [ ] **Step 5: コミット**

```bash
git add docs/plans/complexity-delta
git commit -m "docs(plans): record the complexity-delta spec, plan and research"
```

### T8: 配布と実セッションでの確認（ユーザーの指示を待つ）

**Files:**

- 参照: spec.md R1（配布後の実セッションでログの `notice` か `skip` を見る）
- 参照: `CLAUDE.md`「Settings.json分割管理」（hooks の変更は `chezmoi apply` で `~/.claude/settings.json` に入る）

この Task は `master` への取り込みと `chezmoi apply` を含む。T7 まで終えたら結果を報告し、ユーザーの指示があってから進める。

- [ ] **Step 1: 取り込みと配布**

ユーザーの指示に従って `feat/complexity-delta-notice` を `master` に取り込み、リポジトリ本体で `chezmoi apply` を実行する。

- [ ] **Step 2: 登録を確かめる**

実行: `jq '[.hooks.Stop[].hooks[].command, .hooks.UserPromptSubmit[].hooks[].command] | map(select(test("complexity-delta"))) | length' ~/.claude/settings.json`
期待: `2`

- [ ] **Step 3: 新しいセッションで確かめる**

新しい Claude Code のセッションをこのリポジトリで開き、プロンプトを 1 つ送って応答が終わるのを待つ。

実行: `tail -n 5 ~/.claude/logs/complexity.jsonl; ls ~/.claude/state/complexity-delta/`
期待: 状態ディレクトリにそのセッションの `<session_id>.json` があり、`baseline` が `null` でない。ログに `cccc-not-found` の行が無い（あれば hook の PATH に `cccc` の実体が無い。spec の R1 に従い、解決の方法を spec に戻して決め直す）

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: 基準 `f=24`、現在 `f=29` → **期待**: 該当 1 件（`before: 24, after: 29`）
- **入力**: 基準 `f=21`、現在 `f=25` → **期待**: 該当 0 件（上昇が 4）
- **入力**: 基準 `f=25`、現在 `f=29` → **期待**: 該当 0 件
- **入力**: 基準に無い関数が現在 `25` → **期待**: 該当 1 件（`before: null`）。現在 `24` → **期待**: 0 件
- **入力**: 同じ鍵で基準 `[30, 2]`、現在 `[40, 30, 2]` → **期待**: 該当は `before: null, after: 40` の 1 件だけ
- **入力**: 同じ鍵で基準 `[30, 28]`、現在 `[33, 30]` → **期待**: `before: 28, after: 33` の 1 件（spec K5 が認めた取り違え）
- **入力**: 基準側で `parse_errors` のあるファイルの関数が現在 `40` → **期待**: 0 件
- **入力**: 該当 13 件 → **期待**: 文面は先頭行 + 10 行 + `  ... and 3 more`

### 性能効率性（時間効率性）

- **入力**: `exec sleep 30` を実行する偽の `cccc` と、timeout 200 ミリ秒で UserPromptSubmit を 2 回 → **期待**: 1 回目は出力なしで `timeouts: 1`、2 回目は `systemMessage` が `[complexity-delta] cccc exceeded 200ms twice` で始まり `disabled: "timeout"`（本番の既定は 1000 ミリ秒）
- **入力**: `disabled` の状態で UserPromptSubmit → **期待**: 偽の `cccc` の呼び出し回数が増えない
- **入力**: Stop で timeout、次の UserPromptSubmit で成功 → **期待**: `timeouts: 0`、`disabled` なし
- **実測**（テストではなく記録）: 1 万ファイルで 35〜37 ミリ秒、3 万ファイルで 149〜156 ミリ秒

### 信頼性（障害許容性）

- **入力**: PATH に `cccc` が無い → **期待**: 出力なし、`baseline: null`、ログに `reason: "cccc-not-found"` と `recovery` が 1 行
- **入力**: `cccc` が終了コード 2 → **期待**: 出力なし、`baseline: null`、ログに `reason: "failed"`
- **入力**: `cccc` の出力が `{"files":"changed"}` → **期待**: `systemMessage` に `did not match the expected shape`、`disabled: "schema"`
- **入力**: 状態ファイルが `{not json`、または `{"version":2}` → **期待**: 例外なし、通知なし、ログに `reason: "state"`
- **入力**: git の外のディレクトリ → **期待**: 状態ディレクトリが作られない
- **入力**: 基準を取ったのと別のリポジトリで Stop → **期待**: 出力なし、状態ファイルの内容が変わらない
- **入力**: 入れ子 64 段 → **期待**: 検証を通る。65 段 → **期待**: `null`

### セキュリティ（完全性）

- **入力**: PATH が `/a/bin::.:rel/bin:/b` → **期待**: 候補は `/a/bin/cccc` と `/b/cccc` だけ
- **入力**: リポジトリの `bin/cccc` を PATH の先頭に置く → **期待**: 実行されない（呼び出し 0 回）、ログに `cccc-not-found`
- **入力**: `cccc` が `mise` という名前のファイルへの symlink → **期待**: 実行されない
- **入力**: パスに LF（0x0a）と ESC（0x1b）、名前にバッククォート、CR、LF、U+2028 を含む該当 1 件 → **期待**: 文面は 2 行（先頭行と 1 件）で、2 行目は `  aIGNORE[31m.ts:3 fx 24 → 44`。LF 以外の制御文字、バッククォート、U+2028 を含まない
- **入力**: セッション ID `../escape` → **期待**: 状態ディレクトリが作られない
- **入力**: 状態ファイルの権限 → **期待**: ファイル 0600、ディレクトリ 0700
- **入力**: 1MiB を超える出力（3 万関数に、追加の `big`（cognitive 40、99999 行目）を 1 つ足したもの） → **期待**: `systemMessage` に `a.ts:99999 big new 40` を含む

### 互換性（共存性）

- **入力**: `hook-target-drift.test.ts` を実行 → **期待**: 全件 PASS（同じファイルを 2 つのイベントに登録している）
- **入力**: `bun run test` 全体 → **期待**: T0 で記録した失敗のほかに失敗が無い
- **入力**: Stop の出力 → **期待**: キーは `systemMessage` だけ（`decision` と `hookSpecificOutput` を持たない）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: 計画のコードを scratchpad で実行した。T1 は 2/2、T5 は 19/19 で通る。T4 のテストは、正規表現の中に U+2028 が生の文字で入っていて読み込めない（エスケープに直すと 22/22）。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: spec の「計測から比較までの例外は計測の失敗として扱う」が実装に無い。T7 Step 3 の grep は、写した plan-1 と spec が自分で該当するので必ず失敗する。

### architecture-boundary-analyzer

- verdict: pass
- 主指摘: lib は純粋で、tmpl の編集後も JSON は有効。テストの `which git` と `gitDir` は要らない（PATH の引数は `cccc` の探索にしか使わない）。

### data-contract-evolution-evaluator

- verdict: pass
- 主指摘: 状態の書き込みは 9 つの分岐すべてで spec と一致。`toBaseline` と `diffReports` の例外が捕まらない。`__proto__` と `toString` のテストは、鍵が必ずパスで始まるので何も確かめていない。

### resilience-analyzer

- verdict: needs-work
- 主指摘: `recordFailure` が状態を書く前にログを書くので、書き込みに失敗すると「やめた」の記録だけが残る。テストが本番の 1 秒の timeout に依存していて、負荷の高い CI で落ちうる。

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: pass
- 主指摘: Round 1 の指摘はすべて解消。直したコードを scratchpad で実行し、3 ファイルとも全件通過（2/2、21/21、22/22）。`tsc` で complexity 関連の診断は 0 件。

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: ログの `notice` に該当を全件書くのは、spec の「UI へ出した該当」に反する。「設計の補足」の「spec の範囲内」という見出しと合わない。UI に出した分だけを書く。

### resilience-analyzer

- verdict: pass
- 主指摘: 状態、ログ、文面の順になり、「やめた」の記録だけが残る経路は無い。基準を消す書き込みが失敗すると古い基準が残りうる（best effort と明記すれば足りる）。

### architecture-boundary-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=4ef4c95d4db21ebde2c88cf4272bf14a22a374586d3f916beb4b415d5774d5b8; design-hash=b91e38effc9d433fd3e85a4d56111fec6c52159863bd3cb267acc60b5e92406d; round=1; parent-spec-hash=bb11a37c2f698dd1d671b5cb961297542c832812a7c11523293d9f139db95d1c; at=2026-10-05T15:51:04.506Z; reviewers=logic-validator+scope-justification-reviewer+architecture-boundary-analyzer+data-contract-evolution-evaluator+resilience-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: 差分は整合している。scratchpad で再実行し、lib 21/21、hook 23/23、ログ 2/2 が通過。`tsc` で complexity 関連の診断は 0 件。指摘なし。

### scope-justification-reviewer

- verdict: pass
- 主指摘: ログと UI の該当が同じ集合になり、spec と合う。やめた後の Stop が `cccc` を呼ばないことと、別のリポジトリへ引き継がないことの確認が安く足せる（既存のテストに足して反映済み）。

### resilience-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### architecture-boundary-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### data-contract-evolution-evaluator

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=9a892bc31b0a1323b3bc680cacd58d8cdf2337cee81e10f3f11dd99184bdcc70; design-hash=e17e63679d5f7ccdcf100c9dc6ed65563f00cc55d6bc098859eb47ec318425e8; round=2; parent-spec-hash=bb11a37c2f698dd1d671b5cb961297542c832812a7c11523293d9f139db95d1c; at=2026-10-05T15:56:37.341Z; reviewers=logic-validator+scope-justification-reviewer+resilience-analyzer -->

<!-- auto-review: verdict=pass; hash=e65c5cfa4b9d3fbb77a4215276a3662b122b6dc8535522f1862283d6c3c7dca7; design-hash=840b50147d39b26869e10cb7949837ce0a987dad9d55de6ce1ab2c4a655b73ed; round=3; parent-spec-hash=bb11a37c2f698dd1d671b5cb961297542c832812a7c11523293d9f139db95d1c; at=2026-10-05T15:58:23.798Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=38; excluded=0; at=2026-10-05T15:58:23.815Z -->
