#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { notifyWithContext, notify, cleanupOldFiles } from "../lib/voicevox-audio.ts";
import { logEvent } from "../lib/notification-logging.ts";

/**
 * Notification and Stop event handlers
 * Handles Stop and Notification events with VoiceVox-compatible audio synthesis
 */
const hook = defineHook({
  trigger: { 
    Stop: true,
    Notification: true,
  },
  run: async (context) => {
    const eventType = context.input.hook_event_name || "Unknown";
    const sessionId = context.input.session_id;
    
    try {
      // 並列実行で高速化
      await Promise.allSettled([
        // 互換性のあるログ記録（既存と同じ構造）
        logEvent(eventType, sessionId),
        
        // VoiceVox音声通知
        handleAudioNotification(eventType),
        
        // 古いファイルのクリーンアップ（Notificationイベント時のみ）
        eventType === "Notification" ? cleanupOldFiles() : Promise.resolve()
      ]);
      
      return context.success({});
    } catch (error) {
      // エラーでも成功を返す（既存の動作と同じ）
      console.error(`Notification error: ${error}`);
      return context.success({});
    }
  }
});

async function handleAudioNotification(eventType: string): Promise<void> {
  switch (eventType) {
    case 'Stop':
    case 'Notification':
      await notifyWithContext(eventType as 'Stop' | 'Notification');
      break;
    default:
      await notify("Claude Codeイベントが発生しました", 'notification');
  }
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
