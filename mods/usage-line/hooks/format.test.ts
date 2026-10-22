import { expect, test } from "claude-code/testing";
import {
  MAX_OBSERVATION_AGE_MS,
  type LineInput,
  type RateLimitWindow,
  type UsageForecast,
  type WindowLine,
} from "./forecast";
import { formatLine } from "./format";

const MIN = 60_000;
const now = new Date(2026, 9, 22, 13, 0, 0).getTime();
const local = (h: number, m: number) =>
  new Date(2026, 9, 22, h, m, 0).getTime();
// 2026-10-22 is a Thursday.
const resetFive = local(16, 0) / 1000;
const resetWeek = local(9, 0) / 1000;

function forecast(overrides: Partial<UsageForecast>): UsageForecast {
  return {
    status: "unknown",
    reason: null,
    averagePeriodMs: 0,
    observedMs: 0,
    ratePerHour: null,
    projectedUsedPercent: null,
    exhaustionAt: null,
    ...overrides,
  };
}

function line(
  window: RateLimitWindow,
  usedPercent: number,
  f: Partial<UsageForecast>,
  sampledAt = now - MIN,
): WindowLine {
  return {
    latest: {
      window,
      sampledAt,
      usedPercent,
      resetsAt: window === "five_hour" ? resetFive : resetWeek,
    },
    forecast: forecast(f),
  };
}

const none: WindowLine = {
  latest: null,
  forecast: forecast({ reason: "no_data" }),
};
const expired = (window: RateLimitWindow, sampledAt = now - MIN): WindowLine =>
  line(window, 42, { reason: "expired" }, sampledAt);

function input(
  ctx: number | null,
  five: WindowLine,
  week: WindowLine,
): LineInput {
  return { contextPercent: ctx, windows: { five_hour: five, seven_day: week } };
}

test("full line: runs_out and spare", async () => {
  const result = formatLine(
    input(
      34.9,
      line("five_hour", 42.9, {
        status: "runs_out",
        exhaustionAt: local(14, 10),
      }),
      line("seven_day", 61.2, { status: "spare", projectedUsedPercent: 88.7 }),
    ),
    now,
  );
  expect(result).toBe(
    "ctx 34.9% │ 5h 42.9% 100%→14:10 (reset 16:00) │ 週 61.2% 予想 88.7% (reset 木 09:00)",
  );
});

test("runs_out without exhaustionAt falls back to the reset time", async () => {
  const result = formatLine(
    input(null, line("five_hour", 42, { status: "runs_out" }), none),
    now,
  );
  expect(result).toBe("5h 42.0% 100%→16:00 (reset 16:00)");
});

test("exhausted shows no forecast; 99.96 truncates to 99.9", async () => {
  expect(
    formatLine(
      input(null, line("five_hour", 100, { status: "exhausted" }), none),
      now,
    ),
  ).toBe("5h 100.0% (reset 16:00)");
  expect(
    formatLine(
      input(
        null,
        line("five_hour", 99.96, {
          status: "spare",
          projectedUsedPercent: 99.7,
        }),
        none,
      ),
      now,
    ),
  ).toBe("5h 99.9% 予想 99.7% (reset 16:00)");
  expect(
    formatLine(
      input(
        null,
        line("five_hour", 42, {
          status: "spare",
          projectedUsedPercent: 69.99999999999999,
        }),
        none,
      ),
      now,
    ),
  ).toBe("5h 42.0% 予想 70.0% (reset 16:00)");
});

test("unknown shows only the usage, for every reason", async () => {
  for (const reason of ["unknown", "insufficient_data", "stale"] as const) {
    const f =
      reason === "unknown" ? { status: "unknown" as const } : { reason };
    expect(formatLine(input(null, line("five_hour", 42, f), none), now)).toBe(
      "5h 42.0% (reset 16:00)",
    );
  }
});

test("a window without a latest sample is omitted", async () => {
  expect(
    formatLine(
      input(
        null,
        none,
        line("seven_day", 61, { status: "spare", projectedUsedPercent: 70 }),
      ),
      now,
    ),
  ).toBe("週 61.0% 予想 70.0% (reset 木 09:00)");
});

test("expired windows are omitted", async () => {
  const week = line("seven_day", 61, {
    status: "spare",
    projectedUsedPercent: 70,
  });
  expect(formatLine(input(null, expired("five_hour"), week), now)).toBe(
    "週 61.0% 予想 70.0% (reset 木 09:00)",
  );
  expect(
    formatLine(input(34, expired("five_hour"), expired("seven_day")), now),
  ).toBe("ctx 34.0%");
  expect(
    formatLine(input(null, expired("five_hour"), expired("seven_day")), now),
  ).toBe(undefined);
});

test("a note on the newest sample appears only past the staleness limit", async () => {
  const at = (age: number) => line("five_hour", 42, {}, now - age);
  expect(formatLine(input(null, at(MAX_OBSERVATION_AGE_MS), none), now)).toBe(
    "5h 42.0% (reset 16:00)",
  );
  const stale = formatLine(
    input(null, at(MAX_OBSERVATION_AGE_MS + 1), none),
    now,
  );
  const sampledAt = now - MAX_OBSERVATION_AGE_MS - 1;
  const clock = `${String(new Date(sampledAt).getHours()).padStart(2, "0")}:${String(new Date(sampledAt).getMinutes()).padStart(2, "0")}`;
  expect(stale).toBe(`5h 42.0% (reset 16:00) │ ${clock} 時点`);
});

test("an exhausted window alone still gets the note", async () => {
  const sampledAt = now - 30 * MIN;
  expect(
    formatLine(
      input(
        null,
        line("five_hour", 100, { status: "exhausted" }, sampledAt),
        none,
      ),
      now,
    ),
  ).toBe("5h 100.0% (reset 16:00) │ 12:30 時点");
});

test("an expired window's sample does not decide the note", async () => {
  const week = line(
    "seven_day",
    61,
    { status: "spare", projectedUsedPercent: 70 },
    now - 30 * MIN,
  );
  expect(
    formatLine(input(null, expired("five_hour", now - MIN), week), now),
  ).toBe("週 61.0% 予想 70.0% (reset 木 09:00) │ 12:30 時点");
});

test("ctx is omitted when null", async () => {
  expect(
    formatLine(
      input(null, line("five_hour", 42, { status: "unknown" }), none),
      now,
    ),
  ).toBe("5h 42.0% (reset 16:00)");
});
