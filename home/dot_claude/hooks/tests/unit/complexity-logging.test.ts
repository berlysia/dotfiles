import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { logComplexity } from "../../lib/centralized-logging.ts";
import type { ComplexityLogEntry } from "../../types/logging-types.ts";

function readEntries(sessionId: string): ComplexityLogEntry[] {
  const logDir = process.env.CLAUDE_LOGS_DIR;
  assert.ok(logDir, "run with --import tests/preload-test-env.mjs");
  return readFileSync(join(logDir, "complexity.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as ComplexityLogEntry)
    .filter((entry) => entry.session_id === sessionId);
}

describe("logComplexity", () => {
  it("writes a notice with structured findings to complexity.jsonl", () => {
    logComplexity(
      {
        kind: "notice",
        root: "/repo",
        findings: [
          { path: "a.ts", line: 3, name: "f", before: 24, after: 44 },
          { path: "b.ts", line: null, name: "g", before: null, after: 30 },
        ],
      },
      "logging-notice",
    );
    const [entry] = readEntries("logging-notice");
    assert.ok(entry);
    assert.equal(entry.kind, "notice");
    assert.equal(entry.root, "/repo");
    assert.deepEqual(entry.findings, [
      { path: "a.ts", line: 3, name: "f", before: 24, after: 44 },
      { path: "b.ts", line: null, name: "g", before: null, after: 30 },
    ]);
    assert.ok(entry.timestamp);
  });

  it("writes a skip with reason, binary and recovery", () => {
    logComplexity(
      {
        kind: "skip",
        root: "/repo",
        reason: "cccc-not-found",
        recovery: "put cccc on PATH",
      },
      "logging-skip",
    );
    const [entry] = readEntries("logging-skip");
    assert.ok(entry);
    assert.equal(entry.reason, "cccc-not-found");
    assert.equal(entry.recovery, "put cccc on PATH");
    assert.equal("binary" in entry, false);
  });
});
