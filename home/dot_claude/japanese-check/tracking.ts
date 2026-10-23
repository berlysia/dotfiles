import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  atomicJson,
  defaultStateDir,
  digest,
  DOCUMENTS_DIR,
  fail,
  MARKS_DIR,
  missing,
  object,
  prepareState,
  sessionDir,
  SESSIONS_DIR,
  SNAPSHOTS_DIR,
} from "./state.ts";

export function track(
  file: string,
  session: string,
  stateDir = defaultStateDir(),
): void {
  prepareState(stateDir);
  const path = realpathSync(file);
  atomicJson(
    join(sessionDir(session, stateDir), DOCUMENTS_DIR, `${digest(path)}.json`),
    { path },
  );
}

function trackedPath(dir: string, name: string): string | "corrupt" | null {
  let text: string;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch (error) {
    if (missing(error)) return null;
    fail(error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "corrupt";
  }
  return object(value) && typeof value.path === "string"
    ? value.path
    : "corrupt";
}

export function tracked(
  session: string,
  stateDir = defaultStateDir(),
): { paths: string[]; removedCorrupt: number } {
  const dir = join(sessionDir(session, stateDir), DOCUMENTS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (missing(error)) return { paths: [], removedCorrupt: 0 };
    fail(error);
  }
  const paths: string[] = [];
  let removedCorrupt = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = trackedPath(dir, name);
    if (path === null) continue;
    if (path === "corrupt") {
      try {
        unlinkSync(join(dir, name));
        removedCorrupt++;
      } catch (error) {
        if (!missing(error)) fail(error);
      }
      continue;
    }
    try {
      if (statSync(path).isFile()) paths.push(path);
    } catch (error) {
      if (!missing(error)) fail(error);
    }
  }
  return { paths, removedCorrupt };
}

function snapshotPath(
  session: string,
  toolUseId: string,
  stateDir: string,
): string {
  // The id is hashed: it comes from the hook input and is never a path.
  return join(
    sessionDir(session, stateDir),
    SNAPSHOTS_DIR,
    `${digest(toolUseId)}.json`,
  );
}

export function saveSnapshot(
  session: string,
  toolUseId: string,
  hashes: Record<string, string>,
  stateDir = defaultStateDir(),
): void {
  prepareState(stateDir);
  atomicJson(snapshotPath(session, toolUseId, stateDir), hashes);
}

// Reads and always deletes the snapshot, so one Bash call is compared once.
// A missing or unreadable snapshot is reported as absent.
export function takeSnapshot(
  session: string,
  toolUseId: string,
  stateDir = defaultStateDir(),
): Record<string, string> | null {
  const path = snapshotPath(session, toolUseId, stateDir);
  let value: unknown = null;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (missing(error)) return null;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!missing(error)) console.error("[japanese-check tracking]", error);
  }
  return object(value) &&
    Object.values(value).every((hash) => typeof hash === "string")
    ? (value as Record<string, string>)
    : null;
}

function markPath(session: string, name: string, stateDir: string): string {
  return join(sessionDir(session, stateDir), MARKS_DIR, `${name}.json`);
}

export function hasMark(
  session: string,
  name: string,
  stateDir = defaultStateDir(),
): boolean {
  return existsSync(markPath(session, name, stateDir));
}

export function writeMark(
  session: string,
  name: string,
  value: unknown,
  stateDir = defaultStateDir(),
): void {
  prepareState(stateDir);
  atomicJson(markPath(session, name, stateDir), value);
}

// Returns the stored value, or null when the mark is absent or unreadable: a
// damaged mark must behave like no mark so the notice it guards is shown again.
export function readMark(
  session: string,
  name: string,
  stateDir = defaultStateDir(),
): unknown {
  try {
    return JSON.parse(readFileSync(markPath(session, name, stateDir), "utf8"));
  } catch {
    return null;
  }
}

export function deleteMark(
  session: string,
  name: string,
  stateDir = defaultStateDir(),
): void {
  try {
    unlinkSync(markPath(session, name, stateDir));
  } catch (error) {
    if (!missing(error)) console.error("[japanese-check tracking]", error);
  }
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;

function reportPruneFailure(error: unknown): void {
  if (!missing(error)) console.error("[japanese-check prune]", error);
}

// lstat only: a symlink is judged by its own mtime and never followed.
function newestModification(path: string): number {
  let newest = 0;
  try {
    const stat = lstatSync(path);
    newest = stat.mtimeMs;
    if (!stat.isDirectory()) return newest;
    for (const name of readdirSync(path))
      newest = Math.max(newest, newestModification(join(path, name)));
  } catch (error) {
    reportPruneFailure(error);
  }
  return newest;
}

function removeTree(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path)) removeTree(join(path, name));
      rmdirSync(path);
    } else {
      unlinkSync(path);
    }
  } catch (error) {
    reportPruneFailure(error);
  }
}

function removeStaleTemporaries(dir: string, cutoff: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    reportPruneFailure(error);
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory()) removeStaleTemporaries(path, cutoff);
      else if (name.endsWith(".tmp") && stat.mtimeMs < cutoff) unlinkSync(path);
    } catch (error) {
      reportPruneFailure(error);
    }
  }
}

// Receipts are never removed: they are keyed by document, not by session, and
// the cost of keeping them is a few hundred bytes each. Failures are only
// reported; they must not change what Stop decides.
export function pruneState(
  stateDir: string,
  currentSession: string,
  now: number,
): void {
  prepareState(stateDir);
  const sessions = join(stateDir, SESSIONS_DIR);
  const current = digest(currentSession);
  let names: string[] = [];
  try {
    names = readdirSync(sessions);
  } catch (error) {
    reportPruneFailure(error);
  }
  for (const name of names) {
    const path = join(sessions, name);
    try {
      if (!lstatSync(path).isDirectory()) continue;
      if (name === current) {
        const snapshots = join(path, SNAPSHOTS_DIR);
        for (const file of readdirSync(snapshots)) {
          const target = join(snapshots, file);
          const stat = lstatSync(target);
          if (stat.isFile() && stat.mtimeMs < now - SCRATCH_MAX_AGE_MS)
            unlinkSync(target);
        }
      } else if (newestModification(path) < now - SESSION_MAX_AGE_MS) {
        removeTree(path);
      }
    } catch (error) {
      reportPruneFailure(error);
    }
  }
  removeStaleTemporaries(stateDir, now - SCRATCH_MAX_AGE_MS);
}
