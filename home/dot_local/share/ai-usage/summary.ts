/**
 * Provider-neutral view of the payloads: the 5-hour and weekly windows with
 * the same field names everywhere, so a caller choosing where to delegate
 * does not need a per-provider field map.
 */

import { isRecord } from "./lib.ts";

export type UsageWindow = {
  usedPercent: number;
  /** ISO 8601, or null when the provider gave no usable reset time. */
  resetsAt: string | null;
};

export type ProviderSummary = {
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** True when a window is at 100% or the provider refuses ordinary use. */
  exhausted: boolean;
};

const FIVE_HOUR_MINS = 300;
const WEEK_MINS = 10_080;

function finitePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoFromMs(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function isoFromString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function finish(
  fiveHour: UsageWindow | null,
  weekly: UsageWindow | null,
  refused = false,
): ProviderSummary {
  const full = [fiveHour, weekly].some(
    (w) => w !== null && w.usedPercent >= 100,
  );
  return { fiveHour, weekly, exhausted: refused || full };
}

function claudeWindow(raw: unknown): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = finitePercent(raw.utilization);
  if (usedPercent === null) return null;
  return { usedPercent, resetsAt: isoFromString(raw.resets_at) };
}

export function summarizeClaude(
  data: Record<string, unknown>,
): ProviderSummary {
  return finish(claudeWindow(data.five_hour), claudeWindow(data.seven_day));
}

export function summarizeCodex(data: Record<string, unknown>): ProviderSummary {
  // primary/secondary are slots, not durations; match on windowDurationMins
  // so a plan that reorders or drops a slot is not misread.
  const limits = isRecord(data.rateLimits) ? data.rateLimits : {};
  let fiveHour: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;
  for (const slot of [limits.primary, limits.secondary]) {
    if (!isRecord(slot)) continue;
    const usedPercent = finitePercent(slot.usedPercent);
    if (usedPercent === null) continue;
    const resetsAt =
      typeof slot.resetsAt === "number"
        ? isoFromMs(slot.resetsAt * 1000)
        : null;
    if (slot.windowDurationMins === FIVE_HOUR_MINS)
      fiveHour = { usedPercent, resetsAt };
    if (slot.windowDurationMins === WEEK_MINS)
      weekly = { usedPercent, resetsAt };
  }
  return finish(fiveHour, weekly, data.ordinaryUsageAllowed === false);
}

export function summarizeOpencode(
  data: Record<string, unknown>,
): ProviderSummary {
  const quota = isRecord(data.quota) ? data.quota : {};
  const limits = Array.isArray(quota.limits) ? quota.limits : [];
  const pick = (window: string): UsageWindow | null => {
    const limit = limits.find((l) => isRecord(l) && l.window === window);
    if (!isRecord(limit)) return null;
    const usedPercent = finitePercent(limit.percentage);
    if (usedPercent === null) return null;
    return { usedPercent, resetsAt: isoFromMs(limit.nextResetTime) };
  };
  return finish(pick("5h"), pick("weekly"));
}

export function summarizeCursor(
  data: Record<string, unknown>,
): ProviderSummary {
  const plan = isRecord(data.planInfo) ? data.planInfo : {};
  const period = isRecord(data.periodUsage) ? data.periodUsage : {};
  const usage = isRecord(period.planUsage) ? period.planUsage : {};
  const usedPercent = finitePercent(usage.totalPercentUsed);
  if (
    plan.includedUsagePeriod !== "INCLUDED_USAGE_PERIOD_WEEKLY" ||
    usedPercent === null
  )
    return finish(null, null);
  const ms =
    typeof period.billingCycleEnd === "string"
      ? Number(period.billingCycleEnd)
      : NaN;
  const date = new Date(ms);
  const resetsAt = Number.isFinite(date.getTime()) ? date.toISOString() : null;
  return finish(null, { usedPercent, resetsAt });
}
