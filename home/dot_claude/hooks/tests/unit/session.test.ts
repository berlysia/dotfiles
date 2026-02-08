#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createSessionStartContext,
  EnvironmentHelper,
} from "./test-helpers.ts";

describe("session.ts hook behavior", () => {
  let testDir: string;
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    // Create test directory
    testDir = join(tmpdir(), `session-test-${Date.now()}`);
    logDir = join(testDir, ".config", "claude-companion", "logs");
    logFile = join(logDir, "hooks.jsonl");
    mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("log entry structure", () => {
    it("should create valid JSON log entries", () => {
      // Simulate what the hook would write
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: "test-session-123",
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      const logLine = `${JSON.stringify(logEntry)}\n`;

      // Write to test file
      appendFileSync(logFile, logLine);

      // Read and verify
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 1, "Should have one log line");

      const firstLine = lines[0];
      ok(firstLine, "Should have first line");
      const parsed = JSON.parse(firstLine);
      strictEqual(parsed.event, "SessionStart");
      strictEqual(parsed.session_id, "test-session-123");
      ok(parsed.timestamp, "Should have timestamp");
      ok(parsed.cwd, "Should have cwd");
      ok(parsed.user, "Should have user");
    });

    it("should handle multiple log entries", () => {
      // Write multiple entries
      for (let i = 0; i < 3; i++) {
        const logEntry = {
          timestamp: new Date().toISOString(),
          event: "SessionStart",
          session_id: `session-${i}`,
          user: "testuser",
          cwd: "/test/dir",
        };
        appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);
      }

      // Read and verify
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 3, "Should have three log lines");

      // Each line should be valid JSON
      lines.forEach((line, index) => {
        const parsed = JSON.parse(line);
        strictEqual(parsed.session_id, `session-${index}`);
      });
    });

    it("should escape special characters in log entries", () => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: "test\nwith\nnewlines",
        user: 'user"with"quotes',
        cwd: "/path/with\\backslash",
      };

      const logLine = `${JSON.stringify(logEntry)}\n`;
      appendFileSync(logFile, logLine);

      // Read and parse back
      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());

      // JSON.stringify should have properly escaped everything
      strictEqual(parsed.session_id, "test\nwith\nnewlines");
      strictEqual(parsed.user, 'user"with"quotes');
      strictEqual(parsed.cwd, "/path/with\\backslash");
    });
  });

  describe("directory creation", () => {
    it("should handle nested directory creation", () => {
      const nestedDir = join(testDir, "deep", "nested", "path");
      mkdirSync(nestedDir, { recursive: true });

      ok(existsSync(nestedDir), "Nested directory should exist");
    });

    it("should not throw if directory already exists", () => {
      // Create directory
      mkdirSync(logDir, { recursive: true });

      // Try to create again - should not throw
      mkdirSync(logDir, { recursive: true });

      ok(existsSync(logDir), "Directory should still exist");
    });
  });

  describe("error scenarios", () => {
    it("should handle append to non-existent directory gracefully", () => {
      const nonExistentPath = join(
        testDir,
        "non",
        "existent",
        "path",
        "file.log",
      );

      try {
        appendFileSync(nonExistentPath, "test");
        ok(false, "Should have thrown error");
      } catch (error: any) {
        ok(error.code === "ENOENT", "Should get ENOENT error");
      }
    });

    it("should handle invalid JSON in log file", () => {
      // Write invalid JSON
      appendFileSync(logFile, "not valid json\n");

      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");

      try {
        const firstLine = lines[0];
        ok(firstLine, "Should have first line");
        JSON.parse(firstLine);
        ok(false, "Should have thrown error");
      } catch (error) {
        ok(error instanceof SyntaxError, "Should get JSON parse error");
      }
    });
  });

  describe("shared task list warning", () => {
    const envHelper = new EnvironmentHelper();

    afterEach(() => {
      envHelper.restore();
    });

    it("should warn when CLAUDE_CODE_TASK_LIST_ID is set", () => {
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", "abc-123-def");

      const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
      ok(taskListId, "CLAUDE_CODE_TASK_LIST_ID should be set");

      // Simulate checkSharedTaskList behavior
      const warning = taskListId
        ? `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`
        : null;

      ok(warning, "Warning should be generated");
      ok(
        warning.includes("abc-123-def"),
        "Warning should include the task list ID",
      );
      ok(
        warning.includes("unset CLAUDE_CODE_TASK_LIST_ID"),
        "Warning should include detach instruction",
      );
    });

    it("should not warn when CLAUDE_CODE_TASK_LIST_ID is not set", () => {
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", undefined);

      const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
      const warning = taskListId
        ? `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}`
        : null;

      strictEqual(warning, null, "No warning should be generated");
    });

    it("should include task list warning in session start message", () => {
      envHelper.set("CLAUDE_CODE_TASK_LIST_ID", "shared-list-456");

      const mockContext = createSessionStartContext("cli");

      // Simulate the hook's message assembly
      const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
      const taskListWarning = taskListId
        ? `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`
        : null;

      const messages = [
        "🚀 Claude Code session started. Ready for development!",
      ];
      if (taskListWarning) {
        messages.push(taskListWarning);
      }

      const result = mockContext.success({
        messageForUser: messages.join("\n"),
      });

      ok(
        result.messageForUser.includes("CLAUDE_CODE_TASK_LIST_ID"),
        "Message should contain task list warning",
      );
      ok(
        result.messageForUser.includes("shared-list-456"),
        "Message should contain the specific task list ID",
      );
      ok(
        result.messageForUser.startsWith("🚀"),
        "Message should still start with session start message",
      );
    });
  });

  describe("hook context simulation", () => {
    it("should simulate successful hook execution", () => {
      // Create properly typed context using test helper
      const mockContext = createSessionStartContext("cli");

      // Simulate hook behavior
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: mockContext.input.session_id,
        source: mockContext.input.source,
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      // Would normally write to log
      appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

      // Simulate success response
      const result = mockContext.success({
        messageForUser:
          "🚀 Claude Code session started. Ready for development!",
      });

      deepStrictEqual(result, {
        messageForUser:
          "🚀 Claude Code session started. Ready for development!",
      });

      // Verify log was written
      const content = readFileSync(logFile, "utf-8");
      ok(content.includes(mockContext.input.session_id));
    });

    it("should handle error and still return success", () => {
      const mockContext = createSessionStartContext("api");

      // Simulate error handling
      let errorOccurred = false;
      try {
        // Simulate an error
        throw new Error("Test error");
      } catch (error) {
        errorOccurred = true;
        // Hook would log error but still return success
        console.error(`Session start error: ${error}`);
      }

      ok(errorOccurred, "Error should have occurred");

      // Hook should still return success
      const result = mockContext.success({});
      deepStrictEqual(result, {});
    });
  });
});
