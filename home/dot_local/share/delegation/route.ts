import {
  DEFAULT_SINCE_DAYS,
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
  FREE_ADOPTION_FLOOR,
  LAG_TIE_POINTS,
  RECORD_GAP_POINTS,
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
  effortTrialDisplay,
  offloadDisplay,
  type Destination,
  type DestinationName,
  type FreeDestinationName,
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

/** Any row of either destination table: the fields route reads from both. */
type Row = Pick<Destination, "match" | "sendsOut" | "label" | "display"> & {
  name: string;
  displayNote?: string;
  provider?: External;
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
  /** Provider names or destination names to remove from every route rule. */
  excluded: ReadonlySet<string>;
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
type Usable = (d: Row) => boolean;
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
    : ["codex-luna-max", "codex-terra", "opencode", "sarashina"];
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

type Chosen = {
  line: string;
  dest: External | "sonnet" | "wait" | null;
  destination: DestinationName | FreeDestinationName | null;
};

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
    destination: best.dest.name,
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
    destination: best.dest.name,
    line: `推奨: ${displayFor(best.dest, kind)} [規則 1: 記録] ${kind}×${size} の採用率 ${percent(successes(best.rep), best.rep.n)}% (${best.rep.n} 件) が sonnet の ${percent(successes(claude), claude.n)}% (${claude.n} 件) より ${RECORD_GAP_POINTS}pt 以上高い`,
  };
}

type LagCandidate = {
  destination: DestinationName | "sonnet";
  weeklyLag: number;
};

type RuleTwoResult = {
  chosen: Chosen | null;
  candidates: LagCandidate[];
  reasons: string[];
};

function paceExclusionReason(pace: ProviderPace): string | null {
  if (pace.fiveHour !== "under") return `5h ${pace.fiveHour}`;
  if (pace.weekly === "exhausted") return "週 exhausted";
  if (pace.unmetered) return "週の枠なし";
  if (pace.weeklyLag === null) return "週 unknown";
  return null;
}

function lagCandidate(
  destination: DestinationName | "sonnet",
  paces: Record<ProviderName, ProviderPace>,
): LagCandidate | null {
  const provider =
    destination === "sonnet" ? "claude" : DESTINATIONS[destination].provider;
  const pace = paces[provider];
  if (
    pace.fiveHour !== "under" ||
    pace.weekly === "exhausted" ||
    pace.unmetered ||
    pace.weeklyLag === null
  ) {
    return null;
  }
  return { destination, weeklyLag: pace.weeklyLag };
}

function rankLagCandidates(
  candidates: readonly LagCandidate[],
  order: readonly Destination[],
): LagCandidate[] {
  if (candidates.length === 0) return [];
  const orderIndex = new Map(order.map((dest, i) => [dest.name, i]));
  const indexOf = (candidate: LagCandidate) =>
    candidate.destination === "sonnet"
      ? Number.POSITIVE_INFINITY
      : (orderIndex.get(candidate.destination) ?? Number.POSITIVE_INFINITY);
  const max = Math.max(...candidates.map((candidate) => candidate.weeklyLag));
  const tied = candidates.filter(
    (candidate) => candidate.weeklyLag >= max - LAG_TIE_POINTS,
  );
  const outside = candidates.filter(
    (candidate) => candidate.weeklyLag < max - LAG_TIE_POINTS,
  );
  tied.sort((a, b) => indexOf(a) - indexOf(b));
  outside.sort((a, b) => b.weeklyLag - a.weeklyLag || indexOf(a) - indexOf(b));
  return [...tied, ...outside];
}

const formatLag = (value: number) => {
  const rounded = Math.round(value);
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded)}pt`;
};

function lagSummary(
  paces: Record<ProviderName, ProviderPace>,
  providers: ReadonlySet<ProviderName>,
): string {
  return (["claude", "codex", "opencode", "sarashina"] as const)
    .flatMap((provider) => {
      if (!providers.has(provider)) return [];
      const lag = paces[provider].weeklyLag;
      return lag === null ? [] : [`${provider} ${formatLag(lag)}`];
    })
    .join("、");
}

function ruleTwo(
  groups: GroupStats[],
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  usable: Usable,
  gate: SarashinaGate,
): RuleTwoResult {
  const claude = representative(
    groups.filter(
      (g) => g.harness === "claude-code-agent" && g.model === "sonnet",
    ),
  );
  const ordered = externalOrder(kind, size, usable);
  const reasons: string[] = [];
  const reasonedProviders = new Set<ProviderName>();
  const providerNames = [
    "claude",
    ...new Set(ordered.map((dest) => dest.provider)),
  ] as ProviderName[];
  for (const provider of providerNames) {
    const reason = paceExclusionReason(paces[provider]);
    if (reason !== null) {
      reasons.push(`${provider}: ${reason}`);
      reasonedProviders.add(provider);
    }
  }

  const candidates: LagCandidate[] = [];
  const sonnet = lagCandidate("sonnet", paces);
  if (sonnet !== null) candidates.push(sonnet);
  for (const dest of ordered) {
    const candidate = lagCandidate(dest.name, paces);
    if (candidate === null) {
      if (!reasonedProviders.has(dest.provider)) {
        const reason = paceExclusionReason(paces[dest.provider]);
        if (reason !== null) {
          reasons.push(`${dest.provider}: ${reason}`);
          reasonedProviders.add(dest.provider);
        }
      }
      continue;
    }
    const rep = destinationStats(dest, groups);
    if (
      claude !== null &&
      enoughRecords(claude) &&
      rep !== null &&
      enoughRecords(rep) &&
      !lapseTooHigh(rep) &&
      rateLeadsBy(claude, rep, RECORD_GAP_POINTS)
    ) {
      reasons.push(`${dest.label}: 記録で劣る`);
      continue;
    }
    candidates.push(candidate);
  }

  let remaining = candidates;
  let ranked = rankLagCandidates(remaining, ordered);
  while (ranked[0]?.destination === "sarashina") {
    if (gate.allows(DESTINATIONS.sarashina)) break;
    remaining = remaining.filter(
      (candidate) => candidate.destination !== "sarashina",
    );
    ranked = rankLagCandidates(remaining, ordered);
  }
  const first = ranked[0];
  if (first === undefined) return { chosen: null, candidates: ranked, reasons };

  const comparedProviders = new Set<ProviderName>([
    "claude",
    ...ordered.map((dest) => dest.provider),
  ]);
  const lagReason = lagSummary(paces, comparedProviders);
  const chosen: Chosen =
    first.destination === "sonnet"
      ? {
          dest: "sonnet",
          destination: null,
          line: `推奨: ${SONNET_DISPLAY} [規則 2: 週枠の遅れ]${lagReason === "" ? "" : ` ${lagReason}`}`,
        }
      : {
          dest: DESTINATIONS[first.destination].provider,
          destination: first.destination,
          line: `推奨: ${displayFor(DESTINATIONS[first.destination], kind)} [規則 2: 週枠の遅れ]${lagReason === "" ? "" : ` ${lagReason}`}`,
        };
  return { chosen, candidates: ranked, reasons };
}

function explore(
  folded: Folded,
  paces: Record<ProviderName, ProviderPace>,
  kind: string,
  size: string,
  now: Date,
  usable: Usable,
  gate: SarashinaGate,
): { name: External; destination: DestinationName; line: string } | null {
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
        destination: least.dest.name,
        line: `試す候補: ${displayFor(least.dest, kind)} ${kind}×S の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${least.count}/${EXPLORE_MIN_RECORDS} 件。比較に件数が足りない`,
      };
    }
    skipped.add(least.dest.name);
  }
}

function effortTrialLine(
  folded: Folded,
  destination: Destination | null,
  kind: string,
  size: string,
  now: Date,
): string | null {
  if (
    destination === null ||
    destination.effortTrials === undefined ||
    (kind !== "review" && size !== "S")
  ) {
    return null;
  }

  const groups = groupsForCell(folded, kind, size, now, EXPLORE_WINDOW_DAYS);
  let least: {
    effort: (typeof destination.effortTrials)[number];
    count: number;
  } | null = null;
  for (const effort of destination.effortTrials) {
    const count =
      groups.find(
        (group) =>
          group.harness === destination.match.harness &&
          (destination.match.model === undefined ||
            group.model === destination.match.model) &&
          group.effort === effort,
      )?.n ?? 0;
    if (
      count < EXPLORE_MIN_RECORDS &&
      (least === null || count < least.count)
    ) {
      least = { effort, count };
    }
  }
  if (least === null) return null;
  return `試す effort: ${effortTrialDisplay(destination, least.effort)} ${kind}×${size} の直近 ${EXPLORE_WINDOW_DAYS} 日の記録 ${least.count}/${EXPLORE_MIN_RECORDS} 件`;
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

function localResetTime(at: number, weekly: boolean): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return weekly
    ? `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${time}`
    : time;
}

function ruleThree(
  now: Date,
  paces: Record<ProviderName, ProviderPace>,
): Chosen {
  const claude = paces.claude;
  const blocks: { at: string | null; weekly: boolean }[] = [];
  if (claude.fiveHour === "ahead" || claude.fiveHour === "exhausted") {
    blocks.push({ at: claude.fiveHourResetsAt, weekly: false });
  }
  if (claude.weekly === "exhausted") {
    blocks.push({ at: claude.weeklyResetsAt, weekly: true });
  }
  if (blocks.length === 0) {
    return {
      dest: "sonnet",
      destination: null,
      line: `推奨: ${SONNET_DISPLAY} [規則 3: 既定]`,
    };
  }

  const resets = blocks.map(({ at, weekly }) => ({
    at: at === null ? Number.NaN : Date.parse(at),
    weekly,
  }));
  const usableResets = resets.filter(
    (reset) => Number.isFinite(reset.at) && reset.at > now.getTime(),
  );
  if (usableResets.length !== resets.length) {
    return {
      dest: "wait",
      destination: null,
      line: `推奨: 待機 [規則 3: 使える委譲先が無い] claude のリセット 時刻不明`,
    };
  }
  const latest = usableResets.reduce((a, b) => (a.at > b.at ? a : b));
  const window = latest.weekly ? "週" : "5h";
  return {
    dest: "wait",
    destination: null,
    line: `推奨: 待機 [規則 3: 使える委譲先が無い] claude ${window} のリセット ${localResetTime(latest.at, latest.weekly)}`,
  };
}

function hasHistory(
  destination: DestinationName | FreeDestinationName,
  groups: GroupStats[],
): boolean {
  const row: Row | undefined =
    destination in DESTINATIONS
      ? DESTINATIONS[destination as DestinationName]
      : FREE_DESTINATIONS.find((dest) => dest.name === destination);
  if (row === undefined) return false;
  const rep = destinationStats(row, groups);
  return rep !== null && enoughRecords(rep) && !lapseTooHigh(rep);
}

function needsFailureLine(pick: Chosen, groups: GroupStats[]): boolean {
  if (
    pick.dest === "sonnet" ||
    pick.dest === "wait" ||
    pick.destination === null
  ) {
    return false;
  }
  return !hasHistory(pick.destination, groups);
}

function failureLine(
  pick: Chosen,
  ruleTwo: RuleTwoResult,
  groups: GroupStats[],
  kind: string,
  size: string,
  now: Date,
  paces: Record<ProviderName, ProviderPace>,
  gate: SarashinaGate,
): string {
  let remaining = ruleTwo.candidates.filter(
    (candidate) => candidate.destination !== pick.destination,
  );
  const order = externalOrder(kind, size);
  for (;;) {
    const ranked = rankLagCandidates(remaining, order);
    const next = ranked.find(
      (candidate) =>
        candidate.destination !== "sonnet" &&
        hasHistory(candidate.destination, groups),
    );
    if (next === undefined) break;
    if (next.destination === "sonnet") break;
    if (
      next.destination === "sarashina" &&
      !gate.allows(DESTINATIONS.sarashina)
    ) {
      remaining = remaining.filter(
        (candidate) => candidate.destination !== "sarashina",
      );
      continue;
    }
    const dest = DESTINATIONS[next.destination];
    return `失敗時: ${displayFor(dest, kind)}`;
  }
  if (remaining.some((candidate) => candidate.destination === "sonnet")) {
    return `失敗時: ${SONNET_DISPLAY}`;
  }
  return ruleThree(now, paces).line.replace(/^推奨:/, "失敗時:");
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
  const exposureUsable: Usable = (d) =>
    !d.sendsOut ||
    (verdict !== null &&
      verdict.ok &&
      d.match.model !== undefined &&
      verified.has(d.match.model));
  const excluded = input.excluded;
  const usable: Usable = (d) =>
    exposureUsable(d) &&
    !excluded.has(d.name) &&
    !(d.provider !== undefined && excluded.has(d.provider));
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
  const recordPick =
    freePick === null ? ruleOne(groups, paces, kind, size, usable, gate) : null;
  const ruleTwoResult =
    recordPick === null
      ? ruleTwo(groups, paces, kind, size, usable, gate)
      : null;
  const pick =
    freePick ?? recordPick ?? ruleTwoResult?.chosen ?? ruleThree(now, paces);
  out.push(pick.line);
  if (
    ruleTwoResult !== null &&
    needsFailureLine(pick, groups) &&
    (freePick !== null || pick === ruleTwoResult.chosen)
  ) {
    out.push(
      failureLine(pick, ruleTwoResult, groups, kind, size, now, paces, gate),
    );
  }
  if (
    freePick === null &&
    recordPick === null &&
    ruleTwoResult !== null &&
    ruleTwoResult.reasons.length > 0
  ) {
    out.push(`  除外: ${ruleTwoResult.reasons.join("、")}`);
  }
  const candidate =
    pick.dest === "wait"
      ? null
      : explore(folded, paces, kind, size, now, usable, gate);
  const candidateLines: string[] = [];
  if (candidate !== null && candidate.destination !== pick.destination) {
    candidateLines.push(candidate.line);
  }
  out.push(...classificationLines(kind, exposure, verdict, exposureUsable));
  // After the last rule that can ask, so the line reflects every refusal.
  if (gate.refused) {
    out.push(
      `保留: ${DESTINATIONS.sarashina.display} ${SARASHINA_PRIVATE_REASON}`,
    );
  }
  out.push(...candidateLines);
  const trialDestination =
    pick.destination !== null && pick.destination in DESTINATIONS
      ? DESTINATIONS[pick.destination as DestinationName]
      : null;
  const trialLine = effortTrialLine(folded, trialDestination, kind, size, now);
  if (trialLine !== null) out.push(trialLine);

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
