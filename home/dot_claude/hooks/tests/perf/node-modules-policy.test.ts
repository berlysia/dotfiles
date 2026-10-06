import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildReadOnlyPatterns,
  standaloneSymlinkRemovalOperands as ops,
} from "../../lib/node-modules-policy.ts";

describe("classifyDeletion", () => {
  it("judges a long repeated verb in linear time", () => {
    const text = "ls ".repeat(33334);
    const start = performance.now();
    for (const { pattern } of buildReadOnlyPatterns()) {
      strictEqual(pattern.test(text), false);
    }
    ok(performance.now() - start < 1000);
  });
});

describe("standaloneSymlinkRemovalOperands", () => {
  it("rejects a long inner blank run in linear time", () => {
    const start = performance.now();
    strictEqual(ops("eslint" + " ".repeat(500000) + "x"), null);
    ok(performance.now() - start < 1000);
  });
});
