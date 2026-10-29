import { LAPSE_RATIO_MAX_PERCENT, MIN_RECORDS } from "./constants.ts";
import { displayModel } from "./schema.ts";
import type { Folded, FoldedDelegation } from "./store.ts";

const DAY_MS = 86_400_000;

export type GroupId = { harness: string; model: string; effort: string };

export type GroupStats = GroupId & {
  n: number;
  adopted: number;
  patched: number;
  redone: number;
  discarded: number;
  manual: number;
  /** ms of the newest record, for picking a representative on ties. */
  lastAt: number;
  /** Lapses and delegation rows of the group over every kind and size. */
  lapses: number;
  groupTotal: number;
};

export const groupKey = (g: GroupId) =>
  `${g.harness}\u0000${g.model}\u0000${g.effort}`;

export function groupLabel(g: GroupId): string {
  return `${g.harness}/${displayModel(g.model)}/${g.effort}`;
}

export function withinDays(iso: string, now: Date, days: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= now.getTime() - days * DAY_MS;
}

type Lapses = Map<string, number>;

/** Lapse rows carry no kind or size, so their ratio is per group overall. */
function windowTotals(folded: Folded, now: Date, days: number) {
  const lapses: Lapses = new Map();
  const rows: Lapses = new Map();
  for (const l of folded.lapses) {
    if (!withinDays(l.openedAt ?? l.at, now, days)) continue;
    const k = groupKey(l);
    lapses.set(k, (lapses.get(k) ?? 0) + 1);
  }
  for (const d of folded.delegations) {
    if (!withinDays(d.at, now, days)) continue;
    const k = groupKey(d);
    rows.set(k, (rows.get(k) ?? 0) + 1);
  }
  return { lapses, rows };
}

function emptyStats(id: GroupId): GroupStats {
  return {
    harness: id.harness,
    model: id.model,
    effort: id.effort,
    n: 0,
    adopted: 0,
    patched: 0,
    redone: 0,
    discarded: 0,
    manual: 0,
    lastAt: 0,
    lapses: 0,
    groupTotal: 0,
  };
}

function addTo(stats: GroupStats, d: FoldedDelegation): void {
  stats.n++;
  if (d.verdict === "adopted") stats.adopted++;
  else if (d.verdict === "patched") stats.patched++;
  else if (d.verdict === "redone") stats.redone++;
  else if (d.verdict === "discarded") stats.discarded++;
  if (d.manual) stats.manual++;
  stats.lastAt = Math.max(stats.lastAt, Date.parse(d.at) || 0);
}

function build(
  folded: Folded,
  now: Date,
  days: number,
  pick: (d: FoldedDelegation) => boolean,
): GroupStats[] {
  const totals = windowTotals(folded, now, days);
  const byKey = new Map<string, GroupStats>();
  for (const d of folded.delegations) {
    if (!withinDays(d.at, now, days) || !pick(d)) continue;
    const k = groupKey(d);
    let s = byKey.get(k);
    if (s === undefined) {
      s = emptyStats(d);
      s.lapses = totals.lapses.get(k) ?? 0;
      s.groupTotal = (totals.rows.get(k) ?? 0) + s.lapses;
      byKey.set(k, s);
    }
    addTo(s, d);
  }
  return [...byKey.values()].sort(
    (a, b) => b.n - a.n || groupLabel(a).localeCompare(groupLabel(b)),
  );
}

/** Groups for one kind x size. */
export function groupsForCell(
  folded: Folded,
  kind: string,
  size: string,
  now: Date,
  days: number,
): GroupStats[] {
  return build(folded, now, days, (d) => d.kind === kind && d.size === size);
}

/** Every kind x size cell in the window, with its groups. */
export function allCells(
  folded: Folded,
  now: Date,
  days: number,
): { kind: string; size: string; groups: GroupStats[] }[] {
  const cells = new Map<string, { kind: string; size: string }>();
  for (const d of folded.delegations) {
    if (withinDays(d.at, now, days)) {
      cells.set(`${d.kind}\u0000${d.size}`, { kind: d.kind, size: d.size });
    }
  }
  return [...cells.values()]
    .sort((a, b) => `${a.kind}${a.size}`.localeCompare(`${b.kind}${b.size}`))
    .map((c) => ({
      ...c,
      groups: groupsForCell(folded, c.kind, c.size, now, days),
    }));
}

/** Groups with lapses in the window, whatever their cell. */
export function lapseGroups(
  folded: Folded,
  now: Date,
  days: number,
): GroupStats[] {
  const totals = windowTotals(folded, now, days);
  const ids = new Map<string, GroupId>();
  for (const l of folded.lapses) {
    if (withinDays(l.openedAt ?? l.at, now, days)) ids.set(groupKey(l), l);
  }
  return [...ids.entries()].map(([k, id]) => {
    const s = emptyStats(id);
    s.lapses = totals.lapses.get(k) ?? 0;
    s.groupTotal = (totals.rows.get(k) ?? 0) + s.lapses;
    return s;
  });
}

/** The group with the most records; the newest record breaks ties. */
export function representative(
  groups: readonly GroupStats[],
): GroupStats | null {
  let best: GroupStats | null = null;
  for (const g of groups) {
    if (
      best === null ||
      g.n > best.n ||
      (g.n === best.n && g.lastAt > best.lastAt)
    ) {
      best = g;
    }
  }
  return best;
}

export const successes = (g: GroupStats) => g.adopted + g.patched;
export const enoughRecords = (g: GroupStats) => g.n >= MIN_RECORDS;

/** Integer arithmetic: a boundary such as exactly 30% must not drift on floats. */
export function lapseTooHigh(g: GroupStats): boolean {
  return (
    g.groupTotal > 0 && g.lapses * 100 > LAPSE_RATIO_MAX_PERCENT * g.groupTotal
  );
}

export function percent(num: number, den: number): number {
  return den === 0 ? 0 : Math.round((num * 100) / den);
}

/** True when a's rate beats b's by at least `points`, compared without division. */
export function rateLeadsBy(
  a: GroupStats,
  b: GroupStats,
  points: number,
): boolean {
  return (successes(a) * b.n - successes(b) * a.n) * 100 >= points * a.n * b.n;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] ?? 0)
    : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export function formatRates(g: GroupStats): string {
  if (!enoughRecords(g))
    return `n=${g.n} (手 ${g.manual}) 採用率 n<${MIN_RECORDS} adopted n<${MIN_RECORDS}`;
  return `n=${g.n} (手 ${g.manual}) 採用率 ${percent(successes(g), g.n)}% adopted ${percent(g.adopted, g.n)}%`;
}

export function formatLapse(g: GroupStats): string {
  const pct = percent(g.lapses, g.groupTotal);
  return `lapse ${pct}%${lapseTooHigh(g) ? " (記録漏れが多い)" : ""}`;
}
