import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { scanSafeList } from "../../lib/safe-command-list.ts";

describe("scanSafeList", () => {
  it("scans 100,000 characters in linear time", () => {
    const start = performance.now();
    deepStrictEqual(scanSafeList(`ls ${"a".repeat(100000)}`)?.length, 1);
    deepStrictEqual(scanSafeList(`ls${" ".repeat(100000)}b`)?.length, 1);
    deepStrictEqual(scanSafeList(`ls ;${" ;".repeat(50000)}`), null);
    ok(performance.now() - start < 1000);
  });
});
