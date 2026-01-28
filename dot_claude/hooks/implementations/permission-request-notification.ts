#!/usr/bin/env -S bun run --silent

/**
 * PermissionRequest Notification Hook
 * cc-hooks-ts hook for notifying when permission confirmation is requested
 */

import { defineHook } from "cc-hooks-ts";
import {
  createAudioEngine,
  cleanupSession,
  speakNotification,
  sendSystemNotification,
} from "../../lib/unified-audio-engine.ts";
import { createNotificationMessagesAuto } from "../../lib/notification-messages.ts";
import { logEvent } from "../lib/centralized-logging.ts";

// AskUserQuestionは専用hookがあるため、PermissionRequestでの通知をスキップ
const SKIP_NOTIFICATION_TOOLS = ["AskUserQuestion"];

const hook = defineHook({
  trigger: {
    PermissionRequest: true,
  },
  run: async (context) => {
    const sessionId = context.input.session_id;
    const toolName = context.input.tool_name;

    // Skip notification for tools that have dedicated notification hooks
    if (SKIP_NOTIFICATION_TOOLS.includes(toolName)) {
      return context.success({});
    }

    try {
      const { config, session } = await createAudioEngine();
      const messages = await createNotificationMessagesAuto(
        "PermissionRequest",
        toolName,
      );

      // Setup cleanup on exit
      const cleanup = () => cleanupSession(session, config);
      process.on("exit", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // 並列実行で高速化
      await Promise.allSettled([
        // ログ記録
        logEvent("PermissionRequest", sessionId),

        // システム通知
        sendSystemNotification(messages.system, config),

        // 音声通知（VoiceVoxが利用可能な場合）
        speakNotification(messages.voice, "PermissionRequest", config, session),
      ]);

      // PermissionRequestイベントは処理を継続させるため、空のメッセージで成功を返す
      return context.success({});
    } catch (error) {
      console.error(`PermissionRequest notification error: ${error}`);
      // エラーでも処理は継続する
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
