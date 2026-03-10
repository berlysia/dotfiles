import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type {
  QualityLogEntry,
  ReflectionEntry,
  ReflectionLogEntry,
} from "../../types/logging-types.ts";

describe("quality logging", () => {
  const testDir = "/tmp/test-quality-logging";
  const testLogDir = join(testDir, ".claude", "logs");
  const originalHome = process.env.HOME;

  // Dynamic import after HOME is set so the singleton logger uses test directory
  let logQuality: typeof import("../../lib/centralized-logging.ts").logQuality;
  let logReflection: typeof import("../../lib/centralized-logging.ts").logReflection;

  before(async () => {
    process.env.HOME = testDir;
    mkdirSync(testLogDir, { recursive: true });
    const mod = await import("../../lib/centralized-logging.ts");
    logQuality = mod.logQuality;
    logReflection = mod.logReflection;
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

  describe("logReflection", () => {
    it("writes reflection entry to reflections.jsonl", () => {
      const reflections: ReflectionEntry[] = [
        {
          error_summary: "Type mismatch in return value",
          root_cause: "Missing null check",
          preventable_by_lint: true,
          suggested_rule: {
            type: "custom-rule",
            description: "Check return type consistency",
            pattern_hint: "return.*null",
          },
        },
      ];

      logReflection(2, reflections, "test-session");

      const reflectionFile = join(testLogDir, "reflections.jsonl");
      assert.ok(
        existsSync(reflectionFile),
        "reflections.jsonl should be created",
      );

      const content = readFileSync(reflectionFile, "utf-8").trim();
      const entry = JSON.parse(content) as ReflectionLogEntry;

      assert.strictEqual(entry.errors_analyzed, 2);
      assert.strictEqual(entry.reflections.length, 1);
      assert.strictEqual(entry.reflections[0].preventable_by_lint, true);
      assert.strictEqual(
        entry.reflections[0].suggested_rule?.type,
        "custom-rule",
      );
      assert.strictEqual(entry.session_id, "test-session");
    });

    it("handles empty reflections array", () => {
      logReflection(0, [], "test-session");

      const reflectionFile = join(testLogDir, "reflections.jsonl");
      const content = readFileSync(reflectionFile, "utf-8").trim();
      const entry = JSON.parse(content) as ReflectionLogEntry;

      assert.strictEqual(entry.errors_analyzed, 0);
      assert.deepStrictEqual(entry.reflections, []);
    });
  });
});
