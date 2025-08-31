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
  event: 'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop';
  message?: string;
}

export interface CommandLogEntry extends BaseLogEntry {
  tool_name: 'Bash';
  command: string;
  description?: string;
  exit_code?: number;
}

export interface ToolLogEntry extends BaseLogEntry {
  tool_name: 'Edit' | 'MultiEdit' | 'Write' | string;
  file_path?: string;
  description?: string;
}

export interface DecisionLogEntry extends BaseLogEntry {
  tool_name: string;
  decision: PermissionDecision;
  reason: string;
  command?: string;
  input?: any;
}

export type LogEntry = EventLogEntry | CommandLogEntry | ToolLogEntry | DecisionLogEntry;

export type LogCategory = 'events' | 'commands' | 'tools' | 'decisions';

export interface LogManagerConfig {
  logDir: string;
  maxLines: number;
  rotateBackups: number;
}