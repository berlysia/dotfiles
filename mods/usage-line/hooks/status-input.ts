// The contract between the mod (writer of the forecast file) and statusline.ts
// (reader), plus how the reader turns the status line's stdin and that file
// into the input of `formatLine`. Shared by both sides, so it must import
// neither `node:*` nor `$`.
//
// Version rule: adding a field does not bump `v` and readers ignore unknown
// keys; only a change of meaning or a removal bumps it. A reader neither uses
// nor deletes a file whose `v` differs.
import {
  FORECAST_REASONS,
  FORECAST_STATUSES,
  MAX_OBSERVATION_AGE_MS,
  type LineInput,
  type RateLimitWindow,
  type UsageForecast,
  type WindowLine,
} from "./forecast";

export type ForecastFile = {
  v: 1;
  /** Epoch ms, when the mod wrote the file. */
  at: number;
  windows: Partial<
    Record<
      RateLimitWindow,
      {
        /** Epoch seconds, the same unit as the status line's `resets_at`. */
        resetsAt: number;
        forecast: UsageForecast;
      }
    >
  >;
};

const DAY_MS = 86_400_000;
// A file stamped further in the future than this is a clock skew or garbage.
const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_FORECAST_FILE_BYTES = 64 * 1024;
const WINDOW_KEYS: readonly RateLimitWindow[] = ["five_hour", "seven_day"];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

function isNullOr(
  value: unknown,
  test: (v: unknown) => boolean,
): value is null {
  return value === null || test(value);
}

function isNonNegative(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0;
}

function parseForecast(value: unknown, now: number): UsageForecast | null {
  if (!isObject(value)) return null;
  const {
    status,
    reason,
    averagePeriodMs,
    observedMs,
    ratePerHour,
    projectedUsedPercent,
    exhaustionAt,
  } = value;
  const statusOk = FORECAST_STATUSES.find((s) => s === status);
  if (statusOk === undefined) return null;
  const reasonOk =
    reason === null ? null : FORECAST_REASONS.find((r) => r === reason);
  if (reasonOk === undefined) return null;
  if (!isNonNegative(averagePeriodMs) || !isNonNegative(observedMs))
    return null;
  if (!isNullOr(ratePerHour, isNonNegative)) return null;
  // Not capped at 100: a runs_out projection goes past it (e.g. 600).
  if (!isNullOr(projectedUsedPercent, isNonNegative)) return null;
  const exhaustionOk = (v: unknown) =>
    isFiniteNumber(v) && v >= now - DAY_MS && v <= now + 8 * DAY_MS;
  if (!isNullOr(exhaustionAt, exhaustionOk)) return null;
  return {
    status: statusOk,
    reason: reasonOk,
    averagePeriodMs: averagePeriodMs as number,
    observedMs: observedMs as number,
    ratePerHour: ratePerHour as number | null,
    projectedUsedPercent: projectedUsedPercent as number | null,
    exhaustionAt: exhaustionAt as number | null,
  };
}

/**
 * Validates the parsed JSON of a forecast file. Returns null when the file as
 * a whole is unusable (wrong version, bad or out-of-range `at`); a window
 * whose entry is malformed is dropped on its own.
 */
export function parseForecastFile(
  value: unknown,
  now: number,
): ForecastFile | null {
  if (!isObject(value) || value.v !== 1) return null;
  const { at, windows } = value;
  if (!isFiniteNumber(at)) return null;
  const age = now - at;
  if (age < -MAX_FUTURE_SKEW_MS || age > MAX_OBSERVATION_AGE_MS) return null;
  if (!isObject(windows)) return null;
  const parsed: ForecastFile["windows"] = {};
  for (const key of WINDOW_KEYS) {
    const entry = windows[key];
    if (!isObject(entry) || !isFiniteNumber(entry.resetsAt)) continue;
    const forecast = parseForecast(entry.forecast, now);
    if (forecast === null) continue;
    parsed[key] = { resetsAt: entry.resetsAt, forecast };
  }
  return { v: 1, at, windows: parsed };
}

/** Whether a file's stat says it may be read: a regular file of ours, not huge. */
export function isForecastFileReadable(
  stat: { isFile: boolean; uid: number; size: number },
  uid: number,
): boolean {
  return (
    stat.isFile && stat.uid === uid && stat.size <= MAX_FORECAST_FILE_BYTES
  );
}

function noForecast(): UsageForecast {
  return {
    status: "unknown",
    reason: "no_data",
    averagePeriodMs: 0,
    observedMs: 0,
    ratePerHour: null,
    projectedUsedPercent: null,
    exhaustionAt: null,
  };
}

function readWindow(
  stdin: Obj,
  window: RateLimitWindow,
  now: number,
): { usedPercent: number; resetsAt: number } | null {
  const limits = stdin.rate_limits;
  if (!isObject(limits)) return null;
  const entry = limits[window];
  if (!isObject(entry)) return null;
  const { used_percentage: used, resets_at: resets } = entry;
  if (!isPercent(used) || !isFiniteNumber(resets)) return null;
  const resetsMs = resets * 1000;
  if (resetsMs < now - DAY_MS || resetsMs > now + 8 * DAY_MS) return null;
  return { usedPercent: used, resetsAt: Math.trunc(resets) };
}

/**
 * Builds the line's input: usage and context from the status line's stdin
 * (always current), forecasts from the mod's file when it is fresh and was
 * written for the same reset. Never throws.
 */
export function buildStatusInput(
  stdin: unknown,
  file: unknown,
  now: number,
): LineInput {
  const empty: Record<RateLimitWindow, WindowLine> = {
    five_hour: { latest: null, forecast: noForecast() },
    seven_day: { latest: null, forecast: noForecast() },
  };
  try {
    if (!isObject(stdin)) return { contextPercent: null, windows: empty };
    const context = isObject(stdin.context_window)
      ? stdin.context_window.used_percentage
      : null;
    const parsedFile = parseForecastFile(file, now);
    const windows = { ...empty };
    for (const window of WINDOW_KEYS) {
      const observed = readWindow(stdin, window, now);
      if (observed === null) continue;
      const stored = parsedFile?.windows[window];
      windows[window] = {
        latest: { window, sampledAt: now, ...observed },
        forecast:
          stored !== undefined && stored.resetsAt === observed.resetsAt
            ? stored.forecast
            : noForecast(),
      };
    }
    return {
      contextPercent: isPercent(context) ? context : null,
      windows,
    };
  } catch {
    return { contextPercent: null, windows: empty };
  }
}
