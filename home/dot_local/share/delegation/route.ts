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
const HARNESS_OF: Record<External, string> = {
  codex: "codex-cli",
  opencode: "opencode",
};
const DESTINATION: Record<External | "sonnet", string> = {
  sonnet: 'sonnet (Agent の model: "sonnet")',
  codex: "codex (codex:codex-rescue)",
  opencode: "opencode (opencode run)",
};
const OPENCODE_FIRST = new Set(["mechanical", "triage"]);

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
};

const bothUnder = (p: ProviderPace) =>
  p.fiveHour === "under" && p.weekly === "under";
const label = (s: PaceState) => s;

function externalOrder(kind: string): External[] {
  return OPENCODE_FIRST.has(kind)
    ? ["opencode", "codex"]
    : ["codex", "opencode"];
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
  let best: { name: External; rep: GroupStats } | null = null;
  for (const name of externalOrder(kind)) {
    const rep = representative(
      groups.filter((g) => g.harness === HARNESS_OF[name]),
    );
    if (rep === null || !enoughRecords(rep) || lapseTooHigh(rep)) continue;
    if (!bothUnder(paces[name])) continue;
    if (!rateLeadsBy(rep, claude, RECORD_GAP_POINTS)) continue;
    if (
      best === null ||
      successes(rep) * best.rep.n > successes(best.rep) * rep.n
    ) {
      best = { name, rep };
    }
  }
  if (best === null) return null;
  return {
    line: `推奨: ${DESTINATION[best.name]} [規則 1: 記録] ${kind}×${size} の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件) が sonnet の ${percent(successes(claude), claude.n)}% (${claude.n} 件) より ${RECORD_GAP_POINTS}pt 以上高い`,
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
  for (const name of externalOrder(kind)) {
    if (!bothUnder(paces[name])) continue;
    const rep = representative(
      groups.filter((g) => g.harness === HARNESS_OF[name]),
    );
    const worse =
      claude !== null &&
      rep !== null &&
      enoughRecords(claude) &&
      enoughRecords(rep) &&
      rateLeadsBy(claude, rep, RECORD_GAP_POINTS);
    return {
      line: `推奨: ${DESTINATION[name]} [規則 2: Claude の週枠が ahead]${worse ? " 記録では劣る (Claude の枠を設計判断とメインループに残すことを優先)" : ""}`,
    };
  }
  return {
    line: `推奨: ${DESTINATION.sonnet} [規則 2 の外部は全部 ahead / exhausted / unknown] 全部 ahead。急がない委譲は後へ`,
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
  for (const name of externalOrder(kind)) {
    if (!bothUnder(paces[name])) continue;
    const count = groups
      .filter((g) => g.harness === HARNESS_OF[name])
      .reduce((sum, g) => sum + g.n, 0);
    if (count < EXPLORE_MIN_RECORDS) {
      return `試す候補: ${DESTINATION[name]} ${kind}×S の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${count}/${EXPLORE_MIN_RECORDS} 件。比較に件数が足りない`;
    }
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
      line: `推奨: ${DESTINATION.sonnet} [規則 3: 既定]`,
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
