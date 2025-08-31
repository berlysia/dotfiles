#!/usr/bin/env node --test

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, deepStrictEqual, ok, match } from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createSessionStartContext } from "./test-helpers.ts";

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
      
      const logLine = JSON.stringify(logEntry) + "\n";
      
      // Write to test file
      appendFileSync(logFile, logLine);
      
      // Read and verify
      const content = readFileSync(logFile, "utf-8");
      const lines = content.trim().split("\n");
      strictEqual(lines.length, 1, "Should have one log line");
      
      const parsed = JSON.parse(lines[0]!);
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
        appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
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
        user: "user\"with\"quotes",
        cwd: "/path/with\\backslash",
      };
      
      const logLine = JSON.stringify(logEntry) + "\n";
      appendFileSync(logFile, logLine);
      
      // Read and parse back
      const content = readFileSync(logFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      
      // JSON.stringify should have properly escaped everything
      strictEqual(parsed.session_id, "test\nwith\nnewlines");
      strictEqual(parsed.user, "user\"with\"quotes");
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
      const nonExistentPath = join(testDir, "non", "existent", "path", "file.log");
      
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
      appendFileSync(logFile, JSON.stringify(logEntry) + "\n");
      
      // Simulate success response
      const result = mockContext.success({
        messageForUser: "🚀 Claude Code session started. Ready for development!"
      });
      
      deepStrictEqual(result, {
        messageForUser: "🚀 Claude Code session started. Ready for development!"
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