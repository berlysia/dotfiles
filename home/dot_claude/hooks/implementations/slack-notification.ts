#!/usr/bin/env -S bun run --silent

/**
 * Slack Webhook Notification Hook
 *
 * Thin adapter that converts platform-neutral notifications into Slack attachments.
 * Controlled by CLAUDE_SLACK_WEBHOOK_URL environment variable —
 * if not set, the hook exits silently with no side effects.
 *
 * @see https://api.slack.com/messaging/webhooks
 */

import { defineHook } from "cc-hooks-ts";

import { logEvent } from "../lib/centralized-logging.ts";
import {
  buildNotification,
  type HookInput,
} from "../lib/webhook-notification.ts";

// Slack attachment hex colors mapped from severity
const SEVERITY_TO_HEX = {
  success: "#2EB67D",
  warning: "#E0A500",
  muted: "#959595",
  info: "#36C5F0",
} as const;

/**
 * Send a Slack incoming webhook message with attachment.
 */
async function sendSlackAttachment(
  webhookUrl: string,
  attachment: {
    color: string;
    text: string;
    footer?: string;
  },
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attachments: [attachment] }),
  });

  if (!response.ok) {
    throw new Error(
      `Slack webhook failed: ${response.status} ${response.statusText}`,
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
    const webhookUrl = process.env.CLAUDE_SLACK_WEBHOOK_URL;
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

      const attachment = {
        color: SEVERITY_TO_HEX[notification.severity],
        text: `*${notification.title}*\n${notification.description}`,
        ...(notification.footer ? { footer: notification.footer } : {}),
      };

      await sendSlackAttachment(webhookUrl, attachment);
    } catch (error) {
      logEvent("Error", sessionId, `slack-notification: ${String(error)}`);
    }

    return context.success({});
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
