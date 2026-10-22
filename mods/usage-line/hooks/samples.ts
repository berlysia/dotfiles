import {
  MAX_OBSERVATION_AGE_MS,
  type ObservedWindow,
  type RateLimitSample,
  type RateLimitWindow,
} from "./forecast";

const WINDOW_KINDS = [
  "five_hour",
  "seven_day",
] as const satisfies readonly RateLimitWindow[];
const RECORD_INTERVAL_MS = 600_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_SAMPLES_PER_KEY = 10_000;
const MAX_WAKE_AHEAD_MS = 8 * 24 * 3_600_000;
const KEY_PREFIX = "samples:v1:";

type EncodedSample = [
  sampledAt: number,
  window: 0 | 1,
  usedPercent: number,
  resetsAt: number,
];

/** The only place the engine's `percentUsed` becomes `usedPercent`. */
export function collectWindows(rateLimits: unknown): ObservedWindow[] {
  if (!Array.isArray(rateLimits)) return [];
  const windows: ObservedWindow[] = [];
  for (const kind of WINDOW_KINDS) {
    for (const entry of rateLimits as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const {
        kind: entryKind,
        percentUsed,
        resetsAt,
      } = entry as Record<string, unknown>;
      if (entryKind !== kind) continue;
      if (typeof percentUsed !== "number" || !Number.isFinite(percentUsed))
        continue;
      if (percentUsed < 0 || percentUsed > 100) continue;
      if (typeof resetsAt !== "string") continue;
      const resetsAtMs = Date.parse(resetsAt);
      if (!Number.isFinite(resetsAtMs)) continue;
      windows.push({
        window: kind,
        usedPercent: percentUsed,
        resetsAt: Math.trunc(resetsAtMs / 1000),
      });
      break;
    }
  }
  return windows;
}

export function isRecordDue(
  last: RateLimitSample | undefined,
  observed: ObservedWindow,
  now: number,
): boolean {
  return (
    last === undefined ||
    last.usedPercent !== observed.usedPercent ||
    last.resetsAt !== observed.resetsAt ||
    now - last.sampledAt >= RECORD_INTERVAL_MS
  );
}

export function encode(samples: RateLimitSample[]): EncodedSample[] {
  return samples.map((s) => [
    s.sampledAt,
    s.window === "five_hour" ? 0 : 1,
    s.usedPercent,
    s.resetsAt,
  ]);
}

/** Store values are untrusted: anything malformed is dropped, never thrown on. */
export function decode(value: unknown, now: number): RateLimitSample[] {
  if (!Array.isArray(value)) return [];
  const samples: RateLimitSample[] = [];
  for (const item of value as unknown[]) {
    if (!Array.isArray(item) || item.length !== 4) continue;
    const [sampledAt, window, usedPercent, resetsAt] = item as unknown[];
    if (
      typeof sampledAt !== "number" ||
      typeof window !== "number" ||
      typeof usedPercent !== "number" ||
      typeof resetsAt !== "number"
    )
      continue;
    if (![sampledAt, window, usedPercent, resetsAt].every(Number.isFinite))
      continue;
    if (window !== 0 && window !== 1) continue;
    if (usedPercent < 0 || usedPercent > 100) continue;
    if (sampledAt > now) continue;
    samples.push({
      window: window === 0 ? "five_hour" : "seven_day",
      sampledAt,
      usedPercent,
      resetsAt,
    });
  }
  if (samples.length <= MAX_SAMPLES_PER_KEY) return samples;
  return samples
    .toSorted((a, b) => a.sampledAt - b.sampledAt)
    .slice(-MAX_SAMPLES_PER_KEY);
}

export function mergeAll(
  byKey: Map<string, RateLimitSample[]>,
): RateLimitSample[] {
  const keys = [...byKey.keys()].toSorted();
  return keys
    .flatMap((key) => byKey.get(key) ?? [])
    .toSorted((a, b) => a.sampledAt - b.sampledAt);
}

/** Uses the same `sampledAt <= now` cut as `forecastUsage`, so both read the same sample. */
export function latestUsage(
  merged: RateLimitSample[],
  window: RateLimitWindow,
  now: number,
): RateLimitSample | null {
  return (
    merged.filter((s) => s.window === window && s.sampledAt <= now).at(-1) ??
    null
  );
}

export function pruneOwn(
  samples: RateLimitSample[],
  now: number,
): RateLimitSample[] {
  return samples.filter((s) => now - s.sampledAt <= RETENTION_MS);
}

export function selectKeysToDelete(
  entries: [string, unknown][],
  now: number,
): string[] {
  const doomed: string[] = [];
  for (const [key, value] of entries) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const samples = decode(value, now);
    const newest = samples.reduce(
      (max, s) => Math.max(max, s.sampledAt),
      -Infinity,
    );
    if (samples.length === 0 || now - newest > RETENTION_MS) doomed.push(key);
  }
  return doomed;
}

/** The next instant at which the displayed line changes without a new measure. */
export function nextWakeAt(
  merged: RateLimitSample[],
  now: number,
): number | null {
  const candidates: number[] = [];
  for (const window of WINDOW_KINDS) {
    const latest = latestUsage(merged, window, now);
    if (latest === null) continue;
    candidates.push(
      latest.sampledAt + MAX_OBSERVATION_AGE_MS + 1,
      latest.resetsAt * 1000,
    );
  }
  const upcoming = candidates.filter((at) => at > now);
  if (upcoming.length === 0) return null;
  const earliest = Math.min(...upcoming);
  return earliest > now + MAX_WAKE_AHEAD_MS ? null : earliest;
}
