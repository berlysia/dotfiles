import { expect, test } from "claude-code/testing";
import {
  MAX_OBSERVATION_AGE_MS,
  forecastUsage,
  windowDurationMs,
  type RateLimitSample,
} from "./forecast";

const HOUR = 3_600_000;
const now = Date.parse("2026-10-22T00:00:00Z");

function row(
  minutesAgo: number,
  usedPercent: number,
  overrides: Partial<RateLimitSample> = {},
): RateLimitSample {
  return {
    window: "five_hour",
    sampledAt: now - minutesAgo * 60_000,
    usedPercent,
    resetsAt: (now + 2 * HOUR) / 1000,
    ...overrides,
  };
}

// Samples on a straight line, `intervals` equal steps. The ported cases were written for a
// source whose sparse history is bounded only per service; here every interval is capped at
// MAX_OBSERVATION_AGE_MS, so a long ramp is sampled densely. A straight line keeps the
// time-weighted rate identical to the two-point original.
function ramp(
  startAgo: number,
  endAgo: number,
  startPct: number,
  endPct: number,
  intervals: number,
  overrides: Partial<RateLimitSample> = {},
): RateLimitSample[] {
  return Array.from({ length: intervals + 1 }, (_, i) =>
    row(
      startAgo + ((endAgo - startAgo) * i) / intervals,
      startPct + ((endPct - startPct) * i) / intervals,
      overrides,
    ),
  );
}

function close(actual: number | null, expected: number): void {
  expect(actual !== null && Math.abs(actual - expected) < 0.00001).toBe(true);
}

test("smoke: a sibling module imports without $", async () => {
  expect(MAX_OBSERVATION_AGE_MS).toBe(1_500_000);
});

test("infers window lengths independently of conversation sessions", async () => {
  expect(windowDurationMs("five_hour")).toBe(5 * HOUR);
  expect(windowDurationMs("seven_day")).toBe(168 * HOUR);
});

test("weights irregular observations by time rather than by sample count", async () => {
  const forecast = forecastUsage(
    [row(60, 20), ...ramp(59, 0, 30, 50, 4)],
    "five_hour",
    now,
  );
  close(forecast.ratePerHour, 30);
  close(forecast.projectedUsedPercent, 110);
  close(forecast.exhaustionAt, now + (50 / 30) * HOUR);
  expect(forecast.status).toBe("runs_out");
  expect(forecast.observedMs).toBe(HOUR);
});

test("clips the interval at the trailing hour and moves the cutoff with time", async () => {
  const rows = [...ramp(90, 30, 10, 40, 3), ...ramp(30, 0, 40, 70, 2).slice(1)];
  const first = forecastUsage(rows, "five_hour", now);
  close(first.ratePerHour, 45);
  const later = forecastUsage(
    [...rows, ...ramp(0, -30, 70, 70, 2).slice(1)],
    "five_hour",
    now + HOUR / 2,
  );
  close(later.ratePerHour, 30);
});

test("predicts spare quota for a slower pace and handles observed zero growth", async () => {
  const slow = forecastUsage(ramp(60, 0, 20, 30, 4), "five_hour", now);
  expect(slow.status).toBe("spare");
  close(slow.ratePerHour, 10);
  close(slow.projectedUsedPercent, 50);
  expect(slow.exhaustionAt).toBe(null);
  const flat = forecastUsage(ramp(60, 0, 30, 30, 4), "five_hour", now);
  close(flat.ratePerHour, 0);
  close(flat.projectedUsedPercent, 30);
  expect(flat.status).toBe("spare");
});

test("does not mix resets or infer a zero-valued observation at window start", async () => {
  const forecast = forecastUsage(
    [row(90, 90, { resetsAt: now / 1000 - 1 }), row(0, 20)],
    "five_hour",
    now,
  );
  expect(forecast.reason).toBe("insufficient_data");
  expect(forecast.ratePerHour).toBe(null);
  expect(forecast.projectedUsedPercent).toBe(null);
});

test("restarts observation after a decrease even when reset time has not changed", async () => {
  const forecast = forecastUsage(
    [row(60, 70), ...ramp(30, 0, 20, 30, 2)],
    "five_hour",
    now,
  );
  close(forecast.ratePerHour, 20);
  expect(forecast.observedMs).toBe(HOUR / 2);
});

test("missing intervals are not zero use", async () => {
  const gap = forecastUsage([row(60, 20), row(0, 30)], "five_hour", now);
  expect(gap.reason).toBe("insufficient_data");
});

test("does not count the unobserved tail as zero consumption", async () => {
  const forecast = forecastUsage(ramp(60, 10, 20, 30, 3), "five_hour", now);
  close(forecast.ratePerHour, 12);
  close(forecast.projectedUsedPercent, 56);
  expect(forecast.observedMs).toBe(50 * 60_000);
});

test("withholds forecasts for stale, expired, missing, future or short histories", async () => {
  expect(forecastUsage([], "five_hour", now).reason).toBe("no_data");
  expect(forecastUsage([row(-1, 20)], "five_hour", now).reason).toBe("no_data");
  expect(
    forecastUsage([row(60, 20), row(26, 30)], "five_hour", now).reason,
  ).toBe("stale");
  expect(forecastUsage([row(5, 20), row(0, 30)], "five_hour", now).reason).toBe(
    "insufficient_data",
  );
  expect(
    forecastUsage([row(1, 30, { resetsAt: now / 1000 })], "five_hour", now)
      .reason,
  ).toBe("expired");
});

test("weekly pace uses a trailing day and requires at least an hour of observations", async () => {
  const weekly = {
    window: "seven_day" as const,
    resetsAt: (now + 4 * 24 * HOUR) / 1000,
  };
  const forecast = forecastUsage(
    ramp(24 * 60, 0, 10, 34, 72, weekly),
    "seven_day",
    now,
  );
  close(forecast.ratePerHour, 1);
  close(forecast.projectedUsedPercent, 130);
  expect(forecast.averagePeriodMs).toBe(24 * HOUR);
  expect(forecast.status).toBe("runs_out");
  expect(
    forecastUsage(ramp(30, 0, 10, 11, 2, weekly), "seven_day", now).reason,
  ).toBe("insufficient_data");
});

test("100 percent is reported as exhausted without inventing the time of exhaustion", async () => {
  const forecast = forecastUsage([row(0, 100)], "five_hour", now);
  expect(forecast.status).toBe("exhausted");
  expect(forecast.exhaustionAt).toBe(null);
  expect(forecast.ratePerHour).toBe(null);
});
