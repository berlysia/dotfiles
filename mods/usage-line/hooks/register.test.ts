import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";
import { formatLine } from "./format";
import { buildStatusInput, type ForecastFile } from "./status-input";

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const RESET_5H = NOW + 3 * 60 * MIN;
const RESET_7D = NOW + 3 * DAY;

type Row = [number, 0 | 1, number, number];
const row = (at: number, pct: number, window: 0 | 1 = 0): Row => [
  at,
  window,
  pct,
  Math.trunc((window === 0 ? RESET_5H : RESET_7D) / 1000),
];

function limits(five: number | null, week: number | null = null) {
  const out: { kind: string; percentUsed: number; resetsAt: string }[] = [];
  if (five !== null)
    out.push({
      kind: "five_hour",
      percentUsed: five,
      resetsAt: new Date(RESET_5H).toISOString(),
    });
  if (week !== null)
    out.push({
      kind: "seven_day",
      percentUsed: week,
      resetsAt: new Date(RESET_7D).toISOString(),
    });
  return out;
}

// An in-memory store that counts calls and can refuse writes, with the
// session id, clock and the engine's own session hooks stubbed.
function setup(on: On, seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed));
  const calls = {
    keys: 0,
    get: 0,
    attemptsAtRun: [] as unknown[],
    runs: [] as { argv: readonly string[]; timeoutMs?: number }[],
    sets: [] as { key: string; value: unknown }[],
    deletes: [] as string[],
    logs: [] as string[],
    writes: [] as { path: string; text: string }[],
  };
  const control = {
    id: "me",
    rejectSets: 0,
    rejectGets: 0,
    rejectRuns: 0,
    external: false,
    stdout:
      '{"providers":{"codex":{"ok":true,"fiveHour":{"usedPercent":4,"resetsAt":null},"weekly":{"usedPercent":21,"resetsAt":null},"exhausted":false}}}',
    pending: null as Promise<void> | null,
    pendingGet: null as Promise<void> | null,
    rejectWrites: 0,
    env: { XDG_RUNTIME_DIR: "/run/user/1000" } as Record<string, string>,
    tailSeen: "unset" as string | undefined,
  };
  on("env.get", (_, e) => ({ value: control.env[e.name] }));
  on("fs.write", (_, e) => {
    if (control.rejectWrites > 0) {
      control.rejectWrites--;
      return { deny: "no space" };
    }
    calls.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    control.tailSeen = e.component === "PromptHint" ? e.props.tail : undefined;
    return Text({ children: "hint" });
  });
  on("process.run", async (_, e) => {
    calls.attemptsAtRun.push(store.get("external:v1"));
    calls.runs.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs });
    if (control.pending !== null) await control.pending;
    if (control.rejectRuns-- > 0) return { deny: "secret diagnostic" };
    return {
      value: {
        exitCode: 1,
        stdout: control.stdout,
        stderr: "secret",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  const clock = mock.clock(on, { now: NOW });
  on("session.id", () => ({ value: control.id }));
  on("store.keys", () => {
    calls.keys++;
    return { value: [...store.keys()] };
  });
  on("store.get", async (_, e) => {
    if (e.key === "external:v1") {
      if (!control.external) return { value: { attemptAt: clock.now() } };
      if (control.pendingGet !== null) await control.pendingGet;
      if (control.rejectGets-- > 0) return { deny: "private error" };
    } else calls.get++;
    return { value: store.get(e.key) };
  });
  on("store.set", (_, e) => {
    if (control.rejectSets > 0) {
      control.rejectSets--;
      return { deny: "disk full" };
    }
    calls.sets.push({ key: e.key, value: e.value });
    store.set(e.key, e.value);
    return { value: undefined };
  });
  on("store.delete", (_, e) => {
    calls.deletes.push(e.key);
    store.delete(e.key);
    return { value: undefined };
  });
  on("ui.log", (_, e) => {
    calls.logs.push(e.text);
    return { value: undefined };
  });
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  return { store, calls, control, clock };
}

/** The newest forecast file the plugin wrote. */
function lastFile(calls: { writes: { path: string; text: string }[] }) {
  const last = calls.writes.at(-1);
  if (last === undefined) throw new Error("no forecast file written");
  return { path: last.path, file: JSON.parse(last.text) as ForecastFile };
}

const startArgs = {
  cwd: "/",
  surface: "terminal",
  isInteractive: true,
} as const;

describe("usage-line", () => {
  test("rateLimits [] -> no throw, no store write, empty windows", async ($, on) => {
    const { calls } = setup(on);
    await $.session.start(startArgs);
    const result = await $.session.measure({
      context: { window: 200_000 },
      rateLimits: [],
      changed: ["rateLimits"],
    });
    expect(result).toEqual({ changed: ["rateLimits"] });
    expect(calls.sets).toEqual([]);
    expect(lastFile(calls).file.windows).toEqual({});
  });

  test("5h 42% -> one sample in samples:v1:<id> and the forecast file", async ($, on) => {
    const { calls } = setup(on);
    await $.session.start(startArgs);
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: limits(42),
      changed: ["rateLimits"],
    });
    expect(calls.sets).toHaveLength(1);
    expect(calls.sets[0]?.key).toBe("samples:v1:me");
    expect(calls.sets[0]?.value).toEqual([row(NOW, 42)]);
    const { path, file } = lastFile(calls);
    expect(path).toBe("/run/user/1000/usage-line/me.json");
    expect(file.v).toBe(1);
    expect(file.at).toBe(NOW);
    expect(Object.keys(file.windows)).toEqual(["five_hour"]);
    expect(file.windows.five_hour?.resetsAt).toBe(Math.trunc(RESET_5H / 1000));
    expect(file.windows.five_hour?.forecast).toMatchObject({
      status: "unknown",
      reason: "insufficient_data",
    });
  });

  test("same value is recorded again only after 10 minutes", async ($, on) => {
    const { calls, clock } = setup(on);
    await $.session.start(startArgs);
    const measure = () =>
      $.session.measure({
        context: { percent: 10, window: 200_000 },
        rateLimits: limits(42),
        changed: ["rateLimits"],
      });
    await measure();
    await clock.advance(5 * MIN);
    await measure();
    expect(calls.sets).toHaveLength(1);
    await clock.advance(5 * MIN);
    await measure();
    expect(calls.sets).toHaveLength(2);
    expect((calls.sets[1]?.value as Row[]).length).toBe(2);
  });

  test("measures that record nothing touch neither keys nor get", async ($, on) => {
    const { calls, clock } = setup(on);
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(42),
      changed: ["rateLimits"],
    });
    calls.keys = 0;
    calls.get = 0;
    for (let i = 0; i < 3; i++) {
      await clock.advance(MIN);
      await $.session.measure({
        context: { percent: 2 + i, window: 200_000 },
        rateLimits: limits(42),
        changed: ["context"],
      });
    }
    expect(calls.keys).toBe(0);
    expect(calls.get).toBe(0);
  });

  test("recording both windows re-reads the store once", async ($, on) => {
    const { calls, clock } = setup(on);
    await $.session.start(startArgs);
    await clock.advance(11 * MIN);
    calls.keys = 0;
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(42, 61),
      changed: ["rateLimits"],
    });
    expect(calls.sets).toHaveLength(1);
    expect((calls.sets[0]?.value as Row[]).length).toBe(2);
    expect(calls.keys).toBe(1);
  });

  test("re-reads other keys at most once per 10 minutes", async ($, on) => {
    const { calls, clock } = setup(on);
    await $.session.start(startArgs);
    const measure = (pct: number) =>
      $.session.measure({
        context: { percent: 1, window: 200_000 },
        rateLimits: limits(pct),
        changed: ["rateLimits"],
      });
    await clock.advance(11 * MIN);
    calls.keys = 0;
    await measure(10);
    expect(calls.keys).toBe(1);
    await clock.advance(5 * MIN);
    await measure(11);
    expect(calls.sets).toHaveLength(2);
    expect(calls.keys).toBe(1);
    await clock.advance(10 * MIN);
    await measure(12);
    expect(calls.keys).toBe(2);
  });

  test("another session's rising samples give a forecast", async ($, on) => {
    const other = [0, 1, 2, 3, 4, 5].map((i) =>
      row(NOW - 24 * MIN + i * 4 * MIN, 10 + i * 4),
    );
    const { calls } = setup(on, { "samples:v1:other": other });
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 5, window: 200_000 },
      rateLimits: limits(34),
      changed: ["rateLimits"],
    });
    const status = lastFile(calls).file.windows.five_hour?.forecast.status;
    expect(["runs_out", "spare"]).toContain(status);
  });

  test("the written file read back by the status line gives a forecast", async ($, on) => {
    const other = [0, 1, 2, 3, 4, 5].map((i) =>
      row(NOW - 24 * MIN + i * 4 * MIN, 10 + i * 4),
    );
    const { calls } = setup(on, { "samples:v1:other": other });
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 5, window: 200_000 },
      rateLimits: limits(34),
      changed: ["rateLimits"],
    });
    const { text } = calls.writes.at(-1)!;
    const stdin = {
      context_window: { used_percentage: 5 },
      rate_limits: {
        five_hour: {
          used_percentage: 34,
          resets_at: Math.trunc(RESET_5H / 1000),
        },
      },
    };
    const line = formatLine(
      buildStatusInput(stdin, JSON.parse(text), NOW),
      NOW,
    );
    expect(line).toMatch(/予想|100%→/);
  });

  test("no XDG_RUNTIME_DIR and no TMPDIR -> no file, no throw", async ($, on) => {
    const { calls, control } = setup(on);
    control.env = {};
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 5, window: 200_000 },
      rateLimits: limits(34),
      changed: ["rateLimits"],
    });
    expect(calls.writes).toEqual([]);
    expect(calls.sets).toHaveLength(1);
  });

  test("a refused fs.write logs once, never throws, and is retried", async ($, on) => {
    const { calls, control, clock } = setup(on);
    await $.session.start(startArgs);
    calls.writes.length = 0;
    control.rejectWrites = 2;
    const measure = (pct: number) =>
      $.session.measure({
        context: { percent: 1, window: 200_000 },
        rateLimits: limits(pct),
        changed: ["rateLimits"],
      });
    await measure(10);
    await clock.advance(MIN);
    await measure(11);
    expect(calls.writes).toHaveLength(0);
    expect(
      calls.logs.filter((l) => l.startsWith("usage-line: could not write")),
    ).toHaveLength(1);
    await clock.advance(MIN);
    await measure(12);
    expect(calls.writes).toHaveLength(1);
  });

  test("a changed session id writes the file of the new id", async ($, on) => {
    const { calls, control } = setup(on);
    await $.session.start(startArgs);
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: limits(10),
      changed: ["rateLimits"],
    });
    expect(lastFile(calls).path).toBe("/run/user/1000/usage-line/me.json");
    control.id = "you";
    await $.session.measure({
      context: { window: 200_000 },
      rateLimits: limits(11),
      changed: ["rateLimits"],
    });
    expect(lastFile(calls).path).toBe("/run/user/1000/usage-line/you.json");
  });

  test("session.start deletes expired samples:v1 keys only", async ($, on) => {
    const { calls } = setup(on, {
      "samples:v1:old": [row(NOW - 8 * DAY, 5)],
      "samples:v1:fresh": [row(NOW - DAY, 5)],
      "samples:v2:x": [row(NOW - 8 * DAY, 5)],
      "probe:v1:a": { startedAt: 1 },
    });
    await $.session.start(startArgs);
    expect(calls.deletes).toEqual(["samples:v1:old"]);
  });

  test("a re-read drops vanished keys and keeps the own memory copy", async ($, on) => {
    const other = [0, 1, 2, 3, 4, 5].map((i) =>
      row(NOW - 24 * MIN + i * 4 * MIN, 10 + i * 4),
    );
    const { calls, store, clock } = setup(on, {
      "samples:v1:other": other,
    });
    await $.session.start(startArgs);
    const measure = (pct: number) =>
      $.session.measure({
        context: { percent: 5, window: 200_000 },
        rateLimits: limits(pct),
        changed: ["rateLimits"],
      });
    await measure(34);
    const withOther = lastFile(calls).file.windows.five_hour?.forecast;
    expect(withOther?.reason).toBeNull();

    // The other session ends and the store's copy of ours goes stale.
    store.delete("samples:v1:other");
    store.set("samples:v1:me", "garbage");
    await clock.advance(11 * MIN);
    await measure(35);
    expect(calls.sets.at(-1)?.value).toHaveLength(2); // memory kept, not the store's
    const { file } = lastFile(calls);
    // Only our own two samples (34% then 35% eleven minutes later) remain, so
    // the forecast differs from the one that included the other session.
    const value = formatLine(
      buildStatusInput(
        {
          context_window: { used_percentage: 5 },
          rate_limits: {
            five_hour: {
              used_percentage: 35,
              resets_at: Math.trunc(RESET_5H / 1000),
            },
          },
        },
        file,
        NOW + 11 * MIN,
      ),
      NOW + 11 * MIN,
    );
    expect(value).toBe("ctx 5.0% │ 5h 35.0% 予想 50.3% (reset 15:00)");
    expect(file.windows.five_hour?.forecast).not.toEqual(withOther);
  });

  test("a measure before start (hot reload) keeps the stored samples", async ($, on) => {
    const stored = [3, 2, 1].map((i) => row(NOW - i * 30 * MIN, 10 + i));
    const { calls } = setup(on, { "samples:v1:me": stored });
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(42),
      changed: ["rateLimits"],
    });
    expect(calls.sets).toHaveLength(1);
    expect(calls.sets[0]?.value).toHaveLength(4);
    expect(lastFile(calls).file.windows.five_hour).toBeDefined();
  });

  test("a measure racing session.start loses no samples", async ($, on) => {
    const { calls, clock } = setup(on);
    await Promise.all([
      $.session.start(startArgs),
      $.session.measure({
        context: { window: 200_000 },
        rateLimits: limits(42),
        changed: ["rateLimits"],
      }),
    ]);
    expect(lastFile(calls).file.windows.five_hour).toBeDefined();
    await clock.advance(11 * MIN);
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(43),
      changed: ["rateLimits"],
    });
    expect(calls.sets.at(-1)?.value).toHaveLength(2);
  });

  test("a changed session id writes a new key and leaves the old one", async ($, on) => {
    const { calls, control, clock } = setup(on);
    await $.session.start(startArgs);
    const measure = (pct: number) =>
      $.session.measure({
        context: { percent: 1, window: 200_000 },
        rateLimits: limits(pct),
        changed: ["rateLimits"],
      });
    await measure(10);
    control.id = "me2";
    await clock.advance(MIN);
    await measure(11);
    expect(calls.sets.map((s) => s.key)).toEqual([
      "samples:v1:me",
      "samples:v1:me2",
    ]);
    expect(calls.sets[1]?.value).toHaveLength(1);
  });

  test("a refused store.set logs once, never throws, and is retried", async ($, on) => {
    const { calls, control, clock } = setup(on);
    await $.session.start(startArgs);
    control.rejectSets = 2;
    const measure = (pct: number) =>
      $.session.measure({
        context: { percent: 1, window: 200_000 },
        rateLimits: limits(pct),
        changed: ["rateLimits"],
      });
    await measure(10);
    await clock.advance(MIN);
    await measure(11);
    expect(calls.sets).toHaveLength(0);
    expect(calls.logs.filter((l) => l.startsWith("usage-line"))).toHaveLength(
      1,
    );
    await clock.advance(MIN);
    await measure(12);
    expect(calls.sets).toHaveLength(1);
    expect(calls.sets[0]?.value).toEqual([row(NOW + 2 * MIN, 12)]);
  });

  test("the timer writes a stale forecast 25 minutes + 1ms after the sample", async ($, on) => {
    const other = [0, 1, 2, 3, 4, 5].map((i) =>
      row(NOW - 24 * MIN + i * 4 * MIN, 10 + i * 4),
    );
    const { calls, clock } = setup(on, { "samples:v1:other": other });
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(42),
      changed: ["rateLimits"],
    });
    await clock.advance(25 * MIN);
    expect(lastFile(calls).file.windows.five_hour?.forecast.reason).not.toBe(
      "stale",
    );
    await clock.advance(1);
    const { file } = lastFile(calls);
    expect(file.at).toBe(NOW + 25 * MIN + 1);
    expect(file.windows.five_hour?.forecast.reason).toBe("stale");
  });

  test("PromptHint is not hooked: the tail passes through untouched", async ($, on) => {
    const { control } = setup(on);
    await $.session.start(startArgs);
    await $.session.measure({
      context: { percent: 1, window: 200_000 },
      rateLimits: limits(42),
      changed: ["rateLimits"],
    });
    for (const tail of ["x", undefined]) {
      control.tailSeen = "unset";
      const mounted = await $.ui.mount({
        plugin: "usage-line",
        surface: "terminal",
        component: "PromptHint",
        requestId: "hint",
        props: {
          isDraft: false,
          isWorking: false,
          hint: "? for shortcuts",
          ...(tail === undefined ? {} : { tail }),
        },
      });
      await mounted.unmount();
      expect(control.tailSeen).toBe(tail);
    }
  });
});

function externalSetup(on: On, seed: Record<string, unknown> = {}) {
  const result = setup(on, seed);
  result.control.external = true;
  return result;
}
function externalWrites(calls: { writes: { path: string; text: string }[] }) {
  return calls.writes.filter((w) => w.path.endsWith("/_external.json"));
}

describe("external usage", () => {
  test("only timers fetch, stamping attempt before run and writing mod time", async ($, on) => {
    const { calls, store, clock } = externalSetup(on);
    await $.session.start(startArgs);
    await $.session.measure({
      context: { window: 200000 },
      rateLimits: [],
      changed: [],
    });
    expect(calls.runs).toHaveLength(0);
    await clock.advance(0);
    expect(calls.runs).toEqual([
      {
        argv: [
          "ai-usage",
          "codex",
          "opencode",
          "cursor",
          "--summary",
          "--timeout",
          "8",
        ],
        timeoutMs: 60000,
      },
    ]);
    expect(store.get("external:v1")).toEqual({ attemptAt: NOW });
    expect(calls.attemptsAtRun).toEqual([{ attemptAt: NOW }]);
    expect(JSON.parse(externalWrites(calls)[0]?.text ?? "null")).toMatchObject({
      v: 1,
      fetchedAt: NOW,
    });
    expect(calls.sets.map((s) => s.key)).toEqual(["external:v1"]);
  });
  test("299 seconds skips, 301 seconds fetches at the first tick", async ($, on) => {
    const { calls, clock, store } = externalSetup(on, {
      "external:v1": { attemptAt: NOW - 299000 },
    });
    await $.session.start(startArgs);
    await clock.advance(0);
    expect(calls.runs).toHaveLength(0);
    store.set("external:v1", { attemptAt: NOW - 241000 });
    await clock.advance(MIN);
    expect(calls.runs).toHaveLength(1);
  });
  test("future timestamp fetches and old sample cleanup preserves external key", async ($, on) => {
    const { calls, clock, store } = externalSetup(on, {
      "external:v1": { attemptAt: NOW + 3600000 },
      "samples:v1:old": [row(NOW - 90 * DAY, 4)],
    });
    await $.session.start(startArgs);
    expect(store.has("external:v1")).toBe(true);
    await clock.advance(0);
    expect(calls.runs).toHaveLength(1);
    expect(calls.deletes).not.toContain("external:v1");
  });
  test("store get rejection releases in-flight for the next tick", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    control.rejectGets = 1;
    await $.session.start(startArgs);
    await clock.advance(0);
    expect(calls.runs).toHaveLength(0);
    await clock.advance(MIN);
    expect(calls.runs).toHaveLength(1);
  });
  test("in-flight is set before store.get can yield across a tick", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    let release: () => void = () => {};
    control.pendingGet = new Promise<void>((resolve) => {
      release = resolve;
    });
    await $.session.start(startArgs);
    await clock.advance(0);
    await clock.advance(MIN);
    expect(calls.runs).toHaveLength(0);
    release();
    control.pendingGet = null;
    await clock.settle();
    expect(calls.runs).toHaveLength(1);
  });

  test("pending run spans ticks without overlapping; later run is possible", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    let release: () => void = () => {};
    control.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await $.session.start(startArgs);
    await clock.advance(0);
    await clock.advance(2 * MIN);
    expect(calls.runs).toHaveLength(1);
    release();
    control.pending = null;
    await clock.advance(3 * MIN);
    expect(calls.runs).toHaveLength(2);
  });
  test("run rejections keep attempt, log once and release the flag", async ($, on) => {
    const { calls, store, clock, control } = externalSetup(on);
    control.rejectRuns = 2;
    await $.session.start(startArgs);
    await clock.advance(0);
    expect(externalWrites(calls)).toHaveLength(0);
    expect(store.get("external:v1")).toEqual({ attemptAt: NOW });
    await clock.advance(5 * MIN);
    expect(calls.runs).toHaveLength(2);
    expect(calls.logs.filter((l) => l.includes("run-rejected"))).toEqual([
      "usage-line: external run-rejected",
    ]);
    expect(calls.logs.some((l) => l.includes("secret"))).toBe(false);
  });
  test("bad output and write rejections log each kind once", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    control.stdout = "broken";
    await $.session.start(startArgs);
    await clock.advance(0);
    await clock.advance(5 * MIN);
    expect(externalWrites(calls)).toHaveLength(0);
    expect(calls.logs.filter((l) => l.includes("bad-output"))).toHaveLength(1);
    control.stdout = '{"providers":{}}';
    control.rejectWrites = 1;
    await clock.advance(5 * MIN);
    control.rejectWrites = 1;
    await clock.advance(5 * MIN);
    expect(calls.logs.filter((l) => l.includes("write-rejected"))).toHaveLength(
      1,
    );
  });
  test("store set rejection skips fetching", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    await $.session.start(startArgs);
    control.rejectSets = 1;
    await clock.advance(0);
    expect(calls.runs).toHaveLength(0);
  });
  test("no private runtime directory skips fetching", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    control.env = { TMPDIR: "/tmp" };
    await $.session.start(startArgs);
    await clock.advance(0);
    expect(calls.runs).toHaveLength(0);
  });
  test("repeated session start cancels previous timers", async ($, on) => {
    const { calls, clock, control } = externalSetup(on);
    control.rejectRuns = 10;
    await $.session.start(startArgs);
    await $.session.start(startArgs);
    await clock.advance(0);
    expect(calls.runs).toHaveLength(1);
    await clock.advance(5 * MIN);
    expect(calls.runs).toHaveLength(2);
  });
});
