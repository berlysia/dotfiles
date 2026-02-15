#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildNotification,
  extractFromTranscript,
  type HookInput,
} from "../../lib/webhook-notification.ts";

describe("extractFromTranscript", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "webhook-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty string for empty path", async () => {
    const result = await extractFromTranscript("", "assistant", 300);
    strictEqual(result, "");
  });

  it("should extract last assistant message (string content)", async () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: "first response" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "second response" },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "assistant", 300);
    strictEqual(result, "second response");
  });

  it("should extract last user message", async () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "first question" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: "answer" },
      }),
      JSON.stringify({
        type: "user",
        message: { content: "second question" },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "user", 100);
    strictEqual(result, "second question");
  });

  it("should extract text from array content blocks", async () => {
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "block content" }],
        },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "assistant", 300);
    strictEqual(result, "block content");
  });

  it("should truncate long messages", async () => {
    const longText = "a".repeat(200);
    const transcript = [
      JSON.stringify({
        type: "assistant",
        message: { content: longText },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "assistant", 50);
    strictEqual(result, `${"a".repeat(50)}...`);
  });

  it("should skip malformed JSONL lines", async () => {
    const transcript = [
      "not valid json",
      JSON.stringify({
        type: "assistant",
        message: { content: "valid message" },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "assistant", 300);
    strictEqual(result, "valid message");
  });

  it("should return empty string when no matching role", async () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "hello" } }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractFromTranscript(filePath, "assistant", 300);
    strictEqual(result, "");
  });
});

describe("buildNotification", () => {
  describe("SessionStart event", () => {
    it("should return info notification for session start", async () => {
      const input: HookInput = {
        hook_event_name: "SessionStart",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
      };

      const result = await buildNotification(input);
      ok(result !== null, "should return notification");
      strictEqual(result.title, "🚀 セッション開始");
      strictEqual(result.severity, "info");
      strictEqual(
        result.description,
        "新しいClaude Codeセッションが開始されました。",
      );
    });
  });

  describe("Stop event", () => {
    it("should return success notification", async () => {
      const input: HookInput = {
        hook_event_name: "Stop",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
      };

      const result = await buildNotification(input);
      ok(result !== null, "should return notification");
      strictEqual(result.title, "✅ 返信完了");
      strictEqual(result.severity, "success");
      // No transcript path → fallback message
      strictEqual(result.description, "Claudeの返信が完了しました。");
    });

    it("should return null when stop_hook_active is true", async () => {
      const input: HookInput = {
        hook_event_name: "Stop",
        session_id: "test-session",
        stop_hook_active: true,
      };

      const result = await buildNotification(input);
      strictEqual(result, null);
    });
  });

  describe("PermissionRequest event", () => {
    it("should return warning notification with tool_name", async () => {
      const input: HookInput = {
        hook_event_name: "PermissionRequest",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
        tool_name: "Bash",
      };

      const result = await buildNotification(input);
      ok(result !== null, "should return notification");
      strictEqual(result.title, "🔑 パーミッション確認");
      strictEqual(result.severity, "warning");
      strictEqual(result.description, "Bash の実行許可を求めています");
    });

    it("should use 'unknown' when tool_name is missing", async () => {
      const input: HookInput = {
        hook_event_name: "PermissionRequest",
        session_id: "test-session",
        cwd: "/test",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      ok(result.description.includes("unknown"));
    });
  });

  describe("Notification event", () => {
    it("should return null for permission_prompt (deduplication)", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "test-session",
        notification_type: "permission_prompt",
      };

      const result = await buildNotification(input);
      strictEqual(result, null);
    });

    it("should return muted notification for idle_prompt", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "a2f252b1-xxxx",
        cwd: "/test",
        notification_type: "idle_prompt",
        message: "Waiting for input",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.title, "💤 入力待ち");
      strictEqual(result.severity, "muted");
      strictEqual(result.description, "Waiting for input");
    });

    it("should use fallback message for idle_prompt without message", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "test-session",
        cwd: "/test",
        notification_type: "idle_prompt",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.description, "Claudeが入力を待っています。");
    });

    it("should return info notification for other types", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "a2f252b1-xxxx",
        cwd: "/test",
        notification_type: "auth_success",
        message: "Authentication successful",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.title, "🔔 通知");
      strictEqual(result.severity, "info");
      strictEqual(result.description, "Authentication successful");
    });

    it("should use fallback message for notification without message", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "test-session",
        cwd: "/test",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.description, "通知があります。");
    });
  });

  describe("unknown event", () => {
    it("should return null for unrecognized event type", async () => {
      const input: HookInput = {
        hook_event_name: "UnknownEvent",
        session_id: "test-session",
      };

      const result = await buildNotification(input);
      strictEqual(result, null);
    });
  });

  describe("footer construction", () => {
    it("should include session ID in footer", async () => {
      const input: HookInput = {
        hook_event_name: "PermissionRequest",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
        tool_name: "Bash",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      // Session ID should be truncated to 8 chars
      ok(result.footer.includes("🔑 a2f252b1"));
    });

    it("should have empty footer when no cwd and no session_id", async () => {
      const input: HookInput = {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.footer, "");
    });
  });
});
