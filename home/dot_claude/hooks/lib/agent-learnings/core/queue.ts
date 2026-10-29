import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isValidRepoKey } from "../../repo-key.ts";
import { ensureStateDirs, storePaths, writeFileSyncAtomic } from "./store.ts";

// SessionEnd のジョブ。公開する形式（spec「契約 / queue ジョブ」）
export type QueueJob = {
  schemaVersion: 1;
  sessionId: string; // /^[0-9a-f-]{36}$/
  transcriptPath: string; // core は不透明に扱う
  cwd: string;
  repoKey: string; // isValidRepoKey
  reason: string;
  enqueuedAt: string; // ISO 8601 UTC。失敗で書き戻しても変えない
  attempts: number; // 0 以上の整数
};

export const MAX_ATTEMPTS = 3;
export const ORPHAN_MS = 15 * 60_000;
const PROCESSED_TTL_MS = 30 * 86_400_000;
const SESSION_ID = /^[0-9a-f-]{36}$/;
const JOB_NAME = /^[0-9a-f-]{36}\.json$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const JOB_KEYS = [
  "schemaVersion",
  "sessionId",
  "transcriptPath",
  "cwd",
  "repoKey",
  "reason",
  "enqueuedAt",
  "attempts",
] as const;
const RUNS_TAIL_BYTES = 1024 * 1024;

export type EnqueueInput = {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  repoKey: string;
  reason: string;
};
export type EnqueueResult =
  | { status: "enqueued" }
  | { status: "already-queued" }
  | { status: "processing" }
  | { status: "invalid"; reason: string };

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

const jobJson = (job: QueueJob): string =>
  JSON.stringify(
    Object.fromEntries(JOB_KEYS.map((key) => [key, job[key]])) as QueueJob,
  );

function parseJob(text: string): QueueJob | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== [...JOB_KEYS].sort().join(",")) return null;
  const { sessionId, enqueuedAt, attempts } = record;
  if (record["schemaVersion"] !== 1) return null;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  for (const key of ["transcriptPath", "cwd", "repoKey", "reason"] as const)
    if (typeof record[key] !== "string") return null;
  if (
    typeof enqueuedAt !== "string" ||
    !ISO_8601.test(enqueuedAt) ||
    Number.isNaN(Date.parse(enqueuedAt))
  )
    return null;
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 0
  )
    return null;
  return record as unknown as QueueJob;
}

// 通常ファイル・自分の所有・symlink でない、のものだけを読む
function readJobFile(path: string): QueueJob | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return null;
    return parseJob(readFileSync(fd, "utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function moveToFailed(store: string, from: string, name: string): void {
  try {
    renameSync(from, join(storePaths(store).failed, name));
  } catch {
    try {
      unlinkSync(from);
    } catch {
      // 既に無い
    }
  }
}

function listJobNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => JOB_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

export function enqueueJob(
  store: string,
  input: EnqueueInput,
  now: Date,
): EnqueueResult {
  if (!SESSION_ID.test(input.sessionId))
    return { status: "invalid", reason: "sessionId" };
  if (!isValidRepoKey(input.repoKey))
    return { status: "invalid", reason: "repoKey" };
  ensureStateDirs(store);
  const paths = storePaths(store);
  const name = `${input.sessionId}.json`;
  if (listJobNames(paths.processing).includes(name))
    return { status: "processing" };
  const job: QueueJob = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    cwd: input.cwd,
    repoKey: input.repoKey,
    reason: input.reason,
    enqueuedAt: now.toISOString(),
    attempts: 0,
  };
  const dest = join(paths.queue, name);
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSyncAtomic(tmp, jobJson(job), 0o600);
  return linkIntoQueue(tmp, dest);
}

// 上書きしない配置。同じ sessionId が既にあれば何もしない
function linkIntoQueue(tmp: string, dest: string): EnqueueResult {
  try {
    linkSync(tmp, dest);
    return { status: "enqueued" };
  } catch (error) {
    if (errorCode(error) === "EEXIST") return { status: "already-queued" };
    throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 既に無い
    }
  }
}

// queue/ を名前の昇順に見て、この run で試していない最初の 1 件を processing/ へ確保する
export function claimJob(
  store: string,
  opts: { tried: ReadonlySet<string>; now: Date },
): QueueJob | null {
  const paths = storePaths(store);
  for (const name of listJobNames(paths.queue)) {
    if (opts.tried.has(name.slice(0, -".json".length))) continue;
    const target = join(paths.processing, name);
    try {
      renameSync(join(paths.queue, name), target);
    } catch {
      continue; // 別の worker に取られた、または消えた
    }
    // rename は mtime を保つので、長く queue にあったジョブが孤児と判定されないようにする
    try {
      utimesSync(target, opts.now, opts.now);
    } catch {
      // 失敗しても孤児の回収が拾う
    }
    const job = readJobFile(target);
    if (job === null || `${job.sessionId}.json` !== name) {
      moveToFailed(store, target, name);
      continue;
    }
    return job;
  }
  return null;
}

export function completeJob(store: string, sessionId: string): void {
  try {
    unlinkSync(join(storePaths(store).processing, `${sessionId}.json`));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function writeThenRemoveProcessing(
  store: string,
  job: QueueJob,
  destDir: string,
): void {
  const name = `${job.sessionId}.json`;
  writeFileSyncAtomic(join(destDir, name), jobJson(job), 0o600);
  completeJob(store, job.sessionId);
}

// attempts を 1 増やす。上限に達したら failed/、未満なら queue/ に戻す
export function failJob(store: string, job: QueueJob): "requeued" | "failed" {
  const next = { ...job, attempts: job.attempts + 1 };
  const paths = storePaths(store);
  if (next.attempts >= MAX_ATTEMPTS) {
    writeThenRemoveProcessing(store, next, paths.failed);
    return "failed";
  }
  writeThenRemoveProcessing(store, next, paths.queue);
  return "requeued";
}

// attempts を変えずに queue/ へ戻す（lock の待ち時間切れなど、ジョブ自体に問題が無いとき）
export function releaseJob(store: string, job: QueueJob): void {
  writeThenRemoveProcessing(store, job, storePaths(store).queue);
}

// attempts を使わずに failed/ へ（問題がジョブではなく学びファイルの側にあるとき）
export function failJobNow(store: string, job: QueueJob): void {
  writeThenRemoveProcessing(store, job, storePaths(store).failed);
}

// 15 分より古い processing/ のジョブを attempts+1 で queue/ に戻す（上限なら failed/）
export function recoverOrphans(
  store: string,
  now: Date,
): { requeued: number; failed: number } {
  const paths = storePaths(store);
  const result = { requeued: 0, failed: 0 };
  for (const name of listJobNames(paths.processing)) {
    const path = join(paths.processing, name);
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now.getTime() - mtimeMs <= ORPHAN_MS) continue;
    const job = readJobFile(path);
    if (job === null || `${job.sessionId}.json` !== name) {
      moveToFailed(store, path, name);
      result.failed += 1;
      continue;
    }
    result[failJob(store, job)] += 1;
  }
  return result;
}

export type JobCounts = {
  queue: number;
  processing: number;
  failed: number;
  oldestEnqueuedAt: string | null; // queue のジョブのうち最も古い enqueuedAt
};

export function countJobs(store: string): JobCounts {
  const paths = storePaths(store);
  let oldest: string | null = null;
  const queued = listJobNames(paths.queue);
  for (const name of queued) {
    const job = readJobFile(join(paths.queue, name));
    if (job !== null && (oldest === null || job.enqueuedAt < oldest))
      oldest = job.enqueuedAt;
  }
  return {
    queue: queued.length,
    processing: listJobNames(paths.processing).length,
    failed: listJobNames(paths.failed).length,
    oldestEnqueuedAt: oldest,
  };
}

export type ProcessedRecord = {
  byteOffset: number;
  firstLineHash: string;
  updatedAt: string;
};
export type ProcessedMap = Record<string, ProcessedRecord>;

// 壊れていたら空として扱い corrupt を立てる（呼び出し側が runs.log に残す）
export function readProcessed(store: string): {
  records: ProcessedMap;
  corrupt: boolean;
} {
  let text: string;
  try {
    text = readFileSync(storePaths(store).processed, "utf8");
  } catch (error) {
    return { records: {}, corrupt: errorCode(error) !== "ENOENT" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("shape");
    const records: ProcessedMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      const v = value as Partial<ProcessedRecord> | null;
      if (
        typeof v !== "object" ||
        v === null ||
        typeof v.byteOffset !== "number" ||
        !Number.isInteger(v.byteOffset) ||
        v.byteOffset < 0 ||
        typeof v.firstLineHash !== "string" ||
        typeof v.updatedAt !== "string"
      )
        throw new Error("shape");
      records[key] = {
        byteOffset: v.byteOffset,
        firstLineHash: v.firstLineHash,
        updatedAt: v.updatedAt,
      };
    }
    return { records, corrupt: false };
  } catch {
    return { records: {}, corrupt: true };
  }
}

// store lock の中からだけ呼ぶ
export function writeProcessed(
  store: string,
  sessionId: string,
  record: { byteOffset: number; firstLineHash: string },
  now: Date,
): void {
  const { records } = readProcessed(store);
  records[sessionId] = { ...record, updatedAt: now.toISOString() };
  for (const [key, value] of Object.entries(records)) {
    const at = Date.parse(value.updatedAt);
    if (Number.isNaN(at) || now.getTime() - at > PROCESSED_TTL_MS)
      delete records[key];
  }
  writeFileSyncAtomic(
    storePaths(store).processed,
    JSON.stringify(records),
    0o600,
  );
}

// worker の実行記録 1 行。公開する形式
export type RunLogLine = {
  schemaVersion: 1;
  at: string; // ISO 8601 UTC
  sessionId: string;
  result: "applied" | "skipped" | "rejected" | "failed";
  opsApplied: number;
  opsDropped: number;
  reason?: string; // 固定の文言。LLM や transcript の文字列は入れない
};

// O_APPEND の 1 回の write。lock の外でよい
export function appendRunLog(store: string, line: RunLogLine): void {
  const fd = openSync(
    storePaths(store).runsLog,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(line)}\n`);
  } finally {
    closeSync(fd);
  }
}

export type RunSummary = Record<RunLogLine["result"], number>;

export function summarizeRuns(
  store: string,
  now: Date,
  days: number,
): RunSummary {
  const summary: RunSummary = {
    applied: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
  };
  const path = storePaths(store).runsLog;
  let text: string;
  try {
    const size = statSync(path).size;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const length = Math.min(size, RUNS_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(
          fd,
          buffer,
          read,
          length - read,
          size - length + read,
        );
        if (n === 0) break;
        read += n;
      }
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return summary;
  }
  const since = now.getTime() - days * 86_400_000;
  for (const raw of text.split("\n")) {
    try {
      const line = JSON.parse(raw) as Partial<RunLogLine>;
      const at = Date.parse(line.at ?? "");
      if (Number.isNaN(at) || at < since) continue;
      if (
        line.result === "applied" ||
        line.result === "skipped" ||
        line.result === "rejected" ||
        line.result === "failed"
      )
        summary[line.result] += 1;
    } catch {
      // 壊れた行と、読み始めが途中の行は飛ばす
    }
  }
  return summary;
}
