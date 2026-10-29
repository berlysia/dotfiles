import {
  DEFAULT_SINCE_DAYS,
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
  RECORD_GAP_POINTS,
  SURPLUS_MIN_POINTS,
  WEEK_LOOKAHEAD_HOURS,
} from "./constants.ts";
import {
  enoughRecords,
  formatLapse,
  formatRates,
  groupLabel,
  groupsForCell,
  lapseGroups,
  lapseTooHigh,
  mergeGroups,
  percent,
  rateLeadsBy,
  representative,
  successes,
  groupKey,
  type GroupStats,
} from "./aggregate.ts";
import type {
  AheadBy,
  Lookahead,
  PaceState,
  ProviderName,
  ProviderPace,
} from "./pace.ts";
import {
  DESTINATIONS,
  type Destination,
  type DestinationName,
} from "./destinations.ts";
import type { Folded, ReviewDue, SkipCounts } from "./store.ts";
import { reviewPromptLine } from "./store.ts";

export const ROUTE_HEADER = "delegation route v1";

type External = Exclude<ProviderName, "claude">;
export {
  DESTINATIONS,
  type Destination,
  type DestinationName,
} from "./destinations.ts";
/**
 * Destinations route never recommends. opencode sends the brief and the
 * working tree to Z.ai; it waits until a delegation can say whether its
 * content may leave the machine.
 */
export const HELD_DESTINATIONS: ReadonlySet<DestinationName> = new Set([
  "opencode",
]);
const NO_HOLD: ReadonlySet<DestinationName> = new Set();
const SONNET_DISPLAY = 'sonnet (Agent の model: "sonnet")';
const OPENCODE_FIRST = new Set(["mechanical", "triage"]);
// Kinds whose work can wait for an idle quota at any size.
const SURPLUS_KINDS = new Set(["mechanical", "triage", "draft"]);

const inDestination = (d: Destination, g: GroupStats) =>
  g.harness === d.match.harness &&
  (d.match.model === undefined || g.model === d.match.model) &&
  (d.match.effort === undefined || g.effort === d.match.effort);
const destinationStats = (d: Destination, groups: readonly GroupStats[]) =>
  mergeGroups(groups.filter((g) => inDestination(d, g)));

export type RouteInput = {
  kind: string;
  size: string;
  now: Date;
  folded: Folded;
  /** claude is already the pace after the lookahead was applied. */
  paces: Record<ProviderName, ProviderPace>;
  claudeAheadBy: AheadBy | null;
  lookahead: Lookahead | null;
  /** Week points that will not be spent by the reset; null when unknown. */
  surplus: Record<External, number | null>;
  pendingTotal: number;
  pendingSession: number | null;
  skipped: SkipCounts;
  ledgerLarge: boolean;
  due: ReviewDue | null;
  /** ai-usage's window-length constants could not be imported. */
  windowMinsMissing: boolean;
  /** ai-usage could not be run or its output could not be read. */
  usageMissing: boolean;
  /** Destinations left out of every rule and candidate; none when omitted. */
  held?: ReadonlySet<DestinationName>;
};

const bothUnder = (p: ProviderPace) =>
  p.fiveHour === "under" && p.weekly === "under";
const label = (s: PaceState) => s;

function externalOrder(
  kind: string,
  held: ReadonlySet<DestinationName> = NO_HOLD,
): Destination[] {
  const names: DestinationName[] = OPENCODE_FIRST.has(kind)
    ? ["opencode", "codex-luna-max", "codex-terra"]
    : ["codex-terra", "codex-luna-max", "opencode"];
  return names.filter((n) => !held.has(n)).map((n) => DESTINATIONS[n]);
}

type Pick = { line: string; dest: External | "sonnet" };

export type RecordPick = {
  dest: Destination;
  /** The destination's merged group. */
  rep: GroupStats;
  /** The sonnet group with the most records. */
  claude: GroupStats;
};

/**
 * Rule 1 without the pace check, so it can be re-run on the ledger as it stood
 * on an earlier day. `allowed` lets route drop destinations before the best
 * one is chosen; a pace check applied afterwards would change the winner.
 */
function pickByRecords(
  groups: GroupStats[],
  kind: string,
  allowed: (dest: Destination) => boolean,
): RecordPick | null {
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  if (claude === null || !enoughRecords(claude)) return null;
  let best: { dest: Destination; rep: GroupStats } | null = null;
  for (const dest of externalOrder(kind)) {
    const rep = destinationStats(dest, groups);
    if (rep === null || !enoughRecords(rep) || lapseTooHigh(rep)) continue;
    if (!allowed(dest)) continue;
    if (!rateLeadsBy(rep, claude, RECORD_GAP_POINTS)) continue;
    if (
      best === null ||
      successes(rep) * best.rep.n > successes(best.rep) * rep.n
    ) {
      best = { dest, rep };
    }
  }
  return best === null ? null : { ...best, claude };
}

export const recordRuleOne = (
  groups: GroupStats[],
  kind: string,
): RecordPick | null => pickByRecords(groups, kind, () => true);

function ruleOne(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  held: ReadonlySet<DestinationName>,
): Pick | null {
  const best = pickByRecords(
    groups,
    kind,
    (d) => !held.has(d.name) && bothUnder(paces[d.provider]),
  );
  if (best === null) return null;
  const { claude } = best;
  return {
    dest: best.dest.provider,
    line: `推奨: ${best.dest.display} [規則 1: 記録] ${kind}×${size} の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件) が sonnet の ${percent(successes(claude), claude.n)}% (${claude.n} 件) より ${RECORD_GAP_POINTS}pt 以上高い`,
  };
}

function ruleTwo(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  claudeAheadBy: AheadBy | null,
  held: ReadonlySet<DestinationName>,
): Pick | null {
  const claudeWeek = paces.claude.weekly;
  if (claudeWeek !== "ahead" && claudeWeek !== "exhausted") return null;
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  for (const dest of externalOrder(kind, held)) {
    if (!bothUnder(paces[dest.provider])) continue;
    const rep = destinationStats(dest, groups);
    const worse =
      claude !== null &&
      rep !== null &&
      enoughRecords(claude) &&
      enoughRecords(rep) &&
      rateLeadsBy(claude, rep, RECORD_GAP_POINTS);
    const basis = claudeAheadBy === "lookahead" ? " (先読み)" : "";
    return {
      dest: dest.provider,
      line: `推奨: ${dest.display} [規則 2: Claude の週枠が ahead${basis}]${worse ? " 記録では劣る (Claude の枠を設計判断とメインループに残すことを優先)" : ""}`,
    };
  }
  return {
    dest: "sonnet",
    line: `推奨: ${SONNET_DISPLAY} [規則 2 の外部は全部 ahead / exhausted / unknown] 全部 ahead。急がない委譲は後へ`,
  };
}

function explore(
  folded: Folded,
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  now: Date,
  held: ReadonlySet<DestinationName>,
): { name: External; line: string } | null {
  if (size !== "S") return null;
  const groups = groupsForCell(folded, kind, "S", now, EXPLORE_WINDOW_DAYS);
  // Least-recorded first; strict < keeps the default order on equal counts.
  let least: { dest: Destination; count: number } | null = null;
  for (const dest of externalOrder(kind, held)) {
    if (!bothUnder(paces[dest.provider])) continue;
    const count = destinationStats(dest, groups)?.n ?? 0;
    if (
      count < EXPLORE_MIN_RECORDS &&
      (least === null || count < least.count)
    ) {
      least = { dest, count };
    }
  }
  if (least !== null) {
    return {
      name: least.dest.provider,
      line: `試す候補: ${least.dest.display} ${kind}×S の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${least.count}/${EXPLORE_MIN_RECORDS} 件。比較に件数が足りない`,
    };
  }
  return null;
}

/** Whole points of an external's unspent week when it is worth trying, else null. */
function surplusCandidate(
  input: RouteInput,
  name: External,
  recommended: External | "sonnet",
): number | null {
  if (!SURPLUS_KINDS.has(input.kind)) return null;
  if (name === recommended || !bothUnder(input.paces[name])) return null;
  const points = input.surplus[name];
  if (points === null || points < SURPLUS_MIN_POINTS) return null;
  return Math.floor(points);
}

const oneDecimal = (x: number) => Math.max(0, x).toFixed(1);

function lookaheadLine(l: Lookahead): string {
  if (!l.read.ok) return `  先読み: 使えない (${l.read.reason})`;
  const toLine =
    l.hoursToLine === "over"
      ? "目安を超えている"
      : l.hoursToLine === null
        ? "今週は目安を超えない"
        : `目安を超えるまで ${oneDecimal(l.hoursToLine)}h`;
  const close = l.tooCloseToReset
    ? ` (リセットまで ${WEEK_LOOKAHEAD_HOURS}h 未満: 使わない)`
    : "";
  return `  先読み: claude 週 速さ ${oneDecimal(l.read.ratePerHour)}pt/h (観測 ${oneDecimal(l.read.observedHours)}h) ${toLine}${close}`;
}

/** Everything printed is an enum, a number, or a display name: never stored free text. */
export function buildRoute(input: RouteInput): string[] {
  const { kind, size, now, folded, paces } = input;
  const out: string[] = [ROUTE_HEADER];
  if (input.ledgerLarge) out.push("台帳が大きい。分割を検討");

  const groups = groupsForCell(folded, kind, size, now, DEFAULT_SINCE_DAYS);
  const held = input.held ?? NO_HOLD;
  const pick = ruleOne(groups, paces, kind, size, held) ??
    ruleTwo(groups, paces, kind, input.claudeAheadBy, held) ?? {
      dest: "sonnet" as const,
      line: `推奨: ${SONNET_DISPLAY} [規則 3: 既定]`,
    };
  out.push(pick.line);
  for (const name of held) {
    out.push(
      `保留: ${DESTINATIONS[name].display} 外部へ送ってよいかの区分ができるまで使わない`,
    );
  }
  const candidate = explore(folded, paces, kind, size, now, held);
  const taken = new Set<External>();
  if (candidate !== null) {
    const points = surplusCandidate(input, candidate.name, pick.dest);
    if (points !== null) taken.add(candidate.name);
    out.push(
      points === null
        ? candidate.line
        : `${candidate.line}。週枠の余り ${points}pt`,
    );
  }
  // The week belongs to the provider, so one line per provider, shown as the
  // first of its destinations in this kind's order.
  for (const dest of externalOrder(kind, held)) {
    if (taken.has(dest.provider)) continue;
    taken.add(dest.provider);
    const points = surplusCandidate(input, dest.provider, pick.dest);
    if (points !== null) {
      out.push(
        `試す候補: ${dest.display} 週枠の余り ${points}pt がリセットまでに使われない`,
      );
    }
  }

  const windows = (["claude", "codex", "opencode"] as const)
    .map(
      (n) =>
        `${n} 5h=${label(paces[n].fiveHour)} week=${label(paces[n].weekly)}`,
    )
    .join(" | ");
  out.push(`窓: ${windows}`);
  if (input.lookahead !== null) out.push(lookaheadLine(input.lookahead));
  // Every window reads unknown in both cases; without a cause nobody can tell
  // a stale deployment from a provider outage.
  if (input.usageMissing) {
    out.push(
      "  窓の注意: ai-usage を起動できない、または結果を読めない。ai-usage claude codex opencode --summary を手で確かめる",
    );
  }
  if (input.windowMinsMissing) {
    out.push(
      "  窓の注意: ai-usage の窓の長さを読めない。~/.local/share/ai-usage/summary.ts が古い。引数なしの chezmoi apply で直る",
    );
  }

  out.push(`${kind}×${size} の記録 (直近 ${DEFAULT_SINCE_DAYS} 日):`);
  if (groups.length === 0) out.push("  (記録なし)");
  for (const g of groups) {
    out.push(`  ${groupLabel(g)}: ${formatRates(g)} ${formatLapse(g)}`);
  }
  const inCell = new Set(groups.map(groupKey));
  for (const g of lapseGroups(folded, now, DEFAULT_SINCE_DAYS)) {
    if (!inCell.has(groupKey(g)) && lapseTooHigh(g)) {
      out.push(`  ${groupLabel(g)}: ${formatLapse(g)}`);
    }
  }

  out.push(
    input.pendingSession === null
      ? `記録待ち: 全体 ${input.pendingTotal}`
      : `記録待ち: このセッション ${input.pendingSession} / 全体 ${input.pendingTotal}`,
  );
  const { version, type, broken } = input.skipped;
  if (version + type + broken > 0) {
    out.push(
      `読み飛ばし: v違い ${version} / 知らない type ${type} / 壊れた行 ${broken}`,
    );
  }
  const prompt = reviewPromptLine(input.due);
  if (prompt !== null) out.push(prompt);
  return out;
}
