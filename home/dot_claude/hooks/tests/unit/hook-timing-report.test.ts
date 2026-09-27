#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  type HookTimingRecord,
  labelForCommand,
  parseHookTimingLines,
  summarizeBlocking,
  summarizeByHook,
} from "../../lib/hook-timing-report.ts";

/** Fills in the schema fields a test case does not care about. */
function record(overrides: Partial<HookTimingRecord>): HookTimingRecord {
  return {
    ts: "2026-09-28T00:00:00Z",
    start_ms: 0,
    duration_ms: 0,
    event: "PreToolUse",
    async: false,
    exit_code: 0,
    stdout_bytes: 0,
    stderr_bytes: 0,
    command: "echo x",
    session_id: "s",
    tool_name: null,
    tool_use_id: null,
    terminated: null,
    ...overrides,
  };
}

describe("parseHookTimingLines", () => {
  it("counts one valid record and one invalid line, ignoring blank lines", () => {
    const text = `${JSON.stringify(record({}))}\nbroken\n\n`;
    const { records, invalidLines } = parseHookTimingLines(text);
    strictEqual(records.length, 1);
    strictEqual(invalidLines, 1);
  });
});

describe("labelForCommand", () => {
  it("labels an implementations/*.ts command by its file name", () => {
    strictEqual(
      labelForCommand("bun /h/.claude/hooks/implementations/block-tsx.ts"),
      "block-tsx",
    );
  });

  it("finds the implementations/*.ts label through a run-guard wrapper", () => {
    strictEqual(
      labelForCommand(
        "sh /h/.claude/hooks/run-guard.sh /h/.claude/hooks/implementations/auto-approve.ts || exit 2",
      ),
      "auto-approve",
    );
  });

  it("falls back to inline: + the command itself when there is no implementations/*.ts", () => {
    strictEqual(labelForCommand("echo 'x'"), "inline:echo 'x'");
  });
});

describe("summarizeByHook", () => {
  it("computes nearest-rank p50/p95, max and total for one hook", () => {
    const durations = [10, 20, 30, 40, 100];
    const records = durations.map((duration_ms) =>
      record({ command: "bun implementations/foo.ts", duration_ms }),
    );
    const [stats] = summarizeByHook(records);
    strictEqual(stats.p50, 30);
    strictEqual(stats.p95, 100);
    strictEqual(stats.max, 100);
    strictEqual(stats.totalMs, 200);
  });
});

describe("summarizeBlocking", () => {
  it("takes the max sync duration per firing (grouped by tool_use_id) and finds the top bottleneck", () => {
    const records: HookTimingRecord[] = [
      record({
        command: "bun implementations/A.ts",
        tool_use_id: "t1",
        async: false,
        duration_ms: 40,
      }),
      record({
        command: "bun implementations/B.ts",
        tool_use_id: "t1",
        async: false,
        duration_ms: 90,
      }),
      record({
        command: "bun implementations/C.ts",
        tool_use_id: "t1",
        async: true,
        duration_ms: 500,
      }),
      record({
        command: "bun implementations/A.ts",
        tool_use_id: "t2",
        async: false,
        duration_ms: 50,
      }),
      record({
        command: "bun implementations/B.ts",
        tool_use_id: "t2",
        async: false,
        duration_ms: 20,
      }),
    ];
    const [stats] = summarizeBlocking(records);
    strictEqual(stats.event, "PreToolUse");
    strictEqual(stats.invocations, 2);
    strictEqual(stats.max, 90);
    strictEqual(stats.p50, 50);
    deepStrictEqual(stats.topBottleneck, { label: "A", share: 0.5 });
  });

  it("groups tool_use_id-less records into firings by a 1000ms window from the group's head", () => {
    const records: HookTimingRecord[] = [1000, 1300, 2600].map((start_ms) =>
      record({
        event: "Stop",
        command: "bun implementations/stop-hook.ts",
        tool_use_id: null,
        async: false,
        start_ms,
        duration_ms: 10,
      }),
    );
    const [stats] = summarizeBlocking(records);
    strictEqual(stats.event, "Stop");
    strictEqual(stats.invocations, 2);
  });
});
