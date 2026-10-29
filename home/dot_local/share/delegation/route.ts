import {
  DEFAULT_SINCE_DAYS,
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
  RECORD_GAP_POINTS,
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
import type { PaceState, ProviderName, ProviderPace } from "./pace.ts";
import type { Folded, ReviewDue, SkipCounts } from "./store.ts";
import { reviewPromptLine } from "./store.ts";

export const ROUTE_HEADER = "delegation route v1";

type External = Exclude<ProviderName, "claude">;
type DestinationName = "codex-terra" | "codex-luna-max" | "opencode";
type Destination = {
  name: DestinationName;
  /** Which ai-usage window the destination draws on. */
  provider: External;
  /** Records counted for the destination: every field given must equal. */
  match: { harness: string; model?: string; effort?: string };
  /** Fixed text, including the launch command: never built from records. */
  display: string;
};
export const DESTINATIONS: Record<DestinationName, Destination> = {
  "codex-terra": {
    name: "codex-terra",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6.1-terra" },
    display:
      "codex Terra (codex exec -m gpt-6.1-terra -c model_reasoning_effort=high)",
  },
  "codex-luna-max": {
    name: "codex-luna-max",
    provider: "codex",
    match: { harness: "codex-cli", model: "gpt-6-luna", effort: "max" },
    display:
      "codex Luna max (codex exec -m gpt-6-luna -c model_reasoning_effort=max)",
  },
  opencode: {
    name: "opencode",
    provider: "opencode",
    match: { harness: "opencode" },
    display: "opencode (opencode run)",
  },
};
const SONNET_DISPLAY = 'sonnet (Agent の model: "sonnet")';
const OPENCODE_FIRST = new Set(["mechanical", "triage"]);

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
  paces: Record<ProviderName, ProviderPace>;
  pendingTotal: number;
  pendingSession: number | null;
  skipped: SkipCounts;
  ledgerLarge: boolean;
  due: ReviewDue | null;
  /** ai-usage's window-length constants could not be imported. */
  windowMinsMissing: boolean;
  /** ai-usage could not be run or its output could not be read. */
  usageMissing: boolean;
};

const bothUnder = (p: ProviderPace) =>
  p.fiveHour === "under" && p.weekly === "under";
const label = (s: PaceState) => s;

function externalOrder(kind: string): Destination[] {
  const names: DestinationName[] = OPENCODE_FIRST.has(kind)
    ? ["opencode", "codex-luna-max", "codex-terra"]
    : ["codex-terra", "codex-luna-max", "opencode"];
  return names.map((n) => DESTINATIONS[n]);
}

type Pick = { line: string };

function ruleOne(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
): Pick | null {
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
    if (!bothUnder(paces[dest.provider])) continue;
    if (!rateLeadsBy(rep, claude, RECORD_GAP_POINTS)) continue;
    if (
      best === null ||
      successes(rep) * best.rep.n > successes(best.rep) * rep.n
    ) {
      best = { dest, rep };
    }
  }
  if (best === null) return null;
  return {
    line: `推奨: ${best.dest.display} [規則 1: 記録] ${kind}×${size} の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件) が sonnet の ${percent(successes(claude), claude.n)}% (${claude.n} 件) より ${RECORD_GAP_POINTS}pt 以上高い`,
  };
}

function ruleTwo(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
): Pick | null {
  const claudeWeek = paces.claude.weekly;
  if (claudeWeek !== "ahead" && claudeWeek !== "exhausted") return null;
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  for (const dest of externalOrder(kind)) {
    if (!bothUnder(paces[dest.provider])) continue;
    const rep = destinationStats(dest, groups);
    const worse =
      claude !== null &&
      rep !== null &&
      enoughRecords(claude) &&
      enoughRecords(rep) &&
      rateLeadsBy(claude, rep, RECORD_GAP_POINTS);
    return {
      line: `推奨: ${dest.display} [規則 2: Claude の週枠が ahead]${worse ? " 記録では劣る (Claude の枠を設計判断とメインループに残すことを優先)" : ""}`,
    };
  }
  return {
    line: `推奨: ${SONNET_DISPLAY} [規則 2 の外部は全部 ahead / exhausted / unknown] 全部 ahead。急がない委譲は後へ`,
  };
}

function explore(
  folded: Folded,
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  now: Date,
): string | null {
  if (size !== "S") return null;
  const groups = groupsForCell(folded, kind, "S", now, EXPLORE_WINDOW_DAYS);
  // Least-recorded first; strict < keeps the default order on equal counts.
  let least: { dest: Destination; count: number } | null = null;
  for (const dest of externalOrder(kind)) {
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
    return `試す候補: ${least.dest.display} ${kind}×S の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${least.count}/${EXPLORE_MIN_RECORDS} 件。比較に件数が足りない`;
  }
  return null;
}

/** Everything printed is an enum, a number, or a display name: never stored free text. */
export function buildRoute(input: RouteInput): string[] {
  const { kind, size, now, folded, paces } = input;
  const out: string[] = [ROUTE_HEADER];
  if (input.ledgerLarge) out.push("台帳が大きい。分割を検討");

  const groups = groupsForCell(folded, kind, size, now, DEFAULT_SINCE_DAYS);
  const pick = ruleOne(groups, paces, kind, size) ??
    ruleTwo(groups, paces, kind) ?? {
      line: `推奨: ${SONNET_DISPLAY} [規則 3: 既定]`,
    };
  out.push(pick.line);
  const candidate = explore(folded, paces, kind, size, now);
  if (candidate !== null) out.push(candidate);

  const windows = (["claude", "codex", "opencode"] as const)
    .map(
      (n) =>
        `${n} 5h=${label(paces[n].fiveHour)} week=${label(paces[n].weekly)}`,
    )
    .join(" | ");
  out.push(`窓: ${windows}`);
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
