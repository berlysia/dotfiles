/**
 * 中央ログマネージャー用の型定義
 */
import type { PermissionDecision } from "./project-types.ts";

export interface BaseLogEntry {
  timestamp: string;
  user: string;
  cwd: string;
  session_id?: string;
}

export interface EventLogEntry extends BaseLogEntry {
  event:
    | "SessionStart"
    | "UserPromptSubmit"
    | "Notification"
    | "PermissionRequest"
    | "Stop"
    | "Error";
  message?: string;
}

export interface CommandLogEntry extends BaseLogEntry {
  tool_name: "Bash";
  command: string;
  description?: string;
  exit_code?: number;
}

export interface ToolLogEntry extends BaseLogEntry {
  tool_name: "Edit" | "MultiEdit" | "Write" | string;
  file_path?: string;
  description?: string;
}

export interface DecisionLogEntry extends BaseLogEntry {
  tool_name: string;
  decision: PermissionDecision;
  reason: string;
  input?: Record<string, unknown> | null;
}

export interface QualityLogEntry extends BaseLogEntry {
  source: "quality-loop" | "completion-gate";
  lint_tool: string;
  error_output: string;
  file_path?: string;
}

export interface ReflectionEntry {
  error_summary: string;
  root_cause: string;
  preventable_by_lint: boolean;
  suggested_rule?: {
    type: "custom-rule" | "oxlint-config" | "oxfmt-config" | "eslint-plugin";
    description: string;
    pattern_hint?: string;
  };
}

export interface ReflectionLogEntry extends BaseLogEntry {
  errors_analyzed: number;
  reflections: ReflectionEntry[];
}

export type LogEntry =
  | EventLogEntry
  | CommandLogEntry
  | ToolLogEntry
  | DecisionLogEntry
  | QualityLogEntry
  | ReflectionLogEntry;

export type LogCategory =
  | "events"
  | "commands"
  | "tools"
  | "decisions"
  | "quality"
  | "reflections";

export interface LogManagerConfig {
  logDir: string;
  maxLines: number;
  rotateBackups: number;
  /** Rotation interval in days. If set, rotates when oldest entry is older than this. */
  rotateIntervalDays?: number;
}
