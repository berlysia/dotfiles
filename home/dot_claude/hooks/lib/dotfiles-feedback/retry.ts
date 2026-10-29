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

// 呼び出し側（flush）は、この型で lock の競合を一時的な失敗として見分ける。
// メッセージの文字列で見分けると、文言を変えただけで判定が壊れる。
export class RetryLockBusyError extends Error {
  constructor() {
    super("dotfiles-feedback: retry lock busy");
    this.name = "RetryLockBusyError";
  }
}
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
    change: boolean | "if-changed" | ((state: RetryState) => boolean),
    action: (state: RetryState) => T | Promise<T>,
  ): Promise<T> {
    const release = await acquireLock(
      join(root, "state", "retry.lock"),
      { staleMs: RETRY_LOCK_STALE_MS },
      deps,
    );
    if (!release) throw new RetryLockBusyError();
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
      const before = change === "if-changed" ? JSON.stringify(state) : "";
      const shouldWrite =
        typeof change === "function" ? change(state) : change === true;
      const result = await action(state);
      if (
        shouldWrite ||
        (change === "if-changed" && JSON.stringify(state) !== before)
      )
        await atomicWrite(path, JSON.stringify(state), deps);
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
    // 孤立した項目（確保中も含め、どの待ち場所にも無い id）を消す。
    // flush.lock の下で呼ぶので、一覧のあいだに claim と reclaim は起きない。
    // retry.lock が busy なら、この回は飛ばす（次の refresh が拾う）。
    async prune(
      listIds: () => Promise<ReadonlySet<string>>,
      _flushLockHeld: () => Promise<void>,
    ): Promise<void> {
      try {
        await transaction("if-changed", async (state) => {
          const live = await listIds();
          for (const id of Object.keys(state.items))
            if (!live.has(id)) delete state.items[id];
        });
      } catch (error) {
        if (!(error instanceof RetryLockBusyError)) throw error;
      }
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
