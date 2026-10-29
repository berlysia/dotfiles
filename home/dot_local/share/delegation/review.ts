import {
  AUTO_REWRITE_REVISIT_RECORDS,
  EXPLORE_MIN_RECORDS,
  EXPLORE_WINDOW_DAYS,
  FIVE_HOUR_AHEAD_PERCENT,
  FORECAST_MAX_AGE_MINUTES,
  FORECAST_RESETS_TOLERANCE_HOURS,
  LAPSE_RATIO_MAX_PERCENT,
  LOOKAHEAD_MIN_OBSERVED_HOURS,
  MIN_RECORDS,
  PENDING_LIMIT,
  RECORD_GAP_POINTS,
  REVIEW_AFTER_DAYS,
  REVIEW_AFTER_RECORDS,
  STALE_PENDING_DAYS,
  SURPLUS_MIN_POINTS,
  WEEK_LINE_EXTRA_DAYS,
  WEEK_LOOKAHEAD_HOURS,
} from "./constants.ts";
import {
  allCells,
  enoughRecords,
  formatLapse,
  formatRates,
  groupKey,
  groupLabel,
  median,
  withinDays,
  type GroupStats,
} from "./aggregate.ts";
import { displayModel, formatNote } from "./schema.ts";
import type { Folded, SkipCounts } from "./store.ts";

export const REVIEW_HEADER = "delegation review v1";

export type ReviewInput = {
  now: Date;
  sinceDays: number;
  folded: Folded;
  skipped: SkipCounts;
  ledgerLarge: boolean;
};

const NOTES_PER_GROUP = 3;

function constantsLine(): string {
  return [
    `週の目安=経過日数+${WEEK_LINE_EXTRA_DAYS}`,
    `5h ahead=${FIVE_HOUR_AHEAD_PERCENT}%`,
    `先読み=${WEEK_LOOKAHEAD_HOURS}h`,
    `先読みの観測下限=${LOOKAHEAD_MIN_OBSERVED_HOURS}h`,
    `予想ファイルの鮮度=${FORECAST_MAX_AGE_MINUTES}分`,
    `リセット時刻の許容差=${FORECAST_RESETS_TOLERANCE_HOURS}h`,
    `週枠の余り=${SURPLUS_MIN_POINTS}pt`,
    `規則 1 の差=${RECORD_GAP_POINTS}pt`,
    `率を出す最少件数=${MIN_RECORDS}`,
    `lapse 上限=${LAPSE_RATIO_MAX_PERCENT}%`,
    `探索=${EXPLORE_WINDOW_DAYS} 日 ${EXPLORE_MIN_RECORDS} 件`,
    `振り返り=${REVIEW_AFTER_RECORDS} 件 / ${REVIEW_AFTER_DAYS} 日`,
    `古い pending=${STALE_PENDING_DAYS} 日`,
    `pending 上限=${PENDING_LIMIT}`,
  ].join(" / ");
}

function groupDetail(
  folded: Folded,
  g: GroupStats,
  kind: string,
  size: string,
  now: Date,
  days: number,
): string[] {
  const rows = folded.delegations.filter(
    (d) =>
      d.kind === kind &&
      d.size === size &&
      groupKey(d) === groupKey(g) &&
      withinDays(d.at, now, days),
  );
  const defects = rows.reduce(
    (sum, d) => sum + d.laterDefects.filter((f) => f !== "main").length,
    0,
  );
  const durations = rows
    .map((d) => d.durationMs)
    .filter((v): v is number => v !== null);
  const nulls = rows.length - durations.length;
  const mid = median(durations);
  const out = [
    `  ${groupLabel(g)}: ${formatRates(g)} ${formatLapse(g)} 委譲先の欠陥 ${defects} 所要時間 中央値 ${mid === null ? "-" : `${mid}ms`} (null を除いた数 ${nulls})`,
  ];
  const newest = [...rows]
    .filter((d) => d.note !== undefined && d.note !== "")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, NOTES_PER_GROUP);
  for (const d of newest) out.push(`    ${formatNote(d.note ?? "")}`);
  if (!enoughRecords(g)) out.push("    定数の見直しには件数が足りない");
  if (displayModel(g.model).startsWith("m-")) {
    out.push("    既知の一覧に足す候補 (constants.ts の KNOWN_MODELS)");
  }
  if (g.n > AUTO_REWRITE_REVISIT_RECORDS) {
    out.push(
      `    件数が ${AUTO_REWRITE_REVISIT_RECORDS} を超えた。自動書き換えの再検討の条件に当たる`,
    );
  }
  return out;
}

export function buildReview(input: ReviewInput): string[] {
  const { folded, now, sinceDays } = input;
  const out: string[] = [];
  if (input.ledgerLarge) out.push("台帳が大きい。分割を検討");
  out.push(`${REVIEW_HEADER} (直近 ${sinceDays} 日)`);
  out.push(`定数: ${constantsLine()}`);
  const cells = allCells(folded, now, sinceDays);
  if (cells.length === 0) out.push("(この範囲に記録なし)");
  for (const cell of cells) {
    out.push(`${cell.kind}×${cell.size}:`);
    for (const g of cell.groups) {
      out.push(...groupDetail(folded, g, cell.kind, cell.size, now, sinceDays));
    }
  }
  const { version, type, broken } = input.skipped;
  if (version + type + broken > 0) {
    out.push(
      `読み飛ばし: v違い ${version} / 知らない type ${type} / 壊れた行 ${broken}`,
    );
  }
  if (folded.ignoredAmends > 0) {
    out.push(`対応する記録のない amend: ${folded.ignoredAmends}`);
  }
  return out;
}
