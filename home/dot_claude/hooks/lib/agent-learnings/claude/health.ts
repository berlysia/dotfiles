import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunGit } from "../../run-git.ts";
import { fullLogs, loadMetrics } from "../core/metrics-log.ts";
import { countJobs } from "../core/queue.ts";
import { oldestUnpushedCommitTime } from "../core/store.ts";

const QUEUE_STALE_MS = 24 * 3_600_000;
const UNPUSHED_STALE_MS = 7 * 86_400_000;

// SessionStart で知らせる異常の 1 行。正常（と store が無いとき）は null。
// 件数と固定の文言だけで組み、ジョブの reason やパスは入れない。
// remote が無いことは通知しない（設定するまで毎回出ると読まれなくなる）
export function getLearningsHealthNotice(input: {
  store: string;
  now: Date;
  runGit: RunGit;
}): string | null {
  if (!existsSync(join(input.store, ".git"))) return null;
  const jobs = countJobs(input.store);
  const problems: string[] = [];
  if (jobs.failed > 0) problems.push(`failed/ にジョブ ${jobs.failed} 件`);
  if (
    jobs.oldestEnqueuedAt !== null &&
    input.now.getTime() - Date.parse(jobs.oldestEnqueuedAt) > QUEUE_STALE_MS
  )
    problems.push(`queue に 24 時間より古いジョブ（${jobs.queue} 件）`);
  const oldest = oldestUnpushedCommitTime(input.store, input.runGit);
  if (
    oldest !== null &&
    input.now.getTime() - oldest.getTime() > UNPUSHED_STALE_MS
  )
    problems.push("7 日より古い未 push の commit");
  // 集計の失敗で既存の知らせまで落とさない。失敗したら 2 つを足さない側に倒す
  try {
    const { reviewCount } = loadMetrics(input.store, input.now);
    if (reviewCount > 0) problems.push(`見直す候補 ${reviewCount} 件`);
    if (fullLogs(input.store).length > 0) problems.push("記録のログが上限");
  } catch {
    // 指標の読み込みは知らせの本題ではない
  }
  if (problems.length === 0) return null;
  return `[agent-learnings] ${problems.join("、")}。対処: agent-learnings status`;
}
