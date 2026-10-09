import { ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import denyNodeModulesHook, {
  DESTRUCTIVE_NODE_MODULES_PATTERNS,
} from "../../implementations/deny-node-modules.ts";
import {
  ConsoleCapture,
  createPreToolUseContext,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

describe("deny-node-modules.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    consoleCapture.start();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  // Issue #219: with the regex versions these shapes took seconds to minutes.
  describe("long repeated words", () => {
    const NM = "node" + "_modules";
    for (const [name, command] of [
      ["a repeated cp word", NM + " cp ".repeat(7000)],
      ["a repeated ls word", NM + " " + "ls ".repeat(9000)],
    ] as const) {
      it(`gives no decision for ${name} in linear time`, async () => {
        const context = createPreToolUseContext("Bash", { command });
        const start = performance.now();
        await invokeRun(denyNodeModulesHook, context);
        const elapsed = performance.now() - start;

        ok(elapsed < 1000, `${elapsed} ms`);
        context.assertSuccess({});
      });
    }

    // The tree-sitter parse of a long run of redirect characters is itself
    // quadratic (measured separately from the regexes), so this shape is
    // judged at the table, which is where the regexes were.
    it("judges a long run of redirect characters in linear time", () => {
      const text = NM + " " + ">".repeat(100000);
      const start = performance.now();
      const hit = DESTRUCTIVE_NODE_MODULES_PATTERNS.find(
        ({ operation }) => operation === "overwrite",
      );
      ok(hit);
      strictEqual(hit.pattern.test(text), false);
      ok(performance.now() - start < 1000);
    });

    // Issue #235: over the parser's length limit the command is not analysed.
    for (const [name, command] of [
      ["mentions node_modules", NM + " cp ".repeat(25000)],
      ["does not mention it", `echo ${"a".repeat(32000)}`],
    ] as const) {
      it(`denies a command over the length limit within 1 s that ${name}`, async () => {
        const context = createPreToolUseContext("Bash", { command });
        const start = performance.now();
        await invokeRun(denyNodeModulesHook, context);
        const elapsed = performance.now() - start;

        ok(elapsed < 1000, `${elapsed} ms`);
        context.assertDeny();
      });
    }
  });
});
