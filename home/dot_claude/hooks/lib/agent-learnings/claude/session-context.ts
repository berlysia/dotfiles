import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRedactList } from "../../insight-digest.ts";
import { drainInbox } from "../core/inbox.ts";
import type { RunGit } from "../core/git.ts";
import { COMMON_KEY, type LearningsFile } from "../core/learnings-file.ts";
import { countJobs, enqueueJob } from "../core/queue.ts";
import { renderLearnings } from "../core/render.ts";
import { resolveRepoKey } from "../core/repo-key.ts";
import { filterByTrigger, type Trigger } from "../core/triggers.ts";
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

const SESSION: Trigger = { kind: "session" };

// SessionStart で Claude の文脈へ渡す学び。store が無い・repo の外なら null。
// Codex が inbox に置いた依頼はここで取り込む（lock が取れなければ飛ばす）。
export async function buildSessionLearningsContext(input: {
  cwd: string;
  home: string;
  runGit: RunGit;
  now: Date;
  env?: Readonly<Record<string, string | undefined>>; // 既定は process.env
}): Promise<string | null> {
  // worker が起動した Claude のセッションには学びを渡さず、reads.log も書かない
  if (isWorkerSession(input.env ?? process.env)) return null;
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

  // 開始時は `on` が無い学びと `session` の学びだけ（show --on=session と同じ関数）。
  // 外れた分は場面だけを持つ学び（無効な `on` は絞りに残る）で、件数だけを知らせる
  const sessionOnly = (file: LearningsFile | null) => {
    if (file === null) return { file: null, dropped: 0 };
    const entries = filterByTrigger(file.entries, file.key, SESSION);
    return {
      file: { ...file, entries },
      dropped: file.entries.length - entries.length,
    };
  };
  const repoRead = readLearnings(store, repoKey);
  const commonRead = readLearnings(store, COMMON_KEY);
  const repo = sessionOnly(repoRead.ok ? repoRead.value : null);
  const common = sessionOnly(commonRead.ok ? commonRead.value : null);
  const rendered = renderLearnings({
    repo: repo.file,
    common: common.file,
    sceneOnlyCount: repo.dropped + common.dropped,
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

export type SessionJobInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  reason: string;
};

// PreCompact の入力には reason が無い。ジョブの reason は記録するだけで絞り込みには使わないので固定の文言にする
export const COMPACT_REASON = "compact";

// hook の入力（SessionEnd か PreCompact）からジョブの入力を作る。
// 型の根拠: claude-agent-sdk の PreCompactHookInput = BaseHookInput & { trigger, custom_instructions }
export function jobInputFromHook(
  input:
    | {
        hook_event_name: "SessionEnd";
        session_id: string;
        transcript_path: string;
        cwd: string;
        reason: string;
      }
    | {
        hook_event_name: "PreCompact";
        session_id: string;
        transcript_path: string;
        cwd: string;
      },
): SessionJobInput {
  return {
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    reason:
      input.hook_event_name === "PreCompact" ? COMPACT_REASON : input.reason,
  };
}

// SessionEnd と PreCompact でジョブを queue に入れ、入れられたら worker を 1 回起動する
export function enqueueSessionJob(
  input: SessionJobInput,
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

// 取りこぼし（SessionEnd / PreCompact の worker 起動が失敗した・worker が落ちた）を拾う。
// queue か processing にジョブがあるときだけ worker を起動する（lock で 1 つだけが進む）
export function kickWorkerIfQueued(
  home: string,
  deps: { spawn: (home: string) => void },
): boolean {
  const store = defaultStoreDir(home);
  if (!existsSync(join(store, ".git"))) return false;
  const jobs = countJobs(store);
  if (jobs.queue + jobs.processing === 0) return false;
  deps.spawn(home);
  return true;
}
