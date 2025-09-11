/**
 * Claude Companion Detector
 * claude-companionの実行状態を検出するユーティリティ
 */

import { existsSync, readFileSync } from "fs";
import { $ } from "dax-sh";

export interface ClaudeCompanionStatus {
  isRunning: boolean;
  pid?: number;
  port?: number;
  startTime?: string;
  webUIEnabled?: boolean;
  error?: string;
}

interface DaemonPidFile {
  pid: number;
  port: number;
  startTime: string;
  webUIEnabled: boolean;
}

/**
 * daemon.pidファイルのパスを取得
 */
export function getDaemonPidFilePath(): string {
  return `${process.env.HOME}/.config/claude-companion/logs/daemon.pid`;
}

/**
 * daemon.pidファイルを読み取り、解析する
 */
export function parseDaemonPidFile(): DaemonPidFile | null {
  const pidFilePath = getDaemonPidFilePath();

  if (!existsSync(pidFilePath)) {
    return null;
  }

  try {
    const content = readFileSync(pidFilePath, "utf-8").trim();
    return JSON.parse(content) as DaemonPidFile;
  } catch {
    return null;
  }
}

/**
 * プロセスIDが実際に実行中かをチェック
 */
export async function isProcessRunning(pid: number): Promise<boolean> {
  try {
    // ps コマンドでプロセスの存在を確認
    const result = await $`ps -p ${pid}`.quiet();
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * ヘルスチェックエンドポイントの確認
 */
export async function checkHealthEndpoint(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000), // 3秒タイムアウト
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return (data as { status?: string })?.status === "ok";
  } catch {
    return false;
  }
}

/**
 * claude-companionの実行状態を総合的にチェック
 */
export async function checkClaudeCompanionStatus(): Promise<ClaudeCompanionStatus> {
  try {
    // daemon.pidファイルの読み取り
    const pidData = parseDaemonPidFile();
    if (!pidData) {
      return {
        isRunning: false,
        error: "daemon.pid file not found",
      };
    }

    // プロセスの存在確認
    const processExists = await isProcessRunning(pidData.pid);
    if (!processExists) {
      return {
        isRunning: false,
        pid: pidData.pid,
        port: pidData.port,
        startTime: pidData.startTime,
        webUIEnabled: pidData.webUIEnabled,
        error: `Process ${pidData.pid} not running`,
      };
    }

    // ヘルスチェック
    const healthOk = await checkHealthEndpoint(pidData.port);
    if (!healthOk) {
      return {
        isRunning: false,
        pid: pidData.pid,
        port: pidData.port,
        startTime: pidData.startTime,
        webUIEnabled: pidData.webUIEnabled,
        error: `Health check failed on port ${pidData.port}`,
      };
    }

    // すべてのチェックが通った場合
    return {
      isRunning: true,
      pid: pidData.pid,
      port: pidData.port,
      startTime: pidData.startTime,
      webUIEnabled: pidData.webUIEnabled,
    };
  } catch (error) {
    return {
      isRunning: false,
      error: `Unexpected error: ${error}`,
    };
  }
}
