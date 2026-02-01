#!/usr/bin/env -S bun run --silent

/**
 * AskUserQuestion Notification Hook
 * cc-hooks-ts hook for notifying when Claude asks user questions
 */

import { defineHook } from "cc-hooks-ts";
import { createNotificationMessagesAuto } from "../../lib/notification-messages.ts";
import {
  cleanupSession,
  createAudioEngine,
  sendSystemNotification,
  speakNotification,
} from "../../lib/unified-audio-engine.ts";
import { logEvent } from "../lib/centralized-logging.ts";

const hook = defineHook({
  trigger: {
    PreToolUse: true,
  },
  run: async (context) => {
    // Only process AskUserQuestion tool
    if (context.input.tool_name !== "AskUserQuestion") {
      return context.success({});
    }

    const sessionId = context.input.session_id;

    try {
      const { config, session } = await createAudioEngine();
      const messages = await createNotificationMessagesAuto("AskUserQuestion");

      // Setup cleanup on exit
      const cleanup = () => cleanupSession(session, config);
      process.on("exit", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // 並列実行で高速化
      await Promise.allSettled([
        // ログ記録 (AskUserQuestion は EventLogEntry に定義されていないため Notification を使用)
        logEvent("Notification", sessionId, "AskUserQuestion triggered"),

        // システム通知
        sendSystemNotification(messages.system, config),

        // 音声通知（VoiceVoxが利用可能な場合）
        speakNotification(messages.voice, "AskUserQuestion", config, session),
      ]);

      // PreToolUseイベントは処理を継続させるため、空のメッセージで成功を返す
      return context.success({});
    } catch (error) {
      console.error(`AskUserQuestion notification error: ${error}`);
      // エラーでもツールの実行は継続する
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
