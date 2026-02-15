/**
 * Webhook notification sender
 *
 * Sends WebhookNotification to all configured platforms (Discord, Slack).
 * Used by the permission hook chain to send notifications at the exact
 * point where a decision is made (e.g. "pass to user"), rather than
 * relying on event-based hooks which may fire at imprecise timing.
 */

import {
  createForumThread,
  getThreadId,
  saveThreadId,
  sendToThread,
} from "./discord-forum.ts";
import { getGitContext } from "./git-context.ts";
import type { WebhookNotification } from "./webhook-notification.ts";

const SEVERITY_TO_DISCORD_COLOR = {
  success: 3066993,
  warning: 15105570,
  muted: 9807270,
  info: 3447003,
} as const;

const SEVERITY_TO_SLACK_HEX = {
  success: "#2EB67D",
  warning: "#E0A500",
  muted: "#959595",
  info: "#36C5F0",
} as const;

/**
 * Send a notification to all configured webhook platforms.
 * Errors are silently swallowed to avoid blocking the caller.
 */
export async function sendWebhookNotifications(
  notification: WebhookNotification,
  sessionId: string,
): Promise<void> {
  const discordUrl = process.env.CLAUDE_DISCORD_WEBHOOK_URL;
  const forumUrl = process.env.CLAUDE_DISCORD_FORUM_WEBHOOK_URL;
  const slackUrl = process.env.CLAUDE_SLACK_WEBHOOK_URL;

  if (!discordUrl && !forumUrl && !slackUrl) return;

  const embed = {
    title: notification.title,
    description: notification.description,
    color: SEVERITY_TO_DISCORD_COLOR[notification.severity],
    ...(notification.footer ? { footer: { text: notification.footer } } : {}),
  };

  const promises: Promise<void>[] = [];

  // Discord regular channel
  if (discordUrl) {
    promises.push(
      fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Discord: ${r.status}`);
      }),
    );
  }

  // Discord forum channel (post to existing session thread)
  if (forumUrl) {
    const shortId = sessionId.slice(0, 8);
    promises.push(
      (async () => {
        const threadId = getThreadId(shortId);
        if (threadId) {
          await sendToThread(forumUrl, threadId, embed);
        } else {
          // Fallback: create thread if SessionStart was missed
          const gitContext = await getGitContext();
          const threadName = `📁 ${gitContext.name} | 🔑 ${shortId}`;
          const newThreadId = await createForumThread(
            forumUrl,
            threadName,
            embed,
          );
          saveThreadId(shortId, newThreadId);
        }
      })(),
    );
  }

  // Slack
  if (slackUrl) {
    const attachment = {
      color: SEVERITY_TO_SLACK_HEX[notification.severity],
      text: `*${notification.title}*\n${notification.description}`,
      ...(notification.footer ? { footer: notification.footer } : {}),
    };
    promises.push(
      fetch(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: [attachment] }),
      }).then((r) => {
        if (!r.ok) throw new Error(`Slack: ${r.status}`);
      }),
    );
  }

  await Promise.allSettled(promises);
}
