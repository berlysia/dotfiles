#!/usr/bin/env -S bun run --silent

/**
 * Discord Webhook Notification Hook
 *
 * Sends Discord embed notifications on Stop and Notification events.
 * Controlled by CLAUDE_DISCORD_WEBHOOK_URL environment variable —
 * if not set, the hook exits silently with no side effects.
 *
 * @see https://discord.com/developers/docs/resources/webhook
 */

import { defineHook } from "cc-hooks-ts";
import * as fs from "node:fs";
import * as readline from "node:readline";

import type { NotificationType } from "../../lib/notification-messages.ts";
import { getGitContext } from "../lib/git-context.ts";

// Discord embed color codes
const COLORS = {
  green: 3066993, // Stop: completed
  orange: 15105570, // Notification: permission_prompt
  grey: 9807270, // Notification: idle_prompt
  blue: 3447003, // Notification: other
} as const;

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
}

/**
 * Extract the last message of a given role from a JSONL transcript file.
 * Reads the file in reverse to find the most recent match efficiently.
 */
async function extractFromTranscript(
  transcriptPath: string,
  role: "user" | "assistant",
  limit: number,
): Promise<string> {
  if (!transcriptPath) return "";

  const fileStream = fs.createReadStream(transcriptPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream });

  // Collect all lines then search in reverse (transcript files are typically small)
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

      const content = entry.message?.content;
      if (!content) continue;

      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        // assistant content is an array of blocks
        for (const block of content) {
          if (typeof block === "string") {
            text = block;
            break;
          }
          if (block?.type === "text" && block.text) {
            text = block.text;
            break;
          }
        }
      }

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
 * Send a Discord webhook embed message.
 */
async function sendDiscordEmbed(
  webhookUrl: string,
  embed: DiscordEmbed,
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(
      `Discord webhook failed: ${response.status} ${response.statusText}`,
    );
  }
}

const hook = defineHook({
  trigger: {
    Notification: true,
    Stop: true,
  },
  run: async (context) => {
    const webhookUrl = process.env.CLAUDE_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      // No webhook URL configured — skip silently
      return context.success({});
    }

    const eventType = context.input.hook_event_name as "Notification" | "Stop";
    const sessionId = (context.input.session_id ?? "").slice(0, 8);
    const cwd = context.input.cwd ?? "";

    // cc-hooks-ts types don't include all hook-specific fields yet
    const inputAny = context.input as unknown as {
      notification_type?: NotificationType;
      message?: string;
      transcript_path?: string;
      stop_hook_active?: boolean;
    };

    let title = "";
    let description = "";
    let color: number = COLORS.blue;

    try {
      if (eventType === "Stop") {
        // Prevent infinite loop: stop_hook_active means this was triggered by a hook
        if (inputAny.stop_hook_active) {
          return context.success({});
        }

        title = "✅ 返信完了";
        color = COLORS.green;

        const transcriptPath = inputAny.transcript_path ?? "";
        const [userMsg, assistantMsg] = await Promise.all([
          extractFromTranscript(transcriptPath, "user", 100),
          extractFromTranscript(transcriptPath, "assistant", 300),
        ]);

        const parts: string[] = [];
        if (userMsg) parts.push(`> ${userMsg}`);
        if (assistantMsg) parts.push(assistantMsg);
        description =
          parts.length > 0
            ? parts.join("\n\n")
            : "Claudeの返信が完了しました。";
      } else if (eventType === "Notification") {
        const notificationType = inputAny.notification_type;
        const notificationMessage = inputAny.message ?? "";

        switch (notificationType) {
          case "permission_prompt":
            title = "⚠️ 確認待ち";
            color = COLORS.orange;
            description = notificationMessage || "権限の確認が必要です。";
            break;
          case "idle_prompt":
            title = "💤 入力待ち";
            color = COLORS.grey;
            description =
              notificationMessage || "Claudeが入力を待っています。";
            break;
          default:
            title = "🔔 通知";
            color = COLORS.blue;
            description = notificationMessage || "通知があります。";
            break;
        }
      }

      if (!title) {
        return context.success({});
      }

      // Build footer with cwd and session ID for project identification
      const footerParts: string[] = [];
      if (cwd) {
        const gitContext = await getGitContext();
        footerParts.push(`📁 ${gitContext.name}`);
      }
      if (sessionId) {
        footerParts.push(`🔑 ${sessionId}`);
      }

      const embed: DiscordEmbed = {
        title,
        description,
        color,
        ...(footerParts.length > 0
          ? { footer: { text: footerParts.join("  |  ") } }
          : {}),
      };

      await sendDiscordEmbed(webhookUrl, embed);
    } catch (error) {
      console.error(`Discord notification error: ${error}`);
    }

    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
