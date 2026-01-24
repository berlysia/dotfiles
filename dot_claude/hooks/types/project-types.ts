/**
 * Project-specific type definitions for Claude Code hook scripts
 *
 * This file contains types that are specific to this project's hook implementations.
 * Basic Hook API types are now imported from cc-hooks-ts library.
 *
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 */

// Re-export types from cc-hooks-ts for convenience
import type {
  ExtractAllHookInputsForEvent,
  ExtractSpecificHookInputForEvent,
  ToolSchema,
} from "cc-hooks-ts";
// Import module augmentation for custom tool types (MultiEdit, etc.)
import "./tool-schemas.ts";
/** @public Re-exported from cc-hooks-ts for convenience */
export type { ExtractAllHookInputsForEvent, ExtractSpecificHookInputForEvent };

// Type aliases for commonly used cc-hooks-ts types
export type PermissionDecision = "allow" | "deny" | "ask" | "pass";
/** @public Type alias for built-in tool names */
export type BuiltinToolName =
  ExtractAllHookInputsForEvent<"PreToolUse">["tool_name"];
/** @public Type pattern for MCP tool names */
export type MCPToolName = `mcp__${string}__${string}`;
/** @public Union type for all tool names */
export type ToolName = BuiltinToolName | MCPToolName;
export type ToolInput = Record<string, unknown>;

// Define PreToolUseHookOutput locally since it's not exported from cc-hooks-ts
// Note: permissionDecision is restricted to cc-hooks-ts supported values (excludes "pass")
export interface PreToolUseHookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "ask" | "deny";
    permissionDecisionReason: string;
  };
}

// Union types for hook inputs (for backward compatibility)
/** @public Union type for hook inputs (backward compatibility) */
export type HookInput =
  | ExtractAllHookInputsForEvent<"PreToolUse">
  | ExtractAllHookInputsForEvent<"PostToolUse">;

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

// ツール入力の型定義（中央ログマネージャー用）
export interface BashToolInput {
  command?: string;
  description?: string;
}

export interface FileToolInput {
  file_path?: string;
}

// Note: Tool input types are now imported from cc-hooks-ts ToolSchema
// Use ToolSchema["ToolName"]["input"] for type-safe tool inputs

// 型ガード関数
export function isBashToolInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is BashToolInput {
  return (
    tool_name === "Bash" &&
    typeof tool_input === "object" &&
    tool_input !== null
  );
}

export function isFileToolInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is FileToolInput {
  return (
    ["Edit", "MultiEdit", "Write"].includes(tool_name) &&
    typeof tool_input === "object" &&
    tool_input !== null
  );
}

// More precise tool-specific input guards (using ToolSchema types)
export function isWriteInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is import("cc-hooks-ts").ToolSchema["Write"]["input"] {
  return (
    tool_name === "Write" &&
    typeof tool_input === "object" &&
    tool_input !== null &&
    "file_path" in tool_input
  );
}

export function isEditInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is import("cc-hooks-ts").ToolSchema["Edit"]["input"] {
  return (
    tool_name === "Edit" &&
    typeof tool_input === "object" &&
    tool_input !== null &&
    "file_path" in tool_input
  );
}

export function isMultiEditInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is import("cc-hooks-ts").ToolSchema["MultiEdit"]["input"] {
  return (
    tool_name === "MultiEdit" &&
    typeof tool_input === "object" &&
    tool_input !== null &&
    "file_path" in tool_input
  );
}

export function isNotebookEditInput(
  tool_name: string,
  tool_input: unknown,
): tool_input is import("cc-hooks-ts").ToolSchema["NotebookEdit"]["input"] {
  return (
    tool_name === "NotebookEdit" &&
    typeof tool_input === "object" &&
    tool_input !== null &&
    "notebook_path" in tool_input
  );
}
