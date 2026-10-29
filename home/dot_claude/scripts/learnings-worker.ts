#!/usr/bin/env -S bun run --silent

/**
 * agent-learnings worker. Takes SessionEnd jobs from the queue, reduces the
 * transcript, asks an isolated Claude for edit operations, validates them and
 * applies them to the repo's learnings file. See the agent-learnings spec
 * (K5-K7) for the contract; the pieces live in
 * `hooks/lib/agent-learnings/`.
 *
 * `runWorker` is a function of injected dependencies so `node --test` drives it
 * with a fake query function. Importing this file has no side effects.
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  buildUserPrompt,
  runDistill,
  type DistillQueryFn,
} from "../hooks/lib/agent-learnings/claude/distill.ts";
import {
  checkTranscript,
  reduceTranscript,
} from "../hooks/lib/agent-learnings/claude/transcript.ts";
import { isWorkerSession } from "../hooks/lib/agent-learnings/claude/worker-guard.ts";
import type { RunGit } from "../hooks/lib/run-git.ts";
import { runGit as realRunGit } from "../hooks/lib/run-git.ts";
import { applyInboxLocked } from "../hooks/lib/agent-learnings/core/inbox.ts";
import {
  COMMON_KEY,
  parseLearningsFile,
  serializeLearningsFile,
  type LearningsFile,
} from "../hooks/lib/agent-learnings/core/learnings-file.ts";
import {
  checkOpGroups,
  parseLlmOps,
} from "../hooks/lib/agent-learnings/core/llm-ops.ts";
import {
  touchLock,
  withStoreLock,
} from "../hooks/lib/agent-learnings/core/lock.ts";
import { readNoPromote } from "../hooks/lib/agent-learnings/core/no-promote.ts";
import { applyOps } from "../hooks/lib/agent-learnings/core/ops.ts";
import {
  applyPromotes,
  buildCandidates,
} from "../hooks/lib/agent-learnings/core/promote.ts";
import {
  appendRunLog,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  failJobNow,
  readProcessed,
  recoverOrphans,
  releaseJob,
  writeProcessed,
  type QueueJob,
  type RunLogLine,
} from "../hooks/lib/agent-learnings/core/queue.ts";
import {
  isValidRepoKey,
  keyToFileName,
  resolveRepoKey,
} from "../hooks/lib/agent-learnings/core/repo-key.ts";
import {
  commitStore,
  defaultStoreDir,
  ensureStateDirs,
  readLearnings,
  rotateLogs,
  storePaths,
  writeLearnings,
} from "../hooks/lib/agent-learnings/core/store.ts";
import { loadRedactList } from "../hooks/lib/redact-secrets.ts";
import { getHomeDir } from "../hooks/lib/path-utils.ts";

export type WorkerDeps = {
  home: string;
  store: string;
  now: () => Date;
  queryFn: DistillQueryFn;
  runGit: RunGit;
  claudePath: string | undefined;
  extraRedact: readonly RegExp[];
  env?: Readonly<Record<string, string | undefined>>; // 既定は process.env
  lockWaitMs?: number; // store lock の待ち。既定 30 秒
  llmTimeoutMs?: number; // LLM の打ち切り。既定 5 分
};
export type WorkerResult = {
  status: "done" | "skipped" | "worker-session";
  processed: number;
};

// 1 回の起動で処理するジョブの上限（1 回の LLM 費用と実行時間に上限を置く）
export const MAX_JOBS_PER_RUN = 10;
const MIN_USER_TURNS = 3;
const STORE_LOCK_WAIT_MS = 30_000;
// 1 件は LLM の 5 分と store lock の 30 秒待ちに収まるので、ジョブごとに更新すれば奪われない
const WORKER_LOCK = { lockName: "worker.lock", staleMs: 30 * 60_000 } as const;

type Run = {
  deps: WorkerDeps;
  env: Readonly<Record<string, string | undefined>>;
  tried: Set<string>;
  resetLogged: boolean;
};

function logRun(
  run: Run,
  job: QueueJob,
  result: RunLogLine["result"],
  reason?: string,
  counts: { applied?: number; dropped?: number } = {},
): void {
  try {
    appendRunLog(run.deps.store, {
      schemaVersion: 1,
      at: run.deps.now().toISOString(),
      sessionId: job.sessionId,
      result,
      opsApplied: counts.applied ?? 0,
      opsDropped: counts.dropped ?? 0,
      ...(reason === undefined ? {} : { reason }),
    });
  } catch {
    // 実行記録に失敗しても整理は続ける
  }
}

// 昇格の候補にする他の repo のファイル。ファイル 1 行目の key から求めたファイル名が実際の
// ファイル名と一致し、format 1 で読めるものだけを使う（違うものは候補から外すだけ）
function readOtherRepoFiles(
  store: string,
  currentKey: string,
): Map<string, LearningsFile> {
  const others = new Map<string, LearningsFile>();
  const reposDir = storePaths(store).repos;
  let names: string[];
  try {
    if (!lstatSync(reposDir).isDirectory()) return others;
    names = readdirSync(reposDir).filter((name) => name.endsWith(".md"));
  } catch {
    return others;
  }
  for (const name of names) {
    try {
      const fd = openSync(
        join(reposDir, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let text: string;
      try {
        if (!fstatSync(fd).isFile()) continue;
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const parsed = parseLearningsFile(text);
      if (!parsed.ok || parsed.value.readOnly) continue;
      const { key } = parsed.value;
      if (
        key === currentKey ||
        !isValidRepoKey(key) ||
        keyToFileName(key) !== name
      )
        continue;
      others.set(key, parsed.value);
    } catch {
      // 読めないファイルは候補に入れない
    }
  }
  return others;
}

// lock の中で読み直す。読めなくなったファイルは外す（その matchId の昇格は捨てられる）
function rereadOtherRepoFiles(
  store: string,
  keys: Iterable<string>,
): Map<string, LearningsFile> {
  const others = new Map<string, LearningsFile>();
  for (const key of keys) {
    const file = readLearnings(store, key);
    if (file.ok && !file.value.readOnly && file.value.key === key)
      others.set(key, file.value);
  }
  return others;
}

// ジョブの検査・縮約・LLM・適用。ジョブの終わり方（complete / fail / release）はここで決める
async function processJob(run: Run, job: QueueJob): Promise<void> {
  const { deps } = run;
  const { store } = deps;
  const retry = (result: "failed" | "rejected", reason: string): void => {
    failJob(store, job);
    logRun(run, job, result, reason);
  };
  const projectsDir = join(deps.home, ".claude/projects");

  if (basename(job.transcriptPath) !== `${job.sessionId}.jsonl`)
    return retry("failed", "session mismatch");
  const allowed = checkTranscript(job.transcriptPath, projectsDir);
  if (!allowed.ok) return retry("failed", `transcript ${allowed.reason}`);
  // 縮約の前に取ったサイズ。処理中に伸びたかの比較に使う（伸びを見逃さない側に倒れる）
  const sizeBefore = allowed.value.size;
  if (!isValidRepoKey(job.repoKey)) return retry("failed", "repo mismatch");
  if (
    existsSync(job.cwd) &&
    resolveRepoKey(job.cwd, deps.runGit) !== job.repoKey
  )
    return retry("failed", "repo mismatch");

  const processed = readProcessed(store);
  if (processed.corrupt && !run.resetLogged) {
    run.resetLogged = true;
    logRun(run, job, "skipped", "processed reset");
  }
  const record = processed.records[job.sessionId];
  const reduce = (fromOffset: number) =>
    reduceTranscript({
      transcriptPath: job.transcriptPath,
      projectsDir,
      fromOffset,
      extraRedact: deps.extraRedact,
    });
  let reduced = reduce(record?.byteOffset ?? 0);
  if (
    reduced.ok &&
    record !== undefined &&
    !reduced.value.restarted &&
    reduced.value.firstLineHash !== record.firstLineHash
  )
    reduced = reduce(0);
  if (!reduced.ok) return retry("failed", "reduce failed");
  const transcript = reduced.value;

  if (transcript.userTurns < MIN_USER_TURNS) {
    // 位置は記録しない。次に同じ session が終わったとき、この発言も合わせて数え直す
    completeJob(store, job.sessionId);
    logRun(run, job, "skipped", "fewer than 3 user turns");
    return;
  }

  const repoFile = readLearnings(store, job.repoKey);
  const commonFile = readLearnings(store, COMMON_KEY);
  if (
    !repoFile.ok ||
    repoFile.value.readOnly ||
    !commonFile.ok ||
    commonFile.value.readOnly
  ) {
    failJobNow(store, job);
    logRun(run, job, "failed", "learnings file unreadable");
    return;
  }
  // LLM に見せた repo の id
  const shownIds = new Set(repoFile.value.entries.map((e) => e.id));
  const today = deps.now().toISOString().slice(0, 10);
  // 昇格の候補（lock の外で読む。見せた候補の id を覚えておき、lock の中で照合する）
  const noPromote = readNoPromote(store);
  const otherFiles = readOtherRepoFiles(store, job.repoKey);
  const candidateKeys = [...otherFiles.keys()];
  const candidates = buildCandidates({
    repoKey: job.repoKey,
    others: otherFiles,
    noPromote,
  });
  const newId = (): string => `L-${randomBytes(6).toString("hex")}`;

  const answer = await runDistill({
    queryFn: deps.queryFn,
    userPrompt: buildUserPrompt({
      today,
      repoLearnings: serializeLearningsFile(repoFile.value),
      commonLearnings: serializeLearningsFile(commonFile.value),
      otherRepoLearnings: candidates.text,
      transcript: transcript.text,
    }),
    cwd: storePaths(store).workerCwd,
    claudePath: deps.claudePath,
    parentEnv: run.env,
    ...(deps.llmTimeoutMs === undefined
      ? {}
      : { timeoutMs: deps.llmTimeoutMs }),
  });
  if (!answer.ok) return retry("failed", "llm failed");
  const parsed = parseLlmOps(answer.raw);
  if (!parsed.ok) return retry("rejected", "response rejected");

  type Outcome =
    | { kind: "applied"; applied: number; dropped: number }
    | { kind: "unreadable" }
    | { kind: "ops-rejected" };
  const locked = await withStoreLock(
    storePaths(store).state,
    { waitMs: deps.lockWaitMs ?? STORE_LOCK_WAIT_MS },
    (): Outcome => {
      applyInboxLocked(store, {
        today,
        runGit: deps.runGit,
        extraRedact: deps.extraRedact,
      });
      const current = readLearnings(store, job.repoKey);
      if (!current.ok || current.value.readOnly) return { kind: "unreadable" };
      const common = readLearnings(store, COMMON_KEY);
      if (!common.ok || common.value.readOnly) return { kind: "unreadable" };
      const others = rereadOtherRepoFiles(store, candidateKeys);

      // どれかが拒否なら、どのファイルも書かずに応答全体を拒否する
      const groups = checkOpGroups(
        parsed.ops,
        parsed.promotes,
        candidates.ids,
        deps.extraRedact,
      );
      if (!groups.ok) return { kind: "ops-rejected" };
      const result = applyOps(current.value, parsed.ops, {
        today,
        repoKey: job.repoKey,
        newId,
        rules: { allowUrl: false },
        extraRedact: deps.extraRedact,
        droppableIds: shownIds,
      });
      if (!result.ok) return { kind: "ops-rejected" };
      const next = result.value;
      const promoted = applyPromotes({
        repoKey: job.repoKey,
        today,
        repoFile: next.file,
        others,
        common: common.value,
        noPromote,
        ops: parsed.promotes,
        newId,
        extraRedact: deps.extraRedact,
        droppableIds: new Set([...shownIds, ...candidates.ids]),
        shownCandidateIds: candidates.ids,
      });
      if (!promoted.ok)
        return {
          kind: promoted.kind === "read-only" ? "unreadable" : "ops-rejected",
        };
      const promo = promoted.value;

      // 書く順は common → 他の repo → 現在の repo。途中で落ちると重複が残る側に倒れる
      const writes: LearningsFile[] = [];
      if (promo.appliedCount > 0) writes.push(promo.common);
      writes.push(...promo.changedOthers.values());
      if (
        serializeLearningsFile(promo.repoFile) !==
        serializeLearningsFile(current.value)
      )
        writes.push(promo.repoFile);
      for (const file of writes)
        if (!writeLearnings(store, file).ok) return { kind: "unreadable" };
      if (writes.length > 0) {
        const body = [
          ...next.evidence,
          ...promo.commitLines,
          ...(next.evictedIds.length > 0
            ? [`evicted: ${next.evictedIds.join(", ")}`]
            : []),
        ].join("\n");
        // commit に失敗しても学びは書けている。未 commit は status が知らせる
        commitStore(
          store,
          `learnings: session ${job.sessionId.slice(0, 8)} (${job.repoKey})\n\n${body}`,
          deps.runGit,
        );
      }
      writeProcessed(
        store,
        job.sessionId,
        {
          byteOffset: transcript.endOffset,
          firstLineHash: transcript.firstLineHash,
        },
        deps.now(),
      );
      completeJob(store, job.sessionId);
      return {
        kind: "applied",
        applied: parsed.ops.length - next.droppedCount + promo.appliedCount,
        dropped: next.droppedCount + promo.droppedCount,
      };
    },
  );

  if (!locked.ok) {
    // store lock が取れない・作れない: ジョブ自体に問題は無いので attempts を使わずに戻す
    releaseJob(store, job);
    logRun(run, job, "skipped", "lock busy");
    return;
  }
  const outcome = locked.value;
  if (outcome.kind === "unreadable") {
    failJobNow(store, job);
    logRun(run, job, "failed", "learnings file unreadable");
    return;
  }
  if (outcome.kind === "ops-rejected") return retry("rejected", "ops rejected");

  logRun(run, job, "applied", undefined, {
    applied: outcome.applied,
    dropped: outcome.dropped,
  });
  // 処理中に session が続いた分は、改めて enqueue して次の起動で拾う。
  // endOffset とは比べない（書きかけの行が末尾にあると常に大きくなるため）
  const now = checkTranscript(job.transcriptPath, projectsDir);
  if (now.ok && now.value.size > sizeBefore) {
    enqueueJob(
      store,
      {
        sessionId: job.sessionId,
        transcriptPath: job.transcriptPath,
        cwd: job.cwd,
        repoKey: job.repoKey,
        reason: job.reason,
      },
      deps.now(),
    );
  }
}

export async function runWorker(deps: WorkerDeps): Promise<WorkerResult> {
  const env = deps.env ?? process.env;
  if (isWorkerSession(env)) return { status: "worker-session", processed: 0 };
  if (!existsSync(join(deps.store, ".git")))
    return { status: "skipped", processed: 0 };
  ensureStateDirs(deps.store);
  const state = storePaths(deps.store).state;

  const locked = await withStoreLock(
    state,
    { waitMs: 0, ...WORKER_LOCK },
    async (): Promise<WorkerResult> => {
      const run: Run = {
        deps,
        env,
        tried: new Set(),
        resetLogged: false,
      };
      recoverOrphans(deps.store, deps.now());
      let processed = 0;
      while (processed < MAX_JOBS_PER_RUN) {
        const job = claimJob(deps.store, {
          tried: run.tried,
          now: deps.now(),
        });
        if (job === null) break;
        run.tried.add(job.sessionId);
        touchLock(state, WORKER_LOCK);
        processed += 1;
        await processJob(run, job);
      }
      await withStoreLock(
        state,
        { waitMs: deps.lockWaitMs ?? STORE_LOCK_WAIT_MS },
        () => rotateLogs(deps.store),
      );
      return { status: "done", processed };
    },
  );
  return locked.ok ? locked.value : { status: "skipped", processed: 0 };
}

function whichClaude(): string | undefined {
  try {
    return (
      execFileSync("which", ["claude"], { encoding: "utf8" }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  // 本物の SDK はここでだけ読む（import しただけでは何も起きないように）
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const home = getHomeDir();
  await runWorker({
    home,
    store: defaultStoreDir(home),
    now: () => new Date(),
    queryFn: query as unknown as DistillQueryFn,
    runGit: realRunGit,
    claudePath: whichClaude(),
    extraRedact: loadRedactList(
      join(home, ".claude/insight-distill-redact.txt"),
    ),
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[learnings-worker] fatal: ${error}`);
    process.exitCode = 1;
  });
}
