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
  logMessage,
  sendSystemNotification,
  speakNotification,
} from "../../lib/unified-audio-engine.ts";
import { logEvent } from "../lib/centralized-logging.ts";

/**
 * Stop 入力の background_tasks に status=running のタスクがあるか。
 *
 * バックグラウンド subagent が 1 つ完了するたびにメインループが再起動して
 * 短い応答を返し、その都度 Stop が発火する。まだ他の subagent が走っている
 * Stop は「作業の区切り」ではなく「待ち」なので、読み上げ対象から外す。
 * 最後の subagent が終わった後の Stop は background_tasks が空になるため
 * 通常どおり読み上げる。
 */
export function hasRunningBackgroundTasks(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const tasks = (input as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some(
    (task) =>
      typeof task === "object" &&
      task !== null &&
      (task as { status?: unknown }).status === "running",
  );
}

const STOP_FAILURE_LOG_MAX_LENGTH = 500;

/**
 * StopFailure の events.jsonl 用メッセージ。
 *
 * error / error_details は API 由来の文字列なので、改行を潰して長さを抑える。
 * last_assistant_message は会話内容を含みうるため、ここでは決して読まない。
 */
export function formatStopFailureLogMessage(input: unknown): string {
  const { error, error_details } =
    typeof input === "object" && input !== null
      ? (input as { error?: unknown; error_details?: unknown })
      : ({} as { error?: unknown; error_details?: unknown });
  const errorPart = `error=${typeof error === "string" ? error : "unknown"}`;
  const message =
    typeof error_details === "string" && error_details !== ""
      ? `${errorPart} details=${error_details}`
      : errorPart;
  return message.replace(/[\r\n]+/g, " ").slice(0, STOP_FAILURE_LOG_MAX_LENGTH);
}

export interface StopFailureDeps {
  speak: (text: string, type: "Error") => Promise<unknown>;
  notifySystem: (text: string) => Promise<unknown>;
  getMessages: () => Promise<{ voice: string; system: string }>;
}

/**
 * StopFailure の通知。音声が失敗してもデスクトップ通知は止めないため allSettled。
 * 通知文は Error テンプレートのみから作り、payload の値は混ぜない。
 */
export async function notifyStopFailure(deps: StopFailureDeps): Promise<void> {
  const messages = await deps.getMessages();
  await Promise.allSettled([
    deps.speak(messages.voice, "Error"),
    deps.notifySystem(messages.system),
  ]);
}

const hook = defineHook({
  trigger: {
    Notification: true,
    Stop: true,
    StopFailure: true,
  },
  run: async (context) => {
    const eventType = context.input.hook_event_name as
      | "Notification"
      | "Stop"
      | "StopFailure";
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
        logEvent(
          eventType,
          sessionId,
          eventType === "StopFailure"
            ? formatStopFailureLogMessage(context.input)
            : undefined,
        ),

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
              if (hasRunningBackgroundTasks(context.input)) {
                logMessage(
                  "Stop skipped: background subagents still running",
                  config,
                );
                break;
              }
              await handleStop(config, session);
              break;
            case "StopFailure":
              await notifyStopFailure({
                speak: (text, type) =>
                  speakNotification(text, type, config, session),
                notifySystem: (text) => sendSystemNotification(text, config),
                getMessages: () => createNotificationMessagesAuto("Error"),
              });
              break;
            default:
              await handleNotification(config, session);
              break;
          }
        })(),
      ]);

      // Stop/SubagentStop events should not return messageForUser to avoid duplicate messages
      // (prompt hook will also generate a response)
      if (eventType === "Stop" || eventType === "StopFailure") {
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
