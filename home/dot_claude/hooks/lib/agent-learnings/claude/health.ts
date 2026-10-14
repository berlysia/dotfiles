import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunGit } from "../core/git.ts";
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
  if (problems.length === 0) return null;
  return `[agent-learnings] ${problems.join("、")}。対処: agent-learnings status`;
}
