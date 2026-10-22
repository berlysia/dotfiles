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

export interface PermissionPromptToastInput {
  platform: "darwin" | "linux" | "wsl";
  notificationType: string | undefined;
  WT_SESSION: string | undefined;
  TMUX: string | undefined;
  TERM_PROGRAM: string | undefined;
}

/**
 * permission_prompt で hook 発のトーストを送るか。
 *
 * Windows Terminal Preview のタブでは Claude Code 本体が OSC 777 で同じ場面の
 * 通知を出すので、重ねて送らない。platform だけで止めると VS Code・tmux・ssh で
 * 許可待ちの通知が 0 個になるため、本体の OSC 777 が届く見込みのある条件
 * (WT_SESSION あり、tmux の外、VS Code ではない) がそろうときだけ止める。
 * WT_SESSION からは安定版と Preview も allowOSC777 の有無も分からないので、
 * それらの環境での 0 個は受け入れている (WINDOWS.md)。
 */
export function shouldSendPermissionPromptToast(
  input: PermissionPromptToastInput,
): boolean {
  if (input.notificationType !== "permission_prompt") return false;
  const osc777Likely =
    input.platform === "wsl" &&
    !!input.WT_SESSION &&
    !input.TMUX &&
    input.TERM_PROGRAM !== "vscode";
  return !osc777Likely;
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
              if (
                shouldSendPermissionPromptToast({
                  platform: config.system.platform,
                  notificationType,
                  WT_SESSION: process.env.WT_SESSION,
                  TMUX: process.env.TMUX,
                  TERM_PROGRAM: process.env.TERM_PROGRAM,
                })
              ) {
                const messages = await createNotificationMessagesAuto(
                  "Notification",
                  { notificationType },
                );
                await sendSystemNotification(messages.system, config);
              } else if (notificationType === "permission_prompt") {
                // 本文は外部入力を含みうるので書かない
                logMessage(
                  "System notification skipped: permission_prompt is shown by Windows Terminal (OSC 777)",
                  config,
                );
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
