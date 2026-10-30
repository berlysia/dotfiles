import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AI_USAGE_TIMEOUT_MS,
  FIVE_HOUR_AHEAD_PERCENT,
  WEEK_LINE_EXTRA_DAYS,
  WEEK_LOOKAHEAD_HOURS,
} from "./constants.ts";
import type { ForecastRead } from "./forecast-file.ts";

export type PaceState = "under" | "ahead" | "exhausted" | "unknown";
export type ProviderName = "claude" | "codex" | "opencode" | "sarashina";
export const PROVIDERS: readonly ProviderName[] = [
  "claude",
  "codex",
  "opencode",
  "sarashina",
];

export type Window = { usedPercent: number; resetsAt: string | null };
export type ProviderUsage = {
  fiveHour: Window | null;
  weekly: Window | null;
  exhausted: boolean;
  /** ai-usage reports reachability only: no window exists to be ahead of. */
  unmetered?: boolean;
};
export type ProviderPace = {
  fiveHour: PaceState;
  weekly: PaceState;
  weeklyLag: number | null;
  unmetered: boolean;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
};
export type WindowMins = { fiveHourMins: number; weekMins: number };

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

function resetsInFuture(w: Window, now: Date): number | null {
  if (w.resetsAt === null) return null;
  const at = Date.parse(w.resetsAt);
  return Number.isFinite(at) && at > now.getTime() ? at : null;
}

/** Line = 100 * min(1, (elapsedDays + 1) / 7) at `atMs`: today's share may be spent from the morning. */
function weekLineAt(
  resetsAtMs: number,
  atMs: number,
  weekMins: number,
): number {
  const weekMs = weekMins * MIN_MS;
  const elapsedDays = Math.min(
    weekMs / DAY_MS,
    Math.max(0, (weekMs - (resetsAtMs - atMs)) / DAY_MS),
  );
  const daysInWeek = weekMs / DAY_MS;
  return 100 * Math.min(1, (elapsedDays + WEEK_LINE_EXTRA_DAYS) / daysInWeek);
}

export function paceWeekly(
  w: Window | null,
  exhausted: boolean,
  now: Date,
  weekMins: number,
): PaceState {
  if (exhausted) return "exhausted";
  if (w === null) return "unknown";
  if (w.usedPercent >= 100) return "exhausted";
  const resetsAt = resetsInFuture(w, now);
  if (resetsAt === null) return "unknown";
  const line = weekLineAt(resetsAt, now.getTime(), weekMins);
  return w.usedPercent <= line ? "under" : "ahead";
}

/** The 5h window refills within hours; only a wall in the middle of work matters. */
export function paceFiveHour(
  w: Window | null,
  exhausted: boolean,
  now: Date,
): PaceState {
  if (exhausted) return "exhausted";
  if (w === null) return "unknown";
  if (w.usedPercent >= 100) return "exhausted";
  // An unused window has not started, so it has no reset yet (Z.ai reports
  // this); nothing spent cannot be ahead. Any use without a reset stays unknown.
  if (w.usedPercent === 0 && w.resetsAt === null) return "under";
  if (resetsInFuture(w, now) === null) return "unknown";
  return w.usedPercent >= FIVE_HOUR_AHEAD_PERCENT ? "ahead" : "under";
}

export function paceProvider(
  usage: ProviderUsage | null,
  now: Date,
  mins: WindowMins | null,
): ProviderPace {
  const unmetered = usage?.unmetered === true;
  const fiveHourResetsAt = usage?.fiveHour?.resetsAt ?? null;
  const weeklyResetsAt = usage?.weekly?.resetsAt ?? null;
  const weeklyLag =
    usage === null || unmetered || mins === null || usage.weekly === null
      ? null
      : (() => {
          const resetsAt = resetsInFuture(usage.weekly, now);
          if (resetsAt === null) return null;
          const elapsedPercent =
            (100 * (mins.weekMins - (resetsAt - now.getTime()) / MIN_MS)) /
            mins.weekMins;
          return elapsedPercent - usage.weekly.usedPercent;
        })();
  const metadata = {
    weeklyLag,
    unmetered,
    fiveHourResetsAt,
    weeklyResetsAt,
  };
  if (usage === null) {
    return { fiveHour: "unknown", weekly: "unknown", ...metadata };
  }
  if (usage.exhausted) {
    const fiveHourFull =
      usage.fiveHour !== null && usage.fiveHour.usedPercent >= 100;
    const weeklyFull = usage.weekly !== null && usage.weekly.usedPercent >= 100;
    if (!fiveHourFull && !weeklyFull) {
      return { fiveHour: "exhausted", weekly: "exhausted", ...metadata };
    }
    return {
      fiveHour: fiveHourFull
        ? "exhausted"
        : paceFiveHour(usage.fiveHour, false, now),
      weekly: weeklyFull
        ? "exhausted"
        : mins === null
          ? "unknown"
          : paceWeekly(usage.weekly, false, now, mins.weekMins),
      ...metadata,
    };
  }
  if (unmetered) {
    return { fiveHour: "under", weekly: "under", ...metadata };
  }
  if (mins === null) {
    return { fiveHour: "unknown", weekly: "unknown", ...metadata };
  }
  return {
    fiveHour: paceFiveHour(usage.fiveHour, false, now),
    weekly: paceWeekly(usage.weekly, false, now, mins.weekMins),
    ...metadata,
  };
}

export type AheadBy = "line" | "lookahead";
export type Lookahead = {
  read: ForecastRead;
  // "over": already above the line now. null: never reached at this rate.
  hoursToLine: number | "over" | null;
  // Fewer than WEEK_LOOKAHEAD_HOURS left before the reset: not applied.
  tooCloseToReset: boolean;
};

/** Strictly above the line: landing exactly on it is still under. */
export function crossesLine(
  used: number,
  rate: number,
  hours: number,
  lineAt: number,
): boolean {
  return used + rate * hours > lineAt;
}

/**
 * Earliest t >= 0 with used + rate * t >= line(now + t). The line rises by
 * `slope` per hour until it reaches 100 at `tc` and is flat after that, so the
 * gap is convex in t and meets the line at most once: before tc through the
 * rising part (a), after tc through the flat part (b). Display only.
 */
function hoursUntilLine(
  used: number,
  rate: number,
  lineNow: number,
  weekHours: number,
  remainingHours: number,
): number | "over" | null {
  if (used >= lineNow) return "over";
  const slope = 100 / weekHours;
  const tc = Math.max(0, (100 - lineNow) / slope);
  const candidates: number[] = [];
  if (rate > slope) {
    const a = (lineNow - used) / (rate - slope);
    if (a <= tc) candidates.push(a);
  }
  if (rate > 0) {
    const b = (100 - used) / rate;
    if (b >= tc) candidates.push(b);
  }
  if (candidates.length === 0) return null;
  const t = Math.min(...candidates);
  return t > remainingHours ? null : t;
}

/**
 * Claude's week only. A week under the line is promoted to ahead when
 * WEEK_LOOKAHEAD_HOURS more at the observed rate would cross the line. ahead
 * and exhausted are never rewritten; unknown has nothing to look ahead from.
 */
export function applyLookahead(
  pace: ProviderPace,
  week: Window | null,
  read: ForecastRead,
  now: Date,
  mins: WindowMins | null,
): {
  pace: ProviderPace;
  aheadBy: AheadBy | null;
  lookahead: Lookahead | null;
} {
  if (pace.weekly === "unknown" || mins === null) {
    return { pace, aheadBy: null, lookahead: null };
  }
  const resetsAt = week === null ? null : resetsInFuture(week, now);
  if (week === null || resetsAt === null) {
    return {
      pace,
      aheadBy: pace.weekly === "ahead" ? "line" : null,
      lookahead: { read, hoursToLine: null, tooCloseToReset: false },
    };
  }
  const nowMs = now.getTime();
  const remainingHours = (resetsAt - nowMs) / HOUR_MS;
  const tooCloseToReset = remainingHours < WEEK_LOOKAHEAD_HOURS;
  const lookahead: Lookahead = {
    read,
    hoursToLine: read.ok
      ? hoursUntilLine(
          week.usedPercent,
          read.ratePerHour,
          weekLineAt(resetsAt, nowMs, mins.weekMins),
          mins.weekMins / 60,
          remainingHours,
        )
      : null,
    tooCloseToReset,
  };
  if (pace.weekly === "ahead") return { pace, aheadBy: "line", lookahead };
  if (pace.weekly !== "under" || !read.ok || tooCloseToReset) {
    return { pace, aheadBy: null, lookahead };
  }
  const lineAhead = weekLineAt(
    resetsAt,
    nowMs + WEEK_LOOKAHEAD_HOURS * HOUR_MS,
    mins.weekMins,
  );
  if (
    !crossesLine(
      week.usedPercent,
      read.ratePerHour,
      WEEK_LOOKAHEAD_HOURS,
      lineAhead,
    )
  ) {
    return { pace, aheadBy: null, lookahead };
  }
  return {
    pace: { ...pace, weekly: "ahead" },
    aheadBy: "lookahead",
    lookahead,
  };
}

function validWindow(raw: unknown): Window | null {
  if (raw === null || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const used = w.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (used < 0) return null;
  let resetsAt: string | null = null;
  if (w.resetsAt !== null && w.resetsAt !== undefined) {
    if (typeof w.resetsAt !== "string") return null;
    if (!Number.isFinite(Date.parse(w.resetsAt))) return null;
    resetsAt = w.resetsAt;
  }
  return { usedPercent: Math.min(100, used), resetsAt };
}

/** Anything that does not fit becomes null / unknown rather than being trusted. */
export function parseUsageSummary(
  json: unknown,
): Record<ProviderName, ProviderUsage | null> {
  const out: Record<ProviderName, ProviderUsage | null> = {
    claude: null,
    codex: null,
    opencode: null,
    sarashina: null,
  };
  if (json === null || typeof json !== "object") return out;
  const providers = (json as Record<string, unknown>).providers;
  if (providers === null || typeof providers !== "object") return out;
  for (const name of PROVIDERS) {
    const entry = (providers as Record<string, unknown>)[name];
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.ok !== true) continue;
    out[name] = {
      fiveHour: validWindow(e.fiveHour),
      weekly: validWindow(e.weekly),
      exhausted: e.exhausted === true,
      unmetered: e.unmetered === true,
    };
  }
  return out;
}

type SummaryModule = { FIVE_HOUR_MINS?: unknown; WEEK_MINS?: unknown };

/** Null when the ai-usage module cannot be imported: every pace is then unknown. */
export async function loadWindowMins(
  importer: () => Promise<SummaryModule> = () =>
    import("../ai-usage/summary.ts"),
): Promise<WindowMins | null> {
  try {
    const m = await importer();
    const { FIVE_HOUR_MINS: five, WEEK_MINS: week } = m;
    if (
      typeof five !== "number" ||
      typeof week !== "number" ||
      !(five > 0) ||
      !(week > 0)
    ) {
      return null;
    }
    return { fiveHourMins: five, weekMins: week };
  } catch {
    return null;
  }
}

/** Runs ai-usage; any failure gives all-null so route still answers. */
export function fetchUsage(
  env: Record<string, string | undefined>,
): Record<ProviderName, ProviderUsage | null> {
  // DELEGATION_AI_USAGE_BIN lets tests substitute a fake.
  const candidates =
    env.DELEGATION_AI_USAGE_BIN !== undefined
      ? [env.DELEGATION_AI_USAGE_BIN]
      : ["ai-usage", join(env.HOME ?? "", ".local", "bin", "ai-usage")];
  for (const bin of candidates) {
    const r = spawnSync(bin, [...PROVIDERS, "--summary"], {
      encoding: "utf8",
      timeout: AI_USAGE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
    });
    // Status 1 means "some provider failed" and still carries the envelope,
    // so one provider's outage must not blank the others' windows. Anything
    // else (2 = bad args, signals, spawn errors) has no envelope to trust.
    if (r.error !== undefined || (r.status !== 0 && r.status !== 1)) continue;
    let json: unknown;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    return parseUsageSummary(json);
  }
  return parseUsageSummary(null);
}
