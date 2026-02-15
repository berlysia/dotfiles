#!/usr/bin/env -S bun run --silent

/**
 * Discord Webhook Notification Hook
 *
 * Thin adapter that converts platform-neutral notifications into Discord embeds.
 * Controlled by CLAUDE_DISCORD_WEBHOOK_URL environment variable —
 * if not set, the hook exits silently with no side effects.
 *
 * @see https://discord.com/developers/docs/resources/webhook
 */

import { defineHook } from "cc-hooks-ts";

import { logEvent } from "../lib/centralized-logging.ts";
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
    PermissionRequest: true,
    Stop: true,
  },
  run: async (context) => {
    const webhookUrl = process.env.CLAUDE_DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      return context.success({});
    }

    const sessionId = (context.input.session_id ?? "").slice(0, 8);

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

      await sendDiscordEmbed(webhookUrl, embed);
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
