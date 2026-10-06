#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PermissionAnalyzer } from "../../lib/permission-analyzer.ts";

describe("PermissionAnalyzer - held decisions", () => {
  let dir = "";
  let logPath = "";
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "pa-")));
    logPath = join(dir, "decisions.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = (minute: number, reason: string, decision = "pass") =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 6, 0, minute)).toISOString(),
      session_id: "s1",
      tool_name: "Bash",
      decision,
      reason,
      input: { command: "make build" },
    });

  it("leaves held: and skipped-llm: passes out of the suggestions", async () => {
    writeFileSync(
      logPath,
      [
        entry(1, "held: dot segment .claude"),
        entry(2, "held: dot segment .claude (Layer 2a)"),
        entry(3, "skipped-llm: git-head (Layer 2b)"),
        entry(4, "delegating to Claude Code"),
      ].join("\n"),
    );
    const result = await new PermissionAnalyzer(logPath).analyze({
      minFrequency: 1,
    });
    strictEqual(result.totalAnalyzed, 1);
  });

  it("does not let held entries use up the maxEntries window", async () => {
    writeFileSync(
      logPath,
      [
        entry(1, "delegating to Claude Code"),
        entry(2, "delegating to Claude Code"),
        entry(3, "held: dot segment .claude"),
        entry(4, "held: dot segment .claude"),
      ].join("\n"),
    );
    const result = await new PermissionAnalyzer(logPath).analyze({
      maxEntries: 3,
      minFrequency: 1,
    });
    // Counting holds first would leave one ordinary entry and two holds in the window of three.
    strictEqual(result.totalAnalyzed, 2);
  });

  it("keeps a held-looking reason on a non-pass decision", async () => {
    writeFileSync(logPath, entry(1, "held: x", "ask"));
    const result = await new PermissionAnalyzer(logPath).analyze({
      minFrequency: 1,
    });
    strictEqual(result.totalAnalyzed, 1);
  });
});
