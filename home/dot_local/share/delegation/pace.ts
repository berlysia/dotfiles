import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AI_USAGE_TIMEOUT_MS,
  FIVE_HOUR_AHEAD_PERCENT,
  WEEK_LINE_EXTRA_DAYS,
} from "./constants.ts";

export type PaceState = "under" | "ahead" | "exhausted" | "unknown";
export type ProviderName = "claude" | "codex" | "opencode";
export const PROVIDERS: readonly ProviderName[] = [
  "claude",
  "codex",
  "opencode",
];

export type Window = { usedPercent: number; resetsAt: string | null };
export type ProviderUsage = {
  fiveHour: Window | null;
  weekly: Window | null;
  exhausted: boolean;
};
export type ProviderPace = { fiveHour: PaceState; weekly: PaceState };
export type WindowMins = { fiveHourMins: number; weekMins: number };

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

function resetsInFuture(w: Window, now: Date): number | null {
  if (w.resetsAt === null) return null;
  const at = Date.parse(w.resetsAt);
  return Number.isFinite(at) && at > now.getTime() ? at : null;
}

/** Line = 100 * min(1, (elapsedDays + 1) / 7): today's share may be spent from the morning. */
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
  const weekMs = weekMins * MIN_MS;
  const elapsedDays = Math.min(
    weekMs / DAY_MS,
    Math.max(0, (weekMs - (resetsAt - now.getTime())) / DAY_MS),
  );
  const daysInWeek = weekMs / DAY_MS;
  const line =
    100 * Math.min(1, (elapsedDays + WEEK_LINE_EXTRA_DAYS) / daysInWeek);
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
  if (resetsInFuture(w, now) === null) return "unknown";
  return w.usedPercent >= FIVE_HOUR_AHEAD_PERCENT ? "ahead" : "under";
}

export function paceProvider(
  usage: ProviderUsage | null,
  now: Date,
  mins: WindowMins | null,
): ProviderPace {
  if (usage === null || mins === null) {
    return { fiveHour: "unknown", weekly: "unknown" };
  }
  return {
    fiveHour: paceFiveHour(usage.fiveHour, usage.exhausted, now),
    weekly: paceWeekly(usage.weekly, usage.exhausted, now, mins.weekMins),
  };
}

function validWindow(raw: unknown): Window | null {
  if (raw === null || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const used = w.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  if (used < 0 || used > 100) return null;
  let resetsAt: string | null = null;
  if (w.resetsAt !== null && w.resetsAt !== undefined) {
    if (typeof w.resetsAt !== "string") return null;
    if (!Number.isFinite(Date.parse(w.resetsAt))) return null;
    resetsAt = w.resetsAt;
  }
  return { usedPercent: used, resetsAt };
}

/** Anything that does not fit becomes null / unknown rather than being trusted. */
export function parseUsageSummary(
  json: unknown,
): Record<ProviderName, ProviderUsage | null> {
  const out: Record<ProviderName, ProviderUsage | null> = {
    claude: null,
    codex: null,
    opencode: null,
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
    if (r.error !== undefined || r.status !== 0) continue;
    try {
      return parseUsageSummary(JSON.parse(r.stdout));
    } catch {
      return parseUsageSummary(null);
    }
  }
  return parseUsageSummary(null);
}
