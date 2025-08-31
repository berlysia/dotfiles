/**
 * Type definitions index for Claude Code hook scripts
 * 
 * This file provides a single entry point for importing both
 * cc-hooks-ts library types and project-specific types.
 */

// Re-export cc-hooks-ts types (only actually exported types)
export type {
  ExtractAllHookInputsForEvent,
  ExtractSpecificHookInputForEvent,
  ToolSchema
} from "cc-hooks-ts";

// Re-export project-specific types
export type {
  PermissionDecision,
  ToolInput,
  SettingsFile,
  CommandAnalysisResult,
  PatternMatchConfig,
  ProcessingContext,
  DangerousCommandResult,
  CommandLogEntry,
  FileOperation,
  PathValidationResult,
  LogEntry,
  PendingCommand
} from "./project-types.ts";