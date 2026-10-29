import { readFileSync } from "node:fs";
import { isAddressableName, sanitizeLabel } from "../sanitize-label.ts";
import { liveness, type ReadStat } from "./liveness.ts";
import { identifyRepo, defaultRepoIdentityDeps } from "./repo-identity.ts";
import {
  readSessionFiles,
  type ReadSessionFilesResult,
} from "./read-session-files.ts";
import {
  SCHEMA_VERSION,
  VERIFIED_WITH,
  type RepoIdentity,
  type SessionList,
  type SessionRow,
  type SessionRowInternal,
} from "./types.ts";
import { validateSession, type ValidSession } from "./validate-session.ts";

export type ListSessionsDeps = {
  // May return a promise so that a caller (and the CLI watchdog test) can stand
  // in for a read that never finishes. The default one is synchronous.
  readSessionFiles: (
    dir: string,
  ) => ReadSessionFilesResult | Promise<ReadSessionFilesResult>;
  readStat: ReadStat;
  selfPid: number;
  identifyRepo: (cwd: string, signal: AbortSignal) => Promise<RepoIdentity>;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

export type ListSessionsOptions = {
  dir: string;
  /** Lower-cased UUID, or undefined. Its shape is checked by the caller. */
  self?: string | undefined;
  runningVersion?: string | null;
  concurrency?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
};

export type ListSessionsResult =
  | {
      ok: true;
      value: { list: SessionList; internalRows: SessionRowInternal[] };
    }
  | { ok: false; error: { kind: "sessions-dir-unreadable"; message: string } };

export function defaultListSessionsDeps(): ListSessionsDeps {
  return {
    readSessionFiles: (dir) => readSessionFiles(dir),
    readStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
    selfPid: process.pid,
    identifyRepo: (cwd, signal) =>
      identifyRepo(cwd, defaultRepoIdentityDeps, signal),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

/**
 * The "format may have changed" signal: two or more files got as far as the
 * content check and every one of them failed it. One failure alone is
 * ordinary damage. Files skipped before the content check (symlinks, oversize)
 * say nothing about the format, so they are left out of the count.
 */
export function isShapeSuspect(
  scanned: number,
  skipped: number,
  invalid: number,
): boolean {
  const reachedContentCheck = scanned - (skipped - invalid);
  return reachedContentCheck >= 2 && invalid === reachedContentCheck;
}

const ERROR_IDENTITY: RepoIdentity = {
  repoStatus: "error",
  repo: null,
  worktree: null,
  worktreePath: null,
  branch: null,
};

const compareCodeUnits = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

// BigInt: a 20-digit start time can exceed 2^53 and Number would merge two
// different values.
function newerProcess(a: ValidSession, b: ValidSession): ValidSession {
  const sa = BigInt(a.procStart);
  const sb = BigInt(b.procStart);
  if (sa !== sb) return sa > sb ? a : b;
  return a.pid <= b.pid ? a : b;
}

function dedupeBySessionId(sessions: ValidSession[]): ValidSession[] {
  const bySession = new Map<string, ValidSession>();
  for (const session of sessions) {
    const kept = bySession.get(session.sessionId);
    bySession.set(
      session.sessionId,
      kept === undefined ? session : newerProcess(kept, session),
    );
  }
  return [...bySession.values()];
}

type IdentifyAllOptions = {
  concurrency: number;
  deadlineMs: number;
  signal: AbortSignal | undefined;
};

async function identifyAll(
  cwds: readonly string[],
  deps: ListSessionsDeps,
  options: IdentifyAllOptions,
): Promise<RepoIdentity[]> {
  const results: Array<RepoIdentity | undefined> = cwds.map(() => undefined);
  if (cwds.length === 0) return [];

  const controller = new AbortController();
  let finished = false;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!finished && next < cwds.length) {
      const index = next;
      next += 1;
      const cwd = cwds[index] as string;
      let identity: RepoIdentity;
      try {
        identity = await deps.identifyRepo(cwd, controller.signal);
      } catch {
        identity = ERROR_IDENTITY;
      }
      // A result that settles after the deadline is dropped on purpose.
      if (!finished) results[index] = identity;
    }
  };

  let resolveCutoff: () => void = () => {};
  const cutoff = new Promise<void>((resolve) => {
    resolveCutoff = resolve;
  });
  const stop = (): void => {
    finished = true;
    controller.abort();
    resolveCutoff();
  };
  const timer = deps.setTimer(stop, options.deadlineMs);
  const onExternalAbort = (): void => stop();
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const pool = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, cwds.length)) },
    worker,
  );
  // Raced against the cutoff so an identifyRepo that ignores its signal cannot
  // hold the result back past the deadline.
  await Promise.race([Promise.all(pool), cutoff]);
  finished = true;
  deps.clearTimer(timer);
  options.signal?.removeEventListener("abort", onExternalAbort);
  return results.map((identity) => identity ?? ERROR_IDENTITY);
}

function buildRow(
  session: ValidSession,
  identity: RepoIdentity,
  self: string | undefined,
): SessionRowInternal {
  const raw = session.name;
  return {
    sessionId: session.sessionId,
    name: raw === null ? null : sanitizeLabel(raw, "head"),
    addressable: raw !== null && isAddressableName(raw),
    duplicateName: false,
    status: session.status,
    liveness: "alive",
    isSelf: self !== undefined && session.sessionId === self,
    repoStatus: identity.repoStatus,
    repo: identity.repo,
    worktree: identity.worktree,
    worktreePath: identity.worktreePath,
    branch: identity.branch,
  };
}

// Named field by field, never spread: spreading an internal row would put
// worktreePath into --json.
function toPublicRow(row: SessionRowInternal): SessionRow {
  return {
    sessionId: row.sessionId,
    name: row.name,
    addressable: row.addressable,
    duplicateName: row.duplicateName,
    status: row.status,
    liveness: row.liveness,
    isSelf: row.isSelf,
    repoStatus: row.repoStatus,
    repo: row.repo,
    worktree: row.worktree,
    branch: row.branch,
  };
}

export async function listSessions(
  options: ListSessionsOptions,
  deps: ListSessionsDeps,
): Promise<ListSessionsResult> {
  const { dir, self, runningVersion = null, signal } = options;
  const concurrency = options.concurrency ?? 4;
  const deadlineMs = options.deadlineMs ?? 10000;

  const read = await deps.readSessionFiles(dir);
  if (!read.ok) return { ok: false, error: read.error };
  const { files, scanned, skippedBeforeContent } = read.value;

  // If /proc itself is unreadable every pid would look dead and the list would
  // come back empty; "unknown" keeps the rows visible instead.
  let procReadable = true;
  try {
    deps.readStat(deps.selfPid);
  } catch {
    procReadable = false;
  }

  let invalid = 0;
  const alive: ValidSession[] = [];
  const livenessOf = new Map<string, "alive" | "unknown">();
  for (const file of files) {
    const result = validateSession(file.text, file.pid);
    if (!result.ok) {
      invalid += 1;
      continue;
    }
    const state = procReadable
      ? liveness(result.value.pid, result.value.procStart, deps.readStat)
      : "unknown";
    if (state === "dead") continue;
    alive.push(result.value);
    livenessOf.set(
      `${result.value.pid}:${result.value.procStart}`,
      state === "alive" ? "alive" : "unknown",
    );
  }

  const sessions = dedupeBySessionId(alive).sort((a, b) =>
    compareCodeUnits(a.sessionId, b.sessionId),
  );
  const identities = await identifyAll(
    sessions.map((session) => session.cwd),
    deps,
    { concurrency, deadlineMs, signal },
  );

  const internalRows = sessions.map((session, index): SessionRowInternal => {
    const identity = identities[index] as RepoIdentity;
    let row: SessionRowInternal;
    try {
      row = buildRow(session, identity, self);
    } catch {
      row = buildRow({ ...session, name: null }, ERROR_IDENTITY, self);
    }
    return {
      ...row,
      liveness:
        livenessOf.get(`${session.pid}:${session.procStart}`) ?? "unknown",
    };
  });

  const nameCounts = new Map<string, number>();
  for (const row of internalRows) {
    if (row.name !== null) {
      nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
    }
  }
  for (const row of internalRows) {
    row.duplicateName =
      row.name !== null && (nameCounts.get(row.name) ?? 0) >= 2;
  }

  const skipped = skippedBeforeContent + invalid;
  const list: SessionList = {
    schemaVersion: SCHEMA_VERSION,
    verifiedWith: VERIFIED_WITH,
    sessions: internalRows.map(toPublicRow),
    scanned,
    skipped,
    invalid,
    selfFound:
      self === undefined ? null : internalRows.some((row) => row.isSelf),
    shapeSuspect: isShapeSuspect(scanned, skipped, invalid),
    runningVersion,
  };
  return { ok: true, value: { list, internalRows } };
}
