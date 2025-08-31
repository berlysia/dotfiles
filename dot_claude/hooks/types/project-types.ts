/**
 * Project-specific type definitions for Claude Code hook scripts
 * 
 * This file contains types that are specific to this project's hook implementations.
 * Basic Hook API types are now imported from cc-hooks-ts library.
 * 
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 */

// Re-export types from cc-hooks-ts for convenience
import type { ExtractAllHookInputsForEvent, ExtractSpecificHookInputForEvent, ToolSchema } from "cc-hooks-ts";
export type { ExtractAllHookInputsForEvent, ExtractSpecificHookInputForEvent };

// Type aliases for commonly used cc-hooks-ts types
export type PermissionDecision = "allow" | "deny" | "ask";
export type BuiltinToolName = ExtractAllHookInputsForEvent<"PreToolUse">["tool_name"];
export type MCPToolName = `mcp__${string}__${string}`;
export type ToolName = BuiltinToolName | MCPToolName;
export type ToolInput = Record<string, unknown>;

export type PreToolUseHookInput = {
  [K in keyof ToolSchema]: {
    tool_name: K;
    tool_input: ToolSchema[K]["input"];
  }
};

export type PostToolUseHookInput = {
  [K in keyof ToolSchema]: {
    tool_name: K;
    tool_input: ToolSchema[K]["input"];
    tool_response: ToolSchema[K]["response"];
  }
};

// Define PreToolUseHookOutput locally since it's not exported from cc-hooks-ts
export interface PreToolUseHookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

// Union types for hook inputs (for backward compatibility)
export type HookInput = 
  | ExtractAllHookInputsForEvent<"PreToolUse">
  | ExtractAllHookInputsForEvent<"PostToolUse">;

export type StopHookInput = ExtractAllHookInputsForEvent<"Stop"> | ExtractAllHookInputsForEvent<"SubagentStop">;

/**
 * Structure of Claude settings files (.claude/settings.json)
 */
export interface SettingsFile {
  /** Permission configuration */
  permissions?: {
    /** Commands/patterns to auto-approve */
    allow?: string[];
    /** Commands/patterns to auto-deny */
    deny?: string[];
  };
  /** Other settings (logging, notifications, etc.) */
  [key: string]: unknown;
}

/**
 * Result of command analysis
 */
export interface CommandAnalysisResult {
  /** Final decision */
  decision: PermissionDecision;
  /** Reason for the decision */
  reason: string;
  /** Whether to exit early (for ask decisions) */
  exitEarly?: boolean;
  /** Pattern that matched (for deny decisions) */
  matchedPattern?: string;
}

/**
 * Pattern matching configuration
 */
export interface PatternMatchConfig {
  /** Patterns to check */
  patterns: string[];
  /** Whether to use exact matching */
  exact?: boolean;
  /** Whether patterns are case-sensitive */
  caseSensitive?: boolean;
}

/**
 * Command processing context
 */
export interface ProcessingContext {
  /** Current workspace root directory */
  workspaceRoot?: string | undefined;
  /** Available settings files */
  settingsFiles: string[];
  /** Allow patterns from settings */
  allowPatterns: string[];
  /** Deny patterns from settings */
  denyPatterns: string[];
}

/**
 * Dangerous command detection result
 */
export interface DangerousCommandResult {
  /** Whether command is dangerous */
  isDangerous: boolean;
  /** Reason why command is dangerous */
  reason?: string;
  /** Whether manual review is required */
  requiresManualReview?: boolean;
}

/**
 * Log entry for command approvals
 */
export interface CommandLogEntry {
  /** Timestamp of the decision */
  timestamp: string;
  /** Command that was processed */
  command: string;
  /** Decision made */
  decision: PermissionDecision;
  /** Reason for the decision */
  reason: string;
  /** Tool name */
  toolName: string;
}

/**
 * File system operation types for path validation
 */
export type FileOperation = "read" | "write" | "execute" | "delete";

/**
 * Path validation result
 */
export interface PathValidationResult {
  /** Whether path is allowed */
  isAllowed: boolean;
  /** Reason if not allowed */
  reason?: string;
  /** Resolved absolute path */
  resolvedPath?: string;
}

// Command logging interfaces
export interface LogEntry {
  timestamp: string;
  command_id: string;
  duration_ms: number;
  command: string;
  description: string;
}

export interface PendingCommand {
  command_id: string;
  command: string;
  description: string;
  timestamp_ns: number;
}

// ツール入力の型定義（中央ログマネージャー用）
export interface BashToolInput {
  command?: string;
  description?: string;
}

export interface FileToolInput {
  file_path?: string;
}

// 型ガード関数
export function isBashToolInput(tool_name: string, tool_input: unknown): tool_input is BashToolInput {
  return tool_name === "Bash" && typeof tool_input === "object" && tool_input !== null;
}

export function isFileToolInput(tool_name: string, tool_input: unknown): tool_input is FileToolInput {
  return ["Edit", "MultiEdit", "Write"].includes(tool_name) && typeof tool_input === "object" && tool_input !== null;
}