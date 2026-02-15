#!/usr/bin/env -S bun run --silent

/**
 * Discord Webhook Notification Hook
 *
 * Thin adapter that converts platform-neutral notifications into Discord embeds.
 * Supports two modes:
 *   1. Regular channel: CLAUDE_DISCORD_WEBHOOK_URL — traditional embed posts
 *   2. Forum channel: CLAUDE_DISCORD_FORUM_WEBHOOK_URL — session-scoped threads
 *
 * When forum webhook is configured, SessionStart creates a new thread and
 * subsequent events (Stop/Notification/PermissionRequest) post into that thread.
 *
 * @see https://discord.com/developers/docs/resources/webhook
 */

import { defineHook } from "cc-hooks-ts";

import { logEvent } from "../lib/centralized-logging.ts";
import {
  cleanupOldThreads,
  createForumThread,
  getThreadId,
  saveThreadId,
  sendToThread,
} from "../lib/discord-forum.ts";
import { getGitContext } from "../lib/git-context.ts";
import {
  buildNotification,
  type HookInput,
} from "../lib/webhook-notification.ts";

// Discord embed color codes mapped from severity
const SEVERITY_TO_COLOR = {
  success: 3066993, // green
  warning: 15105570, // orange
  muted: 9807270, // grey
  info: 3447003, // blue
} as const;

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  footer?: { text: string };
}

/**
 * Send a Discord webhook embed message to a regular text channel.
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

/**
 * Build a forum thread name from project context and session ID.
 */
async function buildThreadName(sessionId: string): Promise<string> {
  const gitContext = await getGitContext();
  return `📁 ${gitContext.name} | 🔑 ${sessionId}`;
}

const hook = defineHook({
  trigger: {
    Notification: true,
    PermissionRequest: true,
    SessionStart: true,
    Stop: true,
  },
  run: async (context) => {
    const regularWebhookUrl = process.env.CLAUDE_DISCORD_WEBHOOK_URL;
    const forumWebhookUrl = process.env.CLAUDE_DISCORD_FORUM_WEBHOOK_URL;

    if (!regularWebhookUrl && !forumWebhookUrl) {
      return context.success({});
    }

    const sessionId = (context.input.session_id ?? "").slice(0, 8);
    const eventType = context.input.hook_event_name;

    try {
      const notification = await buildNotification(
        context.input as HookInput,
      );
      if (!notification) {
        return context.success({});
      }

      const embed: DiscordEmbed = {
        title: notification.title,
        description: notification.description,
        color: SEVERITY_TO_COLOR[notification.severity],
        ...(notification.footer
          ? { footer: { text: notification.footer } }
          : {}),
      };

      // Forum channel handling
      if (forumWebhookUrl) {
        if (eventType === "SessionStart") {
          // Create a new forum thread for this session
          const threadName = await buildThreadName(sessionId);
          const threadId = await createForumThread(
            forumWebhookUrl,
            threadName,
            embed,
          );
          saveThreadId(sessionId, threadId);

          // Periodically clean up old thread mappings
          cleanupOldThreads();
        } else {
          // Post to existing thread, or create new one as fallback
          const existingThreadId = getThreadId(sessionId);
          if (existingThreadId) {
            await sendToThread(forumWebhookUrl, existingThreadId, embed);
          } else {
            // Fallback: session thread not found (e.g. SessionStart was missed)
            const threadName = await buildThreadName(sessionId);
            const threadId = await createForumThread(
              forumWebhookUrl,
              threadName,
              embed,
            );
            saveThreadId(sessionId, threadId);
          }
        }
      }

      // Regular channel handling (skip SessionStart for regular channels)
      if (regularWebhookUrl && eventType !== "SessionStart") {
        await sendDiscordEmbed(regularWebhookUrl, embed);
      }
    } catch (error) {
      logEvent("Error", sessionId, `discord-notification: ${String(error)}`);
    }

    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
