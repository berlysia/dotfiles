import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Baseline,
  type Finding,
  diffReports,
  parseCcccOutput,
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
