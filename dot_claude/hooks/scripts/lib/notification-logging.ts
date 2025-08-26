import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';

export interface HookLogEntry {
  timestamp: string;
  event: string;
  session_id?: string;
  user: string;
  cwd: string;
  [key: string]: any; // 追加フィールドも許可
}

// ログファイルパス
export function getLogFilePath(): string {
  return path.join(homedir(), '.config/claude-companion/logs/hooks.jsonl');
}

// ログディレクトリの作成
export async function ensureLogDir(): Promise<void> {
  const logFile = getLogFilePath();
  const logDir = path.dirname(logFile);
  await fs.mkdir(logDir, { recursive: true });
}

// 互換性のあるログエントリ作成（既存のnotification.tsと同じ構造）
export async function logEvent(
  eventType: string,
  sessionId?: string,
  additionalData?: Record<string, any>
): Promise<void> {
  const entry: HookLogEntry = {
    timestamp: new Date().toISOString(),
    event: eventType,
    session_id: sessionId,
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    ...additionalData
  };
  
  try {
    await ensureLogDir();
    const logFile = getLogFilePath();
    await fs.appendFile(logFile, JSON.stringify(entry) + '\n');
  } catch (error) {
    // エラーは握りつぶす（既存の動作と同じ）
    console.error(`Failed to log event: ${error}`);
  }
}

// 統計情報の取得
export async function getEventStats(): Promise<Record<string, number>> {
  try {
    const logFile = getLogFilePath();
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    const stats: Record<string, number> = {};
    
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HookLogEntry;
        stats[entry.event] = (stats[entry.event] || 0) + 1;
      } catch {
        // 不正なJSONは無視
      }
    }
    
    return stats;
  } catch {
    return {};
  }
}

// 最近のイベントを取得
export async function getRecentEvents(limit = 10): Promise<HookLogEntry[]> {
  try {
    const logFile = getLogFilePath();
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    const events: HookLogEntry[] = [];
    
    // 最後のN件を取得
    for (const line of lines.slice(-limit)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // 不正なJSONは無視
      }
    }
    
    return events;
  } catch {
    return [];
  }
}

// ログファイルのローテーション
export async function rotateLogIfNeeded(maxLines = 1000): Promise<void> {
  try {
    const logFile = getLogFilePath();
    const content = await fs.readFile(logFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    
    if (lines.length > maxLines) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFile = `${logFile}.${timestamp}`;
      
      // バックアップを作成
      await fs.rename(logFile, backupFile);
      
      // 古いバックアップファイルのクリーンアップ（最新5つまで保持）
      await cleanOldBackups();
    }
  } catch {
    // ローテーション失敗は無視
  }
}

// 古いバックアップファイルのクリーンアップ
export async function cleanOldBackups(): Promise<void> {
  try {
    const logFile = getLogFilePath();
    const logDir = path.dirname(logFile);
    const baseName = path.basename(logFile);
    
    const files = await fs.readdir(logDir);
    const backupFiles = files
      .filter(file => file.startsWith(`${baseName}.`))
      .map(file => ({
        name: file,
        path: path.join(logDir, file),
        mtime: 0 // statで取得
      }));
    
    // 各ファイルのmtimeを取得
    for (const file of backupFiles) {
      try {
        const stat = await fs.stat(file.path);
        file.mtime = stat.mtime.getTime();
      } catch {
        // statに失敗したファイルは削除対象に
        file.mtime = 0;
      }
    }
    
    // 新しい順にソートして、5つを超える古いファイルを削除
    backupFiles
      .sort((a, b) => b.mtime - a.mtime)
      .slice(5)
      .forEach(file => {
        fs.unlink(file.path).catch(() => {});
      });
  } catch {
    // クリーンアップ失敗は無視
  }
}