import { expect, test } from "claude-code/testing";
import { forecastUsage, type RateLimitSample } from "./forecast";
import { buildLineInput } from "./line";
import { mergeAll } from "./samples";

const MIN = 60_000;
const HOUR = 3_600_000;
const now = new Date(2026, 9, 22, 14, 0, 0).getTime();
const resetsAt = (now + 2 * HOUR) / 1000;

function sample(minutesAgo: number, usedPercent: number): RateLimitSample {
  return {
    window: "five_hour",
    sampledAt: now - minutesAgo * MIN,
    usedPercent,
    resetsAt,
  };
}

test("builds latest and forecast from the same series", async () => {
  const merged = [20, 15, 10, 5, 0].map((ago, i) => sample(ago, 10 + i * 2));
  const input = buildLineInput(merged, 30, now);
  expect(input.contextPercent).toBe(30);
  expect(input.windows.five_hour.latest).toEqual(merged.at(-1)!);
  expect(input.windows.five_hour.forecast).toEqual(
    forecastUsage(merged, "five_hour", now),
  );
  expect(input.windows.five_hour.forecast.reason).toBe(null);
});

test("with equal sampledAt the last merged sample is both the latest and the forecast's latest", async () => {
  // forecastUsage stable-sorts by sampledAt and takes the tail, as latestUsage does.
  const byKey = new Map<string, RateLimitSample[]>();
  byKey.set("a", [sample(20, 40), sample(10, 45), sample(0, 50)]);
  byKey.set("b", [sample(0, 49)]);
  const merged = mergeAll(byKey);
  const input = buildLineInput(merged, null, now);
  expect(input.windows.five_hour.latest?.usedPercent).toBe(49);
  expect(input.windows.five_hour.forecast).toEqual(
    forecastUsage(merged, "five_hour", now),
  );
  expect(input.windows.seven_day.latest).toBe(null);
  expect(input.windows.seven_day.forecast.reason).toBe("no_data");
});
