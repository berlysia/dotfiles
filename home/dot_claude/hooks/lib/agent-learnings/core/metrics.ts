import { isValidRepoKey } from "./repo-key.ts";
import { SCENE_STATE_READERS, type SceneReader } from "./scene-state.ts";
import { formatTriggers, parseTriggers } from "./triggers.ts";

// 注入の記録（injections.log）と評価（feedback.log）の行の形・検査・集計。
// I/O を持たない。status・health の知らせ・feedback の受理が同じ関数を呼ぶ。
// ログはエージェントが書き換えられるので、読む側は行ごとに全項目を検査する

export type RecordKind = "session" | "pre" | "fail" | "path";
export type Verdict = "helpful" | "mistimed" | "wrong";
export type FeedbackReader = SceneReader | "unknown";

// reader は配備前に書かれた行には無い。claude・codex 以外の値は読む側が「無い」として扱う
export type InjectionLine = {
  v: 1;
  at: string;
  repoKey: string;
  id: string;
  kind: RecordKind;
  trigger: string;
  reader?: SceneReader;
};
export type FeedbackLine = {
  v: 1;
  at: string;
  reader: FeedbackReader;
  repoKey: string;
  id: string;
  verdict: Verdict;
  kind: RecordKind;
  trigger: string;
};

export const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const REVIEW_MIN_INJECTIONS = 3;
export const REVIEW_MIN_NEGATIVE = 2;
export const MAX_REVIEW_TRIGGERS = 5;
export const MAX_REVIEW_LINES = 10;
// 正しい行は各値の上限から 1KB に収まる。これを超える行は JSON.parse に渡さない
const MAX_LINE_LENGTH = 2048;

const KINDS: readonly RecordKind[] = ["session", "pre", "fail", "path"];
const VERDICTS: readonly Verdict[] = ["helpful", "mistimed", "wrong"];
const READERS: readonly FeedbackReader[] = ["claude", "codex", "unknown"];
const ID_PATTERN = /^L-[0-9a-f]{12}$/;

export const UNTAGGED = "untagged";

export const formatInjectionLine = (record: InjectionLine): string =>
  `${JSON.stringify({
    v: 1,
    at: record.at,
    repoKey: record.repoKey,
    id: record.id,
    kind: record.kind,
    trigger: record.trigger,
    ...(record.reader === undefined ? {} : { reader: record.reader }),
  })}\n`;

export const formatFeedbackLine = (record: FeedbackLine): string =>
  `${JSON.stringify({
    v: 1,
    at: record.at,
    reader: record.reader,
    repoKey: record.repoKey,
    id: record.id,
    verdict: record.verdict,
    kind: record.kind,
    trigger: record.trigger,
  })}\n`;

export function isRecordedTrigger(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === UNTAGGED) return true;
  const parsed = parseTriggers([value], "human");
  return (
    parsed.ok &&
    parsed.value.length === 1 &&
    formatTriggers(parsed.value) === value
  );
}

export const isRecordedId = (value: unknown): value is string =>
  typeof value === "string" && value.length === 14 && ID_PATTERN.test(value);

export const isRecordKind = (value: unknown): value is RecordKind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value);

const isIsoAt = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
};

function checkInjection(raw: Record<string, unknown>): InjectionLine | null {
  if (raw["v"] !== 1) return null;
  const { at, repoKey, id, kind, trigger } = raw;
  if (!isIsoAt(at)) return null;
  if (typeof repoKey !== "string" || !isValidRepoKey(repoKey)) return null;
  if (!isRecordedId(id)) return null;
  if (!isRecordKind(kind)) return null;
  if (!isRecordedTrigger(trigger)) return null;
  // 知らない値の reader は行ごと捨てず、reader 無しとして読む（配備前の行と同じ扱い）
  const reader = raw["reader"];
  const known = (SCENE_STATE_READERS as readonly unknown[]).includes(reader);
  return {
    v: 1,
    at,
    repoKey,
    id,
    kind,
    trigger,
    ...(known ? { reader: reader as SceneReader } : {}),
  };
}

function checkFeedback(raw: Record<string, unknown>): FeedbackLine | null {
  const base = checkInjection(raw);
  if (base === null) return null;
  const { verdict, reader } = raw;
  if (
    typeof verdict !== "string" ||
    !(VERDICTS as readonly string[]).includes(verdict)
  )
    return null;
  if (
    typeof reader !== "string" ||
    !(READERS as readonly string[]).includes(reader)
  )
    return null;
  // 評価の行の reader は評価した側の reader で、注入の行の reader とは別の意味
  return {
    v: 1,
    at: base.at,
    repoKey: base.repoKey,
    id: base.id,
    kind: base.kind,
    trigger: base.trigger,
    reader: reader as FeedbackReader,
    verdict: verdict as Verdict,
  };
}

// 空行（書き込みの先頭の改行）・JSON として読めない行・オブジェクトでない行は捨て、
// オブジェクトで検査に通らない行だけを unknown に数える
function parseLines<T>(
  text: string,
  check: (raw: Record<string, unknown>) => T | null,
): { lines: T[]; unknown: number } {
  const lines: T[] = [];
  let unknown = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.length > MAX_LINE_LENGTH) {
      unknown += 1;
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const checked = check(raw as Record<string, unknown>);
    if (checked === null) unknown += 1;
    else lines.push(checked);
  }
  return { lines, unknown };
}

export const parseInjectionLines = (
  text: string,
): { lines: InjectionLine[]; unknown: number } =>
  parseLines(text, checkInjection);

export const parseFeedbackLines = (
  text: string,
): { lines: FeedbackLine[]; unknown: number } =>
  parseLines(text, checkFeedback);

// 値は見ず、変数の有無だけで決める。CLAUDECODE を AI_AGENT より先に見るのは、
// Claude Code の Bash も AI_AGENT を持つため。CODEX_SANDBOX* を最初に見るのは、
// Claude の Bash から起動した Codex が CLAUDECODE を継承する場合に備えるため
export function detectFeedbackReader(
  envNames: readonly string[],
): FeedbackReader {
  if (envNames.some((name) => name.startsWith("CODEX_SANDBOX"))) return "codex";
  if (envNames.includes("CLAUDECODE")) return "claude";
  if (envNames.includes("AI_AGENT")) return "codex";
  return "unknown";
}

const atMs = (at: string): number => new Date(at).getTime();
const inWindow = (at: string, now: Date): boolean => {
  const age = now.getTime() - atMs(at);
  return age >= 0 && age <= WINDOW_MS;
};

// 同じ組で窓の中の最新の行（同時刻なら後ろの行）。
// reader が claude・codex の評価は、同じ reader の行か reader の無い行（配備前の古い行）だけで受理する。
// unknown（人が端末から打った）は reader を問わない。reader 省略は unknown と同じ
export function findAcceptingInjection(
  injections: readonly InjectionLine[],
  query: {
    repoKey: string;
    id: string;
    kind: RecordKind;
    now: Date;
    reader?: FeedbackReader;
  },
): InjectionLine | null {
  const reader = query.reader ?? "unknown";
  let best: InjectionLine | null = null;
  for (const line of injections) {
    if (
      line.repoKey !== query.repoKey ||
      line.id !== query.id ||
      line.kind !== query.kind ||
      !inWindow(line.at, query.now)
    )
      continue;
    if (
      reader !== "unknown" &&
      line.reader !== undefined &&
      line.reader !== reader
    )
      continue;
    if (best === null || atMs(line.at) >= atMs(best.at)) best = line;
  }
  return best;
}

export type ReviewItem = {
  repoKey: string;
  id: string;
  kind: RecordKind;
  injections: number;
  mistimed: number;
  wrong: number;
  triggers: Array<{ trigger: string; count: number }>;
};
export type MetricsSummary = {
  injections: Record<RecordKind, number>;
  feedback: Record<Verdict, number>;
  review: ReviewItem[];
  reviewCount: number;
};

const groupKey = (l: { repoKey: string; id: string; kind: RecordKind }) =>
  JSON.stringify([l.repoKey, l.id, l.kind]);

export function summarizeMetrics(input: {
  injections: readonly InjectionLine[];
  feedback: readonly FeedbackLine[];
  now: Date;
}): MetricsSummary {
  const { now } = input;
  const injections: Record<RecordKind, number> = {
    session: 0,
    pre: 0,
    fail: 0,
    path: 0,
  };
  const groups = new Map<
    string,
    {
      repoKey: string;
      id: string;
      kind: RecordKind;
      n: number;
      triggers: Map<string, number>;
    }
  >();
  for (const line of input.injections) {
    if (!inWindow(line.at, now)) continue;
    injections[line.kind] += 1;
    const key = groupKey(line);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        repoKey: line.repoKey,
        id: line.id,
        kind: line.kind,
        n: 0,
        triggers: new Map(),
      };
      groups.set(key, group);
    }
    group.n += 1;
    group.triggers.set(
      line.trigger,
      (group.triggers.get(line.trigger) ?? 0) + 1,
    );
  }

  // 組ごとに評価を新しい順に並べ、注入の回数までだけ数える（連打で水増ししない）
  const byGroup = new Map<
    string,
    Array<{ line: FeedbackLine; index: number }>
  >();
  input.feedback.forEach((line, index) => {
    if (!inWindow(line.at, now)) return;
    const key = groupKey(line);
    if (!groups.has(key)) return;
    const list = byGroup.get(key) ?? [];
    list.push({ line, index });
    byGroup.set(key, list);
  });
  const feedback: Record<Verdict, number> = {
    helpful: 0,
    mistimed: 0,
    wrong: 0,
  };
  const reviewAll: ReviewItem[] = [];
  for (const [key, group] of groups) {
    const counted = { helpful: 0, mistimed: 0, wrong: 0 };
    const list = (byGroup.get(key) ?? []).sort(
      (a, b) => atMs(b.line.at) - atMs(a.line.at) || b.index - a.index,
    );
    for (const { line } of list.slice(0, group.n)) counted[line.verdict] += 1;
    feedback.helpful += counted.helpful;
    feedback.mistimed += counted.mistimed;
    feedback.wrong += counted.wrong;
    const negative = counted.mistimed + counted.wrong;
    if (
      group.n >= REVIEW_MIN_INJECTIONS &&
      negative >= REVIEW_MIN_NEGATIVE &&
      negative * 2 >= group.n
    ) {
      reviewAll.push({
        repoKey: group.repoKey,
        id: group.id,
        kind: group.kind,
        injections: group.n,
        mistimed: counted.mistimed,
        wrong: counted.wrong,
        triggers: [...group.triggers]
          .map(([trigger, count]) => ({ trigger, count }))
          .sort(
            (a, b) =>
              b.count - a.count ||
              (a.trigger < b.trigger ? -1 : a.trigger > b.trigger ? 1 : 0),
          )
          .slice(0, MAX_REVIEW_TRIGGERS),
      });
    }
  }
  const compare = (a: string, b: string): number =>
    a < b ? -1 : a > b ? 1 : 0;
  reviewAll.sort(
    (a, b) =>
      b.mistimed + b.wrong - (a.mistimed + a.wrong) ||
      compare(a.id, b.id) ||
      compare(a.repoKey, b.repoKey) ||
      compare(a.kind, b.kind),
  );
  return {
    injections,
    feedback,
    review: reviewAll.slice(0, MAX_REVIEW_LINES),
    reviewCount: reviewAll.length,
  };
}

// 読む側の検査の二重の防御。端末に出してはいけない文字（制御文字・行区切り・双方向制御）
const isUnsafeChar = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

export function formatReviewLine(item: ReviewItem): string | null {
  const triggers = item.triggers
    .map((t) => `${t.trigger} ${t.count}`)
    .join(", ");
  const line = `review: ${item.id}（mistimed ${item.mistimed} wrong ${item.wrong} / ${item.injections} ${item.kind}; ${triggers}）${item.repoKey}`;
  for (let i = 0; i < line.length; i += 1) {
    if (isUnsafeChar(line.charCodeAt(i))) return null;
  }
  return line;
}
