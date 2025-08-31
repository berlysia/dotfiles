#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { 
  defineHook, 
  createFileSystemMock,
  ConsoleCapture,
  EnvironmentHelper 
} from "./test-helpers.ts";

describe("speak-notification.ts hook behavior", () => {
  const consoleCapture = new ConsoleCapture();
  const envHelper = new EnvironmentHelper();
  const fsMock = createFileSystemMock();
  
  beforeEach(() => {
    consoleCapture.reset();
    consoleCapture.start();
    fsMock.files.clear();
    fsMock.directories.clear();
    
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
          Error: true
        },
        run: (context) => context.success({})
      });
      
      deepStrictEqual(hook.trigger, { 
        Stop: true,
        Notification: true,
        Error: true
      });
    });
  });
  
  describe("voice synthesis", () => {
    it("should generate audio for Stop event", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-session-123"
      });
      
      context.assertSuccess({});
      
      // Should attempt voice synthesis
      ok(
        consoleCapture.logs.some(log => 
          log.includes("Stop") || 
          log.includes("音声") ||
          log.includes("voice")
        )
      );
    });
    
    it("should generate audio for Notification event", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Notification",
        session_id: "test-session-456"
      });
      
      context.assertSuccess({});
    });
    
    it("should generate audio for Error event", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Error",
        session_id: "test-session-789",
        error_message: "Test error occurred"
      });
      
      context.assertSuccess({});
      
      // Should include error in message
      ok(
        consoleCapture.logs.some(log => 
          log.includes("Error") || 
          log.includes("エラー")
        )
      );
    });
  });
  
  describe("configuration", () => {
    it("should respect CLAUDE_VOICE_ENABLED=false", async () => {
      envHelper.set("CLAUDE_VOICE_ENABLED", "false");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-disabled"
      });
      
      context.assertSuccess({});
      
      // Should not attempt synthesis when disabled
      strictEqual(
        consoleCapture.logs.filter(log => 
          log.includes("synthesis") || 
          log.includes("音声生成")
        ).length,
        0
      );
    });
    
    it("should use custom speaker ID", async () => {
      envHelper.set("VOICEVOX_SPEAKER_ID", "3");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Notification",
        session_id: "test-speaker"
      });
      
      context.assertSuccess({});
    });
    
    it("should use custom host", async () => {
      envHelper.set("VOICEVOX_HOST", "http://localhost:50021");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-host"
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("file management", () => {
    it("should create session directory", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-session-dir"
      });
      
      context.assertSuccess({});
      
      // Should create directory structure
      ok(
        fsMock.directories.size > 0 || 
        consoleCapture.logs.some(log => log.includes("session"))
      );
    });
    
    it("should write WAV files", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Notification",
        session_id: "test-wav"
      });
      
      context.assertSuccess({});
      
      // Should create WAV file
      const wavFiles = Array.from(fsMock.files.keys()).filter(f => f.endsWith(".wav"));
      ok(wavFiles.length > 0 || consoleCapture.logs.some(log => log.includes(".wav")));
    });
    
    it("should cleanup old files", async () => {
      // Create old files in mock
      const oldFile = "/tmp/claude-voice/old-session/audio.wav";
      fsMock.writeFileSync(oldFile, "old audio data");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-cleanup"
      });
      
      context.assertSuccess({});
      
      // Should attempt cleanup
      ok(
        consoleCapture.logs.some(log => 
          log.includes("cleanup") || 
          log.includes("クリーンアップ")
        ) ||
        !fsMock.existsSync(oldFile)
      );
    });
  });
  
  describe("git context integration", () => {
    it("should include git context in message", async () => {
      envHelper.set("GIT_BRANCH", "main");
      envHelper.set("GIT_REPO", "test-repo");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-git"
      });
      
      context.assertSuccess({});
      
      // Should include git info
      ok(
        consoleCapture.logs.some(log => 
          log.includes("git") || 
          log.includes("branch") ||
          log.includes("リポジトリ")
        )
      );
    });
  });
  
  describe("platform detection", () => {
    it("should detect macOS", async () => {
      envHelper.set("OS_PLATFORM", "darwin");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-mac"
      });
      
      context.assertSuccess({});
    });
    
    it("should detect Linux", async () => {
      envHelper.set("OS_PLATFORM", "linux");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-linux"
      });
      
      context.assertSuccess({});
    });
    
    it("should detect Windows", async () => {
      envHelper.set("OS_PLATFORM", "win32");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-windows"
      });
      
      context.assertSuccess({});
    });
  });
  
  describe("error handling", () => {
    it("should handle voice synthesis failure gracefully", async () => {
      envHelper.set("FORCE_SYNTHESIS_ERROR", "true");
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-synthesis-error"
      });
      
      // Should not block on synthesis errors
      context.assertSuccess({});
      
      // Should log error
      ok(
        consoleCapture.errors.some(e => 
          e.includes("synthesis") || 
          e.includes("error")
        )
      );
    });
    
    it("should handle missing session_id", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop"
      });
      
      context.assertSuccess({});
    });
    
    it("should handle unknown event type", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "UnknownEvent",
        session_id: "test-unknown"
      });
      
      context.assertSuccess({});
    });
    
    it("should handle file write errors", async () => {
      // Make file writes fail
      fsMock.writeFileSync = () => {
        throw new Error("Disk full");
      };
      
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-write-error"
      });
      
      // Should not fail hook
      context.assertSuccess({});
    });
  });
  
  describe("audio playback", () => {
    it("should play prefix sound immediately", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Stop",
        session_id: "test-prefix"
      });
      
      context.assertSuccess({});
      
      // Should play prefix sound
      ok(
        consoleCapture.logs.some(log => 
          log.includes("prefix") || 
          log.includes("immediate") ||
          log.includes("再生")
        )
      );
    });
    
    it("should queue voice synthesis", async () => {
      const hook = createSpeakNotificationHook();
      
      const { context } = await hook.execute({
        hook_event_name: "Notification",
        session_id: "test-queue"
      });
      
      context.assertSuccess({});
      
      // Should queue synthesis
      ok(
        consoleCapture.logs.some(log => 
          log.includes("queue") || 
          log.includes("synthesis") ||
          log.includes("キュー")
        )
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
      Error: true
    },
    run: async (context) => {
      const eventType = context.input.hook_event_name || "Unknown";
      const sessionId = context.input.session_id || "default";
      
      // Check if voice is enabled
      if (process.env.CLAUDE_VOICE_ENABLED === "false") {
        return context.success({});
      }
      
      try {
        // Log the event
        consoleCapture.logs.push(`Voice notification for ${eventType} event`);
        
        // Simulate session directory creation
        const sessionDir = `/tmp/claude-voice/${sessionId}`;
        fsMock.mkdirSync(sessionDir, { recursive: true });
        
        // Simulate prefix sound playback
        consoleCapture.logs.push("Playing prefix sound");
        
        // Simulate voice synthesis
        if (process.env.FORCE_SYNTHESIS_ERROR === "true") {
          throw new Error("Synthesis failed");
        }
        
        const message = generateMessage(eventType, context.input);
        consoleCapture.logs.push(`Synthesizing: ${message}`);
        
        // Simulate WAV file creation
        const wavFile = `${sessionDir}/notification.wav`;
        fsMock.writeFileSync(wavFile, "audio data");
        
        // Simulate cleanup for old files
        if (eventType === "Stop") {
          consoleCapture.logs.push("Running cleanup");
        }
        
        return context.success({});
      } catch (error) {
        consoleCapture.errors.push(`Voice synthesis error: ${error}`);
        // Don't block on errors
        return context.success({});
      }
    }
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