import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import linterConfigGuard from "../../implementations/linter-config-guard.ts";
import {
  createPreToolUseContextFor,
  invokeRun,
} from "../support/test-helpers.ts";

describe("linter-config-guard", () => {
  it("asks with the message first and the file name on a File line", async () => {
    const context = createPreToolUseContextFor(linterConfigGuard, "Edit", {
      file_path: "/w/tsconfig.json",
      old_string: "a",
      new_string: "b",
    });
    await invokeRun(linterConfigGuard, context);
    const out = context.jsonCalls[0].hookSpecificOutput;
    strictEqual(out?.permissionDecision, "ask");
    strictEqual(
      out?.permissionDecisionReason,
      "Protected linter/formatter config file.\n" +
        "Agent modifications to linter configs can weaken code quality rules.\n" +
        "Allow this edit only if the user explicitly requested it.\n" +
        "File: tsconfig.json",
    );
  });

  it("gives no decision for a file that is not a linter config", async () => {
    const context = createPreToolUseContextFor(linterConfigGuard, "Edit", {
      file_path: "/w/src/a.ts",
      old_string: "a",
      new_string: "b",
    });
    await invokeRun(linterConfigGuard, context);
    context.assertSuccess({});
  });
});
