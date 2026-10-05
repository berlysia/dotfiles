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
