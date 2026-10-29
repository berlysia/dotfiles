import { lstatSync } from "node:fs";
import { relative } from "node:path";
import {
  formatFeedbackLine,
  formatInjectionLine,
  isRecordedId,
  isRecordedTrigger,
  parseFeedbackLines,
  parseInjectionLines,
  summarizeMetrics,
  type FeedbackLine,
  type InjectionLine,
  type MetricsSummary,
  type RecordKind,
} from "./metrics.ts";
import { isValidRepoKey } from "../../repo-key.ts";
import type { SceneReader } from "./scene-state.ts";
import {
  LOG_HARD_MAX_BYTES,
  LOG_MAX_BYTES,
  appendLogLines,
  feedbackLogPathFor,
  injectionLogPaths,
  readLogTailInfo,
  storePaths,
} from "./store.ts";

// 注入の記録・評価のログの読み書き（I/O）。行の形と集計は metrics.ts。
// 読むのは各ログの末尾 1MB だけ（`.1` は読まない）

export type LoadedInjections = {
  lines: InjectionLine[];
  unknown: number;
  // 末尾 1MB で切って読んだか（14 日の窓が短くなっている可能性の目印）
  truncated: boolean;
};

export function loadInjections(store: string): LoadedInjections {
  const lines: InjectionLine[] = [];
  let unknown = 0;
  let truncated = false;
  for (const path of injectionLogPaths(store)) {
    const tail = readLogTailInfo(path, LOG_MAX_BYTES);
    if (tail === null) continue;
    const parsed = parseInjectionLines(tail.text);
    lines.push(...parsed.lines);
    unknown += parsed.unknown;
    truncated = truncated || tail.truncated;
  }
  return { lines, unknown, truncated };
}

export function loadFeedback(store: string): {
  lines: FeedbackLine[];
  unknown: number;
} {
  const paths = storePaths(store);
  const lines: FeedbackLine[] = [];
  let unknown = 0;
  for (const path of [paths.feedbackLog, paths.codexFeedbackLog]) {
    const tail = readLogTailInfo(path, LOG_MAX_BYTES);
    if (tail === null) continue;
    const parsed = parseFeedbackLines(tail.text);
    lines.push(...parsed.lines);
    unknown += parsed.unknown;
  }
  return { lines, unknown };
}

export type LoadedMetrics = MetricsSummary & {
  injectionsUnknown: number;
  feedbackUnknown: number;
  injectionsTruncated: boolean;
  // 読んだ範囲の正しい行のうち最古の at（無ければ null）
  oldestInjectionAt: string | null;
};

export function loadMetrics(store: string, now: Date): LoadedMetrics {
  const injections = loadInjections(store);
  const feedback = loadFeedback(store);
  let oldest: string | null = null;
  for (const line of injections.lines) {
    if (oldest === null || line.at < oldest) oldest = line.at;
  }
  return {
    ...summarizeMetrics({
      injections: injections.lines,
      feedback: feedback.lines,
      now,
    }),
    injectionsUnknown: injections.unknown,
    feedbackUnknown: feedback.unknown,
    injectionsTruncated: injections.truncated,
    oldestInjectionAt: oldest,
  };
}

// 上限に達して書けなくなっているログの、`.state` からの相対パス
export function fullLogs(store: string): string[] {
  const paths = storePaths(store);
  const full: string[] = [];
  for (const path of [
    paths.injectionsLog,
    paths.feedbackLog,
    paths.codexFeedbackLog,
  ]) {
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && stat.size >= LOG_HARD_MAX_BYTES)
        full.push(relative(paths.state, path));
    } catch {
      // 無いログは満杯ではない
    }
  }
  return full;
}

// 注入の記録は指標であり安全の仕組みではない。失敗しても例外にせず、呼び出し側は注入を続ける
export function recordInjections(
  store: string,
  record: {
    at: Date;
    repoKey: string;
    kind: RecordKind;
    items: ReadonlyArray<{ id: string; trigger: string }>;
    reader: SceneReader;
  },
): boolean {
  try {
    if (!isValidRepoKey(record.repoKey)) return false;
    const at = record.at.toISOString();
    // 読む側が捨てる行を書かない
    const text = record.items
      .filter((i) => isRecordedId(i.id) && isRecordedTrigger(i.trigger))
      .map((i) =>
        formatInjectionLine({
          v: 1,
          at,
          repoKey: record.repoKey,
          id: i.id,
          kind: record.kind,
          trigger: i.trigger,
          reader: record.reader,
        }),
      )
      .join("");
    if (text === "") return true;
    return appendLogLines(storePaths(store).injectionsLog, text);
  } catch {
    return false;
  }
}

export function recordFeedback(store: string, line: FeedbackLine): boolean {
  try {
    return appendLogLines(
      feedbackLogPathFor(store, line.reader),
      formatFeedbackLine(line),
    );
  } catch {
    return false;
  }
}
