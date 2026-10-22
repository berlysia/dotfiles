// Ported from ~/workspace/llm-dashboard/src/usageForecast.ts at commit
// cc79b3bfdb46561f3d849143c1165728dc70bab7. Averaging periods are fixed (5h window: 1h,
// weekly window: 24h) and the per-service checks are dropped: this mod only sees Claude.
const HOUR = 3_600_000;
export const MAX_OBSERVATION_AGE_MS = 25 * 60_000;

export function windowDurationMs(window: RateLimitWindow): number {
  return window === "five_hour" ? 5 * HOUR : 7 * 24 * HOUR;
}

export type RateLimitWindow = "five_hour" | "seven_day";

/** One recorded reading of a window: `sampledAt` in epoch ms, `resetsAt` in epoch seconds. */
export type RateLimitSample = {
  window: RateLimitWindow;
  sampledAt: number;
  usedPercent: number;
  resetsAt: number;
};

/** A window as `session.measure` reported it, before it is stamped with a time. */
export type ObservedWindow = {
  window: RateLimitWindow;
  usedPercent: number;
  resetsAt: number;
};

export type UsageForecast = {
  status: "unknown" | "exhausted" | "runs_out" | "spare";
  reason: "no_data" | "expired" | "stale" | "insufficient_data" | null;
  averagePeriodMs: number;
  observedMs: number;
  ratePerHour: number | null;
  projectedUsedPercent: number | null;
  exhaustionAt: number | null;
};

export type WindowLine = {
  latest: RateLimitSample | null;
  forecast: UsageForecast;
};

export type LineInput = {
  contextPercent: number | null;
  windows: Record<RateLimitWindow, WindowLine>;
};

/** Trailing, time-weighted average of quota increments, in percentage points/hour. */
export function forecastUsage(
  rows: RateLimitSample[],
  window: RateLimitWindow,
  now: number,
): UsageForecast {
  const averagePeriodMs = window === "five_hour" ? HOUR : 24 * HOUR;
  const minimumObservationMs = Math.min(
    averagePeriodMs,
    window === "five_hour" ? 10 * 60_000 : HOUR,
  );
  const forecast: UsageForecast = {
    status: "unknown",
    reason: "no_data",
    averagePeriodMs,
    observedMs: 0,
    ratePerHour: null,
    projectedUsedPercent: null,
    exhaustionAt: null,
  };
  const ordered = rows
    .filter((row) => row.window === window && row.sampledAt <= now)
    .toSorted((a, b) => a.sampledAt - b.sampledAt);
  const latest = ordered.at(-1);
  if (!latest) return forecast;
  const resetsAt = latest.resetsAt * 1000;
  if (resetsAt <= now) return { ...forecast, reason: "expired" };
  if (latest.usedPercent === 100) {
    return {
      ...forecast,
      status: "exhausted",
      reason: null,
      projectedUsedPercent: 100,
    };
  }
  if (now - latest.sampledAt > MAX_OBSERVATION_AGE_MS)
    return { ...forecast, reason: "stale" };

  const startsAt = resetsAt - windowDurationMs(window);
  const cutoff = Math.max(startsAt, now - averagePeriodMs);
  let observedMs = 0;
  let increase = 0;
  // Walk backwards only through the current uninterrupted quota window. A correction,
  // reset, or unobserved gap starts a new segment; none is counted as zero use.
  for (let index = ordered.length - 1; index > 0; index--) {
    const right = ordered[index]!;
    const left = ordered[index - 1]!;
    const duration = right.sampledAt - left.sampledAt;
    if (right.sampledAt <= cutoff) break;
    if (
      left.resetsAt !== latest.resetsAt ||
      right.usedPercent < left.usedPercent ||
      duration > MAX_OBSERVATION_AGE_MS ||
      duration > averagePeriodMs
    )
      break;
    if (duration <= 0) continue;
    const overlap = right.sampledAt - Math.max(left.sampledAt, cutoff);
    observedMs += overlap;
    increase += ((right.usedPercent - left.usedPercent) * overlap) / duration;
  }
  if (observedMs < minimumObservationMs)
    return { ...forecast, reason: "insufficient_data", observedMs };
  const ratePerHour = (increase / observedMs) * HOUR;
  // The unobserved tail is not added to the average's denominator. Extrapolation
  // begins at the last actual observation and is explicitly shown as a prediction.
  const projectedUsedPercent =
    latest.usedPercent + (ratePerHour * (resetsAt - latest.sampledAt)) / HOUR;
  const exhaustionAt =
    ratePerHour > 0
      ? latest.sampledAt + ((100 - latest.usedPercent) / ratePerHour) * HOUR
      : null;
  return {
    status: projectedUsedPercent >= 100 ? "runs_out" : "spare",
    reason: null,
    averagePeriodMs,
    observedMs,
    ratePerHour,
    projectedUsedPercent,
    exhaustionAt:
      exhaustionAt !== null && exhaustionAt <= resetsAt ? exhaustionAt : null,
  };
}
