import { notStrictEqual, ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { staticRuleEngine } from "../../implementations/permission-auto-approve.ts";
import type { PermissionRequestInput } from "../../lib/structured-llm-evaluator.ts";
import { ConsoleCapture, EnvironmentHelper } from "../support/test-helpers.ts";

describe("permission-auto-approve.ts hook behavior", () => {
  let consoleCapture: ConsoleCapture;
  const envHelper = new EnvironmentHelper();

  beforeEach(() => {
    consoleCapture = new ConsoleCapture();
    consoleCapture.reset();
    consoleCapture.start();
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  describe("staticRuleEngine - Dangerous patterns", () => {
    // Issue #219: these shapes took seconds with the regex versions of the dangerous patterns.
    for (const [name, cmd] of [
      ["a long blank run after dd", "dd " + " ".repeat(100000) + "x"],
      ["a repeated dd word", "dd if ".repeat(16667)],
      ["a repeated curl word", "curl x ".repeat(14286)],
    ] as const) {
      it(`judges ${name} in linear time without denying`, () => {
        const input: PermissionRequestInput = {
          session_id: "test-session",
          tool_name: "Bash",
          tool_input: { command: cmd },
        };

        const start = performance.now();
        const result = staticRuleEngine(input);
        const elapsed = performance.now() - start;
        ok(elapsed < 1000, `${elapsed} ms`);
        notStrictEqual(result.behavior, "deny");
      });
    }
  });
});

describe("staticRuleEngine - Bash allow from the whole-text split (spec K8)", () => {
  const bash = (command: unknown, cwd = "/home/user/project") =>
    staticRuleEngine({
      session_id: "test-session",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    });

  it("runs in linear time on long inputs", () => {
    // Plan-time probe: 19 ms for both; the old `\s+.*--check` takes seconds.
    // Monotonic clock: a wall-clock step (WSL2 resyncs it) once failed a 22 ms run.
    const start = performance.now();
    strictEqual(bash(`eslint${" ".repeat(500_000)}x`).behavior, "uncertain");
    strictEqual(bash(`ls ${"a".repeat(500_000)}`).behavior, "allow");
    strictEqual(performance.now() - start < 1000, true);
  });
});
