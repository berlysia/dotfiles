import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { prefixThenOnLine } from "../../lib/linear-match.ts";

const DD = prefixThenOnLine(/dd\s+/, /\/dev\//);

describe("prefixThenOnLine", () => {
  it("scans a repeated prefix word in linear time", () => {
    const start = performance.now();
    strictEqual(DD.test("dd if ".repeat(16667)), false);
    ok(performance.now() - start < 1000);
  });

  it("scans a long whitespace run after the prefix in linear time", () => {
    const start = performance.now();
    strictEqual(DD.test("dd " + " ".repeat(100000) + "x"), false);
    ok(performance.now() - start < 1000);
  });
});
