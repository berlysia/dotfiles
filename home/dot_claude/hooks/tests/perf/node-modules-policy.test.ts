import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildReadOnlyPatterns,
  isNonModifyingShape,
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

describe("isNonModifyingShape", () => {
  const cases: Array<[string, boolean]> = [
    ["sed -n 1p " + "a ".repeat(16000) + "!", false],
    ["node_modules/.bin/tsc " + "a ".repeat(16000), true],
    ["node_modules/.bin/" + "a".repeat(32000) + "/", false],
  ];
  for (const [text, expected] of cases) {
    it(`judges ${text.length} characters in linear time`, () => {
      const start = performance.now();
      strictEqual(isNonModifyingShape(text), expected);
      ok(performance.now() - start < 1000);
    });
  }
});
