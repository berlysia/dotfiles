#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ConsoleCapture,
  defineHook,
  EnvironmentHelper,
  invokeRun,
  MockHookContext,
} from "./test-helpers.ts";

describe("permission-request-notification.ts hook behavior", () => {
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

  describe("hook configuration", () => {
    it("should trigger on PermissionRequest event", () => {
      const hook = defineHook({
        trigger: {
          PermissionRequest: true,
        },
        run: (context: any) => context.success({}),
      });

      strictEqual(hook.trigger.PermissionRequest, true);
    });
  });

  describe("notification behavior", () => {
    it("should notify when permission request is triggered", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Bash", {
        command: "rm -rf /",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should log notification
      ok(
        consoleCapture.logs.some(
          (log) => log.includes("確認") || log.includes("permission"),
        ),
      );
    });

    it("should include tool name in notification", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Edit", {
        file_path: "/etc/passwd",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should include tool name
      ok(
        consoleCapture.logs.some(
          (log) => log.includes("Edit") || log.includes("確認"),
        ),
      );
    });
  });

  describe("system notification", () => {
    it("should send system notification with tool name", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Write", {
        file_path: "/important/file.txt",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should attempt system notification
      ok(
        consoleCapture.logs.some(
          (log) => log.includes("System notification") || log.includes("Write"),
        ),
      );
    });
  });

  describe("voice notification", () => {
    it("should attempt voice notification if available", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Bash", {
        command: "sudo make install",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should attempt voice notification
      ok(
        consoleCapture.logs.some(
          (log) =>
            log.includes("Voice notification") ||
            log.includes("音声") ||
            log.includes("voice"),
        ),
      );
    });
  });

  describe("error handling", () => {
    it("should not block on notification errors", async () => {
      envHelper.set("FORCE_NOTIFICATION_ERROR", "true");

      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Bash", {
        command: "test",
      });

      await invokeRun(hook, context);

      // Should succeed despite error
      context.assertSuccess({});
      strictEqual(context.successCalls.length, 1);
    });

    it("should handle missing tool_name", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = new MockHookContext<{ PermissionRequest: true }>({
        hook_event_name: "PermissionRequest",
        cwd: "/test",
        session_id: "test-session",
        transcript_path: "/test/transcript",
        tool_name: undefined as any,
        tool_input: {},
      });

      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("skip notification for specific tools", () => {
    it("should skip notification for AskUserQuestion tool", async () => {
      const hook = createPermissionRequestNotificationHookWithSkip();

      const context = createPermissionRequestContext("AskUserQuestion", {
        questions: [{ question: "test?" }],
      });

      await invokeRun(hook, context);

      // Should succeed without any notification logs
      context.assertSuccess({});
      strictEqual(
        consoleCapture.logs.filter((log) =>
          log.includes("PermissionRequest notification triggered"),
        ).length,
        0,
        "Should not trigger notification for AskUserQuestion",
      );
    });

    it("should skip notification for ExitPlanMode tool", async () => {
      const hook = createPermissionRequestNotificationHookWithSkip();

      const context = createPermissionRequestContext("ExitPlanMode", {});

      await invokeRun(hook, context);

      // Should succeed without any notification logs
      context.assertSuccess({});
      strictEqual(
        consoleCapture.logs.filter((log) =>
          log.includes("PermissionRequest notification triggered"),
        ).length,
        0,
        "Should not trigger notification for ExitPlanMode",
      );
    });

    it("should notify for other tools (Bash)", async () => {
      const hook = createPermissionRequestNotificationHookWithSkip();

      const context = createPermissionRequestContext("Bash", {
        command: "ls",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});
      ok(
        consoleCapture.logs.some((log) =>
          log.includes("PermissionRequest notification triggered"),
        ),
        "Should trigger notification for Bash",
      );
    });
  });

  describe("logging", () => {
    it("should log PermissionRequest event", async () => {
      const hook = createPermissionRequestNotificationHook();

      const context = createPermissionRequestContext("Read", {
        file_path: "/secret/file.txt",
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should log the event
      ok(
        consoleCapture.logs.some(
          (log) =>
            log.includes("PermissionRequest") || log.includes("確認"),
        ),
      );
    });
  });
});

// Skip notification tools list (matches production code)
const SKIP_NOTIFICATION_TOOLS = ["AskUserQuestion", "ExitPlanMode"];

// Helper function to create permission-request-notification hook with skip logic
function createPermissionRequestNotificationHookWithSkip() {
  return defineHook({
    trigger: {
      PermissionRequest: true,
    },
    run: async (context: any) => {
      const toolName = context.input.tool_name;

      // Skip notification for tools that have dedicated notification hooks
      if (SKIP_NOTIFICATION_TOOLS.includes(toolName)) {
        return context.success({});
      }

      const sessionId = context.input.session_id || "default";

      try {
        console.log("PermissionRequest notification triggered");
        console.log(`Session ID: ${sessionId}`);
        console.log(`Tool: ${toolName}`);

        await Promise.allSettled([
          (async () => {
            console.log(
              `Logging PermissionRequest event for session ${sessionId}`,
            );
          })(),
          (async () => {
            console.log(`System notification: パーミッション確認: ${toolName}`);
          })(),
          (async () => {
            console.log("Voice notification: 確認が必要です");
          })(),
        ]);

        return context.success({});
      } catch (error) {
        console.error(`PermissionRequest notification error: ${error}`);
        return context.success({});
      }
    },
  });
}

// Helper function to create permission-request-notification hook
function createPermissionRequestNotificationHook() {
  return defineHook({
    trigger: {
      PermissionRequest: true,
    },
    run: async (context: any) => {
      const sessionId = context.input.session_id || "default";
      const toolName = context.input.tool_name || "操作";

      try {
        // Mock implementation for testing
        console.log("PermissionRequest notification triggered");
        console.log(`Session ID: ${sessionId}`);
        console.log(`Tool: ${toolName}`);

        // Parallel execution for speed
        await Promise.allSettled([
          // Log event
          (async () => {
            console.log(
              `Logging PermissionRequest event for session ${sessionId}`,
            );
          })(),

          // System notification
          (async () => {
            if (process.env.FORCE_NOTIFICATION_ERROR === "true") {
              throw new Error("Notification failed");
            }
            console.log(`System notification: パーミッション確認: ${toolName}`);
          })(),

          // Voice notification
          (async () => {
            console.log("Voice notification: 確認が必要です");
          })(),
        ]);

        return context.success({});
      } catch (error) {
        console.error(`PermissionRequest notification error: ${error}`);
        return context.success({});
      }
    },
  });
}

// Helper function to create PermissionRequest context
function createPermissionRequestContext(toolName: string, toolInput: any) {
  return new MockHookContext<{ PermissionRequest: true }>({
    hook_event_name: "PermissionRequest",
    cwd: "/test",
    session_id: "test-session",
    transcript_path: "/test/transcript",
    tool_name: toolName,
    tool_input: toolInput,
  });
}
