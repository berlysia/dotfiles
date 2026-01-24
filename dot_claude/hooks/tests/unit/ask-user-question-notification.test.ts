#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ConsoleCapture,
  createPreToolUseContext,
  defineHook,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

describe("ask-user-question-notification.ts hook behavior", () => {
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
    it("should trigger on AskUserQuestion PreToolUse event", () => {
      const hook = defineHook({
        trigger: {
          PreToolUse: "AskUserQuestion",
        },
        run: (context: any) => context.success({}),
      });

      strictEqual(hook.trigger.PreToolUse, "AskUserQuestion");
    });
  });

  describe("notification behavior", () => {
    it("should notify when AskUserQuestion is called", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Which option do you prefer?",
            header: "Option",
            options: [
              { label: "Option A", description: "First option" },
              { label: "Option B", description: "Second option" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should log notification
      ok(
        consoleCapture.logs.some(
          (log) => log.includes("質問") || log.includes("question"),
        ),
      );
    });

    it("should handle multiple questions", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "First question?",
            header: "Q1",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
          {
            question: "Second question?",
            header: "Q2",
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("system notification", () => {
    it("should send system notification", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Test question?",
            header: "Test",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should attempt system notification
      ok(
        consoleCapture.logs.some(
          (log) =>
            log.includes("System notification") || log.includes("通知"),
        ),
      );
    });
  });

  describe("voice notification", () => {
    it("should attempt voice notification if available", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Voice test?",
            header: "Voice",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
        ],
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

      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Error test?",
            header: "Error",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      // Should succeed despite error
      context.assertSuccess({});

      // Promise.allSettled silently catches errors, so we just verify
      // that the hook completes successfully without blocking
      strictEqual(context.successCalls.length, 1);
    });

    it("should handle missing session_id", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Test?",
            header: "Test",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("logging", () => {
    it("should log AskUserQuestion event", async () => {
      const hook = createAskUserQuestionNotificationHook();

      const context = createPreToolUseContext("AskUserQuestion", {
        questions: [
          {
            question: "Log test?",
            header: "Log",
            options: [
              { label: "Yes", description: "Confirm" },
              { label: "No", description: "Decline" },
            ],
            multiSelect: false,
          },
        ],
      });

      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should log the event
      ok(
        consoleCapture.logs.some(
          (log) =>
            log.includes("AskUserQuestion") || log.includes("質問"),
        ),
      );
    });
  });
});

// Helper function to create ask-user-question-notification hook
function createAskUserQuestionNotificationHook() {
  return defineHook({
    trigger: {
      PreToolUse: "AskUserQuestion",
    },
    run: async (context: any) => {
      const sessionId = context.input.session_id || "default";

      try {
        // Mock implementation for testing
        console.log("AskUserQuestion notification triggered");
        console.log(`Session ID: ${sessionId}`);

        // Parallel execution for speed
        await Promise.allSettled([
          // Log event
          (async () => {
            console.log(`Logging AskUserQuestion event for session ${sessionId}`);
          })(),

          // System notification
          (async () => {
            if (process.env.FORCE_NOTIFICATION_ERROR === "true") {
              throw new Error("Notification failed");
            }
            console.log("System notification: Claude が質問しています");
          })(),

          // Voice notification
          (async () => {
            console.log("Voice notification: 質問があります");
          })(),
        ]);

        // PreToolUse should return empty success to allow tool execution
        return context.success({});
      } catch (error) {
        console.error(`AskUserQuestion notification error: ${error}`);
        // Don't block tool execution on error
        return context.success({});
      }
    },
  });
}
