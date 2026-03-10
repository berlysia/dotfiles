import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

describe("stop-reflection", () => {
  const testDir = "/tmp/test-stop-reflection";
  const testLogDir = join(testDir, ".claude", "logs");
  const originalHome = process.env.HOME;

  // Dynamic import after HOME is set so LOG_DIR picks up the test directory
  let readQualityLogs: typeof import("../../implementations/stop-reflection.ts").readQualityLogs;
  let countReflections: typeof import("../../implementations/stop-reflection.ts").countReflections;
  let REFLECTION_NUDGE_THRESHOLD: number;
  let SYSTEM_PROMPT: string;

  before(async () => {
    process.env.HOME = testDir;
    mkdirSync(testLogDir, { recursive: true });
    const mod = await import("../../implementations/stop-reflection.ts");
    readQualityLogs = mod.readQualityLogs;
    countReflections = mod.countReflections;
    REFLECTION_NUDGE_THRESHOLD = mod.REFLECTION_NUDGE_THRESHOLD;
    SYSTEM_PROMPT = mod.SYSTEM_PROMPT;
  });

  beforeEach(() => {
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

  // Restore HOME after all tests in this suite
  after(() => {
    process.env.HOME = originalHome;
  });

  describe("readQualityLogs", () => {
    it("returns empty array when quality.jsonl does not exist", () => {
      const result = readQualityLogs("session-1");
      assert.deepStrictEqual(result, []);
    });

    it("filters entries by session_id and source=completion-gate", () => {
      const entries = [
        {
          timestamp: "2026-03-10T00:00:00Z",
          user: "test",
          cwd: "/test",
          session_id: "session-1",
          source: "completion-gate",
          lint_tool: "typecheck",
          error_output: "TS2322: Type error",
        },
        {
          timestamp: "2026-03-10T00:00:01Z",
          user: "test",
          cwd: "/test",
          session_id: "session-1",
          source: "quality-loop",
          lint_tool: "oxlint",
          error_output: "oxlint error",
        },
        {
          timestamp: "2026-03-10T00:00:02Z",
          user: "test",
          cwd: "/test",
          session_id: "session-2",
          source: "completion-gate",
          lint_tool: "test",
          error_output: "test failed",
        },
      ];
      const content = entries.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(join(testLogDir, "quality.jsonl"), content);

      const result = readQualityLogs("session-1");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].lint_tool, "typecheck");
      assert.strictEqual(result[0].source, "completion-gate");
    });

    it("skips malformed JSON lines", () => {
      const content = [
        '{"timestamp":"2026-03-10T00:00:00Z","user":"test","cwd":"/test","session_id":"s1","source":"completion-gate","lint_tool":"typecheck","error_output":"err"}',
        "not-valid-json",
        '{"timestamp":"2026-03-10T00:00:01Z","user":"test","cwd":"/test","session_id":"s1","source":"completion-gate","lint_tool":"test","error_output":"fail"}',
      ].join("\n");
      writeFileSync(join(testLogDir, "quality.jsonl"), content);

      const result = readQualityLogs("s1");
      assert.strictEqual(result.length, 2);
    });

    it("skips empty lines", () => {
      const content = [
        '{"timestamp":"2026-03-10T00:00:00Z","user":"test","cwd":"/test","session_id":"s1","source":"completion-gate","lint_tool":"typecheck","error_output":"err"}',
        "",
        "",
      ].join("\n");
      writeFileSync(join(testLogDir, "quality.jsonl"), content);

      const result = readQualityLogs("s1");
      assert.strictEqual(result.length, 1);
    });
  });

  describe("countReflections", () => {
    it("returns 0 when no reflection files exist", () => {
      assert.strictEqual(countReflections(), 0);
    });

    it("counts lines in reflections.jsonl", () => {
      const lines = [
        '{"timestamp":"2026-03-10","errors_analyzed":1,"reflections":[]}',
        '{"timestamp":"2026-03-10","errors_analyzed":2,"reflections":[]}',
        '{"timestamp":"2026-03-10","errors_analyzed":1,"reflections":[]}',
      ].join("\n");
      writeFileSync(join(testLogDir, "reflections.jsonl"), lines);

      assert.strictEqual(countReflections(), 3);
    });

    it("counts lines across main and backup files", () => {
      writeFileSync(
        join(testLogDir, "reflections.jsonl"),
        '{"a":1}\n{"a":2}\n',
      );
      writeFileSync(
        join(testLogDir, "reflections.jsonl.2026-03-09T00-00-00"),
        '{"a":3}\n{"a":4}\n{"a":5}\n',
      );

      assert.strictEqual(countReflections(), 5);
    });

    it("returns 0 when log directory does not exist", () => {
      rmSync(testLogDir, { recursive: true, force: true });
      assert.strictEqual(countReflections(), 0);
    });
  });

  describe("constants", () => {
    it("REFLECTION_NUDGE_THRESHOLD is 5", () => {
      assert.strictEqual(REFLECTION_NUDGE_THRESHOLD, 5);
    });

    it("SYSTEM_PROMPT instructs JSON-only response", () => {
      assert.ok(SYSTEM_PROMPT.includes("JSON"));
      assert.ok(SYSTEM_PROMPT.includes("preventable_by_lint"));
    });
  });
});
