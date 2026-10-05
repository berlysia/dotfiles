import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Baseline,
  type Finding,
  diffReports,
  formatNotice,
  hashNotice,
  isUsableCccc,
  listCcccCandidates,
  parseCcccOutput,
  shownFindings,
  toBaseline,
} from "../../lib/complexity-delta.ts";

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
          { ...fn("outer", 3, 10), children: [fn("<anonymous>", 7, 12, "arrow")] },
        ]),
      ]),
    );
    assert.ok(report);
    assert.deepEqual([...report.byKey.keys()], [
      "a.ts :: outer:function",
      "a.ts :: outer:function > <anonymous>:arrow",
    ]);
    assert.deepEqual(report.byKey.get("a.ts :: outer:function > <anonymous>:arrow"), [
      { path: "a.ts", name: "<anonymous>", line: 12, cognitive: 7 },
    ]);
  });

  it("collects same-key functions into one list", () => {
    const report = parseCcccOutput(
      output([file("./a.ts", [fn("run", 1, 1, "method"), fn("run", 3, 2, "method")])]),
    );
    assert.deepEqual(
      report?.byKey.get("a.ts :: run:method")?.map((m) => m.cognitive),
      [1, 3],
    );
  });

  it("treats a missing kind as empty, a non-integer line as null, and non-array children as none", () => {
    const report = parseCcccOutput(
      output([file("a.ts", [{ name: "f", cognitive: 2, line: "x", children: "nope" }])]),
    );
    assert.deepEqual(report?.byKey.get("a.ts :: f:"), [
      { path: "a.ts", name: "f", line: null, cognitive: 2 },
    ]);
  });

  it("marks parse-error files from either the file entry or the summary", () => {
    const report = parseCcccOutput(
      output(
        [file("./bad.ts", [], { parse_errors: ["Expected `,`"] }), file("./ok.ts", [])],
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
      output([file("./a.ts", [fn("run", 1, 1, "method"), fn("run", 3, 2, "method")])]),
    );
    assert.ok(report);
    assert.deepEqual(toBaseline(report), {
      functions: { "a.ts :: run:method": [1, 3] },
      parseErrorFiles: [],
    });
  });
});

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
  const one = (cognitive: number, line = 1) => [file("a.ts", [fn("f", cognitive, line)])];

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
    const before = [file("a.ts", [fn("<anonymous>", 30, 1), fn("<anonymous>", 2, 2)])];
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
        finding({ path: "b.ts", name: "g", line: null, before: null, after: 30 }),
      ]),
      [
        "[complexity-delta] Cognitive complexity rose this turn (>= 25, new or +5):",
        "  a.ts:3 f 24 → 44",
        "  b.ts g new 30",
      ].join("\n"),
    );
  });

  it("caps the list at ten lines and counts the rest", () => {
    const many = Array.from({ length: 13 }, (_, i) => finding({ name: `f${i}` }));
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
    assert.deepEqual(listCcccCandidates("/a/bin::.:rel/bin:/b"), ["/a/bin/cccc", "/b/cccc"]);
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
