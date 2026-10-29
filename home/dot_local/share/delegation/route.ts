import {
  DEFAULT_SINCE_DAYS,
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
  FREE_ADOPTION_FLOOR,
  RECORD_GAP_POINTS,
  SURPLUS_MIN_POINTS,
  WEEK_LOOKAHEAD_HOURS,
  type Exposure,
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
  FREE_DESTINATIONS,
  offloadDisplay,
  type Destination,
  type DestinationName,
} from "./destinations.ts";
import { VERIFY_RECOVERY } from "./offload.ts";
import type { Folded, ReviewDue, SkipCounts } from "./store.ts";
import { reviewPromptLine } from "./store.ts";

export const ROUTE_HEADER = "delegation route v1";

type External = Exclude<ProviderName, "claude">;
export {
  DESTINATIONS,
  type Destination,
  type DestinationName,
} from "./destinations.ts";
// Sarashina is held per route call, not statically: see RouteInput.isPublicRepo.
const SARASHINA_PRIVATE_REASON =
  "公開リポジトリでないか判定できないので送らない（入力が学習に使われうる）";
// Output cap (8000 tokens) and 30 RPM: only small delegations fit.
const SARASHINA_SIZE = "S";
const SONNET_DISPLAY = 'sonnet (Agent の model: "sonnet")';
const OPENCODE_FIRST = new Set(["mechanical", "triage"]);
// Kinds whose work can wait for an idle quota at any size.
const SURPLUS_KINDS = new Set(["mechanical", "triage", "draft"]);

/** Any row of either destination table: the fields route reads from both. */
type Row = Pick<Destination, "match" | "sendsOut" | "label" | "display"> & {
  name: string;
  displayNote?: string;
};

const inDestination = (d: Pick<Row, "match">, g: GroupStats) =>
  g.harness === d.match.harness &&
  (d.match.model === undefined || g.model === d.match.model) &&
  (d.match.effort === undefined || g.effort === d.match.effort);
const destinationStats = (
  d: Pick<Row, "match">,
  groups: readonly GroupStats[],
) => mergeGroups(groups.filter((g) => inDestination(d, g)));

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
  /** Whether the brief may leave the machine; omitted means closed. review is closed whatever is given (K6). */
  exposure?: Exposure;
  /**
   * The offload entry's verification: which models it would accept. Called
   * only when the effective exposure is external-ok, at most once per
   * buildRoute call, because it hashes the opencode executable. Omitted means
   * no model passed: an unanswered safety check must not grant permission.
   */
  offload?: () => OffloadVerdict;
  /**
   * Whether the repository route was started in is public on github.com.
   * Called only once Sarashina has won a rule or the try-candidate slot, and
   * at most once per buildRoute call. false skips Sarashina for that rule.
   * Omitted means false: an unanswered safety check must not grant permission.
   */
  isPublicRepo?: () => boolean;
};

export type OffloadVerdict =
  | { ok: true; models: readonly string[] }
  | { ok: false; reason: string; recovery: readonly string[] };

/** Kinds whose delegation edits files; the rest only read. */
const WRITE_KINDS = new Set(["impl", "mechanical", "draft"]);
type Usable = (d: Pick<Row, "sendsOut" | "match">) => boolean;
const anyUsable: Usable = () => true;

const bothUnder = (p: ProviderPace) =>
  p.fiveHour === "under" && p.weekly === "under";
const label = (s: PaceState) => s;

function externalOrder(
  kind: string,
  size: string,
  usable: Usable = anyUsable,
): Destination[] {
  const names: DestinationName[] = OPENCODE_FIRST.has(kind)
    ? ["opencode", "codex-luna-max", "codex-terra", "sarashina"]
    : ["codex-terra", "codex-luna-max", "opencode", "sarashina"];
  return names
    .map((n) => DESTINATIONS[n])
    .filter(
      (d) => usable(d) && (d.name !== "sarashina" || size === SARASHINA_SIZE),
    );
}

/**
 * Remembers the answer for one buildRoute call, and whether Sarashina was
 * turned down, so the hold line is printed once and the check runs once.
 */
function sarashinaGate(isPublicRepo: () => boolean) {
  let answer: boolean | undefined;
  let refused = false;
  return {
    /** Only Sarashina is checked; every other destination passes. */
    allows(dest: Destination): boolean {
      if (dest.name !== "sarashina") return true;
      answer ??= isPublicRepo();
      if (!answer) refused = true;
      return answer;
    },
    get refused() {
      return refused;
    },
  };
}
type SarashinaGate = ReturnType<typeof sarashinaGate>;

type Chosen = { line: string; dest: External | "sonnet" | null };

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
  size: string,
  allowed: (dest: Destination) => boolean,
  gate?: SarashinaGate,
): RecordPick | null {
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  if (claude === null || !enoughRecords(claude)) return null;
  // The public-repo check runs only for a winner, never while comparing, so a
  // refused Sarashina is dropped and the best of the rest is chosen again.
  const skipped = new Set<DestinationName>();
  for (;;) {
    let best: { dest: Destination; rep: GroupStats } | null = null;
    for (const dest of externalOrder(kind, size)) {
      if (skipped.has(dest.name)) continue;
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
    if (best === null) return null;
    if (gate === undefined || gate.allows(best.dest))
      return { ...best, claude };
    skipped.add(best.dest.name);
  }
}

export const recordRuleOne = (
  groups: GroupStats[],
  kind: string,
  size: string,
): RecordPick | null => pickByRecords(groups, kind, size, () => true);

function ruleZero(
  groups: GroupStats[],
  kind: string,
  usable: Usable,
): Chosen | null {
  const candidates = FREE_DESTINATIONS.flatMap((dest) => {
    if (!usable(dest)) return [];
    return [{ dest, rep: destinationStats(dest, groups) }];
  });
  if (candidates.length === 0) return null;

  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  const enoughClaude = claude !== null && enoughRecords(claude);
  const remaining = candidates.filter(({ rep }) => {
    if (rep === null || !enoughRecords(rep)) return true;
    if (enoughClaude) {
      return !rateLeadsBy(claude, rep, RECORD_GAP_POINTS);
    }
    return successes(rep) * 100 >= FREE_ADOPTION_FLOOR * rep.n;
  });
  if (remaining.length === 0) return null;

  const underSampled = remaining.filter(
    ({ rep }) => rep === null || !enoughRecords(rep),
  );
  const compared = underSampled.length > 0 ? underSampled : remaining;
  let best = compared[0];
  if (best === undefined) return null;
  for (const candidate of compared.slice(1)) {
    const bestCount = best.rep?.n ?? 0;
    const candidateCount = candidate.rep?.n ?? 0;
    if (underSampled.length > 0) {
      if (candidateCount < bestCount) best = candidate;
      continue;
    }
    const bestRep = best.rep;
    const candidateRep = candidate.rep;
    if (
      bestRep !== null &&
      candidateRep !== null &&
      successes(candidateRep) * bestRep.n > successes(bestRep) * candidateRep.n
    ) {
      best = candidate;
    }
  }

  const evidence =
    best.rep === null || !enoughRecords(best.rep)
      ? `${kind}×S の記録 ${best.rep?.n ?? 0}/${EXPLORE_MIN_RECORDS} 件`
      : `${kind}×S の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件)`;
  return {
    dest: null,
    line: `推奨: ${displayFor(best.dest, kind)} [規則 0: 無料] ${evidence}`,
  };
}

function ruleOne(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  usable: Usable,
  gate: SarashinaGate,
): Chosen | null {
  const best = pickByRecords(
    groups,
    kind,
    size,
    (d) => usable(d) && bothUnder(paces[d.provider]),
    gate,
  );
  if (best === null) return null;
  const { claude } = best;
  return {
    dest: best.dest.provider,
    line: `推奨: ${displayFor(best.dest, kind)} [規則 1: 記録] ${kind}×${size} の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件) が sonnet の ${percent(successes(claude), claude.n)}% (${claude.n} 件) より ${RECORD_GAP_POINTS}pt 以上高い`,
  };
}

function ruleTwo(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  claudeAheadBy: AheadBy | null,
  usable: Usable,
  gate: SarashinaGate,
): Chosen | null {
  const claudeWeek = paces.claude.weekly;
  if (claudeWeek !== "ahead" && claudeWeek !== "exhausted") return null;
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  for (const dest of externalOrder(kind, size, usable)) {
    if (!bothUnder(paces[dest.provider])) continue;
    if (!gate.allows(dest)) continue;
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
      line: `推奨: ${displayFor(dest, kind)} [規則 2: Claude の週枠が ahead${basis}]${worse ? " 記録では劣る (Claude の枠を設計判断とメインループに残すことを優先)" : ""}`,
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
  usable: Usable,
  gate: SarashinaGate,
): { name: External; line: string } | null {
  if (size !== "S") return null;
  const groups = groupsForCell(folded, kind, "S", now, EXPLORE_WINDOW_DAYS);
  const skipped = new Set<DestinationName>();
  for (;;) {
    // Least-recorded first; strict < keeps the default order on equal counts.
    let least: { dest: Destination; count: number } | null = null;
    for (const dest of externalOrder(kind, size, usable)) {
      if (skipped.has(dest.name) || !bothUnder(paces[dest.provider])) continue;
      const count = destinationStats(dest, groups)?.n ?? 0;
      if (
        count < EXPLORE_MIN_RECORDS &&
        (least === null || count < least.count)
      ) {
        least = { dest, count };
      }
    }
    if (least === null) return null;
    if (gate.allows(least.dest)) {
      return {
        name: least.dest.provider,
        line: `試す候補: ${displayFor(least.dest, kind)} ${kind}×S の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${least.count}/${EXPLORE_MIN_RECORDS} 件。比較に件数が足りない`,
      };
    }
    skipped.add(least.dest.name);
  }
}

/** Whole points of an external's unspent week when it is worth trying, else null. */
function surplusCandidate(
  input: RouteInput,
  name: External,
  recommended: Chosen["dest"],
): number | null {
  if (!SURPLUS_KINDS.has(input.kind)) return null;
  if (name === recommended || !bothUnder(input.paces[name])) return null;
  const points = input.surplus[name];
  if (points === null || points < SURPLUS_MIN_POINTS) return null;
  return Math.floor(points);
}

/**
 * The launch text for a row. Rows that send out are built from the table's
 * model, so what route shows is what the entry accepts; kind decides --write.
 */
function displayFor(d: Row, kind: string): string {
  if (!d.sendsOut) return d.display;
  return offloadDisplay(d, WRITE_KINDS.has(kind));
}

const LINE_MAX_CHARS = 200;
/**
 * reason and recovery carry strings that came from the file system (paths,
 * directory names). A newline in one must not start a line that looks like
 * route's own output.
 */
function sanitizeLine(text: string): string {
  const chars = Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
      ? "?"
      : char;
  });
  return chars.length > LINE_MAX_CHARS
    ? `${chars.slice(0, LINE_MAX_CHARS).join("")}…`
    : chars.join("");
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

/**
 * The 区分 line: whether the brief may leave, and which sending-out rows were
 * left out and why. Failure details are sanitized (see sanitizeLine); when the
 * verification names no step, VERIFY_RECOVERY is printed so a left-out row
 * always comes with a way back.
 */
function classificationLines(
  kind: string,
  exposure: Exposure,
  verdict: OffloadVerdict | null,
  usable: Usable,
): string[] {
  if (kind === "review") return ["区分: closed (review は外部へ送らない)"];
  const sending: Row[] = [
    ...Object.values(DESTINATIONS),
    ...FREE_DESTINATIONS,
  ].filter((d) => d.sendsOut);
  if (exposure === "closed") {
    return [
      `区分: closed (外部へ送る委譲先を除いた: ${sending.map((d) => d.label).join(", ")})`,
    ];
  }
  const left = sending.filter((d) => !usable(d));
  if (left.length === 0) return ["区分: external-ok"];
  const lines = [
    `区分: external-ok (確認済みでない model の委譲先を除いた: ${left.map((d) => d.label).join(", ")})`,
  ];
  const recovery: readonly string[] =
    verdict?.ok === false ? verdict.recovery : [];
  if (verdict?.ok === false)
    lines.push(`  理由: ${sanitizeLine(verdict.reason)}`);
  const steps = recovery.length > 0 ? recovery : [VERIFY_RECOVERY];
  for (const step of steps) lines.push(`  ${sanitizeLine(step)}`);
  return lines;
}

/** Everything printed is an enum, a number, or a display name: never stored free text. */
export function buildRoute(input: RouteInput): string[] {
  const { kind, size, now, folded, paces } = input;
  const out: string[] = [ROUTE_HEADER];
  if (input.ledgerLarge) out.push("台帳が大きい。分割を検討");

  const groups = groupsForCell(folded, kind, size, now, DEFAULT_SINCE_DAYS);
  // review reads the workflow dir, which the offload agent cannot (K6).
  const exposure: Exposure =
    kind === "review" ? "closed" : (input.exposure ?? "closed");
  const verdict: OffloadVerdict | null =
    exposure === "external-ok"
      ? (input.offload?.() ?? { ok: true, models: [] })
      : null;
  const verified = new Set(verdict?.ok ? verdict.models : []);
  // One predicate for every rule and candidate: a row that sends out is usable
  // only when the brief may leave and the entry has verified its model.
  const usable: Usable = (d) =>
    !d.sendsOut ||
    (verdict !== null &&
      verdict.ok &&
      d.match.model !== undefined &&
      verified.has(d.match.model));
  const gate = sarashinaGate(input.isPublicRepo ?? (() => false));
  const freePick =
    exposure === "external-ok" &&
    (kind === "mechanical" || kind === "triage") &&
    size === "S"
      ? ruleZero(
          groupsForCell(folded, kind, "S", now, DEFAULT_SINCE_DAYS),
          kind,
          usable,
        )
      : null;
  const pick = freePick ??
    ruleOne(groups, paces, kind, size, usable, gate) ??
    ruleTwo(groups, paces, kind, size, input.claudeAheadBy, usable, gate) ?? {
      dest: "sonnet" as const,
      line: `推奨: ${SONNET_DISPLAY} [規則 3: 既定]`,
    };
  out.push(pick.line);
  const candidate = explore(folded, paces, kind, size, now, usable, gate);
  // The surplus scan can ask the gate too, so it runs before the hold line is
  // decided; its lines are printed after the hold line.
  const candidateLines: string[] = [];
  const taken = new Set<External>();
  if (candidate !== null) {
    const points = surplusCandidate(input, candidate.name, pick.dest);
    if (points !== null) taken.add(candidate.name);
    candidateLines.push(
      points === null
        ? candidate.line
        : `${candidate.line}。週枠の余り ${points}pt`,
    );
  }
  // The week belongs to the provider, so one line per provider, shown as the
  // first of its destinations in this kind's order.
  for (const dest of externalOrder(kind, size, usable)) {
    if (taken.has(dest.provider)) continue;
    taken.add(dest.provider);
    const points = surplusCandidate(input, dest.provider, pick.dest);
    if (points !== null && gate.allows(dest)) {
      candidateLines.push(
        `試す候補: ${displayFor(dest, kind)} 週枠の余り ${points}pt がリセットまでに使われない`,
      );
    }
  }
  out.push(...classificationLines(kind, exposure, verdict, usable));
  // After the last rule that can ask, so the line reflects every refusal.
  if (gate.refused) {
    out.push(
      `保留: ${DESTINATIONS.sarashina.display} ${SARASHINA_PRIVATE_REASON}`,
    );
  }
  out.push(...candidateLines);

  const windows = (["claude", "codex", "opencode", "sarashina"] as const)
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
