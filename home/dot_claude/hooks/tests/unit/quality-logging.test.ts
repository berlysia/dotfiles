import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { QualityLogEntry } from "../../types/logging-types.ts";

describe("quality logging", () => {
  const testDir = "/tmp/test-quality-logging";
  const testLogDir = join(testDir, ".claude", "logs");
  const originalHome = process.env.HOME;
  const originalClaudeLogsDir = process.env.CLAUDE_LOGS_DIR;

  // Dynamic import after HOME is set so the singleton logger uses test directory
  let logQuality: typeof import("../../lib/centralized-logging.ts").logQuality;

  before(async () => {
    process.env.HOME = testDir;
    // This test exercises the HOME-based fallback derivation in
    // centralized-logging.ts. The suite-wide preload
    // (tests/preload-test-env.mjs) sets CLAUDE_LOGS_DIR, which takes
    // precedence over HOME, so it must be cleared here or every assertion
    // below would look for entries under the preload's temp dir instead of
    // testLogDir.
    delete process.env.CLAUDE_LOGS_DIR;
    mkdirSync(testLogDir, { recursive: true });
    const mod = await import("../../lib/centralized-logging.ts");
    logQuality = mod.logQuality;
  });

  beforeEach(() => {
    // Clean and recreate log dir for each test
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
    mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  after(() => {
    process.env.HOME = originalHome;
    if (originalClaudeLogsDir === undefined) {
      delete process.env.CLAUDE_LOGS_DIR;
    } else {
      process.env.CLAUDE_LOGS_DIR = originalClaudeLogsDir;
    }
  });

  describe("logQuality", () => {
    it("writes quality entry to quality.jsonl", () => {
      logQuality(
        "quality-loop",
        "oxlint",
        "lint error output",
        "test-session",
        "/test/file.ts",
      );

      const qualityFile = join(testLogDir, "quality.jsonl");
      assert.ok(existsSync(qualityFile), "quality.jsonl should be created");

      const content = readFileSync(qualityFile, "utf-8").trim();
      const entry = JSON.parse(content) as QualityLogEntry;

      assert.strictEqual(entry.source, "quality-loop");
      assert.strictEqual(entry.lint_tool, "oxlint");
      assert.strictEqual(entry.error_output, "lint error output");
      assert.strictEqual(entry.session_id, "test-session");
      assert.strictEqual(entry.file_path, "/test/file.ts");
      assert.ok(entry.timestamp);
    });

    it("writes completion-gate entries", () => {
      logQuality(
        "completion-gate",
        "typecheck",
        "TS2322: Type mismatch",
        "session-abc",
      );

      const qualityFile = join(testLogDir, "quality.jsonl");
      const content = readFileSync(qualityFile, "utf-8").trim();
      const entry = JSON.parse(content) as QualityLogEntry;

      assert.strictEqual(entry.source, "completion-gate");
      assert.strictEqual(entry.lint_tool, "typecheck");
      assert.strictEqual(entry.file_path, undefined);
    });

    it("appends multiple entries", () => {
      logQuality("quality-loop", "oxlint", "error 1", "s1");
      logQuality("completion-gate", "test", "error 2", "s1");

      const qualityFile = join(testLogDir, "quality.jsonl");
      const lines = readFileSync(qualityFile, "utf-8").trim().split("\n");
      assert.strictEqual(lines.length, 2);
    });
  });
});
