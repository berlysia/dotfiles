import { join } from "node:path";
import type { FeedbackDeps } from "./deps.ts";
import { openSpool, type ClaimedItem } from "./spool.ts";
import { openRetry, RetryLockBusyError } from "./retry.ts";
import { openGh, type GhResult } from "./gh.ts";
import { acquireLock } from "./lock.ts";
import { isFeedbackId, parseItem } from "./item.ts";
import { renderIssue } from "./issue-body.ts";
import { clearLastFlush, writeLastFlush, type FeedbackError } from "./cache.ts";
import {
  FLUSH_LOCK_FILE,
  FLUSH_LOCK_STALE_MS,
  GH_TIMEOUT_MS,
  ITEM_DEADLINE_MS,
  MAX_FLUSH_ITEMS,
  MAX_FLUSH_REACQUIRES,
} from "./constants.ts";

export type FlushDeps = Pick<
  FeedbackDeps,
  | "root"
  | "home"
  | "uid"
  | "fs"
  | "repo"
  | "runGh"
  | "spawnFlush"
  | "now"
  | "pid"
  | "randomBytes"
  | "isPidAlive"
  | "getPidStartTime"
>;
function retryBusy<T>(error: T): boolean {
  return error instanceof RetryLockBusyError;
}
export async function flush(
  deps: FlushDeps,
  options: { maxReacquires?: number } = {},
): Promise<void> {
  const spool = await openSpool(deps.root, deps);
  const retry = openRetry(deps.root, deps);
  const cache = join(deps.root, "state", "last-flush.json");
  let lastError: FeedbackError | null = null;
  let delivered = false;
  let busy = false;
  async function due(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of (
      await deps.fs.readdir(join(deps.root, "pending"))
    ).sort()) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isFeedbackId(id)) continue;
      try {
        if (await retry.isDue(id, deps.now())) ids.push(id);
      } catch (error) {
        if (!retryBusy(error)) {
          console.error("dotfiles-feedback: retry lookup failed");
          throw error;
        }
        busy = true;
        lastError = "other";
      }
    }
    return ids;
  }
  async function fail(
    id: string,
    claimed: ClaimedItem | null,
    permanent: boolean,
    reason: string,
  ) {
    if (claimed && !(await spool.stillClaimed(claimed))) return;
    try {
      if (permanent) {
        await spool.moveToFailed(claimed ?? id, reason);
        return;
      }
      const result = await retry.recordFailure(id, deps.now());
      if (result.exhausted) {
        await spool.moveToFailed(claimed ?? id, "retries-exhausted");
        return;
      }
    } catch (error) {
      if (!retryBusy(error)) {
        console.error("dotfiles-feedback: retry update failed");
        throw error;
      }
      busy = true;
      lastError = "other";
    }
    if (claimed && (await spool.stillClaimed(claimed)))
      await deps.fs.rename(
        join(deps.root, "sending", `${id}.${claimed.nonce}.json`),
        join(deps.root, "pending", `${id}.json`),
      );
  }
  function saveCache() {
    if (delivered) clearLastFlush(cache);
    else if (lastError)
      writeLastFlush(cache, {
        v: 1,
        at: deps.now().toISOString(),
        error: lastError,
      });
  }
  for (let round = 0; ; round++) {
    const release = await acquireLock(
      join(deps.root, FLUSH_LOCK_FILE),
      { staleMs: FLUSH_LOCK_STALE_MS },
      deps,
    );
    if (!release) return;
    let stop = false;
    try {
      await spool.reclaimStale(deps.now());
      await spool.sortPending();
      const ids = await due();
      if (!ids.length) {
        saveCache();
        stop = true;
      } else {
        const gh = openGh(deps);
        const checked = await gh.checkDestination();
        const ready = checked.ok ? await gh.ensureLabels() : checked;
        if (!ready.ok) {
          lastError = ready.error;
          for (const id of ids) await fail(id, null, false, ready.message);
          saveCache();
          stop = true;
        } else {
          for (const id of ids.slice(0, MAX_FLUSH_ITEMS)) {
            const claimed = await spool.claim(id);
            if (!claimed) continue;
            const deadline = deps.now().getTime() + ITEM_DEADLINE_MS;
            const perItemGh = openGh(deps, () =>
              Math.min(GH_TIMEOUT_MS, deadline - deps.now().getTime()),
            );
            try {
              const parsed = parseItem(
                await deps.fs.readFile(
                  join(deps.root, "sending", `${id}.${claimed.nonce}.json`),
                  "utf8",
                ),
              );
              if (parsed.kind === "newer") {
                await spool.holdClaimed(claimed);
                continue;
              }
              if (parsed.kind === "invalid" || parsed.item.id !== id) {
                await fail(
                  id,
                  claimed,
                  true,
                  parsed.kind === "invalid" ? parsed.reason : "id-mismatch",
                );
                continue;
              }
              const found = await perItemGh.findIssueById(
                id,
                parsed.item.createdAt,
                deps.now(),
              );
              let result: GhResult<number>;
              if (!found.ok) result = found;
              else {
                if (!(await spool.stillClaimed(claimed))) continue;
                result = found.value
                  ? { ok: true, value: found.value.number }
                  : await perItemGh.createIssue(renderIssue(parsed.item));
              }
              if (deps.now().getTime() >= deadline)
                result = {
                  ok: false,
                  error: "network",
                  permanent: false,
                  message: "deadline exceeded",
                };
              if (result.ok) {
                if (await spool.stillClaimed(claimed)) {
                  await spool.markSent(claimed, result.value);
                  delivered = true;
                  await retry.reset(id);
                }
              } else {
                if (!result.permanent) lastError = result.error;
                await fail(id, claimed, result.permanent, result.message);
              }
            } catch (error) {
              if (!retryBusy(error)) {
                console.error("dotfiles-feedback: item delivery failed");
                throw error;
              }
              busy = true;
              lastError = "other";
              if (await spool.stillClaimed(claimed))
                await deps.fs.rename(
                  join(deps.root, "sending", `${id}.${claimed.nonce}.json`),
                  join(deps.root, "pending", `${id}.json`),
                );
            }
          }
          saveCache();
        }
      }
    } catch (error) {
      if (!retryBusy(error)) {
        console.error("dotfiles-feedback: flush failed");
        throw error;
      }
      busy = true;
      lastError = "other";
      saveCache();
    } finally {
      await release();
    }
    if (stop || busy || !(await due()).length) return;
    if (round >= (options.maxReacquires ?? MAX_FLUSH_REACQUIRES)) {
      await deps.spawnFlush();
      return;
    }
  }
}
