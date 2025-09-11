#!/usr/bin/env -S bun run --silent

/**
 * Voice Notification Hook
 * cc-hooks-ts hook for Notification and Stop events using shared library
 */

import { defineHook } from "cc-hooks-ts";
import {
  createAudioEngine,
  handleNotification,
  handleStop,
  cleanupSession,
  cleanupOldFiles,
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
              await handleNotification(config, session);
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
