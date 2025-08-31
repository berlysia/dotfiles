/**
 * 中央ログマネージャー
 * Hook実装で使用する統一ログ機能
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { 
  LogEntry, 
  LogCategory, 
  LogManagerConfig,
  EventLogEntry,
  CommandLogEntry,
  ToolLogEntry,
  DecisionLogEntry,
  BaseLogEntry
} from "../types/logging-types.ts";

const DEFAULT_CONFIG: LogManagerConfig = {
  logDir: join(homedir(), ".claude", "logs"),
  maxLines: 1000,
  rotateBackups: 5
};

class CentralizedLogger {
  private config: LogManagerConfig;

  constructor(config: Partial<LogManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  private getLogFilePath(category: LogCategory): string {
    return join(this.config.logDir, `${category}.jsonl`);
  }

  private createBaseEntry(): BaseLogEntry {
    return {
      timestamp: new Date().toISOString(),
      user: process.env.USER || "unknown",
      cwd: process.cwd()
    };
  }

  private writeLog(category: LogCategory, entry: LogEntry): void {
    const logFile = this.getLogFilePath(category);
    const logLine = JSON.stringify(entry) + "\n";

    try {
      appendFileSync(logFile, logLine);
      this.rotateLogIfNeeded(category);
    } catch (error) {
      console.error(`Failed to write to ${category} log: ${error}`);
    }
  }

  private writeClaudeCompanionLog(entry: EventLogEntry): void {
    const logFile = join(homedir(), ".config", "claude-companion", "logs", "hooks.jsonl");
    const logLine = JSON.stringify(entry) + "\n";
    
    try {
      // Ensure directory exists
      const logDir = join(homedir(), ".config", "claude-companion", "logs");
      mkdirSync(logDir, { recursive: true });
      
      appendFileSync(logFile, logLine);
    } catch (error) {
      console.error(`Failed to write to claude-companion log: ${error}`);
    }
  }

  private rotateLogIfNeeded(category: LogCategory): void {
    const logFile = this.getLogFilePath(category);
    
    try {
      if (!existsSync(logFile)) return;

      const content = readFileSync(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      if (lines.length > this.config.maxLines) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupFile = `${logFile}.${timestamp}`;
        
        renameSync(logFile, backupFile);
        this.cleanOldBackups(category);
      }
    } catch (error) {
      console.error(`Failed to rotate ${category} log: ${error}`);
    }
  }

  private cleanOldBackups(category: LogCategory): void {
    const logFile = this.getLogFilePath(category);
    const logDir = dirname(logFile);
    const baseName = basename(logFile);

    try {
      const files = readdirSync(logDir)
        .filter(file => file.startsWith(`${baseName}.`))
        .map(file => ({
          name: file,
          path: join(logDir, file),
          mtime: statSync(join(logDir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime);

      // Keep only the latest backups
      files.slice(this.config.rotateBackups).forEach(file => {
        try {
          unlinkSync(file.path);
        } catch (error) {
          console.error(`Failed to clean backup ${file.name}: ${error}`);
        }
      });
    } catch (error) {
      console.error(`Failed to clean backups for ${category}: ${error}`);
    }
  }

  /**
   * イベントログを記録
   */
  logEvent(
    event: EventLogEntry['event'], 
    sessionId?: string, 
    message?: string
  ): void {
    const entry: EventLogEntry = {
      ...this.createBaseEntry(),
      event,
      ...(sessionId && { session_id: sessionId }),
      ...(message && { message })
    };

    this.writeLog('events', entry);
    
    // claude-companionプロジェクトとの互換性のため、デュアル書き込み
    this.writeClaudeCompanionLog(entry);
  }

  /**
   * コマンドログを記録
   */
  logCommand(
    command: string,
    sessionId?: string,
    description?: string,
    exitCode?: number
  ): void {
    const entry: CommandLogEntry = {
      ...this.createBaseEntry(),
      tool_name: 'Bash',
      command: command.replace(/\n/g, "\\n"), // Escape newlines
      ...(sessionId && { session_id: sessionId }),
      ...(description && { description }),
      ...(exitCode !== undefined && { exit_code: exitCode })
    };

    this.writeLog('commands', entry);
  }

  /**
   * ツール使用ログを記録
   */
  logTool(
    toolName: string,
    sessionId?: string,
    filePath?: string,
    description?: string
  ): void {
    const entry: ToolLogEntry = {
      ...this.createBaseEntry(),
      tool_name: toolName,
      ...(sessionId && { session_id: sessionId }),
      ...(filePath && { file_path: filePath }),
      ...(description && { description })
    };

    this.writeLog('tools', entry);
  }

  /**
   * 決定ログを記録
   */
  logDecision(
    toolName: string,
    decision: DecisionLogEntry['decision'],
    reason: string,
    sessionId?: string,
    command?: string,
    input?: any
  ): void {
    const entry: DecisionLogEntry = {
      ...this.createBaseEntry(),
      tool_name: toolName,
      decision,
      reason,
      ...(sessionId && { session_id: sessionId }),
      ...(command && { command }),
      ...(input && { input })
    };

    this.writeLog('decisions', entry);
  }

}

// シングルトンインスタンス
let loggerInstance: CentralizedLogger | null = null;

/**
 * グローバルログマネージャーインスタンスを取得
 */
export function getLogger(config?: Partial<LogManagerConfig>): CentralizedLogger {
  if (!loggerInstance) {
    loggerInstance = new CentralizedLogger(config);
  }
  return loggerInstance;
}

/**
 * 便利関数：イベントログ
 */
export function logEvent(
  event: EventLogEntry['event'], 
  sessionId?: string, 
  message?: string
): void {
  getLogger().logEvent(event, sessionId, message);
}

/**
 * 便利関数：コマンドログ
 */
export function logCommand(
  command: string,
  sessionId?: string,
  description?: string,
  exitCode?: number
): void {
  getLogger().logCommand(command, sessionId, description, exitCode);
}

/**
 * 便利関数：ツールログ
 */
export function logTool(
  toolName: string,
  sessionId?: string,
  filePath?: string,
  description?: string
): void {
  getLogger().logTool(toolName, sessionId, filePath, description);
}

/**
 * 便利関数：決定ログ
 */
export function logDecision(
  toolName: string,
  decision: DecisionLogEntry['decision'],
  reason: string,
  sessionId?: string,
  command?: string,
  input?: any
): void {
  getLogger().logDecision(toolName, decision, reason, sessionId, command, input);
}

