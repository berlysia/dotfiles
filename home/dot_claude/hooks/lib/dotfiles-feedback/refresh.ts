import { constants } from "node:fs";
import { join } from "node:path";
import {
  readInbox,
  writeInbox,
  type FeedbackError,
  type InboxV1,
} from "./cache.ts";
import {
  FEEDBACK_OWNER,
  FEEDBACK_REPO,
  FLUSH_LOCK_FILE,
  FLUSH_LOCK_STALE_MS,
  REFRESH_LOCK_STALE_MS,
} from "./constants.ts";
import { flush, type FlushDeps } from "./flush.ts";
import { openGh } from "./gh.ts";
import { countOpenTargets } from "./issue-body.ts";
import { isFeedbackId } from "./item.ts";
import { acquireLock, hasCode, unlinkIfPresent } from "./lock.ts";
import { openRetry } from "./retry.ts";
import { openSpool } from "./spool.ts";

export type RefreshDeps = FlushDeps & { log(text: string): void };
export type RefreshResult =
  | { kind: "done"; runs: number; cleaned: boolean }
  | { kind: "busy" }
  | { kind: "failed"; reason: string };

// 4 を繰り返す上限。最初の回を含める。
const MAX_RUNS = 3;

export async function refresh(deps: RefreshDeps): Promise<RefreshResult> {
  const state = join(deps.root, "state");
  const lockPath = join(state, "refresh.lock");
  const markPath = join(state, "refresh.rerun");
  const inboxPath = join(state, "inbox.json");
  const spool = await openSpool(deps.root, deps);
  const retry = openRetry(deps.root, deps);

  // 1. flush は refresh.lock の外で行う。flush は長く走りうるが、refresh.lock は 5 分で奪われる。
  await flush(deps);

  const acquire = () =>
    acquireLock(lockPath, { staleMs: REFRESH_LOCK_STALE_MS }, deps);
  async function leaveMark(): Promise<void> {
    try {
      const handle = await deps.fs.open(
        markPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.close();
    } catch {
      deps.log("dotfiles-feedback: refresh の再実行の印を書けなかった\n");
    }
  }
  async function markExists(): Promise<boolean> {
    try {
      await deps.fs.lstat(markPath);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  // 2. 取れなければ印を作り、もう一度だけ試す。印を作った後に始まる 4 が 1 回は走る。
  let release = await acquire();
  if (!release) {
    await leaveMark();
    release = await acquire();
    if (!release) return { kind: "busy" };
  }

  // 3. 掃除は flush.lock を取れたときだけ。flush と並べないので、追記と書き直し、claim と prune が重ならない。
  async function cleanup(): Promise<boolean> {
    const flushRelease = await acquireLock(
      join(deps.root, FLUSH_LOCK_FILE),
      { staleMs: FLUSH_LOCK_STALE_MS },
      deps,
    );
    if (!flushRelease) return false;
    try {
      await spool.pruneFailed(deps.now(), flushRelease);
      await spool.truncateSent(flushRelease);
      await retry.prune(async () => {
        const ids = new Set<string>();
        for (const dir of ["pending", "sending"])
          for (const name of await deps.fs.readdir(join(deps.root, dir))) {
            const id = name.split(".")[0] ?? "";
            if (isFeedbackId(id)) ids.add(id);
          }
        return ids;
      }, flushRelease);
    } finally {
      await flushRelease();
    }
    return true;
  }

  // 4. 件数を数えて inbox.json を書く。数えきれない回は前の件数を写し、error を書く。
  async function count(): Promise<void> {
    await unlinkIfPresent(markPath, deps.fs);
    const previous = readInbox(inboxPath, deps.now());
    const carried =
      previous.state === "ok" || previous.state === "stale"
        ? {
            fetchedAt: previous.value.fetchedAt,
            unprocessed: previous.value.unprocessed,
          }
        : { fetchedAt: null, unprocessed: null };
    let counts: { fetchedAt: string | null; unprocessed: number | null };
    let error: FeedbackError | undefined;
    const gh = openGh(deps);
    const checked = await gh.checkDestination();
    if (!checked.ok) {
      counts = carried;
      error = checked.error;
    } else {
      const listed = await gh.listFeedbackIssues({
        repo: FEEDBACK_REPO,
        state: "open",
        creator: FEEDBACK_OWNER,
      });
      if (!listed.ok) {
        counts = carried;
        error = listed.error;
      } else {
        counts = {
          fetchedAt: deps
            .now()
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z"),
          unprocessed: countOpenTargets(listed.value).targets,
        };
      }
    }
    const local = await spool.countLocal();
    const inbox: InboxV1 = {
      v: 1,
      ...counts,
      pendingLocal: local.unsent,
      failedLocal: local.failed,
      heldLocal: local.held,
      ...(error === undefined ? {} : { error }),
    };
    writeInbox(inboxPath, inbox);
  }

  let runs = 0;
  let cleaned = false;
  for (;;) {
    try {
      if (runs === 0) {
        try {
          cleaned = await cleanup();
        } catch {
          // 掃除の失敗で件数の更新を止めない。次の refresh でやり直す。
          deps.log("dotfiles-feedback: 掃除に失敗した\n");
        }
      }
      await count();
      runs++;
    } catch (error) {
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : "inbox を書けなかった",
      };
    } finally {
      await release();
    }
    // 5. 放した後に印を確かめる。残った印は次の refresh が拾う。
    if (runs >= MAX_RUNS || !(await markExists())) break;
    const again = await acquire();
    if (!again) break;
    release = again;
  }
  return { kind: "done", runs, cleaned };
}
