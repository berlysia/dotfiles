/**
 * Notification Messages - Centralized message management for voice notifications
 * 音声通知メッセージの一元管理
 */

import type { GitContextInfo } from "../hooks/lib/git-context.ts";
import { getGitContext } from "../hooks/lib/git-context.ts";

/**
 * Supported notification event types
 */
export type NotificationEventType =
  | "Notification"
  | "Stop"
  | "Error"
  | "AskUserQuestion"
  | "PermissionRequest";

/**
 * Generated notification messages
 */
export interface NotificationMessages {
  /** Full message for voice synthesis (includes computer name prefix) */
  voice: string;
  /** Message for system notifications */
  system: string;
  /** Raw action message without context */
  action: string;
}

/**
 * Message templates for each event type
 */
const MESSAGE_TEMPLATES: Record<
  NotificationEventType,
  { action: string; systemPrefix: string }
> = {
  Notification: {
    action: "操作の確認が必要です",
    systemPrefix: "Claude: 確認が必要です",
  },
  Stop: {
    action: "処理が完了しました",
    systemPrefix: "Claude: 完了",
  },
  Error: {
    action: "エラーが発生しました",
    systemPrefix: "Claude: エラー",
  },
  AskUserQuestion: {
    action: "質問があります",
    systemPrefix: "Claude が質問しています",
  },
  PermissionRequest: {
    action: "許可の確認が必要です",
    systemPrefix: "パーミッション確認",
  },
};

/**
 * Context for message generation
 */
export interface MessageContext {
  computerName: string;
  gitContext: GitContextInfo;
  toolName?: string | undefined;
}

/**
 * Get message context from environment and git
 */
export async function getMessageContext(
  toolName?: string,
): Promise<MessageContext> {
  const computerName = process.env.CLAUDE_COMPUTER_NAME || "Claude";
  const gitContext = await getGitContext();

  return {
    computerName,
    gitContext,
    toolName,
  };
}

/**
 * Create notification messages for a given event type
 * Central function for all notification message generation
 */
export function createNotificationMessages(
  eventType: NotificationEventType,
  context: MessageContext,
): NotificationMessages {
  const template = MESSAGE_TEMPLATES[eventType];
  if (!template) {
    return {
      voice: `${context.computerName}の通知です`,
      system: "Claude: 通知",
      action: "通知です",
    };
  }

  const { gitContext, computerName, toolName } = context;
  const locationDesc = `${gitContext.name} ${gitContext.containerType}`;

  // Build action message with location context
  const action = `${locationDesc}で${template.action}`;

  // Build voice message with computer name prefix
  const voice = `${computerName}の${action}`;

  // Build system notification message
  let system = `${template.systemPrefix}: ${gitContext.name}`;
  if (toolName && eventType === "PermissionRequest") {
    system = `${template.systemPrefix}: ${toolName} (${gitContext.name})`;
  }

  return { voice, system, action };
}

/**
 * Convenience function to create messages with auto-fetched context
 */
export async function createNotificationMessagesAuto(
  eventType: NotificationEventType,
  toolName?: string,
): Promise<NotificationMessages> {
  const context = await getMessageContext(toolName);
  return createNotificationMessages(eventType, context);
}

/**
 * Get available event types (for type checking and validation)
 */
export function getAvailableEventTypes(): NotificationEventType[] {
  return Object.keys(MESSAGE_TEMPLATES) as NotificationEventType[];
}

/**
 * Check if an event type is valid
 */
export function isValidEventType(
  eventType: string,
): eventType is NotificationEventType {
  return eventType in MESSAGE_TEMPLATES;
}
