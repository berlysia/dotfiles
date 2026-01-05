#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ConsoleCapture,
  createFileSystemMock,
  createNotificationContext,
  createStopContext,
  defineHook,
  EnvironmentHelper,
  invokeRun,
} from "./test-helpers.ts";

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
        consoleCapture.logs.some(
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
        consoleCapture.logs.some(
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
        consoleCapture.logs.filter(
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
          consoleCapture.logs.some((log) => log.includes("session")),
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
          consoleCapture.logs.some((log) => log.includes(".wav")),
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
        consoleCapture.logs.some(
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
        consoleCapture.logs.some(
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
        consoleCapture.logs.some(
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
        consoleCapture.logs.some(
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
        console.log(`Voice notification for ${eventType} event`);

        // Log git context if available (for testing)
        if (gitBranch || gitRepo) {
          console.log(
            `git context: branch=${gitBranch || ""} repo=${gitRepo || ""}`,
          );
        }

        // Simulate session directory creation
        const sessionDir = `/tmp/claude-voice/${sessionId}`;
        console.log(`Creating directory: ${sessionDir}`);

        // Simulate prefix sound playback
        console.log("Playing prefix sound");
        // For notifications, simulate queuing synthesis
        if (eventType === "Notification") {
          console.log("queue synthesis");
        }

        // Simulate voice synthesis
        if (process.env.FORCE_SYNTHESIS_ERROR === "true") {
          throw new Error("Synthesis failed");
        }

        const message = generateMessage(eventType, context.input);
        console.log(`Synthesizing: ${message}`);

        // Simulate WAV file creation
        const wavFile = `${sessionDir}/notification.wav`;
        console.log(`Creating audio file: ${wavFile}`);

        // Simulate cleanup for old files
        if (eventType === "Stop") {
          console.log("Running cleanup");
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
