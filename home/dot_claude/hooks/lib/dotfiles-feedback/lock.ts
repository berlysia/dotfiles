import { constants } from "node:fs";
import type { FeedbackDeps, FeedbackFs } from "./deps.ts";
import { CACHE_TEMP_RANDOM_BYTES } from "./constants.ts";

export type LockDeps = Pick<
  FeedbackDeps,
  "now" | "pid" | "randomBytes" | "isPidAlive" | "getPidStartTime"
> & {
  fs: Pick<
    FeedbackFs,
    "open" | "readFile" | "rename" | "link" | "unlink" | "lstat"
  >;
};

export function hasCode<T>(error: T, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function unlinkIfPresent(
  path: string,
  fs: Pick<FeedbackFs, "unlink">,
): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      console.error("dotfiles-feedback: unlink failed");
      throw error;
    }
  }
}

type LockInspection =
  | { state: "free" }
  | { state: "held" }
  | { state: "stale"; original: string };

// lock のファイルを書き換えずに、持ち主が生きているかを判定する。
// acquireLock の「奪えるか」と isLockHeld が同じ判定を使う。
async function classifyLock(
  path: string,
  staleMs: number,
  deps: LockDeps,
): Promise<LockInspection> {
  const { fs } = deps;
  let original: string;
  try {
    original = await fs.readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { state: "free" };
    console.error("dotfiles-feedback: lock read failed");
    throw error;
  }
  let stale = false;
  try {
    const value = JSON.parse(original) as {
      v?: number;
      pid?: number;
      startTime?: string | null;
      acquiredAt?: string;
    } | null;
    if (
      !value ||
      value.v !== 1 ||
      !Number.isInteger(value.pid) ||
      typeof value.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(value.acquiredAt))
    )
      throw new Error("invalid lock");
    stale = deps.now().getTime() - Date.parse(value.acquiredAt) > staleMs;
    const pid = value.pid as number;
    const startTime = await deps.getPidStartTime(pid);
    if (startTime !== null)
      stale ||=
        deps.isPidAlive(pid) === false ||
        (typeof value.startTime === "string" && value.startTime !== startTime);
    else if (deps.isPidAlive(pid) === false) stale = true;
  } catch {
    // Invalid records have no trustworthy timestamp; use the file age.
    stale = deps.now().getTime() - (await fs.lstat(path)).mtimeMs > staleMs;
  }
  return stale ? { state: "stale", original } : { state: "held" };
}

export async function inspectLock(
  path: string,
  staleMs: number,
  deps: LockDeps,
): Promise<"free" | "held" | "stale"> {
  return (await classifyLock(path, staleMs, deps)).state;
}

// held のときだけ真。奪えない lock を持つ側が生きている間は、その処理が実行中である。
export async function isLockHeld(
  path: string,
  staleMs: number,
  deps: LockDeps,
): Promise<boolean> {
  return (await inspectLock(path, staleMs, deps)) === "held";
}

export async function acquireLock(
  path: string,
  { staleMs }: { staleMs: number },
  deps: LockDeps,
): Promise<(() => Promise<void>) | null> {
  const { fs } = deps;
  const contents = JSON.stringify({
    v: 1,
    pid: deps.pid,
    startTime: await deps.getPidStartTime(deps.pid),
    acquiredAt: deps.now().toISOString(),
  });
  const create = async () => {
    try {
      const handle = await fs.open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          if ((await fs.readFile(path, "utf8")) === contents)
            await unlinkIfPresent(path, fs);
        } catch (error) {
          if (!hasCode(error, "ENOENT")) {
            console.error("dotfiles-feedback: release failed");
            throw error;
          }
        }
      };
    } catch (error) {
      if (hasCode(error, "EEXIST")) return null;
      console.error("dotfiles-feedback: lock creation failed");
      throw error;
    }
  };
  const release = await create();
  if (release) return release;
  const inspected = await classifyLock(path, staleMs, deps);
  if (inspected.state !== "stale") return null;
  const original = inspected.original;
  const aside = `${path}.${deps.pid}.${Buffer.from(deps.randomBytes(CACHE_TEMP_RANDOM_BYTES)).toString("hex")}.stale`;
  try {
    await fs.rename(path, aside);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    console.error("dotfiles-feedback: lock rename failed");
    throw error;
  }
  try {
    if ((await fs.readFile(aside, "utf8")) !== original) {
      try {
        await fs.link(aside, path);
      } catch {
        /* Restoration must never overwrite another owner. */
      }
      return null;
    }
  } finally {
    await unlinkIfPresent(aside, fs);
  }
  return create();
}
