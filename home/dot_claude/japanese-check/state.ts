import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const RECEIPTS_DIR = "receipts";
export const SESSIONS_DIR = "sessions";
export const SNAPSHOTS_DIR = "snapshots";
export const DOCUMENTS_DIR = "documents";
export const MARKS_DIR = "marks";
export const ATTRIBUTION_SKIPPED_MARK = "attribution-skipped";
export const PENDING_NOTICE_MARK = "pending-notice";

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// Same expression as hooks/lib/path-utils.ts getHomeDir(). The CLI cannot
// import hooks code, so it is repeated here; reading HOME first keeps tests
// that swap it isolated, which os.homedir() alone does not under Bun.
export function homeDirectory(): string {
  return process.env.HOME || homedir();
}

// Under the home directory, not the repository: the state must not depend on
// the cwd of whichever process runs, and must stay out of any work tree.
export function defaultStateDir(): string {
  return join(homeDirectory(), ".claude", "state", "japanese-check");
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function missing(error: unknown): boolean {
  return object(error) && error.code === "ENOENT";
}

export function fail(error: unknown): never {
  console.error("[japanese-check receipts]", error);
  throw error;
}

export class StateDirError extends Error {
  readonly kind: "symlink" | "not-directory" | "owner" | "io";
  constructor(kind: StateDirError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface StateOps {
  lstat: (
    path: string,
  ) => Pick<Stats, "isSymbolicLink" | "isDirectory" | "uid" | "mode">;
  chmod: (path: string, mode: number) => void;
  uid: number | undefined;
}

const defaultOps: StateOps = {
  lstat: (path) => lstatSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
  uid: typeof process.getuid === "function" ? process.getuid() : undefined,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspect(stateDir: string, ops: StateOps) {
  let stat: ReturnType<StateOps["lstat"]>;
  try {
    stat = ops.lstat(stateDir);
  } catch (error) {
    throw new StateDirError("io", `${stateDir}: ${errorText(error)}`);
  }
  if (stat.isSymbolicLink())
    throw new StateDirError("symlink", `${stateDir} は symlink です。`);
  if (!stat.isDirectory())
    throw new StateDirError(
      "not-directory",
      `${stateDir} はディレクトリではありません。`,
    );
  if (ops.uid !== undefined && stat.uid !== ops.uid)
    throw new StateDirError(
      "owner",
      `${stateDir} の所有者が自分ではありません。`,
    );
  return stat;
}

// Everything that writes, and the sweep before it, goes through here. Reads
// (verify) do not: a wrong directory then only yields "missing".
export function prepareState(
  stateDir: string,
  ops: StateOps = defaultOps,
): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // An existing non-directory is reported precisely by the lstat below.
    if (!object(error) || error.code !== "EEXIST")
      throw new StateDirError("io", `${stateDir}: ${errorText(error)}`);
  }
  const stat = inspect(stateDir, ops);
  if ((stat.mode & 0o077) === 0) return;
  try {
    ops.chmod(stateDir, 0o700);
  } catch (error) {
    throw new StateDirError("io", `${stateDir}: ${errorText(error)}`);
  }
  // The path may have been swapped between the first lstat and the chmod.
  inspect(stateDir, ops);
}

export function temporaryName(path: string): string {
  return `${path}.${randomUUID()}.tmp`;
}

export function atomicJson(
  path: string,
  data: unknown,
  nameTemporary: (path: string) => string = temporaryName,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = nameTemporary(path);
  writeFileSync(temp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  try {
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The rename error below is the one that matters.
    }
    throw error;
  }
}

export function sessionDir(session: string, stateDir: string): string {
  // Session IDs are hashed, never interpreted as paths.
  return join(stateDir, SESSIONS_DIR, digest(session));
}
