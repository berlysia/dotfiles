/**
 * Type definitions for Claude Code hook scripts
 * 
 * These types define the interfaces for JSON input/output
 * used in Claude Code's hook system. Based on official Claude Code documentation.
 * 
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 */

/**
 * Common hook input structure - shared across all hook events
 */
export interface BaseHookInput {
  /** Session identifier for command correlation */
  session_id: string;
  /** Path to transcript file */
  transcript_path: string;
  /** Current working directory when the hook is invoked */
  cwd: string;
  /** Name of the hook event */
  hook_event_name: string;
}

/**
 * Input structure for PreToolUse hooks
 */
export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  /** Name of the tool being invoked (e.g., "Bash", "Read", "Write") */
  tool_name: string;
  /** Tool-specific parameters and arguments */
  tool_input: ToolInput;
}

/**
 * Input structure for PostToolUse hooks
 */
export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  /** Name of the tool that was executed */
  tool_name: string;
  /** Tool input parameters */
  tool_input: ToolInput;
  /** Response from the tool execution */
  tool_response: Record<string, unknown>;
}

/**
 * Input structure for Stop/SubagentStop hooks
 */
export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop" | "SubagentStop";
  /** Whether stop hook is already active */
  stop_hook_active: boolean;
}

/**
 * Input structure for UserPromptSubmit hooks
 */
export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  /** User's submitted prompt text */
  prompt: string;
}

/**
 * Input structure for Notification hooks
 */
export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: "Notification";
  /** Notification message */
  message: string;
}

/**
 * Input structure for PreCompact hooks
 */
export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: "PreCompact";
  /** How the compaction was triggered */
  trigger: "manual" | "auto";
  /** Instructions from /compact command */
  custom_instructions: string;
}

/**
 * Input structure for SessionStart hooks
 */
export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  /** How the session was started */
  source: "startup" | "resume" | "clear" | "compact";
}

/**
 * Input structure for SessionEnd hooks
 */
export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
  /** Reason for session end */
  reason: "clear" | "logout" | "prompt_input_exit" | "other";
}

/**
 * Union type for all hook input types
 */
export type HookInput = 
  | PreToolUseHookInput
  | PostToolUseHookInput
  | StopHookInput
  | UserPromptSubmitHookInput
  | NotificationHookInput
  | PreCompactHookInput
  | SessionStartHookInput
  | SessionEndHookInput;

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
 * Permission decision for PreToolUse hooks
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Common hook output fields available for all hook types
 */
export interface BaseHookOutput {
  /** Whether Claude should continue after hook execution (default: true) */
  continue?: boolean;
  /** Message shown when continue is false */
  stopReason?: string;
  /** Hide stdout from transcript mode (default: false) */
  suppressOutput?: boolean;
  /** Optional warning message shown to the user */
  systemMessage?: string;
}

/**
 * Hook-specific output for PreToolUse hooks
 */
export interface PreToolUseHookSpecificOutput {
  hookEventName: "PreToolUse";
  /** Permission decision for the requested tool use */
  permissionDecision: PermissionDecision;
  /** Human-readable reason for the decision */
  permissionDecisionReason: string;
}

/**
 * Hook-specific output for PostToolUse hooks
 */
export interface PostToolUseHookSpecificOutput {
  hookEventName: "PostToolUse";
  /** Additional context for Claude to consider */
  additionalContext?: string;
}

/**
 * Hook-specific output for UserPromptSubmit hooks
 */
export interface UserPromptSubmitHookSpecificOutput {
  hookEventName: "UserPromptSubmit";
  /** Additional context added to the prompt if not blocked */
  additionalContext?: string;
}

/**
 * Hook-specific output for SessionStart hooks
 */
export interface SessionStartHookSpecificOutput {
  hookEventName: "SessionStart";
  /** Additional context added to the session start */
  additionalContext?: string;
}

/**
 * Union type for all hook-specific outputs
 */
export type HookSpecificOutput = 
  | PreToolUseHookSpecificOutput
  | PostToolUseHookSpecificOutput
  | UserPromptSubmitHookSpecificOutput
  | SessionStartHookSpecificOutput;

/**
 * Output structure for PreToolUse hooks
 */
export interface PreToolUseHookOutput extends BaseHookOutput {
  hookSpecificOutput?: PreToolUseHookSpecificOutput;
  /** @deprecated Use hookSpecificOutput.permissionDecision instead */
  decision?: "approve" | "block";
  /** @deprecated Use hookSpecificOutput.permissionDecisionReason instead */
  reason?: string;
}

/**
 * Output structure for PostToolUse hooks
 */
export interface PostToolUseHookOutput extends BaseHookOutput {
  /** Control whether to provide feedback to Claude */
  decision?: "block";
  /** Explanation for the decision */
  reason?: string;
  hookSpecificOutput?: PostToolUseHookSpecificOutput;
}

/**
 * Output structure for UserPromptSubmit hooks
 */
export interface UserPromptSubmitHookOutput extends BaseHookOutput {
  /** Control whether to block the prompt */
  decision?: "block";
  /** Explanation for the decision */
  reason?: string;
  hookSpecificOutput?: UserPromptSubmitHookSpecificOutput;
}

/**
 * Output structure for Stop/SubagentStop hooks
 */
export interface StopHookOutput extends BaseHookOutput {
  /** Control whether to prevent Claude from stopping */
  decision?: "block";
  /** Must be provided when Claude is blocked from stopping */
  reason?: string;
}

/**
 * Output structure for SessionStart hooks
 */
export interface SessionStartHookOutput extends BaseHookOutput {
  hookSpecificOutput?: SessionStartHookSpecificOutput;
}

/**
 * Output structure for other hook types (Notification, PreCompact, SessionEnd)
 */
export interface SimpleHookOutput extends BaseHookOutput {}

/**
 * Union type for all hook output types
 */
export type HookOutput = 
  | PreToolUseHookOutput
  | PostToolUseHookOutput
  | UserPromptSubmitHookOutput
  | StopHookOutput
  | SessionStartHookOutput
  | SimpleHookOutput;

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