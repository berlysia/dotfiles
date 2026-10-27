import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  summarizeClaude,
  summarizeCodex,
  summarizeCursor,
  summarizeOpencode,
} from "../home/dot_local/share/ai-usage/summary.ts";

const main = new URL(
  "../home/dot_local/share/ai-usage/main.ts",
  import.meta.url,
).pathname;

test("claude: utilization and resets_at map to both windows", () => {
  const summary = summarizeClaude({
    five_hour: { utilization: 12, resets_at: "2026-10-27T20:00:00+00:00" },
    seven_day: { utilization: 96, resets_at: "2026-10-29T00:00:00+00:00" },
  });
  assert.deepEqual(summary, {
    fiveHour: { usedPercent: 12, resetsAt: "2026-10-27T20:00:00.000Z" },
    weekly: { usedPercent: 96, resetsAt: "2026-10-29T00:00:00.000Z" },
    exhausted: false,
  });
});

test("codex: windows are matched by duration, not slot order", () => {
  const summary = summarizeCodex({
    ordinaryUsageAllowed: true,
    rateLimits: {
      primary: {
        usedPercent: 16,
        windowDurationMins: 10080,
        resetsAt: 1793705131,
      },
      secondary: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: 1793118331,
      },
    },
  });
  assert.equal(summary.fiveHour?.usedPercent, 40);
  assert.equal(summary.weekly?.usedPercent, 16);
  assert.equal(
    summary.fiveHour?.resetsAt,
    new Date(1793118331 * 1000).toISOString(),
  );
  assert.equal(summary.exhausted, false);
});

test("codex: 100% in the 5-hour window -> exhausted", () => {
  const summary = summarizeCodex({
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } },
  });
  assert.equal(summary.exhausted, true);
  assert.equal(summary.weekly, null);
  assert.equal(summary.fiveHour?.resetsAt, null);
});

test("codex: ordinaryUsageAllowed false -> exhausted even below 100%", () => {
  const summary = summarizeCodex({
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } },
  });
  assert.equal(summary.exhausted, true);
});

test("opencode: picks 5h and weekly, ignores mcp-monthly", () => {
  const summary = summarizeOpencode({
    quota: {
      limits: [
        { window: "mcp-monthly", percentage: 100, nextResetTime: 1 },
        { window: "5h", percentage: 6, nextResetTime: 1793115095368 },
        { window: "weekly", percentage: 2, nextResetTime: 1793498412983 },
      ],
    },
  });
  assert.deepEqual(summary, {
    fiveHour: {
      usedPercent: 6,
      resetsAt: new Date(1793115095368).toISOString(),
    },
    weekly: { usedPercent: 2, resetsAt: new Date(1793498412983).toISOString() },
    exhausted: false,
  });
});

test("opencode: missing quota -> both windows null", () => {
  assert.deepEqual(summarizeOpencode({}), {
    fiveHour: null,
    weekly: null,
    exhausted: false,
  });
});

test("cursor: no 5-hour or weekly windows", () => {
  assert.deepEqual(summarizeCursor(), {
    fiveHour: null,
    weekly: null,
    exhausted: false,
  });
});

test("entrypoint: --summary is accepted and documented", () => {
  const help = spawnSync(process.execPath, [main, "--summary", "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--summary/);

  const bad = spawnSync(process.execPath, [main, "--summary", "nope"], {
    encoding: "utf8",
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument: nope/);
});
