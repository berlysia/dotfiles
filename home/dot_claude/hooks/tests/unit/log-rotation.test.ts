#!/usr/bin/env node

/**
 * Log Rotation Tests
 * ログローテーション機能のテスト
 */

import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUnifiedVoiceConfig } from "../../../lib/unified-audio-config.ts";
import { logMessage } from "../../../lib/unified-audio-engine.ts";

describe("Log Rotation", () => {
  const testDir = "/tmp/test-log-rotation";
  const testLogDir = join(testDir, ".claude", "log");
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = testDir;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("logMessage with rotation", () => {
    it("should write log messages normally when under size limit", () => {
      const config = createUnifiedVoiceConfig();

      logMessage("Test message 1", config);
      logMessage("Test message 2", config);

      const content = readFileSync(config.paths.logFile, "utf-8");
      assert.ok(content.includes("Test message 1"));
      assert.ok(content.includes("Test message 2"));
    });

    it("should rotate log when exceeding 1MB", () => {
      const config = createUnifiedVoiceConfig();
      const logFile = config.paths.logFile;

      // Create a log file larger than 1MB (1.5MB)
      const largeContent = `${"X".repeat(1024)}\n`;
      const lines = Array(1500).fill(largeContent).join("");
      writeFileSync(logFile, lines);

      const sizeBefore = statSync(logFile).size;
      assert.ok(
        sizeBefore > 1024 * 1024,
        "Log should be larger than 1MB before rotation",
      );

      // Trigger rotation by logging a new message
      logMessage("New message after rotation", config);

      const sizeAfter = statSync(logFile).size;
      assert.ok(sizeAfter < sizeBefore, "Log should be smaller after rotation");

      const content = readFileSync(logFile, "utf-8");
      assert.ok(
        content.includes("New message after rotation"),
        "New message should be present",
      );
    });

    it("should retain recent lines after rotation", () => {
      const config = createUnifiedVoiceConfig();
      const logFile = config.paths.logFile;

      // Create lines with identifiable content
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(
          `[2025-01-01T00:00:00.000Z] Line ${i.toString().padStart(4, "0")}`,
        );
      }
      // Add extra content to exceed 1MB
      const extraPadding = "X".repeat(500);
      const paddedLines = lines.map((line) => line + extraPadding);
      writeFileSync(logFile, `${paddedLines.join("\n")}\n`);

      // Trigger rotation
      logMessage("Final message", config);

      const content = readFileSync(logFile, "utf-8");
      const resultLines = content.split("\n").filter((l) => l.trim());

      // Should retain approximately 1000 lines plus the new message
      assert.ok(
        resultLines.length <= 1100,
        `Should have ~1000 lines, got ${resultLines.length}`,
      );
      assert.ok(
        content.includes("Final message"),
        "New message should be present",
      );
      // Should retain recent lines (higher numbers)
      assert.ok(content.includes("Line 1999"), "Should retain recent lines");
    });

    it("should not rotate when under size limit", () => {
      const config = createUnifiedVoiceConfig();
      const logFile = config.paths.logFile;

      // Create a small log file
      const smallContent = "Small log entry\n".repeat(100);
      writeFileSync(logFile, smallContent);

      const sizeBefore = statSync(logFile).size;

      logMessage("New message", config);

      const content = readFileSync(logFile, "utf-8");
      const lineCount = content.split("\n").filter((l) => l.trim()).length;

      // Should have all original lines plus the new one
      assert.strictEqual(lineCount, 101);
    });

    it("should handle empty log file gracefully", () => {
      const config = createUnifiedVoiceConfig();

      // Don't create the file, let logMessage create it
      logMessage("First message", config);

      assert.ok(existsSync(config.paths.logFile));
      const content = readFileSync(config.paths.logFile, "utf-8");
      assert.ok(content.includes("First message"));
    });
  });
});
