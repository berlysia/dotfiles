import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type LockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "unwritable" };

const STALE_MS = 10 * 60_000;
const POLL_MS = 50;

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException).code;

export function isStale(
  content: string,
  mtimeMs: number,
  nowMs: number,
): boolean {
  if (nowMs - mtimeMs > STALE_MS) return true;
  const match = /^(\d+) (\d+)$/.exec(content);
  if (!match) return false; // 読めない内容は mtime だけで判定する
  try {
    process.kill(Number(match[1]), 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

// 観測した内容 observed の lock を奪う。奪えたら true（呼び出し側が作り直す）
export function stealIfStale(stateDir: string, observed: string): boolean {
  const lock = join(stateDir, "lock");
  const stale = `${lock}.stale.${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  try {
    renameSync(lock, stale);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  let content = "";
  try {
    content = readFileSync(stale, "utf8");
  } catch {
    // 読めない退避ファイルは一致しなかったものとして戻す
  }
  if (content === observed) {
    unlinkSync(stale);
    return true;
  }
  // 観測の後に別のプロセスが作り直した lock を退避してしまったので、上書きせずに戻す
  try {
    linkSync(stale, lock);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  unlinkSync(stale);
  return false;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function withStoreLock<T>(
  stateDir: string,
  opts: { waitMs: number },
  fn: () => T | Promise<T>,
): Promise<LockResult<T>> {
  const lock = join(stateDir, "lock");
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    const content = `${process.pid} ${Date.now()}`;
    let acquired = false;
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "EACCES" || code === "EPERM" || code === "EROFS")
        return { ok: false, reason: "unwritable" };
      if (code !== "EEXIST") throw error;
    }
    if (acquired) {
      try {
        return { ok: true, value: await fn() };
      } finally {
        try {
          if (readFileSync(lock, "utf8") === content) unlinkSync(lock);
        } catch {
          // 既に無い
        }
      }
    }
    try {
      const observed = readFileSync(lock, "utf8");
      if (
        isStale(observed, statSync(lock).mtimeMs, Date.now()) &&
        stealIfStale(stateDir, observed)
      )
        continue;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
    await sleep(POLL_MS);
  }
}
