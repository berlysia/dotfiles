import { ok } from "node:assert";
import { describe, it } from "node:test";
import {
  extractBaseCommands,
  extractCommandsStructured,
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../../lib/bash-parser.ts";

describe("for-loop body splitting (Issue #219 H)", () => {
  it("splits a body with a long blank run in linear time", async () => {
    const command = `bash -c "for x in a; do echo${" ".repeat(30000)}y; done"`;
    const start = performance.now();
    await extractCommandsStructured(command);
    ok(performance.now() - start < 1000);
  });
});

describe("parser limits (Issue #235)", () => {
  for (const [name, command] of [
    ["a chain of wrapper words", "xargs ".repeat(700)],
    ["sibling substitutions", `echo ${"$(xargs echo a) ".repeat(500)}`],
  ] as const) {
    it(`stops the extractor at the scan limit within 1 s on ${name}`, async () => {
      const mark = parserGiveUpMark();
      const start = performance.now();
      await extractBaseCommands(command);
      ok(performance.now() - start < 1000);
      ok(
        parserGiveUpReasonSince(mark)?.includes("2,000,000 characters scanned"),
      );
    });
  }
});
