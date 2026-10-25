#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildFooter,
  buildNotification,
  extractFromTranscript,
  extractLastExchange,
  type HookInput,
} from "../../lib/webhook-notification.ts";

describe("extractFromTranscript", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "webhook-test-")));
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

describe("extractLastExchange", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "webhook-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty strings for empty path", async () => {
    const result = await extractLastExchange("");
    strictEqual(result.userMsg, "");
    strictEqual(result.assistantMsg, "");
  });

  it("should return paired user and assistant messages", async () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "question" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer" }] },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractLastExchange(filePath);
    strictEqual(result.userMsg, "question");
    strictEqual(result.assistantMsg, "answer");
  });

  it("should match assistant to the user message before it (not after)", async () => {
    // Simulates the bug: last user text comes AFTER the last assistant text
    // when tool_use or thinking entries appear at the end.
    // extractLastExchange should pair the last assistant text with the user before it.
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "question A" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer A" }] },
      }),
      // Turn 2 starts: user posts question B, then assistant uses tool (no text)
      JSON.stringify({ type: "user", message: { content: "question B" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ tool_use_id: "t1", type: "tool_result", content: "ok" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer B" }] },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractLastExchange(filePath);
    strictEqual(result.assistantMsg, "answer B");
    strictEqual(result.userMsg, "question B");
  });

  it("should skip tool_result user entries and return the real user text", async () => {
    // The last user entry in the transcript is a tool_result (not human text).
    // extractLastExchange should skip it and find the actual human message.
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "real question" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { tool_use_id: "t1", type: "tool_result", content: "result" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractLastExchange(filePath);
    strictEqual(result.assistantMsg, "final answer");
    strictEqual(result.userMsg, "real question");
  });

  it("should skip thinking-only assistant entries to find the last text entry", async () => {
    // Thinking entries appear after the final text due to streaming.
    // extractLastExchange must skip them and pick the text entry.
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "question" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "final answer" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "post-processing..." }],
        },
      }),
    ].join("\n");

    const filePath = join(tempDir, "transcript.jsonl");
    writeFileSync(filePath, transcript);

    const result = await extractLastExchange(filePath);
    strictEqual(result.assistantMsg, "final answer");
    strictEqual(result.userMsg, "question");
  });
});

describe("buildNotification", () => {
  describe("Stop event", () => {
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
    it("should return null (not handled — use Notification(permission_prompt) instead)", async () => {
      const input: HookInput = {
        hook_event_name: "PermissionRequest",
        session_id: "a2f252b1-1234-5678-abcd-123456789012",
        cwd: "/test",
        tool_name: "Bash",
      };

      const result = await buildNotification(input);
      strictEqual(result, null);
    });
  });

  describe("Notification event", () => {
    it("should return null for permission_prompt (handled by permission hook chain)", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        session_id: "test-session",
        cwd: "/test",
        notification_type: "permission_prompt",
        message: "Bash の実行許可を求めています",
      };

      const result = await buildNotification(input);
      strictEqual(result, null);
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
    it("should have empty footer when no cwd and no session_id", async () => {
      const input: HookInput = {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
      };

      const result = await buildNotification(input);
      ok(result !== null);
      strictEqual(result.footer, "");
    });
  });

  describe("buildFooter", () => {
    it("should include session ID truncated to 8 chars", async () => {
      const footer = await buildFooter(
        undefined,
        "a2f252b1-1234-5678-abcd-123456789012",
      );
      ok(footer.includes("🔑 a2f252b1"));
    });

    it("should return empty string when no cwd and no session_id", async () => {
      const footer = await buildFooter();
      strictEqual(footer, "");
    });
  });
});
