import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendRunLog,
  claimJob,
  completeJob,
  countJobs,
  enqueueJob,
  failJob,
  failJobNow,
  readProcessed,
  recoverOrphans,
  releaseJob,
  summarizeRuns,
  writeProcessed,
  type QueueJob,
} from "../../lib/agent-learnings/core/queue.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";
import { NOW, SID, input } from "../support/agent-learnings-queue-fixture.ts";
import { initStore, storePaths } from "../../lib/agent-learnings/core/store.ts";

const SID2 = "0f0e0d0c-0000-4000-8000-000000000002";

function withStore(fn: (store: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "agent-learnings-queue-"));
  try {
    const store = join(root, "s");
    ok(initStore(store, runGit).ok);
    fn(store);
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
}
const ageFile = (path: string, minutes: number): void => {
  const t = new Date(NOW.getTime() - minutes * 60_000);
  utimesSync(path, t, t);
};
const names = (dir: string): string[] => readdirSync(dir).sort();

describe("ensureStateDirs / enqueueJob", () => {
  it("does nothing for a duplicate, and reports a job in processing", () => {
    withStore((store) => {
      strictEqual(enqueueJob(store, input(), NOW).status, "enqueued");
      strictEqual(enqueueJob(store, input(), NOW).status, "already-queued");
      const claimed = claimJob(store, { tried: new Set(), now: NOW });
      ok(claimed);
      strictEqual(enqueueJob(store, input(), NOW).status, "processing");
      deepStrictEqual(names(storePaths(store).queue), []);
    });
  });
  it("rejects malformed session ids and repo keys", () => {
    withStore((store) => {
      strictEqual(enqueueJob(store, input("../x"), NOW).status, "invalid");
      strictEqual(
        enqueueJob(store, { ...input(), repoKey: "../x" }, NOW).status,
        "invalid",
      );
      deepStrictEqual(names(storePaths(store).queue), []);
    });
  });
});

describe("claimJob and job endings", () => {
  it("fails three times, then moves to failed keeping enqueuedAt", () => {
    withStore((store) => {
      const paths = storePaths(store);
      enqueueJob(store, input(), NOW);
      const first = claimJob(store, { tried: new Set(), now: NOW });
      ok(first);
      const enqueuedAt = first.enqueuedAt;
      strictEqual(enqueuedAt, NOW.toISOString());
      strictEqual(failJob(store, first), "requeued");
      for (let i = 1; i < 3; i++) {
        const job = claimJob(store, {
          tried: new Set(),
          now: new Date(NOW.getTime() + i * 1000),
        });
        ok(job);
        strictEqual(job.attempts, i);
        strictEqual(job.enqueuedAt, enqueuedAt);
        strictEqual(failJob(store, job), i === 2 ? "failed" : "requeued");
      }
      strictEqual(claimJob(store, { tried: new Set(), now: NOW }), null);
      deepStrictEqual(names(paths.failed), [`${SID}.json`]);
      const failed = JSON.parse(
        readFileSync(join(paths.failed, `${SID}.json`), "utf8"),
      ) as QueueJob;
      strictEqual(failed.attempts, 3);
      strictEqual(failed.enqueuedAt, enqueuedAt);
      deepStrictEqual(names(paths.processing), []);
    });
  });
  it("skips session ids tried in this run", () => {
    withStore((store) => {
      enqueueJob(store, input(), NOW);
      strictEqual(claimJob(store, { tried: new Set([SID]), now: NOW }), null);
      enqueueJob(store, input(SID2), NOW);
      strictEqual(
        claimJob(store, { tried: new Set([SID]), now: NOW })?.sessionId,
        SID2,
      );
    });
  });
  it("claims in name order", () => {
    withStore((store) => {
      enqueueJob(store, input(SID2), NOW);
      enqueueJob(store, input(SID), NOW);
      strictEqual(
        claimJob(store, { tried: new Set(), now: NOW })?.sessionId,
        SID,
      );
    });
  });
  it("releaseJob keeps attempts", () => {
    withStore((store) => {
      enqueueJob(store, input(), NOW);
      const job = claimJob(store, { tried: new Set(), now: NOW });
      ok(job);
      releaseJob(store, job);
      const again = claimJob(store, { tried: new Set(), now: NOW });
      strictEqual(again?.attempts, 0);
    });
  });
  it("completeJob removes the job everywhere", () => {
    withStore((store) => {
      const paths = storePaths(store);
      enqueueJob(store, input(), NOW);
      const job = claimJob(store, { tried: new Set(), now: NOW });
      ok(job);
      completeJob(store, job.sessionId);
      for (const dir of [paths.queue, paths.processing, paths.failed])
        deepStrictEqual(names(dir), []);
    });
  });
  it("failJobNow moves to failed without using an attempt", () => {
    withStore((store) => {
      const paths = storePaths(store);
      enqueueJob(store, input(), NOW);
      const job = claimJob(store, { tried: new Set(), now: NOW });
      ok(job);
      failJobNow(store, job);
      const failed = JSON.parse(
        readFileSync(join(paths.failed, `${SID}.json`), "utf8"),
      ) as QueueJob;
      strictEqual(failed.attempts, 0);
      deepStrictEqual(names(paths.processing), []);
      deepStrictEqual(names(paths.queue), []);
    });
  });
  it("moves malformed job files to failed instead of claiming them", () => {
    withStore((store) => {
      const paths = storePaths(store);
      const good = {
        schemaVersion: 1,
        sessionId: SID,
        transcriptPath: "/t.jsonl",
        cwd: "/c",
        repoKey: "github.com/a/b",
        reason: "r",
        enqueuedAt: NOW.toISOString(),
        attempts: 0,
      };
      const bad: Record<string, unknown>[] = [
        { ...good, extra: 1 },
        { ...good, attempts: -1 },
        { ...good, enqueuedAt: "x" },
        { ...good, schemaVersion: 2 },
      ];
      const ids = [
        "0f0e0d0c-0000-4000-8000-00000000000a",
        "0f0e0d0c-0000-4000-8000-00000000000b",
        "0f0e0d0c-0000-4000-8000-00000000000c",
        "0f0e0d0c-0000-4000-8000-00000000000d",
      ];
      bad.forEach((job, i) =>
        writeFileSync(
          join(paths.queue, `${ids[i]}.json`),
          JSON.stringify({ ...job, sessionId: ids[i] }),
        ),
      );
      writeFileSync(
        join(paths.queue, "0f0e0d0c-0000-4000-8000-00000000000e.json"),
        "not json",
      );
      strictEqual(claimJob(store, { tried: new Set(), now: NOW }), null);
      strictEqual(names(paths.failed).length, 5);
      deepStrictEqual(names(paths.queue), []);
    });
  });
  it("does not claim a symlinked job file", () => {
    withStore((store) => {
      const paths = storePaths(store);
      const target = join(paths.state, "target.json");
      writeFileSync(target, "{}");
      symlinkSync(target, join(paths.queue, `${SID}.json`));
      strictEqual(claimJob(store, { tried: new Set(), now: NOW }), null);
      deepStrictEqual(names(paths.queue), []);
    });
  });
});

describe("recoverOrphans", () => {
  it("does not recover a job claimed just now even if it sat in queue", () => {
    withStore((store) => {
      const paths = storePaths(store);
      enqueueJob(store, input(), NOW);
      ageFile(join(paths.queue, `${SID}.json`), 20);
      ok(claimJob(store, { tried: new Set(), now: NOW }));
      deepStrictEqual(recoverOrphans(store, NOW), { requeued: 0, failed: 0 });
      deepStrictEqual(names(paths.processing), [`${SID}.json`]);
    });
  });
  it("requeues with attempts+1 after 15 minutes, fails at the limit", () => {
    withStore((store) => {
      const paths = storePaths(store);
      enqueueJob(store, input(), NOW);
      enqueueJob(store, input(SID2), NOW);
      ok(claimJob(store, { tried: new Set(), now: NOW }));
      ok(claimJob(store, { tried: new Set(), now: NOW }));
      const second = join(paths.processing, `${SID2}.json`);
      const job = JSON.parse(readFileSync(second, "utf8")) as QueueJob;
      writeFileSync(second, JSON.stringify({ ...job, attempts: 2 }));
      ageFile(join(paths.processing, `${SID}.json`), 16);
      ageFile(second, 16);
      deepStrictEqual(recoverOrphans(store, NOW), { requeued: 1, failed: 1 });
      const back = JSON.parse(
        readFileSync(join(paths.queue, `${SID}.json`), "utf8"),
      ) as QueueJob;
      strictEqual(back.attempts, 1);
      deepStrictEqual(names(paths.failed), [`${SID2}.json`]);
      deepStrictEqual(names(paths.processing), []);
    });
  });
});

describe("processed.json", () => {
  it("is empty when missing, round-trips, resets when corrupt, prunes after 30 days", () => {
    withStore((store) => {
      const paths = storePaths(store);
      deepStrictEqual(readProcessed(store), { records: {}, corrupt: false });
      writeProcessed(store, SID, { byteOffset: 10, firstLineHash: "h" }, NOW);
      const read = readProcessed(store);
      strictEqual(read.records[SID]?.byteOffset, 10);
      strictEqual(read.records[SID]?.updatedAt, NOW.toISOString());
      strictEqual(statSync(paths.processed).mode & 0o777, 0o600);

      writeFileSync(paths.processed, "{broken");
      deepStrictEqual(readProcessed(store), { records: {}, corrupt: true });

      writeFileSync(
        paths.processed,
        JSON.stringify({
          [SID2]: {
            byteOffset: 1,
            firstLineHash: "h",
            updatedAt: new Date(NOW.getTime() - 31 * 86_400_000).toISOString(),
          },
        }),
      );
      writeProcessed(store, SID, { byteOffset: 5, firstLineHash: "h" }, NOW);
      const after = readProcessed(store);
      ok(!(SID2 in after.records));
      strictEqual(after.records[SID]?.byteOffset, 5);
    });
  });
});

describe("countJobs and runs.log", () => {
  it("counts jobs and reports the oldest queued enqueuedAt", () => {
    withStore((store) => {
      enqueueJob(store, input(SID2), new Date("2026-10-14T00:00:00Z"));
      enqueueJob(store, input(SID), new Date("2026-10-15T00:00:00Z"));
      deepStrictEqual(countJobs(store), {
        queue: 2,
        processing: 0,
        failed: 0,
        oldestEnqueuedAt: "2026-10-14T00:00:00.000Z",
      });
    });
  });
  it("summarizes the last 14 days of results", () => {
    withStore((store) => {
      const line = (at: Date, result: string) => ({
        schemaVersion: 1 as const,
        at: at.toISOString(),
        sessionId: SID,
        result: result as "applied",
        opsApplied: 0,
        opsDropped: 0,
      });
      appendRunLog(store, line(NOW, "rejected"));
      appendRunLog(store, line(NOW, "applied"));
      appendRunLog(store, line(new Date("2026-09-01T00:00:00Z"), "failed"));
      writeFileSync(
        storePaths(store).runsLog,
        `${readFileSync(storePaths(store).runsLog, "utf8")}garbage\n`,
      );
      deepStrictEqual(summarizeRuns(store, NOW, 14), {
        applied: 1,
        skipped: 0,
        rejected: 1,
        failed: 0,
      });
    });
  });
});
