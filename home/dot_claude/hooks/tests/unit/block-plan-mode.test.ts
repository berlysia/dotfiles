#!/usr/bin/env node --test

import { ok } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { ExtractAllHookInputsForEvent } from "cc-hooks-ts";
import blockPlanModeHook from "../../implementations/block-plan-mode.ts";
import {
  EnvironmentHelper,
  MockHookContext,
  invokeRun,
} from "./test-helpers.ts";

function createContext(toolName: string): MockHookContext<{ PreToolUse: true }> {
  const input = {
    hook_event_name: "PreToolUse" as const,
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    tool_name: toolName,
    tool_input: {},
  } as ExtractAllHookInputsForEvent<"PreToolUse">;
  return new MockHookContext<{ PreToolUse: true }>(input);
}

const envHelper = new EnvironmentHelper();

afterEach(() => {
  envHelper.restore();
});

describe("block-plan-mode.ts hook behavior", () => {
  describe("EnterPlanMode blocking", () => {
    it("should deny EnterPlanMode", async () => {
      const context = createContext("EnterPlanMode");
      await invokeRun(blockPlanModeHook, context);
      context.assertDeny();
    });

    it("should include Document Workflow instructions in deny reason", async () => {
      const context = createContext("EnterPlanMode");
      await invokeRun(blockPlanModeHook, context);

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ?? "";
      ok(reason.includes("Document Workflow"), "should mention Document Workflow");
      ok(reason.includes("plan.md"), "should mention plan.md");
    });

    it("should include DOCUMENT_WORKFLOW_DIR in deny reason when env is set", async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abc123/");

      const context = createContext("EnterPlanMode");
      await invokeRun(blockPlanModeHook, context);

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ?? "";
      ok(
        reason.includes(".tmp/sessions/abc123/"),
        "should include DOCUMENT_WORKFLOW_DIR value",
      );
    });
  });

  describe("other tools pass-through", () => {
    it("should pass through Bash", async () => {
      const context = createContext("Bash");
      await invokeRun(blockPlanModeHook, context);
      context.assertPass();
    });

    it("should pass through ExitPlanMode (handled by separate hook)", async () => {
      const context = createContext("ExitPlanMode");
      await invokeRun(blockPlanModeHook, context);
      context.assertPass();
    });
  });
});
