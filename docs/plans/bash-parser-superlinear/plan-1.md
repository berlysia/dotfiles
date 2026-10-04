<!-- spec-ref: spec.md -->

# Plan: Bash パーサーの所要時間を入力長に対して抑える (Execution layer)

spec.md の K1〜K8 を実装する。テストは `node:test`、実行は repo root から次の形で行う。

```
node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/<file>.test.ts
```

以下、この前置きを `NT` と書く（例: `NT bash-parser.test.ts`）。

## Files

```
# 編集
home/dot_claude/hooks/lib/bash-parser.ts
home/dot_claude/hooks/implementations/auto-approve.ts
home/dot_claude/hooks/implementations/deny-node-modules.ts
home/dot_claude/hooks/implementations/document-workflow-guard.ts

# テスト
home/dot_claude/hooks/tests/unit/bash-parser.test.ts
home/dot_claude/hooks/tests/unit/auto-approve.test.ts
home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts
home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
```

## Tasks

### T1: 打ち切りの記録、長さの制約、parse の時間予算（K8・K1・K2・K4 の export）

**Files:**

- 編集: `home/dot_claude/hooks/lib/bash-parser.ts:21-24`（`TreeSitterParser`）、`:100-114`（`META_COMMANDS` の直後に追加）、`:463-475`（`parseBashCommand`）、`:531`（parse の呼び出し）、`:950-954`（`parseForCollect`）
- テスト: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts`
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:531-538`（木が `null` のときの既存の経路）、`home/dot_claude/hooks/lib/bash-parser.ts:1006`（`collectExecutableTexts` の `null` の経路）

- [ ] **Step 1: 失敗するテストを書く**

`bash-parser.test.ts` の import を次に差し替える（fixture は使わない）。

```ts
import {
  collectExecutableTexts,
  type ExtractedCommands,
  extractBaseCommands,
  extractCommandsStructured,
  MAX_COMMAND_CHARS,
  parseBashCommand,
  parseForCollect,
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../../lib/bash-parser.ts";
```

ファイルの末尾に追加する。

```ts
describe("parser limits (Issue #235)", () => {
  it("does not analyse a command longer than 32,000 characters", async () => {
    const command = `echo ${"a".repeat(MAX_COMMAND_CHARS - 4)}`;
    strictEqual(command.length, MAX_COMMAND_CHARS + 1);
    const mark = parserGiveUpMark();
    const result = await extractCommandsStructured(command);
    strictEqual(result.parsingMethod, "fallback");
    ok(parserGiveUpReasonSince(mark)?.includes("32,000 characters"));
  });

  it("analyses a command of exactly 32,000 characters as before", async () => {
    const command = `echo ${"a".repeat(MAX_COMMAND_CHARS - 5)}`;
    strictEqual(command.length, MAX_COMMAND_CHARS);
    const mark = parserGiveUpMark();
    const result = await extractCommandsStructured(command);
    strictEqual(result.parsingMethod, "tree-sitter");
    strictEqual(parserGiveUpReasonSince(mark), null);
  });

  it("records the length limit on the parseBashCommand path too", async () => {
    const mark = parserGiveUpMark();
    const result = await parseBashCommand(
      `xargs ${"a".repeat(MAX_COMMAND_CHARS)}`,
      true,
    );
    deepStrictEqual(result.commands, []);
    strictEqual(result.parsingMethod, "fallback");
    ok(parserGiveUpReasonSince(mark)?.includes("32,000 characters"));
  });

  for (const [name, command] of [
    ["a long run of redirects", `echo limit-a ${">".repeat(20000)}`],
    ["repeated subshells", `${"(a) ".repeat(5000)}limit-b`],
  ] as const) {
    it(`gives up within the time budget on ${name}`, async () => {
      const mark = parserGiveUpMark();
      const start = performance.now();
      const result = await extractCommandsStructured(command);
      ok(performance.now() - start < 1000);
      strictEqual(result.parsingMethod, "fallback");
      ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
    });
  }

  it("keeps the parser usable after a cancelled parse", async () => {
    strictEqual(
      await parseForCollect(`echo limit-c ${">".repeat(20000)}`),
      null,
    );
    deepStrictEqual(await extractCommandsStructured("echo after-limit-c"), {
      individualCommands: ["echo after-limit-c"],
      originalCommand: null,
      parsingMethod: "tree-sitter",
    });
  });

  it("does not parse an input again after giving up on it", async () => {
    const command = `echo limit-d ${">".repeat(20000)}`;
    strictEqual(await parseForCollect(command), null);
    const mark = parserGiveUpMark();
    const start = performance.now();
    strictEqual(await parseForCollect(command), null);
    ok(performance.now() - start < 50);
    ok(parserGiveUpReasonSince(mark)?.includes("within 100 ms"));
  });

  it("reports no reason when nothing gave up", async () => {
    const mark = parserGiveUpMark();
    await extractCommandsStructured("ls -la | wc -l");
    strictEqual(parserGiveUpReasonSince(mark), null);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT bash-parser.test.ts`
期待: FAIL（`SyntaxError`: `bash-parser.ts` は `MAX_COMMAND_CHARS` を export していない）

- [ ] **Step 3: 最小実装を書く**

(1) `TreeSitterParser` を差し替える。

```ts
interface TreeSitterParser {
  parse(
    input: string,
    oldTree?: null,
    options?: { progressCallback?: () => boolean },
  ): ParseTree | null;
  reset(): void;
  setLanguage(language: unknown): void;
}
```

(2) `META_COMMANDS` の定義（`};` の行）の直後に追加する。

```ts
// Limits on what the guards analyse (issue #235). A command over a limit is
// not analysed further and the hooks deny it; the two character limits depend
// only on the input, so the verdict is the same on every machine.
export const MAX_COMMAND_CHARS = 32_000;
export const MAX_META_SCAN_CHARS = 2_000_000;
// A backstop inside the length limit: tree-sitter's error recovery is
// superlinear on some malformed inputs. Wall clock, so load can trip it; the
// only outcome is a deny.
const PARSE_BUDGET_MS = 100;

type ParserGiveUpKind = "length" | "scan" | "time";

const GIVE_UP_REASONS: Record<ParserGiveUpKind, string> = {
  length:
    "Bash command is longer than 32,000 characters, so the guard does not analyse it and blocks it. Split it into smaller commands.",
  scan: `Bash command repeats wrapper words (${Object.keys(META_COMMANDS).join(", ")}) or command substitutions too many times on one line for the guard to analyse, quoted text included (over 2,000,000 characters scanned), so it is blocked. Split it into smaller commands or shorter lines.`,
  time: "Bash command could not be parsed within 100 ms, so the guard blocks it. It probably contains a syntax error; fix it or split it into smaller commands.",
};

// Every give-up of this process, in order. Never cleared: a hook compares a
// mark taken before its parser calls, so a missed check fails towards deny
// only if the hook reads it. The three guard hooks must read it.
const giveUps: ParserGiveUpKind[] = [];
// Characters handed to the regex extractor so far in this process.
let metaScanned = 0;
// Inputs whose parse was cut; parsing them again would cost the same time.
const timedOutInputs = new Set<string>();

export interface ParserGiveUpMark {
  giveUps: number;
  scanned: number;
}

export function parserGiveUpMark(): ParserGiveUpMark {
  return { giveUps: giveUps.length, scanned: metaScanned };
}

/**
 * The deny reason when the parser stopped analysing something since `mark`,
 * or when the extractor scanned more than the limit since `mark` in total
 * (auto-approve re-extracts every fragment, so no single call need be capped).
 */
export function parserGiveUpReasonSince(mark: ParserGiveUpMark): string | null {
  const since = giveUps.slice(mark.giveUps);
  for (const kind of ["length", "scan", "time"] as const) {
    if (since.includes(kind)) return GIVE_UP_REASONS[kind];
  }
  if (metaScanned - mark.scanned > MAX_META_SCAN_CHARS) {
    return GIVE_UP_REASONS.scan;
  }
  return null;
}

/**
 * The only caller of parser.parse. Returns null when the input is over the
 * length limit, when the parse was cut (cancelled, threw, or returned after
 * the budget), or when an earlier parse of the same input was cut.
 */
async function parseBounded(command: string): Promise<TsTree | null> {
  if (command.length > MAX_COMMAND_CHARS) {
    giveUps.push("length");
    return null;
  }
  if (timedOutInputs.has(command)) {
    giveUps.push("time");
    return null;
  }
  // An init failure rejects as before; it is not a give-up.
  const parser = await ensureTreeSitter();
  const start = performance.now();
  const overBudget = () => performance.now() - start > PARSE_BUDGET_MS;
  let tree: TsTree | null = null;
  try {
    tree = parser.parse(command, null, {
      progressCallback: overBudget,
    }) as unknown as TsTree | null;
    if (tree !== null && !overBudget()) return tree;
  } catch {
    // A wasm abort on a degenerate input; handled as a cut parse below.
  }
  // Recorded before the cleanup so a throwing cleanup cannot lose it.
  timedOutInputs.add(command);
  giveUps.push("time");
  try {
    tree?.delete();
    // Without a reset the next parse aborts the wasm module.
    parser.reset();
  } catch (error) {
    console.error(
      `[bash-parser] parser cleanup failed: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
  return null;
}
```

(3) `parseBashCommand` の本体の先頭（`try {` の前）に追加する。

```ts
if (command.length > MAX_COMMAND_CHARS) {
  giveUps.push("length");
  return {
    commands: [],
    errors: [{ message: "command exceeds the parser's length limit" }],
    parsingMethod: "fallback",
  };
}
```

(4) `parseWithTreeSitter` の `const parser = await ensureTreeSitter();` を `await ensureTreeSitter();` に、`const tree = parser.parse(command);` を次に差し替える。

```ts
const tree = (await parseBounded(command)) as unknown as ParseTree | null;
```

(5) `parseForCollect` を差し替える。

```ts
export const parseForCollect: ParseForCollect = parseBounded;
```

(6) `extractCommandsStructured` の本体の先頭に追加する（`wholeAndCoarse` は同じファイルの既存の関数）。

```ts
if (command.length > MAX_COMMAND_CHARS) {
  giveUps.push("length");
  return {
    individualCommands: wholeAndCoarse(command),
    originalCommand: null,
    parsingMethod: "fallback",
  };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT bash-parser.test.ts` と `bun run typecheck`
期待: 追加した 8 件が PASS。既存のテストは `splits a body with a long blank run in linear time` を含めて PASS（この時点では、100k 文字の入力が長さの制約で parse されずに返るので通る。T7 で入力を縮めて、for ループの本体の分割を通る形に戻す）。typecheck のエラー 0 件

K1 の (b)（parse が例外を投げる）と (c)（木は返ったが予算を超えた）だけを狙うテストは書かない。どちらも、このマシンでの tree-sitter の内部の進み方に依存し、入力から安定して起こせない。3 つの条件は `parseBounded` の同じ後始末に合流するので、(a) のテストがその後始末を通す。

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/bash-parser.ts home/dot_claude/hooks/tests/unit/bash-parser.test.ts
git commit -m "fix(hooks): bound bash parsing by a length limit and a parse time budget"
```

### T2: メタコマンド抽出器の走査の上限とデバッグ出力（K5・K6）

**Files:**

- 編集: `home/dot_claude/hooks/lib/bash-parser.ts:3-7`（`_debugLog`）、`:463-475`、`:477-611`、`:613-642`、`:644-670`、`:672-805`、`:808-839`、`:841-870`
- テスト: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts`
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:710`・`:759`・`:852`（`processed` は `add` されるだけで読まれない）、research.md §3（`xargs ` × 100 の走査は 1,025,156 文字、× 700 は 3.44 億文字）

- [ ] **Step 1: 失敗するテストを書く**

`describe("parser limits (Issue #235)", …)` の中に追加する。期待値は変更前のコードで採取した出力である。

```ts
it("keeps today's fragments under the scan limit", async () => {
  const mark = parserGiveUpMark();
  deepStrictEqual(
    await extractBaseCommands("timeout 10 env A=b xargs sh -c 'echo hi'"),
    {
      individualCommands: ["echo hi"],
      originalCommand: "timeout 10 env A=b xargs sh -c 'echo hi'",
      parsingMethod: "tree-sitter",
    },
  );
  deepStrictEqual(
    await extractBaseCommands("echo $(xargs echo a) $(xargs echo b)"),
    {
      individualCommands: ["xargs echo b", "echo b", "echo b)"],
      originalCommand: "echo $(xargs echo a) $(xargs echo b)",
      parsingMethod: "tree-sitter",
    },
  );
  deepStrictEqual(
    await extractBaseCommands("ls | xargs -n1 echo | xargs -n1 cat"),
    {
      individualCommands: ["ls", "xargs -n1 echo", "-n1 echo", "xargs -n1 cat"],
      originalCommand: null,
      parsingMethod: "tree-sitter",
    },
  );
  strictEqual(parserGiveUpReasonSince(mark), null);
});

for (const [name, command] of [
  ["a chain of wrapper words", "xargs ".repeat(700)],
  ["sibling substitutions", `echo ${"$(xargs echo a) ".repeat(500)}`],
] as const) {
  it(`stops the extractor at the scan limit on ${name}`, async () => {
    const mark = parserGiveUpMark();
    const start = performance.now();
    await extractBaseCommands(command);
    ok(performance.now() - start < 1000);
    ok(parserGiveUpReasonSince(mark)?.includes("2,000,000 characters scanned"));
  });
}

it("counts the scan across calls made after one mark", async () => {
  const mark = parserGiveUpMark();
  await extractBaseCommands(`${"xargs ".repeat(100)}one`);
  strictEqual(parserGiveUpReasonSince(mark), null);
  await extractBaseCommands(`${"xargs ".repeat(100)}two`);
  await extractBaseCommands(`${"xargs ".repeat(100)}three`);
  ok(parserGiveUpReasonSince(mark)?.includes("2,000,000 characters scanned"));
});

it("prints no debug lines unless BASH_PARSER_DEBUG is set", async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(String(args[0]));
  };
  try {
    await extractCommandsStructured("ls | xargs -n1 echo debug-lines");
  } finally {
    console.error = original;
  }
  deepStrictEqual(
    lines.filter(
      (line) =>
        line.startsWith("[bash-parser]") ||
        line.startsWith("[extractMetaCommands]"),
    ),
    [],
  );
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT bash-parser.test.ts`
期待: 追加した 5 件のうち 4 件が FAIL（`stops the extractor …` の 2 件は 1000 ms を超える、`counts the scan …` は理由が `null`、`prints no debug lines …` は配列が空でない）。`keeps today's fragments …` は PASS

- [ ] **Step 3: 最小実装を書く**

(1) ファイル先頭の `_debugLog` を差し替える。引数を関数にするのは、`DEBUG` が偽のとき文字列を組み立てないため。

```ts
function debugLog(message: () => string) {
  if (DEBUG) console.error(message());
}
```

(2) `console.error(` のうち、第 1 引数が `` `[bash-parser] `` または `` `[extractMetaCommands] `` で始まるものをすべて `debugLog(() => <同じテンプレート文字列>)` に置き換える。対象は 484・514・525・572・582・583・593・680・687・693・707・714・741・755・763・790・801 行で始まる呼び出しで、複数の引数を持つものはない。置き換えた後、`grep -n 'console.error' home/dot_claude/hooks/lib/bash-parser.ts` の結果が `debugLog` の中の 1 行、`collectExecutableTexts failed` の 1 行、`parser cleanup failed` の 1 行の 3 行だけであることを確かめる。`collectExecutableTexts failed` を出す 1033 行と、T1 で足した `parser cleanup failed` は置き換えない。`console.warn` は変えない。

(3) T1 で足した `parseBounded` の直前に追加する。

```ts
// One per parseBashCommand call, shared by reference with every nested call.
interface MetaWork {
  // metaScanned when the call started.
  start: number;
  capped: boolean;
}

/** False when the scan limit is reached: the caller must not scan `text`. */
function chargeScan(work: MetaWork, text: string): boolean {
  if (work.capped) return false;
  metaScanned += text.length;
  if (metaScanned - work.start > MAX_META_SCAN_CHARS) {
    markCapped(work);
    return false;
  }
  return true;
}

function markCapped(work: MetaWork): void {
  if (work.capped) return;
  work.capped = true;
  giveUps.push("scan");
}
```

(4) 引数を置き換える。`processed: Set<string>` を取る関数は `work: MetaWork` を取るようにし、`processed.add(command);` の 3 行（710・759・852）は削除する。

- `parseBashCommand`: 長さの検査の直後に `const work: MetaWork = { start: metaScanned, capped: false };` を置き、`parseWithTreeSitter(command, work)` と `parseWithFallback(command, work)` を呼ぶ
- `parseWithTreeSitter(command: string, work: MetaWork)`: `extractMetaCommands(command, new Set<string>())` を `extractMetaCommands(command, work)` に、`extractCommandSubstitutions(command)` を `extractCommandSubstitutions(command, work)` に、2 か所の `parseWithFallback(command)`（522・602 行）を `parseWithFallback(command, work)` にする
- `parseWithFallback(command: string, work: MetaWork)`: `extractCommandsInternal(command)` を `extractCommandsInternal(command, work)` にする
- `extractCommandsInternal(command: string, work: MetaWork)`: 本体の先頭を次にし、`const processed = new Set<string>();` を削除し、`extractMetaCommands(command, work)` と `extractFromControlStructures(command, work)` を呼ぶ

```ts
// After the scan limit nothing is split further; the hooks deny the command.
if (work.capped) return [command];
```

- `extractMetaCommands(command: string, work: MetaWork)`: `const commands: string[] = [];` の直後に `if (!chargeScan(work, command)) return commands;` を置く。`while ((match = regex.exec(part)) !== null) {` の直後に `if (work.capped) break;` を置く。内側の呼び出しは `extractCommandsInternal(quoted, work)`・`extractCommandsInternal(extractedCommand, work)`・`extractCommandSubstitutions(cmd, work)`（2 か所）にする
- `extractCommandSubstitutions(command: string, work: MetaWork)`: `const commands: string[] = [];` の直後に `if (!chargeScan(work, command)) return [command];` を置く。2 つの `while` の直後にそれぞれ `if (work.capped) break;` を置く。内側の呼び出しは `extractCommandsInternal(substitutedCommand, work)`（2 か所）にする
- `extractFromControlStructures(command: string, work: MetaWork)`: `const commands: string[] = [];` の直後に `if (!chargeScan(work, command)) return commands;` を置く

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT bash-parser.test.ts` と `bun run typecheck`
期待: 追加した 5 件が PASS。`BASE_GOLDEN` を含む既存のテストが PASS。typecheck のエラー 0 件（`MetaWork` の渡し忘れは引数の不足として検出される）

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/bash-parser.ts home/dot_claude/hooks/tests/unit/bash-parser.test.ts
git commit -m "fix(hooks): cap the meta-command extractor by characters scanned"
```

### T3: `extractCommandsStructured` の結果を文字列ごとに覚える（K3）

**Files:**

- 編集: `home/dot_claude/hooks/lib/bash-parser.ts:1042-1055`
- テスト: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts`
- 参照: `home/dot_claude/hooks/lib/pattern-matcher.ts:419-423`（deny パターンごとに同じ断片を渡し直す呼び出し元）

- [ ] **Step 1: 失敗するテストを書く**

`describe("parser limits (Issue #235)", …)` の中に追加する。

```ts
it("returns an equal, independent result for a repeated input", async () => {
  const first = await extractCommandsStructured("echo memo-a; ls memo-a");
  first.individualCommands.push("mutated by the caller");
  deepStrictEqual(await extractCommandsStructured("echo memo-a; ls memo-a"), {
    individualCommands: ["echo memo-a", "ls memo-a"],
    originalCommand: null,
    parsingMethod: "tree-sitter",
  });
});

it("replays a give-up when a remembered result is reused", async () => {
  const command = `echo ${"b".repeat(MAX_COMMAND_CHARS)}`;
  await extractCommandsStructured(command);
  const mark = parserGiveUpMark();
  await extractCommandsStructured(command);
  ok(parserGiveUpReasonSince(mark)?.includes("32,000 characters"));
});

it("does not scan a repeated input again", async () => {
  const command = `${"xargs ".repeat(100)}memo-c`;
  await extractCommandsStructured(command);
  const mark = parserGiveUpMark();
  await extractCommandsStructured(command);
  await extractCommandsStructured(command);
  await extractCommandsStructured(command);
  strictEqual(parserGiveUpReasonSince(mark), null);
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT bash-parser.test.ts`
期待: `does not scan a repeated input again` が FAIL（3 回の走査で 2,000,000 文字を超え、理由が `null` でない）。他の 2 件は PASS（覚える前でも成り立つ。覚えた後も成り立つことを固定する）

Step 3 の前に、覚える前の時間を 1 回測って控える（spec K3 の「覚える前後の時間」）。`a | ` × 7,999 + `a`（31,997 文字、構文が正しい）を、T8 Step 1 と同じ方法で auto-approve に run-guard 経由で渡し、所要時間を記録する。Step 4 の後に同じ計測をもう 1 回行い、2 つの値を PR の本文に書く。

Promise が reject したときに Map から消す動作は、テストしない。`computeStructured` が reject するのは tree-sitter の初期化の失敗だけで、テストのプロセスの中では起こせない。

- [ ] **Step 3: 最小実装を書く**

`extractCommandsStructured` を次に差し替え、元の本体（T1 で足した長さの検査を含む）を `computeStructured` に移す。

```ts
interface StructuredMemo {
  result: Promise<ExtractedCommands>;
  // Give-ups recorded while computing, replayed to callers that reuse it.
  replay: ParserGiveUpKind[];
}

// Keyed by the input text. pattern-matcher re-extracts each fragment once per
// Bash deny pattern; without this the scan total of a hook is multiplied by
// the number of patterns.
const structuredMemo = new Map<string, StructuredMemo>();

export async function extractCommandsStructured(
  command: string,
): Promise<ExtractedCommands> {
  let memo = structuredMemo.get(command);
  if (memo === undefined) {
    const before = giveUps.length;
    const created: StructuredMemo = {
      result: computeStructured(command).then((value) => {
        created.replay = giveUps.slice(before);
        return value;
      }),
      replay: [],
    };
    structuredMemo.set(command, created);
    try {
      const value = await created.result;
      return { ...value, individualCommands: [...value.individualCommands] };
    } catch (error) {
      structuredMemo.delete(command);
      throw error;
    }
  }
  const value = await memo.result;
  giveUps.push(...memo.replay);
  return { ...value, individualCommands: [...value.individualCommands] };
}

async function computeStructured(command: string): Promise<ExtractedCommands> {
  if (command.length > MAX_COMMAND_CHARS) {
    giveUps.push("length");
    return {
      individualCommands: wholeAndCoarse(command),
      originalCommand: null,
      parsingMethod: "fallback",
    };
  }
  const base = await extractBaseCommands(command);
  const supplement = await collectExecutableTexts(command, base.parsingMethod);
  const seen = new Set(base.individualCommands.map((c) => c.trim()));
  const individualCommands = [...base.individualCommands];
  for (const text of supplement) {
    if (seen.has(text)) continue;
    seen.add(text);
    individualCommands.push(text);
  }
  return { ...base, individualCommands };
}
```

`let memo` は再代入しないので `const memo` にする。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT bash-parser.test.ts` と `bun run typecheck`
期待: 追加した 3 件と既存のテストが PASS。typecheck のエラー 0 件

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/lib/bash-parser.ts home/dot_claude/hooks/tests/unit/bash-parser.test.ts
git commit -m "perf(hooks): remember structured extraction results per command text"
```

### T4: auto-approve が打ち切りを deny にする（K4）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/auto-approve.ts:373-456`（`processBashTool`）と import
- テスト: `home/dot_claude/hooks/tests/unit/auto-approve.test.ts`
- 参照: `home/dot_claude/hooks/implementations/auto-approve.ts:210-224`（`BashCommandResult` の `deny` の形）、`home/dot_claude/hooks/tests/unit/auto-approve.test.ts:283-301`（`processBashTool` に `stages` を渡す既存のテスト）

- [ ] **Step 1: 失敗するテストを書く**

`auto-approve.test.ts` の import に `import { parseForCollect } from "../../lib/bash-parser.ts";` を足し、`describe("whole-text allow (spec K1/K2/K4)", …)` の直後に追加する。`autoApproveHook`・`processBashTool`・`createPreToolUseContextFor`・`invokeRun`・`envHelper` はこのファイルで既に使っているもの。

```ts
describe("parser limits (Issue #235)", () => {
  it("denies a command over the length limit without classifying fragments", async () => {
    let classified = 0;
    const result = await processBashTool(
      { command: `ls ${"a".repeat(32000)}` },
      [],
      ["Bash(ls *)"],
      "/tmp",
      {
        classifyBashDeny: async () => {
          classified++;
          return { type: "clear" };
        },
        matchBashAllow: async (cmd) => ({
          type: "allow",
          command: cmd,
          pattern: "Bash(ls *)",
        }),
      },
    );
    strictEqual(classified, 0);
    strictEqual(result.commands.length, 1);
    strictEqual(result.commands[0]?.type, "deny");
    strictEqual(result.hasAskRequired, false);
    strictEqual(result.hasPassRequired, false);
  });

  it("denies when a fragment's re-parse gives up during classification", async () => {
    const result = await processBashTool(
      { command: "ls -la" },
      [],
      ["Bash(ls *)"],
      "/tmp",
      {
        classifyBashDeny: async () => {
          await parseForCollect(`echo aa-limit ${">".repeat(20000)}`);
          return { type: "clear" };
        },
        matchBashAllow: async (cmd) => ({
          type: "allow",
          command: cmd,
          pattern: "Bash(ls *)",
        }),
      },
    );
    deepStrictEqual(
      result.commands.map((c) => c.type),
      ["deny"],
    );
  });

  it("denies through the hook with the limit as the reason", async () => {
    envHelper.set("CLAUDE_TEST_ALLOW", JSON.stringify(["Bash(ls *)"]));
    envHelper.set("CLAUDE_TEST_DENY", JSON.stringify([]));
    const context = createPreToolUseContextFor(autoApproveHook, "Bash", {
      command: `ls ${"b".repeat(32000)}`,
    });
    await invokeRun(autoApproveHook, context);
    context.assertDeny();
    const reason =
      context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
    ok(reason?.includes("32,000 characters"), reason);
    ok((reason?.length ?? 0) < 2000, `${reason?.length} characters`);
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT auto-approve.test.ts`
期待: 追加した 3 件が FAIL（1 件目は `classified` が 0 でない、2 件目は `["allow"]`、3 件目は deny でない）

- [ ] **Step 3: 最小実装を書く**

import に追加する。

```ts
import {
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
```

`processBashTool` の `const { maskedText, individualCommands, parsingMethod } = await prepareDenyInput(bashCommand);` を次に差し替える。

```ts
// Taken before any parser call. A command the parser stopped analysing is
// denied whatever its fragments say (today it is blocked by the 20 s
// timeout); coarse fragments alone would let some writes through.
const giveUpMark = parserGiveUpMark();
const deniedForGiveUp = (): BashToolResult | null => {
  const reason = parserGiveUpReasonSince(giveUpMark);
  if (reason === null) return null;
  // The decision reason quotes `command`; a full over-limit command would
  // push the reason itself out of what the reader sees.
  const shown =
    bashCommand.length > 200
      ? `${bashCommand.slice(0, 200)}… (${bashCommand.length} characters)`
      : bashCommand;
  return {
    commands: [{ type: "deny", command: shown, reason }],
    hasAskRequired: false,
    hasPassRequired: false,
  };
};
const { maskedText, individualCommands, parsingMethod } =
  await prepareDenyInput(bashCommand);
// Before the whole-text home check: both outcomes are a deny, and this one
// skips reading a text the parser already refused.
const gaveUpOnInput = deniedForGiveUp();
if (gaveUpOnInput !== null) return gaveUpOnInput;
```

断片ごとのループの `const result = await stages.classifyBashDeny(target, denyList, { readOnlyExempt });` の直後に追加する（pattern-matcher が断片を parse し直したときの打ち切りを、ask を返すより前に拾う）。

```ts
const gaveUpOnFragment = deniedForGiveUp();
if (gaveUpOnFragment !== null) return gaveUpOnFragment;
```

関数の最後の `return {` の直前に追加する。

```ts
const gaveUpLate = deniedForGiveUp();
if (gaveUpLate !== null) return gaveUpLate;
```

`if (commands.some((c) => c.type === "deny")) { return … }` は既に deny を返すので変えない。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT auto-approve.test.ts` と `bun run typecheck`
期待: 追加した 3 件と既存のテストが PASS。typecheck のエラー 0 件

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/auto-approve.ts home/dot_claude/hooks/tests/unit/auto-approve.test.ts
git commit -m "fix(hooks): deny in auto-approve when the parser gives up"
```

### T5: deny-node-modules が打ち切りを deny にする（K4、R2）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/deny-node-modules.ts:203-212`（`analyzeBashCommand`）、`:62-65`（symlink の免除）と import
- テスト: `home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts:288-304`
- 参照: `home/dot_claude/hooks/implementations/deny-node-modules.ts:222-228`（`decision: "deny"` を返す既存の形）、research.md §3（`node_modules cp cp …` 28k 文字の走査は 56,024 文字、parse を含めて 20 ms）

- [ ] **Step 1: 失敗するテストを書く**

`describe("long repeated words", …)` の中の `for (const [name, command] of [ … ] as const) { … }` の入力を、長さの制約の内側に縮める（正規表現の表が線形であることを確かめる目的は変えない）。

```ts
    for (const [name, command] of [
      ["a repeated cp word", NM + " cp ".repeat(7000)],
      ["a repeated ls word", NM + " " + "ls ".repeat(9000)],
    ] as const) {
```

同じ `describe` の中に追加する。`denyNodeModulesHook`・`createPreToolUseContext`・`invokeRun` はこのファイルで既に使っているもの。

```ts
// Issue #235: over the parser's length limit the command is not analysed.
for (const [name, command] of [
  ["mentions node_modules", NM + " cp ".repeat(25000)],
  ["does not mention it", `echo ${"a".repeat(32000)}`],
] as const) {
  it(`denies a command over the length limit that ${name}`, async () => {
    const context = createPreToolUseContext("Bash", { command });
    const start = performance.now();
    await invokeRun(denyNodeModulesHook, context);
    const elapsed = performance.now() - start;

    ok(elapsed < 1000, `${elapsed} ms`);
    context.assertDeny();
  });
}

// The symlink-removal exemption reads the whole text before the parser
// does, so it must not apply to a command over the length limit.
it("does not exempt a symlink removal padded over the length limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dnm-limit-"));
  try {
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, NM));
    const context = createPreToolUseContext("Bash", {
      command: `rm${" ".repeat(100000)}${join(dir, NM)}`,
    });
    await invokeRun(denyNodeModulesHook, context);
    context.assertDeny();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

`mkdtempSync`・`mkdirSync`・`symlinkSync`・`rmSync`・`tmpdir`・`join` はこのファイルが既に import している。

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT deny-node-modules.test.ts`
期待: 追加した 3 件が FAIL（1 件目は ask、2 件目は success、3 件目は免除されて success）。縮めた 2 件は PASS

- [ ] **Step 3: 最小実装を書く**

import に追加する。

```ts
import {
  MAX_COMMAND_CHARS,
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
```

hook の `run` の中の symlink の免除（`deny-node-modules.ts:62-65`）は、長さの制約の内側のコマンドだけに適用する。この免除は `analyzeBashCommand` より前に全文を読むので、制約を超える入力をここで読ませない。

```ts
const linkOperands =
  cmd.length > MAX_COMMAND_CHARS ? null : standaloneSymlinkRemovalOperands(cmd);
```

`analyzeBashCommand` の `const { maskedText, individualCommands, parsingMethod } = await prepareDenyInput(command);` を次に差し替える。

```ts
const giveUpMark = parserGiveUpMark();
const { maskedText, individualCommands, parsingMethod } =
  await prepareDenyInput(command);
// A command the parser stopped analysing is denied whether or not its text
// mentions node_modules: the fragments below are incomplete for it.
const giveUpReason = parserGiveUpReasonSince(giveUpMark);
if (giveUpReason !== null) {
  return { decision: "deny", reason: giveUpReason, operation: "unknown" };
}
```

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT deny-node-modules.test.ts` と `bun run typecheck`
期待: 追加した 3 件、縮めた 2 件、既存のテストが PASS。typecheck のエラー 0 件

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/deny-node-modules.ts home/dot_claude/hooks/tests/unit/deny-node-modules.test.ts
git commit -m "fix(hooks): deny in deny-node-modules when the parser gives up"
```

### T6: document-workflow-guard が打ち切りを deny にする（K4、R6）

**Files:**

- 編集: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:78-81`（`run` の先頭）、`:219-226`（`analyzeBashWrite` の直後）、`:335-347`（外側の catch）と import
- テスト: `home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts`
- 参照: `home/dot_claude/hooks/implementations/document-workflow-guard.ts:277-285`（`warnOnly` のときの既存の扱いと `createDenyResponse`）、`home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts:86-98`（`pendingWorkflowRepo` を使う既存のテスト）

- [ ] **Step 1: 失敗するテストを書く**

`describe("document-workflow-guard.ts hook behavior", …)` の中に追加する。`hook`・`envHelper`・`createWorkflowRepo`・`pendingWorkflowRepo`・`createPreToolUseContextFor`・`invokeRun` はこのファイルで既に使っているもの。

```ts
describe("parser limits (Issue #235)", () => {
  it("denies a Bash command over the length limit", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const context = createPreToolUseContextFor(hook, "Bash", {
      command: `echo ${"a".repeat(32000)}`,
    });
    await invokeRun(hook, context);
    context.assertDeny();
    const reason =
      context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
    ok(reason?.includes("32,000 characters"), reason);
  });

  it("denies a write hidden behind an input the parser gives up on", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    const context = createPreToolUseContextFor(hook, "Bash", {
      command: `for f in a; do tee src/a.ts; done; echo ${">".repeat(20000)}`,
    });
    const start = performance.now();
    await invokeRun(hook, context);
    ok(performance.now() - start < 1000);
    context.assertDeny();
    const reason =
      context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason;
    ok(reason?.includes("within 100 ms"), reason);
  });

  it("only warns under DOCUMENT_WORKFLOW_WARN_ONLY", async () => {
    const repo = createWorkflowRepo(pendingWorkflowRepo());
    envHelper.set("CLAUDE_TEST_CWD", repo);
    envHelper.set("DOCUMENT_WORKFLOW_WARN_ONLY", "1");
    const context = createPreToolUseContextFor(hook, "Bash", {
      command: `echo ${"c".repeat(32000)}`,
    });
    await invokeRun(hook, context);
    context.assertSuccess({});
  });
});
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `NT document-workflow-guard.test.ts`
期待: 1 件目と 2 件目が FAIL（1 件目は deny でなく success。2 件目は今も deny だが、parse に約 3.6 秒かかり、理由は `src/a.ts` の gate の診断で、`within 100 ms` を含まない）。3 件目は PASS（変更後も成り立つことを固定する）

- [ ] **Step 3: 最小実装を書く**

import に追加する。

```ts
import {
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
```

`run: async (context) => {` の直後、`try {` の前に追加する。

```ts
// Taken outside the try: the catch below allows the call on an internal
// error, and must not do so for a command the parser stopped analysing.
const giveUpMark = parserGiveUpMark();
```

`const analysis = await analyzeBashWrite(command, cwd, wfDir, gateClosed);` の直後、`if (!analysis.isWriteLike) {` の前に追加する。

```ts
// The fragments of a command the parser stopped analysing are
// incomplete, so they cannot show that it writes nothing.
const giveUpReason = parserGiveUpReasonSince(giveUpMark);
if (giveUpReason !== null) {
  if (warnOnly) {
    console.error("[document-workflow-guard][would-block] Bash: parser limits");
    return context.success({});
  }
  return context.json(createDenyResponse(giveUpReason));
}
```

外側の `catch (error) {` の本体の先頭に追加する（`warnOnly` は try の中の変数なので、環境変数を読み直す）。

```ts
const giveUpReason = parserGiveUpReasonSince(giveUpMark);
if (giveUpReason !== null && process.env.DOCUMENT_WORKFLOW_WARN_ONLY !== "1") {
  return context.json(createDenyResponse(giveUpReason));
}
```

catch の経路は、パーサーの後で例外を起こす差し込み口がこの hook にないので、テストでは通さない。コードの読み合わせで確かめる（T8 の Step 3）。

- [ ] **Step 4: テストを実行して通過を確認**

実行: `NT document-workflow-guard.test.ts` と `bun run typecheck`
期待: 追加した 3 件と既存のテストが PASS。typecheck のエラー 0 件

- [ ] **Step 5: コミット**

```bash
git add home/dot_claude/hooks/implementations/document-workflow-guard.ts home/dot_claude/hooks/tests/unit/document-workflow-guard.test.ts
git commit -m "fix(hooks): deny in document-workflow-guard when the parser gives up"
```

### T7: hook が打ち切りを確認していることの固定と、既存テストの入力の調整（K4、R2）

**Files:**

- テスト: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts:596-601` と `describe("parser limits (Issue #235)", …)`
- 参照: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts:559-577`（実装ファイルを読んで識別子の有無を確かめる既存のテスト）

- [ ] **Step 1: テストを書く**

`splits a body with a long blank run in linear time` の入力を、長さの制約の内側に縮める（for ループの本体の分割を通す目的を保つ。変更前のコードでの走査は 120,093 文字、2 ms）。

```ts
const command = `bash -c "for x in a; do echo${" ".repeat(30000)}y; done"`;
```

`describe("parser limits (Issue #235)", …)` の中に追加する。

```ts
it("is read by every guard hook that parses Bash commands", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const implementations = join(
    import.meta.dirname,
    "..",
    "..",
    "implementations",
  );
  for (const file of [
    "auto-approve.ts",
    "deny-node-modules.ts",
    "document-workflow-guard.ts",
  ]) {
    const source = readFileSync(join(implementations, file), "utf8");
    ok(source.includes("parserGiveUpMark()"), file);
    ok(source.includes("parserGiveUpReasonSince("), file);
  }
});
```

- [ ] **Step 2: テストを実行して通過を確認**

実行: `NT bash-parser.test.ts`
期待: PASS（T4〜T6 が済んでいるので最初から通る。T4〜T6 のどれかを取り消すと FAIL することを、`deny-node-modules.ts` の `parserGiveUpMark()` の呼び出しを一時的に `{ giveUps: 0, scanned: 0 }` に置き換えて 1 回確かめ、元に戻す）

- [ ] **Step 3: 全体の検査**

実行: `bun run test`、`bun run typecheck`、`bun run lint`
期待: 3 つとも終了コード 0

- [ ] **Step 4: コミット**

```bash
git add home/dot_claude/hooks/tests/unit/bash-parser.test.ts
git commit -m "test(hooks): pin that guard hooks read the parser's give-ups"
```

### T8: hook プロセス単位の計測と記録

**Files:**

- 参照: `home/dot_claude/hooks/executable_run-guard.sh:15`（計測は run-guard 経由で行う）、research.md §6（変更前の値）

repo のファイルは変えない。計測のスクリプトは session の scratchpad に置く。

hook の起動は次の形で行う。stdin に JSON を渡し、所要時間は起動の前後の時刻の差で測る。

```
sh home/dot_claude/hooks/executable_run-guard.sh home/dot_claude/hooks/implementations/<hook>.ts < input.json
```

`input.json` は `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"<コマンド>"},"session_id":"<session id>","transcript_path":"/tmp/none.jsonl","permission_mode":"default","tool_use_id":"t1","cwd":"<cwd>"}` の形にする。

document-workflow-guard を workflow が active な状態で測るときは、`mktemp -d` で作った一時ディレクトリを project として使う。その中に `.tmp/sessions/aaaaaaaa/research.md`（本文は `research`）と `.tmp/sessions/aaaaaaaa/plan.md`（`- Plan Status: draft` を含む未承認の plan）を置き、`cwd` をそのディレクトリ、`session_id` を `aaaaaaaa-0000-0000-0000-000000000000` にし、環境変数 `CLAUDE_PROJECT_DIR` もそのディレクトリにする。`DOCUMENT_WORKFLOW_DIR` は指定しない。この hook は入力の `cwd` ではなくプロセスの作業ディレクトリを使うので（`document-workflow-guard.ts:361`）、同じ 1 回の呼び出しの中で一時ディレクトリに `cd` してから、run-guard と hook を絶対パスで起動する。準備ができたことは、`touch src.ts` を渡して deny が返ることで確かめる。

- [ ] **Step 1: 4 形 × 100,000 文字 × 3 hook**

`xargs ` の繰り返し、`a | ` の繰り返し、`(a) ` の繰り返し、`echo ` + `>` の繰り返しを各 100,000 文字で作り、auto-approve・deny-node-modules・document-workflow-guard を 1 回ずつ起動して、終了コードと所要時間を記録する。
期待: 12 回とも 500 ms 以内。出力は 12 回とも deny の JSON で、理由に `32,000 characters` を含む

- [ ] **Step 2: 制約の内側**

次を auto-approve で 1 回ずつ測る。

- `echo ` + `>` × 20,000 → 期待: 500 ms 以内、deny、理由に `within 100 ms` を含む
- `a | ` × 8,000（32,000 文字）→ 期待: deny。時間は記録するだけにする（spec K7 の例外で、変更前の計測は約 1.0〜1.3 秒）
- `a | ` × 7,999 + `a`（31,997 文字、構文が正しい）→ 期待: 理由に `Bash command` で始まる打ち切りの文言を含まない。時間を記録する（T3 の前後の値と並べる）
- `a; ` × 10,600 + `xargs x`（31,807 文字。断片が約 10,600 個で、`parseSimpleCommandFallback` の `indexOf` が断片の数だけ走る形）→ 期待: 500 ms 以内。超えた場合は時間を PR の本文と Issue #235 に書く
- `ls` だけ → 期待: auto-approve と deny-node-modules の stderr が 0 バイト

3 つの hook を同時に起動した場合の `ls -la; ` × 4,000 + `true`（32,004 文字にならないよう `ls -la; ` × 3,999 + `true` の 31,996 文字）の時間を 1 回測る。期待: 3 つとも打ち切りの deny を返さない。

- [ ] **Step 3: 走査の合計と catch の経路の確認**

scratchpad のスクリプトで、直近 30 日の transcript にある Bash コマンド（research.md §3 と同じ集め方、重複を除く）を 1 件ずつ `processBashTool`（`auto-approve.ts` の export）に渡す。deny と allow の一覧は `~/.claude/settings.json` の `permissions.deny` と `permissions.allow` から読む。各コマンドについて、呼び出しの前後の `parserGiveUpMark().scanned` の差と、`parserGiveUpReasonSince` が理由を返したかを記録する。スクリプトは件数と数値だけを出力し、コマンドの内容は出力しない。
期待: 理由が返ったコマンドは 0 件。走査の差の最大値を research.md §3 の 131,530 文字と並べて PR の本文に書く（200,000 文字を超えた場合は、その値と件数も書く）。

`document-workflow-guard.ts` の外側の catch に足した分岐を読み、`giveUpMark` が try の外で宣言されていること、`createDenyResponse` を返していることを確かめる。

- [ ] **Step 4: 記録**

Step 1〜3 の数値を PR の本文に書く。「末尾が `|`」の 22k〜32k 文字の値と、既存のテスト 2 か所の期待を変えたことを Issue #235 にコメントする。

## ISO 25010 具体テストケース

### 性能効率性（時間効率性）

- **入力**: `echo limit-a ` + `>` × 20,000 を `extractCommandsStructured` に渡す → **期待**: 1000 ms 未満で返り、`parsingMethod` が `"fallback"`（T1）
- **入力**: `xargs ` × 700 を `extractBaseCommands` に渡す → **期待**: 1000 ms 未満で返る（T2）
- **入力**: Issue の 4 形 × 100,000 文字を 3 つの hook に run-guard 経由で渡す → **期待**: 12 回とも 500 ms 以内（T8 Step 1）
- **入力**: `a | ` × 8,000（32,000 文字）を auto-approve に渡す → **期待**: deny。時間は基準を設けず記録する（spec K7）

### セキュリティ

- **入力**: `ls ` + `a` × 32,000 を、`Bash(ls *)` を allow に持つ auto-approve に渡す → **期待**: deny、理由に `32,000 characters` を含む（T4）
- **入力**: `ls -la` の判定の途中で、断片の parse が打ち切られる → **期待**: auto-approve の結果が deny 1 件（T4）
- **入力**: `for f in a; do tee src/a.ts; done; echo ` + `>` × 20,000 を、plan が未承認の document-workflow-guard に渡す → **期待**: deny（T6）
- **入力**: `echo ` + `a` × 32,000（`node_modules` を含まない）を deny-node-modules に渡す → **期待**: deny（T5）

### 機能適合性（正確性）

- **入力**: 32,000 文字ちょうどの `echo aaa…` → **期待**: `parsingMethod` が `"tree-sitter"`、打ち切りの理由が `null`（T1）
- **入力**: 32,005 文字の `echo aaa…` → **期待**: `parsingMethod` が `"fallback"`、理由に `32,000 characters` を含む（T1）
- **入力**: `timeout 10 env A=b xargs sh -c 'echo hi'` → **期待**: `individualCommands` が `["echo hi"]`（変更前と同じ。T2）
- **入力**: `xargs ` × 100 + `one`、`…two`、`…three` を 1 つの mark の後に順に渡す → **期待**: 1 つ目の後は理由が `null`、3 つ目の後は理由に `2,000,000 characters scanned` を含む（T2）
- **入力**: `node_modules` + `cp` × 7,000（28,012 文字）を deny-node-modules に渡す → **期待**: ask（変更前の 100k 文字の入力と同じ判定。T5）

### 信頼性（障害許容性）

- **入力**: 打ち切られる入力を parse した直後に `echo after-limit-c` を渡す → **期待**: `parsingMethod` が `"tree-sitter"`、`individualCommands` が `["echo after-limit-c"]`（T1）
- **入力**: 同じ打ち切られる入力を 2 回 `parseForCollect` に渡す → **期待**: 2 回目は 50 ms 未満で `null`、打ち切りの理由が記録される（T1）

### 使用性（エラーの明確さ）

- **入力**: 32,000 文字を超えるコマンドを auto-approve の hook に渡す → **期待**: `permissionDecisionReason` に `32,000 characters` を含む（T4）
- **入力**: `ls | xargs -n1 echo debug-lines` を `BASH_PARSER_DEBUG` なしで渡す → **期待**: `[bash-parser]`・`[extractMetaCommands]` で始まる stderr の行が 0 件（T2）

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: needs-work
- 主指摘: T6 の 2 件目のテストは今も deny で、打ち切りの確認の有無を区別しない。デバッグ行の一覧に 583 行が抜けている。T8 の document-workflow-guard の準備では workflow が active にならない。T7 の取り消しの確かめ方では FAIL しない。→ 4 点とも直した

### scope-justification-reviewer

- verdict: needs-work
- 主指摘: T1〜T7 は spec を網羅している。T8 に `indexOf` の計測、結果を覚える前後の比較、実際の deny の一覧での走査の合計の読み方がない。→ T3 と T8 に足した

### security-vulnerability-analyzer

- verdict: pass
- 主指摘: 保証を満たさないコードは見つからない。軽微: deny の理由にコマンド全文が入ると理由が切り捨てられうる、symlink の免除が長さの確認より前に全文を読む。→ T4 と T5 に反映した

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- parent-spec-hash は plan-review-automation hook が auto-review marker 生成時に挿入する。手で編集しない。 -->

## Reviewer Outputs (Round 2)

### logic-validator

- verdict: needs-work
- 主指摘: T5 の 3 件目のテスト（`rm` + 空白 + `node_modules`）は今も deny で、免除の経路を通らない。T8 の document-workflow-guard はプロセスの作業ディレクトリを使うので、準備の確認が成り立たない。→ 実在する symlink を使うテストに替え、T8 に `cd` を明記した

### scope-justification-reviewer

- verdict: pass
- 主指摘: spec の全項目にタスクがある。security 由来の 2 点（理由に入れるコマンドの短縮、symlink の免除の制限）は Goal の範囲内。軽微: symlink の免除の制限を PR の本文に書くこと。

### security-vulnerability-analyzer

- verdict: pass (carried from Round 1)
- 主指摘: Round 1 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=8ccec8a5112e23fe853a5203652fe9b410686dbb2af654aa7001864428afc71a; design-hash=baf65b9d0326c192546800bd8092452996a96a92f619d177ff0a3520d89228b0; round=1; parent-spec-hash=004215ca25a2dfce93ec399e26d1a5c8702c62968965a846ae7e7bc2f0f0df16; at=2026-10-04T11:06:58.512Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer -->

## Reviewer Outputs (Round 3)

### logic-validator

- verdict: pass
- 主指摘: T5 の新しいテストは、今のコードでは免除されて success になり、Step 3 の前に FAIL することを実行して確かめた。T8 の `cd` で準備の確認が成り立つ。symlink の免除が全文を読む処理は線形だった（時間の問題ではなく、制約を超えるコマンドが免除されないことがこの変更の理由になる）。

### scope-justification-reviewer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

### security-vulnerability-analyzer

- verdict: pass (carried from Round 2)
- 主指摘: Round 2 で pass、再実行なし

<!-- auto-review: verdict=needs-work; hash=999fd02f05edaff04f60abf7035153e86445cec9a2774308e5ba23d0c5140318; design-hash=7bce64217bc9803a86a4561172b6331769ecd6669c548b9e9cc243271d02460a; round=2; parent-spec-hash=004215ca25a2dfce93ec399e26d1a5c8702c62968965a846ae7e7bc2f0f0df16; at=2026-10-04T11:09:56.498Z; reviewers=logic-validator+scope-justification-reviewer -->

<!-- auto-review: verdict=pass; hash=62c0ff1236af4384a59d11b3621b81c231509e0e338aefb339fb976a80545b0d; design-hash=7bce64217bc9803a86a4561172b6331769ecd6669c548b9e9cc243271d02460a; round=3; parent-spec-hash=004215ca25a2dfce93ec399e26d1a5c8702c62968965a846ae7e7bc2f0f0df16; at=2026-10-04T11:10:49.799Z; reviewers=logic-validator+scope-justification-reviewer+security-vulnerability-analyzer -->
<!-- intent-triage: adopted=24; excluded=0; at=2026-10-04T11:10:49.818Z -->
