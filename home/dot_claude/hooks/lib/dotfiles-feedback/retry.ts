import { constants } from "node:fs";
import { join } from "node:path";
import type { FeedbackDeps, FeedbackFs } from "./deps.ts";
import {
  acquireLock,
  hasCode,
  unlinkIfPresent,
  type LockDeps,
} from "./lock.ts";
import { isFeedbackId } from "./item.ts";
import {
  RETRY_LOCK_STALE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  CACHE_TEMP_RANDOM_BYTES,
} from "./constants.ts";

export type RetryDeps = Omit<LockDeps, "fs"> & {
  fs: Pick<
    FeedbackFs,
    "open" | "readFile" | "rename" | "link" | "unlink" | "lstat"
  >;
};
export type RetryEntry = { attempts: number; nextAt: string };
type RetryState = { v: 1; items: Record<string, RetryEntry> };

export async function atomicWrite(
  path: string,
  contents: string,
  deps: Pick<FeedbackDeps, "pid" | "randomBytes"> & {
    fs: Pick<FeedbackFs, "open" | "rename" | "unlink">;
  },
): Promise<void> {
  const temporary = `${path}.${deps.pid}.${Buffer.from(deps.randomBytes(CACHE_TEMP_RANDOM_BYTES)).toString("hex")}.tmp`;
  const handle = await deps.fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    await deps.fs.rename(temporary, path);
  } finally {
    await unlinkIfPresent(temporary, deps.fs);
  }
}

export function openRetry(root: string, deps: RetryDeps) {
  const path = join(root, "state", "retry.json");
  async function transaction<T>(
    change: boolean | ((state: RetryState) => boolean),
    action: (state: RetryState) => T,
  ): Promise<T> {
    const release = await acquireLock(
      join(root, "state", "retry.lock"),
      { staleMs: RETRY_LOCK_STALE_MS },
      deps,
    );
    if (!release) throw new Error("dotfiles-feedback: retry lock busy");
    try {
      let state: RetryState = { v: 1, items: {} };
      let text: string | null = null;
      try {
        text = await deps.fs.readFile(path, "utf8");
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          console.error("dotfiles-feedback: retry read failed");
          throw error;
        }
      }
      if (text !== null) {
        try {
          const parsed = JSON.parse(text) as RetryState;
          if (
            parsed.v === 1 &&
            parsed.items &&
            !Array.isArray(parsed.items) &&
            typeof parsed.items === "object" &&
            Object.entries(parsed.items).every(
              ([id, value]) =>
                isFeedbackId(id) &&
                value &&
                Number.isSafeInteger(value.attempts) &&
                value.attempts >= 0 &&
                typeof value.nextAt === "string" &&
                Number.isFinite(Date.parse(value.nextAt)),
            )
          )
            state = parsed;
        } catch {
          /* A corrupt retry ledger starts empty. */
        }
      }
      const shouldWrite = typeof change === "boolean" ? change : change(state);
      const result = action(state);
      if (shouldWrite) await atomicWrite(path, JSON.stringify(state), deps);
      return result;
    } finally {
      await release();
    }
  }
  function check(id: string) {
    if (!isFeedbackId(id)) throw new Error("dotfiles-feedback: invalid id");
  }
  return {
    async isDue(id: string, now: Date): Promise<boolean> {
      check(id);
      return transaction(
        false,
        (state) =>
          !state.items[id] ||
          Date.parse(state.items[id].nextAt) <= now.getTime(),
      );
    },
    async recordFailure(
      id: string,
      now: Date,
    ): Promise<{ exhausted: boolean; attempts: number; nextAt: string }> {
      check(id);
      return transaction(true, (state) => {
        const attempts = (state.items[id]?.attempts ?? 0) + 1;
        const nextAt = new Date(
          now.getTime() +
            Math.min(2 ** attempts * RETRY_BASE_MS, RETRY_MAX_DELAY_MS),
        ).toISOString();
        state.items[id] = { attempts, nextAt };
        return { exhausted: attempts >= MAX_RETRY_ATTEMPTS, attempts, nextAt };
      });
    },
    async reset(id: string): Promise<void> {
      check(id);
      await transaction(
        (state) => id in state.items,
        (state) => {
          delete state.items[id];
        },
      );
    },
  };
}
