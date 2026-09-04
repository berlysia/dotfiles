#!/usr/bin/env node --test

import { ok } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtractAllHookInputsForEvent } from "cc-hooks-ts";
import blockPlanModeHook from "../../implementations/block-plan-mode.ts";
import {
  EnvironmentHelper,
  invokeRun,
  MockHookContext,
} from "./test-helpers.ts";

function createContext(
  toolName: string,
  overrides: { cwd?: string; session_id?: string } = {},
): MockHookContext<{ PreToolUse: true }> {
  const input = {
    hook_event_name: "PreToolUse" as const,
    cwd: overrides.cwd ?? "/test",
    session_id: overrides.session_id ?? "test-session",
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
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ??
        "";
      ok(
        reason.includes("Document Workflow"),
        "should mention Document Workflow",
      );
      ok(reason.includes("plan.md"), "should mention plan.md");
    });

    it("should include DOCUMENT_WORKFLOW_DIR in deny reason when env is set", async () => {
      envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abc123/");

      const context = createContext("EnterPlanMode");
      await invokeRun(blockPlanModeHook, context);

      const reason =
        context.jsonCalls[0]?.hookSpecificOutput?.permissionDecisionReason ??
        "";
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

  describe("workflow dir in the deny message", () => {
    it("separates the dir from the file name", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bpm-")));
      mkdirSync(join(cwd, ".tmp", "sessions", "abcd1234"), {
        recursive: true,
      });
      envHelper.set("CLAUDE_TEST_CWD", cwd);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const context = createContext("EnterPlanMode", {
        session_id: "abcd1234-0000-0000-0000-000000000000",
      });
      await invokeRun(blockPlanModeHook, context);
      const reason =
        context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
      ok(reason.includes(".tmp/sessions/abcd1234/research.md"));
      ok(!reason.includes("abcd1234research.md"));
    });

    it("does not leak a literal placeholder when the session id is malformed", async () => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bpm-")));
      envHelper.set("CLAUDE_TEST_CWD", cwd);
      envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
      const context = createContext("EnterPlanMode", { session_id: "" });
      await invokeRun(blockPlanModeHook, context);
      const reason =
        context.jsonCalls[0].hookSpecificOutput.permissionDecisionReason;
      ok(!reason.includes("<session-id>"));
      // code span の中にスペース入りパスを作らないこと。散文を wfDirLabel に代入して
      // 同じテンプレートに流すと `the session workflow directory/research.md` が出る。
      ok(!/`[^`]*\s[^`]*\/research\.md`/.test(reason));
    });
  });
});
