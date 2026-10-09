import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  sortOutputThenNodeModules,
  standaloneSymlinkRemovalOperands as ops,
} from "../../lib/node-modules-policy.ts";

describe("standaloneSymlinkRemovalOperands", () => {
  it("rejects a long inner blank run in linear time", () => {
    const start = performance.now();
    strictEqual(ops("eslint" + " ".repeat(500000) + "x"), null);
    ok(performance.now() - start < 1000);
  });
});

describe("sortOutputThenNodeModules", () => {
  it("judges a long run of options in linear time", () => {
    const matcher = sortOutputThenNodeModules();
    const start = performance.now();
    strictEqual(matcher.test("sort " + "-n ".repeat(10000) + "x"), false);
    ok(performance.now() - start < 1000);
  });
});
