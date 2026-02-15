#!/usr/bin/env -S bun run --silent

/**
 * Voice Notification Hook
 * cc-hooks-ts hook for Notification and Stop events using shared library
 */

import { defineHook } from "cc-hooks-ts";

import {
  createNotificationMessagesAuto,
  type NotificationType,
} from "../../lib/notification-messages.ts";
import {
  cleanupOldFiles,
  cleanupSession,
  createAudioEngine,
  handleNotification,
  handleStop,
  sendSystemNotification,
} from "../../lib/unified-audio-engine.ts";
import { logEvent } from "../lib/centralized-logging.ts";

const hook = defineHook({
  trigger: {
    Notification: true,
    Stop: true,
  },
  run: async (context) => {
    const eventType = context.input.hook_event_name as "Notification" | "Stop";
    const sessionId = context.input.session_id;
    // Extract notification_type and message from Notification events
    // @see https://code.claude.com/docs/en/hooks#notification
    // cc-hooks-ts types don't include these fields yet, so we cast to unknown first
    const inputAny = context.input as unknown as {
      notification_type?: NotificationType;
      message?: string;
    };
    const notificationType = inputAny.notification_type;
    const notificationMessage = inputAny.message;

    try {
      const { config, session } = await createAudioEngine();

      // Setup cleanup on exit
      const cleanup = () => cleanupSession(session, config);
      process.on("exit", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // 並列実行で高速化
      await Promise.allSettled([
        // ログ記録
        logEvent(eventType, sessionId),

        // 音声通知
        (async () => {
          switch (eventType) {
            case "Notification":
              await handleNotification(config, session, {
                notificationType,
                notificationMessage,
              });
              // permission_prompt の場合はシステム通知も併用して気付きやすくする
              if (notificationType === "permission_prompt") {
                const messages = await createNotificationMessagesAuto(
                  "Notification",
                  { notificationType },
                );
                await sendSystemNotification(messages.system, config);
              }
              // Notificationイベント時のみクリーンアップ
              await cleanupOldFiles(config);
              break;
            case "Stop":
              await handleStop(config, session);
              break;
            default:
              await handleNotification(config, session);
              break;
          }
        })(),
      ]);

      // Stop/SubagentStop events should not return messageForUser to avoid duplicate messages
      // (prompt hook will also generate a response)
      if (eventType === "Stop") {
        return context.success({});
      }
      return context.success({
        messageForUser: `Voice notification completed for ${eventType} event`,
      });
    } catch (error) {
      console.error(`Voice notification error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
