#!/usr/bin/env node

/**
 * Claude Companion Detector Tests
 * claude-companion検出機能のユニットテスト
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import type { ClaudeCompanionStatus } from "../../../lib/claude-companion-detector.ts";
import {
  getDaemonPidFilePath,
  parseDaemonPidFile,
  isProcessRunning,
  checkHealthEndpoint,
  checkClaudeCompanionStatus,
} from "../../../lib/claude-companion-detector.ts";

describe("Claude Companion Detector", () => {
  const originalEnvHome = process.env.HOME;

  beforeEach(() => {
    // テスト用のHOME環境変数を設定
    process.env.HOME = "/tmp/test-claude-companion";

    // テスト用のdaemon.pidファイルを作成
    const pidDir = dirname(getDaemonPidFilePath());
    if (!existsSync(pidDir)) {
      mkdirSync(pidDir, { recursive: true });
    }
  });

  afterEach(() => {
    // テストファイルをクリーンアップ（HOME変更前に）
    const pidPath = getDaemonPidFilePath();
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }

    // 環境変数を復元
    process.env.HOME = originalEnvHome;

    // テストディレクトリをクリーンアップ
    const testDir = "/tmp/test-claude-companion";
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("getDaemonPidFilePath", () => {
    it("should return correct daemon.pid file path", () => {
      const expected = `/tmp/test-claude-companion/.config/claude-companion/logs/daemon.pid`;
      assert.strictEqual(getDaemonPidFilePath(), expected);
    });
  });

  describe("parseDaemonPidFile", () => {
    it("should return null if file does not exist", () => {
      const result = parseDaemonPidFile();
      assert.strictEqual(result, null);
    });

    it("should parse valid daemon.pid file", () => {
      const pidData = {
        pid: 12345,
        port: 3000,
        startTime: "2025-09-04T19:17:09.015Z",
        webUIEnabled: true,
      };

      writeFileSync(getDaemonPidFilePath(), JSON.stringify(pidData));

      const result = parseDaemonPidFile();
      assert.deepStrictEqual(result, pidData);
    });

    it("should return null for invalid JSON", () => {
      writeFileSync(getDaemonPidFilePath(), "invalid json");
      const result = parseDaemonPidFile();
      assert.strictEqual(result, null);
    });

    it("should return null for empty file", () => {
      writeFileSync(getDaemonPidFilePath(), "");
      const result = parseDaemonPidFile();
      assert.strictEqual(result, null);
    });
  });

  describe("isProcessRunning", () => {
    it("should return true for current process", async () => {
      const currentPid = process.pid;
      const result = await isProcessRunning(currentPid);
      assert.strictEqual(result, true);
    });

    it("should return false for non-existent process", async () => {
      // 存在しないPIDを使用（通常999999は存在しない）
      const result = await isProcessRunning(999999);
      assert.strictEqual(result, false);
    });
  });

  describe("checkClaudeCompanionStatus", () => {
    it("should return not running when daemon.pid file does not exist", async () => {
      const result = await checkClaudeCompanionStatus();

      assert.strictEqual(result.isRunning, false);
      assert.strictEqual(result.error, "daemon.pid file not found");
    });

    it("should return not running when process does not exist", async () => {
      const pidData = {
        pid: 999999, // 存在しないPID
        port: 3000,
        startTime: "2025-09-04T19:17:09.015Z",
        webUIEnabled: true,
      };

      writeFileSync(getDaemonPidFilePath(), JSON.stringify(pidData));

      const result = await checkClaudeCompanionStatus();

      assert.strictEqual(result.isRunning, false);
      assert.strictEqual(result.pid, 999999);
      assert.strictEqual(result.port, 3000);
      assert.ok(result.error?.includes("Process 999999 not running"));
    });

    it("should include all daemon.pid data in result when health check fails", async () => {
      const pidData = {
        pid: process.pid, // 現在のプロセスのPIDを使用
        port: 9999, // 存在しないポート
        startTime: "2025-09-04T19:17:09.015Z",
        webUIEnabled: true,
      };

      writeFileSync(getDaemonPidFilePath(), JSON.stringify(pidData));

      const result = await checkClaudeCompanionStatus();

      // プロセスは存在するが、ヘルスチェックが失敗するはず
      assert.strictEqual(result.isRunning, false);
      assert.strictEqual(result.pid, process.pid);
      assert.strictEqual(result.port, 9999);
      assert.strictEqual(result.startTime, "2025-09-04T19:17:09.015Z");
      assert.strictEqual(result.webUIEnabled, true);
      assert.ok(result.error?.includes("Health check failed on port 9999"));
    });
  });
});
