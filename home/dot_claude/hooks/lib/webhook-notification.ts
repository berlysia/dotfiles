/**
 * Platform-neutral webhook notification builder
 *
 * Extracts event processing logic (Stop/Notification branching,
 * transcript extraction, footer construction) into a shared module.
 * Discord/Slack adapters consume the output.
 *
 * Note: Permission notifications are NOT handled via events here.
 * Notification(permission_prompt) may fire before PermissionRequest hooks
 * complete (e.g. LLM evaluator), so permission webhooks are sent directly
 * from the permission hook chain via webhook-sender.ts.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";

import type { NotificationType } from "../../lib/notification-messages.ts";
import { getGitContext } from "./git-context.ts";

/** Platform-neutral notification message */
export interface WebhookNotification {
  title: string;
  description: string;
  severity: "success" | "warning" | "info" | "muted";
  footer: string;
}

/** Hook input fields used by webhook notification logic */
export interface HookInput {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  notification_type?: NotificationType;
  message?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
}

/**
 * Extract text content from a JSONL transcript entry's message content field.
 * Returns empty string if no text block is found (e.g. tool_use, tool_result, thinking).
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block === "string") return block;
    if (block?.type === "text" && block.text) return block.text;
  }
  return "";
}

/**
 * Extract the last message of a given role from a JSONL transcript file.
 * Reads the file then searches in reverse to find the most recent match.
 */
export async function extractFromTranscript(
  transcriptPath: string,
  role: "user" | "assistant",
  limit: number,
): Promise<string> {
  if (!transcriptPath) return "";

  const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream });

  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== role) continue;

      const text = extractTextFromContent(entry.message?.content);
      if (text) {
        return text.length > limit ? `${text.slice(0, limit)}...` : text;
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  return "";
}

/**
 * Extract the last assistant-user exchange from a JSONL transcript file.
 *
 * Searches backward for the last assistant text entry (the latest Claude response),
 * then searches backward from that position for the preceding user text entry
 * (the corresponding user message). This ensures the pair belongs to the same
 * conversational turn, avoiding a mismatch when tool-use or thinking entries
 * appear between the last user text and the final assistant text.
 */
export async function extractLastExchange(
  transcriptPath: string,
): Promise<{ userMsg: string; assistantMsg: string }> {
  if (!transcriptPath) return { userMsg: "", assistantMsg: "" };

  const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream });

  const lines: string[] = [];
  for await (const line of rl) {
    lines.push(line);
  }

  // Find the last assistant text entry
  let assistantMsg = "";
  let assistantLineIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "assistant") continue;

      const text = extractTextFromContent(entry.message?.content);
      if (text) {
        assistantMsg = text.length > 300 ? `${text.slice(0, 300)}...` : text;
        assistantLineIndex = i;
        break;
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  // Find the user text entry preceding the assistant entry
  let userMsg = "";
  const searchEnd =
    assistantLineIndex >= 0 ? assistantLineIndex : lines.length - 1;

  for (let i = searchEnd; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user") continue;

      const text = extractTextFromContent(entry.message?.content);
      if (text) {
        userMsg = text.length > 100 ? `${text.slice(0, 100)}...` : text;
        break;
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  return { userMsg, assistantMsg };
}

/**
 * Build a platform-neutral notification from hook input.
 * Returns null when the event should be skipped (e.g. stop_hook_active, unrecognized event).
 */
export async function buildNotification(
  input: HookInput,
): Promise<WebhookNotification | null> {
  const eventType = input.hook_event_name;
  const sessionId = (input.session_id ?? "").slice(0, 8);
  const cwd = input.cwd ?? "";

  let title = "";
  let description = "";
  let severity: WebhookNotification["severity"] = "info";

  if (eventType === "SessionStart") {
    title = "🚀 セッション開始";
    severity = "info";
    description = "新しいClaude Codeセッションが開始されました。";
  } else if (eventType === "Stop") {
    // Prevent infinite loop: stop_hook_active means this was triggered by a hook
    if (input.stop_hook_active) {
      return null;
    }

    title = "✅ 返信完了";
    severity = "success";

    const transcriptPath = input.transcript_path ?? "";
    // Wait briefly for the transcript file to be fully flushed to disk.
    // The Stop event fires ~50ms after the final assistant entry is created,
    // but the write may still be buffered in the parent process.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { userMsg, assistantMsg } = await extractLastExchange(transcriptPath);

    const parts: string[] = [];
    if (userMsg) parts.push(`> ${userMsg}`);
    if (assistantMsg) parts.push(assistantMsg);
    description =
      parts.length > 0 ? parts.join("\n\n") : "Claudeの返信が完了しました。";
  } else if (eventType === "Notification") {
    const notificationType = input.notification_type;
    const notificationMessage = input.message ?? "";

    switch (notificationType) {
      case "permission_prompt":
        // Permission webhooks are sent from the permission hook chain
        // (permission-llm-evaluator.ts) when passing to user, not from events
        return null;
      case "idle_prompt":
        title = "💤 入力待ち";
        severity = "muted";
        description = notificationMessage || "Claudeが入力を待っています。";
        break;
      default:
        title = "🔔 通知";
        severity = "info";
        description = notificationMessage || "通知があります。";
        break;
    }
  }

  if (!title) {
    return null;
  }

  return {
    title,
    description,
    severity,
    footer: await buildFooter(cwd, sessionId),
  };
}

/**
 * Build footer string with project name and session ID.
 * Exported for use by permission hook chain (webhook-sender.ts).
 */
export async function buildFooter(
  cwd?: string,
  sessionId?: string,
): Promise<string> {
  const footerParts: string[] = [];
  if (cwd) {
    const gitContext = await getGitContext();
    footerParts.push(`📁 ${gitContext.name}`);
  }
  const shortId = (sessionId ?? "").slice(0, 8);
  if (shortId) {
    footerParts.push(`🔑 ${shortId}`);
  }
  return footerParts.join("  |  ");
}
