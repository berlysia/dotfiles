#!/usr/bin/env -S bun run --silent

/**
 * PermissionRequest Notification Hook
 * cc-hooks-ts hook for notifying when permission confirmation is requested
 */

import { defineHook } from "cc-hooks-ts";
import { createNotificationMessagesAuto } from "../../lib/notification-messages.ts";
import {
  cleanupSession,
  createAudioEngine,
  sendSystemNotification,
  speakNotification,
} from "../../lib/unified-audio-engine.ts";
import { logDecision } from "../lib/centralized-logging.ts";

// 専用hookがあるツール、またはユーザー対話を目的とするツールはスキップ
// NOTE: AskUserQuestion はスキップしない - LLM evaluatorが承認しない場合のみここに到達する
const SKIP_NOTIFICATION_TOOLS = ["ExitPlanMode"];

// Type assertion for PermissionRequest input (Claude Code provides more than cc-hooks-ts types)
interface PermissionRequestInput {
  session_id: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
}

const hook = defineHook({
  trigger: {
    PermissionRequest: true,
  },
  run: async (context) => {
    const input = context.input as unknown as PermissionRequestInput;
    const sessionId = input.session_id;
    const toolName = input.tool_name;
    const toolInput = input.tool_input;

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
        // ログ記録（decisions.jsonlに記録、auto-approveのログと合流）
        logDecision(
          toolName,
          "permission_request",
          `User permission requested for ${toolName}`,
          sessionId,
          toolInput,
        ),

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
