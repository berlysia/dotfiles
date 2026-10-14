import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRedactList } from "../../insight-digest.ts";
import { drainInbox } from "../core/inbox.ts";
import type { RunGit } from "../core/git.ts";
import { COMMON_KEY } from "../core/learnings-file.ts";
import { enqueueJob } from "../core/queue.ts";
import { renderLearnings } from "../core/render.ts";
import { resolveRepoKey } from "../core/repo-key.ts";
import {
  appendReadLog,
  commonFilePath,
  defaultStoreDir,
  ensureStateDirs,
  readLearnings,
  repoFilePath,
  storePaths,
} from "../core/store.ts";
import { buildWorkerEnv } from "./worker-env.ts";
import { isWorkerSession } from "./worker-guard.ts";

// SessionStart で Claude の文脈へ渡す学び。store が無い・repo の外なら null。
// Codex が inbox に置いた依頼はここで取り込む（lock が取れなければ飛ばす）。
export async function buildSessionLearningsContext(input: {
  cwd: string;
  home: string;
  runGit: RunGit;
  now: Date;
}): Promise<string | null> {
  const store = defaultStoreDir(input.home);
  if (!existsSync(join(store, ".git"))) return null;
  const repoKey = resolveRepoKey(input.cwd, input.runGit);
  if (repoKey === null) return null;

  await drainInbox(store, {
    waitMs: 0,
    today: input.now.toISOString().slice(0, 10),
    runGit: input.runGit,
    extraRedact: loadRedactList(
      join(input.home, ".claude/insight-distill-redact.txt"),
    ),
  });

  const repo = readLearnings(store, repoKey);
  const common = readLearnings(store, COMMON_KEY);
  const rendered = renderLearnings({
    repo: repo.ok ? repo.value : null,
    common: common.ok ? common.value : null,
    repoPath: repoFilePath(store, repoKey),
    commonPath: commonFilePath(store),
  });
  if (rendered !== null) {
    appendReadLog(storePaths(store).readsLog, {
      at: input.now,
      reader: "claude",
      repoKey,
    });
  }
  return rendered;
}

export type WorkerSpawnSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached: true;
  stdio: "ignore";
};

// hook が起動する worker のプロセスの組み立て。shell を使わず、引数は固定のパス 1 つだけ。
// 環境は許可リストだけで、worker の印は付けない（worker 自身は worker のセッションではない）
export function buildWorkerSpawnSpec(
  home: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
  execPath: string = process.execPath,
): WorkerSpawnSpec {
  return {
    command: execPath,
    args: [join(home, ".claude/scripts/learnings-worker.ts")],
    cwd: storePaths(defaultStoreDir(home)).workerCwd,
    env: buildWorkerEnv(parentEnv, { markWorker: false }),
    detached: true,
    stdio: "ignore",
  };
}

// worker を待たずに起動する（detached・unref）
export function spawnWorker(home: string): void {
  ensureStateDirs(defaultStoreDir(home));
  const spec = buildWorkerSpawnSpec(home, process.env);
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: spec.stdio,
  });
  child.on("error", () => {
    // 起動できなくても queue に残る。次の SessionStart が拾う
  });
  child.unref();
}

export type SessionEndInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  reason: string;
};

// SessionEnd でジョブを queue に入れ、入れられたら worker を 1 回起動する
export function enqueueSessionEnd(
  input: SessionEndInput,
  deps: {
    home: string;
    runGit: RunGit;
    env: Readonly<Record<string, string | undefined>>;
    spawn: (home: string) => void;
    now?: Date;
  },
):
  | "enqueued"
  | "worker-session"
  | "no-store"
  | "no-repo"
  | "already-queued"
  | "processing"
  | "invalid" {
  if (isWorkerSession(deps.env)) return "worker-session";
  const store = defaultStoreDir(deps.home);
  if (!existsSync(join(store, ".git"))) return "no-store";
  const repoKey = resolveRepoKey(input.cwd, deps.runGit);
  if (repoKey === null) return "no-repo";
  const result = enqueueJob(
    store,
    {
      sessionId: input.session_id,
      transcriptPath: input.transcript_path,
      cwd: input.cwd,
      repoKey,
      reason: input.reason,
    },
    deps.now ?? new Date(),
  );
  if (result.status !== "enqueued") return result.status;
  deps.spawn(deps.home);
  return "enqueued";
}
