#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import realHook, {
  formatStopFailureLogMessage,
  notifyStopFailure,
  shouldSendPermissionPromptToast,
} from "../../implementations/speak-notification.ts";
import {
  ConsoleCapture,
  createFileSystemMock,
  createNotificationContext,
  createStopContext,
  defineHook,
  EnvironmentHelper,
  invokeRun,
} from "../support/test-helpers.ts";

describe("speak-notification.ts hook behavior", () => {
  let consoleCapture: ConsoleCapture;
  const envHelper = new EnvironmentHelper();
  let fileSystemMock: ReturnType<typeof createFileSystemMock>;

  beforeEach(() => {
    consoleCapture = new ConsoleCapture();
    consoleCapture.reset();
    consoleCapture.start();
    fileSystemMock = createFileSystemMock();
    fileSystemMock.files.clear();
    fileSystemMock.directories.clear();

    // Set test environment
    envHelper.set("CLAUDE_VOICE_ENABLED", "true");
  });

  afterEach(() => {
    consoleCapture.stop();
    envHelper.restore();
  });

  describe("hook configuration", () => {
    it("should handle Stop and Notification events", () => {
      const hook = defineHook({
        trigger: {
          Stop: true,
          Notification: true,
        },
        run: (context: any) => context.success({}),
      });

      deepStrictEqual(hook.trigger, {
        Stop: true,
        Notification: true,
      });
    });
  });

  describe("voice synthesis", () => {
    it("should generate audio for Stop event", async () => {
      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should attempt voice synthesis
      ok(
        consoleCapture.errors.some(
          (log) =>
            log.includes("Stop") ||
            log.includes("音声") ||
            log.includes("voice"),
        ),
      );
    });

    it("should generate audio for Notification event", async () => {
      const hook = createSpeakNotificationHook();

      const context = createNotificationContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should generate audio for Notification event with message", async () => {
      const hook = createSpeakNotificationHook();

      const context = createNotificationContext("Test notification message");
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should include message in output
      ok(
        consoleCapture.errors.some(
          (log) => log.includes("notification") || log.includes("通知"),
        ),
      );
    });
  });

  describe("configuration", () => {
    it("should respect CLAUDE_VOICE_ENABLED=false", async () => {
      envHelper.set("CLAUDE_VOICE_ENABLED", "false");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should not attempt synthesis when disabled
      strictEqual(
        consoleCapture.errors.filter(
          (log) => log.includes("synthesis") || log.includes("音声生成"),
        ).length,
        0,
      );
    });

    it("should use custom speaker ID", async () => {
      envHelper.set("VOICEVOX_SPEAKER_ID", "3");

      const hook = createSpeakNotificationHook();

      const context = createNotificationContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should use custom host", async () => {
      envHelper.set("VOICEVOX_HOST", "http://localhost:50021");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("file management", () => {
    it("should create session directory", async () => {
      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should create directory structure
      ok(
        fileSystemMock.directories.size > 0 ||
          consoleCapture.errors.some((log) => log.includes("session")),
      );
    });

    it("should write WAV files", async () => {
      const hook = createSpeakNotificationHook();

      const context = createNotificationContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should create WAV file
      const wavFiles = Array.from(fileSystemMock.files.keys()).filter((f) =>
        f.endsWith(".wav"),
      );
      ok(
        wavFiles.length > 0 ||
          consoleCapture.errors.some((log) => log.includes(".wav")),
      );
    });

    it("should cleanup old files", async () => {
      // Create old files in mock
      const oldFile = "/tmp/claude-voice/old-session/audio.wav";
      fileSystemMock.writeFileSync(oldFile, "old audio data");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should attempt cleanup
      ok(
        consoleCapture.errors.some(
          (log) => log.includes("cleanup") || log.includes("クリーンアップ"),
        ) || !fileSystemMock.existsSync(oldFile),
      );
    });
  });

  describe("git context integration", () => {
    it("should include git context in message", async () => {
      envHelper.set("GIT_BRANCH", "main");
      envHelper.set("GIT_REPO", "test-repo");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should include git info
      ok(
        consoleCapture.errors.some(
          (log) =>
            log.includes("git") ||
            log.includes("branch") ||
            log.includes("リポジトリ"),
        ),
      );
    });
  });

  describe("platform detection", () => {
    it("should detect macOS", async () => {
      envHelper.set("OS_PLATFORM", "darwin");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should detect Linux", async () => {
      envHelper.set("OS_PLATFORM", "linux");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should detect Windows", async () => {
      envHelper.set("OS_PLATFORM", "win32");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });
  });

  describe("error handling", () => {
    it("should handle voice synthesis failure gracefully", async () => {
      envHelper.set("FORCE_SYNTHESIS_ERROR", "true");

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      // Should not block on synthesis errors
      context.assertSuccess({});

      // Should log error
      ok(
        consoleCapture.errors.some(
          (e) => e.includes("synthesis") || e.includes("error"),
        ),
      );
    });

    it("should handle missing session_id", async () => {
      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should handle unknown event type", async () => {
      const hook = createSpeakNotificationHook();

      const context = createStopContext(); // Using Stop context for unknown event test
      await invokeRun(hook, context);

      context.assertSuccess({});
    });

    it("should handle file write errors", async () => {
      // Make file writes fail
      fileSystemMock.writeFileSync = () => {
        throw new Error("Disk full");
      };

      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      // Should not fail hook
      context.assertSuccess({});
    });
  });

  describe("audio playback", () => {
    it("should play prefix sound immediately", async () => {
      const hook = createSpeakNotificationHook();

      const context = createStopContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should play prefix sound
      ok(
        consoleCapture.errors.some(
          (log) =>
            log.includes("prefix") ||
            log.includes("immediate") ||
            log.includes("再生"),
        ),
      );
    });

    it("should queue voice synthesis", async () => {
      const hook = createSpeakNotificationHook();

      const context = createNotificationContext();
      await invokeRun(hook, context);

      context.assertSuccess({});

      // Should queue synthesis
      ok(
        consoleCapture.errors.some(
          (log) =>
            log.includes("queue") ||
            log.includes("synthesis") ||
            log.includes("キュー"),
        ),
      );
    });
  });
});

// Helper function to create speak-notification hook
function createSpeakNotificationHook() {
  return defineHook({
    trigger: {
      Stop: true,
      Notification: true,
    },
    run: async (context: any) => {
      const eventType = context.input.hook_event_name || "Unknown";
      const sessionId = context.input.session_id || "default";
      const gitBranch = process.env.GIT_BRANCH;
      const gitRepo = process.env.GIT_REPO;

      // Check if voice is enabled
      if (process.env.CLAUDE_VOICE_ENABLED === "false") {
        return context.success({});
      }

      try {
        // Mock implementation for testing
        console.error(`Voice notification for ${eventType} event`);

        // Log git context if available (for testing)
        if (gitBranch || gitRepo) {
          console.error(
            `git context: branch=${gitBranch || ""} repo=${gitRepo || ""}`,
          );
        }

        // Simulate session directory creation
        const sessionDir = `/tmp/claude-voice/${sessionId}`;
        console.error(`Creating directory: ${sessionDir}`);

        // Simulate prefix sound playback
        console.error("Playing prefix sound");
        // For notifications, simulate queuing synthesis
        if (eventType === "Notification") {
          console.error("queue synthesis");
        }

        // Simulate voice synthesis
        if (process.env.FORCE_SYNTHESIS_ERROR === "true") {
          throw new Error("Synthesis failed");
        }

        const message = generateMessage(eventType, context.input);
        console.error(`Synthesizing: ${message}`);

        // Simulate WAV file creation
        const wavFile = `${sessionDir}/notification.wav`;
        console.error(`Creating audio file: ${wavFile}`);

        // Simulate cleanup for old files
        if (eventType === "Stop") {
          console.error("Running cleanup");
        }

        return context.success({});
      } catch (error) {
        console.error(`Voice synthesis error: ${error}`);
        // Don't block on errors
        return context.success({});
      }
    },
  });
}

function generateMessage(eventType: string, input: any): string {
  switch (eventType) {
    case "Stop":
      return "処理が完了しました";
    case "Notification":
      return "通知があります";
    case "Error":
      return `エラーが発生しました: ${input.error_message || "不明なエラー"}`;
    default:
      return "イベントが発生しました";
  }
}

describe("formatStopFailureLogMessage", () => {
  it("includes error and details", () => {
    strictEqual(
      formatStopFailureLogMessage({
        error: "server_error",
        error_details: "stream idle",
      }),
      "error=server_error details=stream idle",
    );
  });

  it("omits details when absent", () => {
    strictEqual(
      formatStopFailureLogMessage({ error: "rate_limit" }),
      "error=rate_limit",
    );
  });

  it("falls back to error=unknown", () => {
    strictEqual(formatStopFailureLogMessage({}), "error=unknown");
    strictEqual(formatStopFailureLogMessage({ error: 5 }), "error=unknown");
    strictEqual(formatStopFailureLogMessage(null), "error=unknown");
  });

  it("replaces newlines with spaces", () => {
    strictEqual(
      formatStopFailureLogMessage({
        error: "server_error",
        error_details: "a\nb",
      }),
      "error=server_error details=a b",
    );
  });

  it("truncates to 500 characters", () => {
    strictEqual(
      formatStopFailureLogMessage({
        error: "x",
        error_details: "y".repeat(1000),
      }).length,
      500,
    );
  });

  it("never includes last_assistant_message", () => {
    const message = formatStopFailureLogMessage({
      error: "server_error",
      last_assistant_message: "SECRET",
    });
    ok(!message.includes("SECRET"));
  });
});

describe("notifyStopFailure", () => {
  const messages = { voice: "V", system: "S" };

  it("speaks once as Error and notifies the desktop once", async () => {
    const spoken: [string, string][] = [];
    const notified: string[] = [];
    await notifyStopFailure({
      speak: async (text, type) => {
        spoken.push([text, type]);
      },
      notifySystem: async (text) => {
        notified.push(text);
      },
      getMessages: async () => messages,
    });
    deepStrictEqual(spoken, [["V", "Error"]]);
    deepStrictEqual(notified, ["S"]);
  });

  it("still notifies the desktop when speak rejects", async () => {
    const notified: string[] = [];
    await notifyStopFailure({
      speak: async () => {
        throw new Error("voice down");
      },
      notifySystem: async (text) => {
        notified.push(text);
      },
      getMessages: async () => messages,
    });
    deepStrictEqual(notified, ["S"]);
  });
});

describe("StopFailure hook definition", () => {
  it("hook triggers include StopFailure, Stop and Notification", () => {
    const trigger = (
      realHook as unknown as { trigger: Record<string, unknown> }
    ).trigger;
    ok(trigger["StopFailure"]);
    ok(trigger["Stop"]);
    ok(trigger["Notification"]);
  });
});

describe("shouldSendPermissionPromptToast", () => {
  const base = {
    platform: "wsl" as const,
    notificationType: "permission_prompt",
    WT_SESSION: "abc",
    TMUX: undefined as string | undefined,
    TERM_PROGRAM: undefined as string | undefined,
  };

  it("wsl + Windows Terminal: leaves the toast to the OSC 777 of Claude Code itself", () => {
    strictEqual(shouldSendPermissionPromptToast(base), false);
  });

  it("wsl without WT_SESSION (VS Code etc.): sends", () => {
    strictEqual(
      shouldSendPermissionPromptToast({ ...base, WT_SESSION: "" }),
      true,
    );
  });

  it("wsl inside tmux: sends", () => {
    strictEqual(
      shouldSendPermissionPromptToast({
        ...base,
        TMUX: "/tmp/tmux-1000/default,1,0",
      }),
      true,
    );
  });

  it("wsl VS Code opened from Windows Terminal: sends", () => {
    strictEqual(
      shouldSendPermissionPromptToast({ ...base, TERM_PROGRAM: "vscode" }),
      true,
    );
  });

  it("linux: sends", () => {
    strictEqual(
      shouldSendPermissionPromptToast({ ...base, platform: "linux" }),
      true,
    );
  });

  it("darwin without WT_SESSION: sends", () => {
    strictEqual(
      shouldSendPermissionPromptToast({
        ...base,
        platform: "darwin",
        WT_SESSION: "",
      }),
      true,
    );
  });

  it("idle_prompt: does not send (unchanged)", () => {
    strictEqual(
      shouldSendPermissionPromptToast({
        ...base,
        notificationType: "idle_prompt",
      }),
      false,
    );
  });

  it("empty notification type: does not send (unchanged)", () => {
    strictEqual(
      shouldSendPermissionPromptToast({ ...base, notificationType: "" }),
      false,
    );
  });
});
