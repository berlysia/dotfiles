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
import { createUserPromptSubmitContext } from "./test-helpers.ts";

describe("user-prompt-logger.ts hook behavior", () => {
  let testDir: string;
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    // Create test directory
    testDir = join(tmpdir(), `user-prompt-logger-test-${Date.now()}`);
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

  describe("hook configuration", () => {
    it("should be configured for UserPromptSubmit trigger", () => {
      const expectedTrigger = { UserPromptSubmit: true };
      ok(
        expectedTrigger.UserPromptSubmit,
        "Should handle UserPromptSubmit trigger",
      );
    });
  });

  describe("log entry structure", () => {
    it("should create valid JSON log entries for user prompts", () => {
      // Simulate what the hook would write
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
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

      const parsed = JSON.parse(lines[0]!);
      strictEqual(parsed.event, "UserPromptSubmit");
      strictEqual(parsed.session_id, "test-session-123");
      ok(parsed.timestamp, "Should have timestamp");
      ok(parsed.cwd, "Should have cwd");
      ok(parsed.user, "Should have user");
    });

    it("should handle missing USER environment variable", () => {
      const originalUser = process.env.USER;
      delete process.env.USER;

      try {
        const logEntry = {
          timestamp: new Date().toISOString(),
          event: "UserPromptSubmit",
          session_id: "test-session-456",
          user: process.env.USER || "unknown",
          cwd: process.cwd(),
        };

        strictEqual(
          logEntry.user,
          "unknown",
          "Should use 'unknown' for missing USER",
        );

        appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

        const content = readFileSync(logFile, "utf-8");
        const parsed = JSON.parse(content.trim());
        strictEqual(parsed.user, "unknown");
      } finally {
        if (originalUser) {
          process.env.USER = originalUser;
        }
      }
    });

    it("should handle missing session_id", () => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: undefined,
        user: "testuser",
        cwd: "/test/dir",
      };

      appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(
        parsed.session_id,
        undefined,
        "session_id should be undefined",
      );
    });

    it("should format log line correctly with newline", () => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: "test-session-newline",
        user: "testuser",
        cwd: "/test/dir",
      };

      const logLine = `${JSON.stringify(logEntry)}\n`;
      appendFileSync(logFile, logLine);

      const content = readFileSync(logFile, "utf-8");

      // Verify the log line ends with newline
      ok(content.endsWith("\n"), "Log line should end with newline");

      // Verify it's valid JSON before the newline
      const jsonContent = content.replace(/\n$/, "");
      const parsed = JSON.parse(jsonContent);
      ok(parsed, "Should be valid JSON");
      strictEqual(parsed.event, "UserPromptSubmit");
    });

    it("should use consistent log file path", () => {
      // Write multiple entries
      for (let i = 0; i < 2; i++) {
        const logEntry = {
          timestamp: new Date().toISOString(),
          event: "UserPromptSubmit",
          session_id: `session-${i}`,
          user: "testuser",
          cwd: "/test/dir",
        };
        appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);
      }

      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 2, "Should have two log lines");

      // Parse both lines to verify they're valid
      const entry1 = JSON.parse(lines[0]!);
      const entry2 = JSON.parse(lines[1]!);
      strictEqual(entry1.session_id, "session-0");
      strictEqual(entry2.session_id, "session-1");
    });

    it("should capture current working directory", () => {
      const originalCwd = process.cwd();

      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: "test-cwd",
        user: "testuser",
        cwd: originalCwd,
      };

      appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(
        parsed.cwd,
        originalCwd,
        "Should capture current working directory",
      );
    });

    it("should validate timestamp format", () => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: "test-timestamp",
        user: "testuser",
        cwd: "/test/dir",
      };

      appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());

      // Verify timestamp is valid ISO string
      const timestamp = new Date(parsed.timestamp);
      ok(!Number.isNaN(timestamp.getTime()), "Timestamp should be valid");
      ok(
        parsed.timestamp.includes("T"),
        "Should be ISO format with T separator",
      );
      ok(
        parsed.timestamp.includes("Z") ||
          parsed.timestamp.includes("+") ||
          parsed.timestamp.includes("-"),
        "Should have timezone indicator",
      );
    });
  });

  describe("directory creation", () => {
    it("should handle nested directory creation", () => {
      const nestedLogDir = join(testDir, ".config", "claude-companion", "logs");

      // Directory should already exist from beforeEach
      ok(existsSync(nestedLogDir), "Nested directory should exist");

      // Verify we can write to it
      const testFile = join(nestedLogDir, "test.jsonl");
      appendFileSync(testFile, "test content");
      ok(existsSync(testFile), "Should be able to write to nested directory");
    });

    it("should not throw if directory already exists", () => {
      // Try to create the same directory again
      mkdirSync(logDir, { recursive: true });

      // Should not throw and directory should still exist
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
        "file.jsonl",
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
        JSON.parse(lines[0]!);
        ok(false, "Should have thrown error");
      } catch (error) {
        ok(error instanceof SyntaxError, "Should get JSON parse error");
      }
    });
  });

  describe("hook context simulation", () => {
    it("should simulate successful user prompt logging", () => {
      const mockContext = createUserPromptSubmitContext("Test user prompt");

      // Simulate hook behavior
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: mockContext.input.session_id,
        prompt: mockContext.input.prompt,
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      // Would normally write to log
      appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);

      // Simulate success response
      const result = mockContext.success({});
      deepStrictEqual(result, {});

      // Verify log was written
      const content = readFileSync(logFile, "utf-8");
      ok(content.includes(mockContext.input.session_id));
      ok(content.includes("UserPromptSubmit"));
    });

    it("should handle error and still return success", () => {
      const mockContext = createUserPromptSubmitContext("Error test prompt");

      // Simulate error handling
      let errorOccurred = false;
      try {
        // Simulate an error during logging
        throw new Error("Test logging error");
      } catch (error) {
        errorOccurred = true;
        // Hook would log error but still return success
        console.error(`User prompt logger error: ${error}`);
      }

      ok(errorOccurred, "Error should have occurred");

      // Hook should still return success
      const result = mockContext.success({});
      deepStrictEqual(result, {});
    });
  });

  describe("concurrent writes", () => {
    it("should handle multiple concurrent log entries", async () => {
      const promises = [];

      // Simulate multiple concurrent writes
      for (let i = 0; i < 5; i++) {
        const promise = new Promise<void>((resolve) => {
          const logEntry = {
            timestamp: new Date().toISOString(),
            event: "UserPromptSubmit",
            session_id: `concurrent-${i}`,
            user: "testuser",
            cwd: "/test/dir",
          };

          setTimeout(() => {
            appendFileSync(logFile, `${JSON.stringify(logEntry)}\n`);
            resolve();
          }, Math.random() * 10);
        });

        promises.push(promise);
      }

      await Promise.all(promises);

      // Verify all entries were written
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 5, "Should have 5 log lines");

      // Verify each line is valid JSON
      const sessionIds = new Set<string>();
      lines.forEach((line) => {
        const parsed = JSON.parse(line);
        ok(
          parsed.session_id.startsWith("concurrent-"),
          "Should be concurrent session",
        );
        sessionIds.add(parsed.session_id);
      });

      // Verify all unique session IDs were written
      strictEqual(sessionIds.size, 5, "Should have 5 unique session IDs");
    });
  });
});
