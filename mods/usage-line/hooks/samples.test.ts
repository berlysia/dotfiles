import { expect, test } from "claude-code/testing";
import { forecastUsage, type RateLimitSample } from "./forecast";
import {
  collectWindows,
  decode,
  encode,
  isRecordDue,
  latestUsage,
  mergeAll,
  nextWakeAt,
  pruneOwn,
  selectKeysToDelete,
} from "./samples";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-22T00:00:00Z");

function sample(
  sampledAt: number,
  usedPercent: number,
  overrides: Partial<RateLimitSample> = {},
): RateLimitSample {
  return {
    window: "five_hour",
    sampledAt,
    usedPercent,
    resetsAt: (now + 2 * HOUR) / 1000,
    ...overrides,
  };
}

test("collectWindows keeps a valid window and truncates resetsAt to seconds", async () => {
  const result = collectWindows([
    {
      kind: "five_hour",
      percentUsed: 42.5,
      resetsAt: "2026-10-22T07:00:00.900Z",
    },
    { kind: "spend_limit", percentUsed: 10 },
  ]);
  expect(result).toEqual([
    {
      window: "five_hour",
      usedPercent: 42.5,
      resetsAt: Date.parse("2026-10-22T07:00:00Z") / 1000,
    },
  ]);
});

test("collectWindows rejects malformed input", async () => {
  const resetsAt = "2026-10-22T07:00:00Z";
  expect(
    collectWindows([{ kind: "seven_day", percentUsed: NaN, resetsAt: "x" }]),
  ).toEqual([]);
  expect(collectWindows("x")).toEqual([]);
  expect(collectWindows([null])).toEqual([]);
  expect(
    collectWindows([{ kind: "five_hour", percentUsed: 100.1, resetsAt }]),
  ).toEqual([]);
  expect(
    collectWindows([{ kind: "five_hour", percentUsed: -1, resetsAt }]),
  ).toEqual([]);
});

test("isRecordDue", async () => {
  const resetsAt = (now + 2 * HOUR) / 1000;
  const last = sample(now, 40, { resetsAt });
  const same = { window: "five_hour" as const, usedPercent: 40, resetsAt };
  expect(isRecordDue(last, same, now + 10 * MIN - 1000)).toBe(false);
  expect(isRecordDue(last, same, now + 10 * MIN)).toBe(true);
  expect(isRecordDue(last, { ...same, usedPercent: 40.1 }, now + MIN)).toBe(
    true,
  );
  expect(
    isRecordDue(last, { ...same, resetsAt: resetsAt + 1 }, now + MIN),
  ).toBe(true);
  expect(isRecordDue(undefined, same, now)).toBe(true);
});

test("decode drops malformed elements without throwing", async () => {
  expect(decode("x", now)).toEqual([]);
  const value = [
    [1, 0, 42, 2],
    [1, 2, 42, 2],
    [1, 0, 101, 2],
    [1, 0, -1, 2],
    [now + 1, 0, 1, 2],
    [1, 0, "a", 2],
    [1, 0, 1],
    null,
    "x",
    {},
  ];
  expect(decode(value, now)).toEqual([
    { window: "five_hour", sampledAt: 1, usedPercent: 42, resetsAt: 2 },
  ]);
});

test("decode keeps the newest 10,000 samples", async () => {
  const value = Array.from({ length: 10_001 }, (_, i) => [i + 1, 0, 1, 2]);
  const result = decode(value, now);
  expect(result.length).toBe(10_000);
  expect(result[0]!.sampledAt).toBe(2);
  expect(result.at(-1)!.sampledAt).toBe(10_001);
});

test("encode then decode round-trips", async () => {
  const samples = [
    sample(now - 20 * MIN, 10),
    sample(now - 10 * MIN, 12, { window: "seven_day" }),
    sample(now, 14),
  ];
  expect(decode(encode(samples), now)).toEqual(samples);
});

test("mergeAll orders ties by key, so the later key is the latest", async () => {
  const resetsAt = (now + 2 * HOUR) / 1000;
  const byKey = new Map<string, RateLimitSample[]>();
  byKey.set("b", [sample(100, 40, { resetsAt })]);
  byKey.set("a", [sample(100, 41, { resetsAt })]);
  const merged = mergeAll(byKey);
  expect(merged.map((s) => s.usedPercent)).toEqual([41, 40]);
  expect(latestUsage(merged, "five_hour", now)?.usedPercent).toBe(40);
});

test("mergeAll interleaves keys by time", async () => {
  const byKey = new Map<string, RateLimitSample[]>();
  byKey.set("a", [sample(10, 1), sample(30, 3), sample(50, 5)]);
  byKey.set("b", [sample(20, 2), sample(40, 4)]);
  expect(mergeAll(byKey).map((s) => s.sampledAt)).toEqual([10, 20, 30, 40, 50]);
});

test("latestUsage ignores future samples and returns null without a match", async () => {
  const merged = [sample(now - MIN, 10), sample(now + MIN, 20)];
  expect(latestUsage(merged, "five_hour", now)?.usedPercent).toBe(10);
  expect(latestUsage(merged, "seven_day", now)).toBe(null);
});

test("pruneOwn keeps exactly 7 days and drops 7 days + 1ms", async () => {
  const kept = sample(now - 7 * DAY, 1);
  const dropped = sample(now - 7 * DAY - 1, 2);
  expect(pruneOwn([dropped, kept], now)).toEqual([kept]);
});

test("selectKeysToDelete picks only old or empty v1 sample keys", async () => {
  const entries: [string, unknown][] = [
    ["samples:v1:x", encode([sample(now - 8 * DAY, 1)])],
    ["samples:v1:y", encode([sample(now - DAY, 1)])],
    ["samples:v1:z", []],
    ["samples:v2:w", encode([sample(now - 8 * DAY, 1)])],
    ["probe:v1:a", encode([sample(now - 8 * DAY, 1)])],
  ];
  expect(selectKeysToDelete(entries, now)).toEqual([
    "samples:v1:x",
    "samples:v1:z",
  ]);
});

function risingSamples(resetsAt: number): RateLimitSample[] {
  return [20, 15, 10, 5, 0].map((minutesAgo, i) =>
    sample(now - minutesAgo * MIN, 10 + i * 2, { resetsAt }),
  );
}

test("nextWakeAt returns the stale boundary, where forecastUsage flips to stale", async () => {
  const merged = risingSamples((now + 2 * HOUR) / 1000);
  const wake = nextWakeAt(merged, now);
  expect(wake).toBe(now + 25 * MIN + 1);
  expect(forecastUsage(merged, "five_hour", wake! - 1).reason).not.toBe(
    "stale",
  );
  expect(forecastUsage(merged, "five_hour", wake!).reason).toBe("stale");
});

test("nextWakeAt returns resetsAt when the stale boundary has passed", async () => {
  const resetsAt = (now + 2 * HOUR) / 1000;
  const merged = risingSamples(resetsAt);
  const at = resetsAt * 1000 - 1;
  expect(nextWakeAt(merged, at)).toBe(resetsAt * 1000);
  expect(forecastUsage(merged, "five_hour", resetsAt * 1000).reason).toBe(
    "expired",
  );
});

test("nextWakeAt gives up beyond 8 days", async () => {
  const merged = risingSamples((now + 9 * DAY) / 1000);
  expect(nextWakeAt(merged, now + 30 * MIN)).toBe(null);
});
