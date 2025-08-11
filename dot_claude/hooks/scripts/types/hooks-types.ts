/**
 * Type definitions for Claude Code hook scripts
 * 
 * These types define the interfaces for JSON input/output
 * used in Claude Code's hook system for permission management.
 */

export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Input structure received by hook scripts from Claude Code
 */
export interface HookInput {
  /** Name of the tool being invoked (e.g., "Bash", "Read", "Write") */
  tool_name: string;
  /** Tool-specific parameters and arguments */
  tool_input: ToolInput;
  /** Session identifier for command correlation */
  session_id?: string;
}

/**
 * Input structure for Stop/SubagentStop hooks
 */
export interface StopHookInput {
  /** Session identifier */
  session_id: string;
  /** Path to transcript file */
  transcript_path: string;
  /** Hook event name */
  hook_event_name: "Stop" | "SubagentStop";
  /** Whether stop hook is already active */
  stop_hook_active: boolean;
}

/**
 * Tool input parameters - varies by tool type
 */
export interface ToolInput {
  /** For Bash tool: command to execute */
  command?: string;
  /** For file operations: file path */
  file_path?: string;
  /** For file operations: content to write */
  content?: string;
  /** Additional tool-specific parameters */
  [key: string]: unknown;
}

/**
 * Output structure that hooks must return to Claude Code
 */
export interface HookOutput {
  hookSpecificOutput: HookSpecificOutput;
}

/**
 * Hook-specific output with permission decision
 */
export interface HookSpecificOutput {
  /** Event type - currently only PreToolUse is supported */
  hookEventName: "PreToolUse";
  /** Permission decision for the requested tool use */
  permissionDecision: PermissionDecision;
  /** Human-readable reason for the decision */
  permissionDecisionReason: string;
}

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