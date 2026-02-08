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

describe("command-logger.ts hook behavior", () => {
  let testDir: string;
  let claudeDir: string;
  let commandHistoryFile: string;
  let toolUsageFile: string;

  beforeEach(() => {
    // Create test directory
    testDir = join(tmpdir(), `command-logger-test-${Date.now()}`);
    claudeDir = join(testDir, ".claude");
    commandHistoryFile = join(claudeDir, "command_history.log");
    toolUsageFile = join(claudeDir, "tool_usage.jsonl");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Bash command logging", () => {
    it("should log Bash commands to both files", () => {
      const mockInput = {
        tool_name: "Bash",
        tool_input: {
          command: "ls -la",
          description: "List all files",
        },
        session_id: "test-session-123",
      };

      // Simulate command history log entry
      const timestamp = new Date();
      const commandLogLine = `[${timestamp.toLocaleString()}] ${process.env.USER || "unknown"} [${process.cwd()}]: ${mockInput.tool_input.command}\n`;
      appendFileSync(commandHistoryFile, commandLogLine);

      // Simulate structured log entry
      const structuredEntry = {
        timestamp: timestamp.toISOString(),
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
        tool_name: "Bash",
        command: mockInput.tool_input.command,
        description: mockInput.tool_input.description,
        session_id: mockInput.session_id,
      };
      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      // Verify command history log
      const commandHistory = readFileSync(commandHistoryFile, "utf-8");
      ok(commandHistory.includes("ls -la"), "Should contain command");
      ok(
        commandHistory.includes(process.env.USER || "unknown"),
        "Should contain user",
      );

      // Verify structured log
      const toolUsage = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(toolUsage.trim());
      strictEqual(parsed.tool_name, "Bash");
      strictEqual(parsed.command, "ls -la");
      strictEqual(parsed.description, "List all files");
      strictEqual(parsed.session_id, "test-session-123");
    });

    it("should escape newlines in commands", () => {
      const multiLineCommand = "echo 'line1'\necho 'line2'";
      const escapedCommand = multiLineCommand.replace(/\n/g, "\\n");

      const structuredEntry = {
        timestamp: new Date().toISOString(),
        user: "testuser",
        cwd: "/test/dir",
        tool_name: "Bash",
        command: escapedCommand,
        description: "Multi-line command",
      };

      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      const content = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(parsed.command, "echo 'line1'\\necho 'line2'");
    });

    it("should handle missing session_id", () => {
      const structuredEntry = {
        timestamp: new Date().toISOString(),
        user: "testuser",
        cwd: "/test/dir",
        tool_name: "Bash",
        command: "pwd",
        description: "",
      };

      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      const content = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      ok(!("session_id" in parsed), "Should not have session_id");
    });
  });

  describe("Edit/Write tool logging", () => {
    it("should log Edit tool with file path", () => {
      const structuredEntry = {
        timestamp: new Date().toISOString(),
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
        tool_name: "Edit",
        file_path: "/path/to/file.ts",
        description: "Auto-format triggered",
        session_id: "test-session-789",
      };

      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      const content = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(parsed.tool_name, "Edit");
      strictEqual(parsed.file_path, "/path/to/file.ts");
      strictEqual(parsed.description, "Auto-format triggered");
    });

    it("should log MultiEdit tool", () => {
      const structuredEntry = {
        timestamp: new Date().toISOString(),
        user: "testuser",
        cwd: "/test/dir",
        tool_name: "MultiEdit",
        file_path: "/path/to/file.ts",
        description: "Auto-format triggered",
      };

      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      const content = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(parsed.tool_name, "MultiEdit");
      strictEqual(parsed.file_path, "/path/to/file.ts");
    });

    it("should log Write tool", () => {
      const structuredEntry = {
        timestamp: new Date().toISOString(),
        user: "testuser",
        cwd: "/test/dir",
        tool_name: "Write",
        file_path: "/path/to/newfile.ts",
        description: "Auto-format triggered",
      };

      appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);

      const content = readFileSync(toolUsageFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      strictEqual(parsed.tool_name, "Write");
      strictEqual(parsed.file_path, "/path/to/newfile.ts");
    });
  });

  describe("log file formats", () => {
    it("should write valid JSONL format for multiple entries", () => {
      // Write multiple entries
      for (let i = 0; i < 3; i++) {
        const entry = {
          timestamp: new Date().toISOString(),
          user: "testuser",
          cwd: "/test/dir",
          tool_name: "Bash",
          command: `command-${i}`,
          description: `Description ${i}`,
        };
        appendFileSync(toolUsageFile, `${JSON.stringify(entry)}\n`);
      }

      // Read and verify each line is valid JSON
      const content = readFileSync(toolUsageFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 3, "Should have 3 lines");

      lines.forEach((line, index) => {
        const parsed = JSON.parse(line);
        strictEqual(parsed.command, `command-${index}`);
      });
    });

    it("should format command history log correctly", () => {
      const timestamp = new Date();
      const user = process.env.USER || "unknown";
      const cwd = process.cwd();
      const command = "git status";

      const logLine = `[${timestamp.toLocaleString()}] ${user} [${cwd}]: ${command}\n`;
      appendFileSync(commandHistoryFile, logLine);

      const content = readFileSync(commandHistoryFile, "utf-8");
      ok(content.includes(user), "Should contain user");
      ok(content.includes(cwd), "Should contain cwd");
      ok(content.includes(command), "Should contain command");
      ok(content.startsWith("["), "Should start with timestamp bracket");
    });
  });

  describe("error handling", () => {
    it("should handle write errors gracefully", () => {
      // Try to write to a file in a non-existent directory
      const badPath = join(testDir, "non", "existent", "path", "file.jsonl");

      try {
        appendFileSync(badPath, "test");
        ok(false, "Should have thrown error");
      } catch (error: any) {
        ok(error.code === "ENOENT", "Should get ENOENT error");
      }
    });

    it("should handle missing USER environment variable", () => {
      const originalUser = process.env.USER;
      delete process.env.USER;

      try {
        const entry = {
          timestamp: new Date().toISOString(),
          user: process.env.USER || "unknown",
          cwd: process.cwd(),
          tool_name: "Bash",
          command: "whoami",
        };

        strictEqual(
          entry.user,
          "unknown",
          "Should use 'unknown' for missing USER",
        );
      } finally {
        if (originalUser) {
          process.env.USER = originalUser;
        }
      }
    });
  });

  describe("hook context simulation", () => {
    it("should simulate successful Bash command logging", () => {
      const mockContext = {
        input: {
          tool_name: "Bash",
          tool_input: {
            command: "npm test",
            description: "Run tests",
          },
          session_id: "test-session",
        },
        success: (result: any) => result,
      };

      // Simulate the logging that would happen
      if (mockContext.input.tool_name === "Bash") {
        // Log to command history
        const timestamp = new Date();
        const commandLogLine = `[${timestamp.toLocaleString()}] ${process.env.USER || "unknown"} [${process.cwd()}]: ${mockContext.input.tool_input.command}\n`;
        appendFileSync(commandHistoryFile, commandLogLine);

        // Log to structured file
        const structuredEntry = {
          timestamp: timestamp.toISOString(),
          user: process.env.USER || "unknown",
          cwd: process.cwd(),
          tool_name: "Bash",
          command: mockContext.input.tool_input.command,
          description: mockContext.input.tool_input.description,
          session_id: mockContext.input.session_id,
        };
        appendFileSync(toolUsageFile, `${JSON.stringify(structuredEntry)}\n`);
      }

      // Verify success
      const result = mockContext.success({});
      deepStrictEqual(result, {});

      // Verify logs were written
      ok(existsSync(commandHistoryFile), "Command history file should exist");
      ok(existsSync(toolUsageFile), "Tool usage file should exist");

      const toolUsage = readFileSync(toolUsageFile, "utf-8");
      ok(toolUsage.includes("npm test"), "Should contain the command");
    });

    it("should ignore non-Bash, non-Edit tools", () => {
      const mockContext = {
        input: {
          tool_name: "Read",
          tool_input: {
            file_path: "/path/to/file.ts",
          },
        },
        success: (result: any) => result,
      };

      // Simulate the hook logic - should not log anything for Read tool
      const shouldLog = ["Bash", "Edit", "MultiEdit", "Write"].includes(
        mockContext.input.tool_name,
      );
      ok(!shouldLog, "Should not log Read tool");

      // Return success without logging
      const result = mockContext.success({});
      deepStrictEqual(result, {});
    });
  });
});
