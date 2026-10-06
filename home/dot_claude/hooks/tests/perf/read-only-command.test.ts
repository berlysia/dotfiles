import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isExemptReadOnlyCommand } from "../../lib/read-only-command.ts";

const exempt = (cmd: string) =>
  isExemptReadOnlyCommand(cmd, { parsingMethod: "tree-sitter" });

describe("isExemptReadOnlyCommand", () => {
  it("scans 100,000 characters in linear time", () => {
    const cmd = `grep ${"a".repeat(100000)}`;
    const start = performance.now();
    strictEqual(exempt(cmd), true);
    ok(performance.now() - start < 1000);
  });

  it("scans a long inner blank run in linear time", () => {
    const cmd = `grep a${" ".repeat(100000)}b f`;
    const start = performance.now();
    strictEqual(exempt(cmd), true);
    ok(performance.now() - start < 1000);
  });
});
