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
  /** Action message with location context */
  action: string;
}

/**
 * Variables available for message template functions
 */
export interface MessageTemplateVars {
  /** Repository or directory name */
  repoName: string;
  /** "リポジトリ" or "ディレクトリ" */
  containerType: string;
  /** Combined location: `${repoName} ${containerType}` */
  location: string;
  /** Computer name (from env or default "Claude") */
  computerName: string;
  /** Tool name (for PermissionRequest) */
  toolName?: string | undefined;
  /** Base action text (e.g., "質問があります") */
  actionText: string;
}

/**
 * Message template definition for each event type
 */
export interface MessageTemplate {
  /** Base action text (required) */
  actionText: string;
  /** Custom voice message generator (optional, uses default if not provided) */
  voice?: (vars: MessageTemplateVars) => string;
  /** Custom system notification generator (optional, uses default if not provided) */
  system?: (vars: MessageTemplateVars) => string;
  /** Custom action message generator (optional, uses default if not provided) */
  action?: (vars: MessageTemplateVars) => string;
}

// =========================================================================
// Default Message Patterns
// =========================================================================

/**
 * Default voice message pattern
 * Example: "Claudeのdotfiles リポジトリで質問があります"
 */
const DEFAULT_VOICE = (v: MessageTemplateVars): string =>
  `${v.computerName}の${v.location}で${v.actionText}`;

/**
 * Default system notification pattern
 * Example: "Claude: 質問があります (dotfiles)"
 */
const DEFAULT_SYSTEM = (v: MessageTemplateVars): string =>
  `Claude: ${v.actionText} (${v.repoName})`;

/**
 * Default action message pattern (for voice synthesis without computer name)
 * Example: "dotfiles リポジトリで質問があります"
 */
const DEFAULT_ACTION = (v: MessageTemplateVars): string =>
  `${v.location}で${v.actionText}`;

// =========================================================================
// Message Templates per Event Type
// =========================================================================

const MESSAGE_TEMPLATES: Record<NotificationEventType, MessageTemplate> = {
  Notification: {
    actionText: "通知があります",
    system: (v) => `通知: ${v.repoName}`,
  },

  Stop: {
    voice: (v) => `${v.computerName}の${v.location}で、Claudeが動作を停止しました`,
    actionText: "動作を停止しました",
    system: (v) => `停止: ${v.repoName}`,
  },

  Error: {
    actionText: "エラーが発生しました",
    system: (v) => `エラー: ${v.repoName}`,
  },

  AskUserQuestion: {
    voice: (v) => `${v.computerName}の${v.location}で、Claudeから質問があります。`,
    actionText: "質問があります",
    system: (v) => `Claude が質問しています: ${v.repoName}`,
  },

  PermissionRequest: {
    voice: (v) =>
      v.toolName
        ? `${v.computerName}の${v.location}で、Claudeが ${v.toolName} を使う許可を求めています。`
        : `${v.computerName}の${v.location}で、Claudeが許可を求めています。`,
    actionText: "許可の確認が必要です",
    system: (v) =>
      v.toolName
        ? `パーミッション確認: ${v.toolName} (${v.repoName})`
        : `パーミッション確認: ${v.repoName}`,
  },
};

// =========================================================================
// Context Management
// =========================================================================

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

// =========================================================================
// Message Generation
// =========================================================================

/**
 * Build template variables from context
 */
function buildTemplateVars(
  template: MessageTemplate,
  context: MessageContext,
): MessageTemplateVars {
  const { gitContext, computerName, toolName } = context;

  return {
    repoName: gitContext.name,
    containerType: gitContext.containerType,
    location: `${gitContext.name} ${gitContext.containerType}`,
    computerName,
    toolName,
    actionText: template.actionText,
  };
}

/**
 * Create notification messages for a given event type
 * Uses custom template functions if defined, otherwise falls back to defaults
 */
export function createNotificationMessages(
  eventType: NotificationEventType,
  context: MessageContext,
): NotificationMessages {
  const template = MESSAGE_TEMPLATES[eventType];

  if (!template) {
    // Fallback for unknown event types
    const fallbackVars: MessageTemplateVars = {
      repoName: context.gitContext.name,
      containerType: context.gitContext.containerType,
      location: `${context.gitContext.name} ${context.gitContext.containerType}`,
      computerName: context.computerName,
      toolName: context.toolName,
      actionText: "通知です",
    };

    return {
      voice: DEFAULT_VOICE(fallbackVars),
      system: DEFAULT_SYSTEM(fallbackVars),
      action: DEFAULT_ACTION(fallbackVars),
    };
  }

  const vars = buildTemplateVars(template, context);

  // Use custom generators if defined, otherwise use defaults
  const voiceGenerator = template.voice ?? DEFAULT_VOICE;
  const systemGenerator = template.system ?? DEFAULT_SYSTEM;
  const actionGenerator = template.action ?? DEFAULT_ACTION;

  return {
    voice: voiceGenerator(vars),
    system: systemGenerator(vars),
    action: actionGenerator(vars),
  };
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

// =========================================================================
// Utilities
// =========================================================================

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

/**
 * Get default message generators (for external customization)
 */
export const defaultGenerators = {
  voice: DEFAULT_VOICE,
  system: DEFAULT_SYSTEM,
  action: DEFAULT_ACTION,
} as const;
