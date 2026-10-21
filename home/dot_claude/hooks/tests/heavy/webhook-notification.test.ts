#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

import {
  buildFooter,
  buildNotification,
  type HookInput,
} from "../../lib/webhook-notification.ts";

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
  });

  describe("Notification event", () => {
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

  describe("footer construction", () => {
    it("should include session ID in footer via buildNotification", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
        notification_type: "idle_prompt",
        message: "Waiting",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      // Session ID should be truncated to 8 chars
      ok(result.footer.includes("🔑 a2f252b1"));
    });
  });

  describe("buildFooter", () => {
    it("should include project name when cwd is provided", async () => {
      const footer = await buildFooter("/test", "test-session");
      ok(footer.includes("📁"));
      ok(footer.includes("🔑 test-ses"));
    });
  });
});
