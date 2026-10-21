import { ok, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { enqueueJob } from "../../lib/agent-learnings/core/queue.ts";
import {
  ensureStateDirs,
  storePaths,
} from "../../lib/agent-learnings/core/store.ts";
import { NOW, SID, input } from "../support/agent-learnings-queue-fixture.ts";

describe("ensureStateDirs / enqueueJob", () => {
  it("creates queue directories for a plan-1 shaped store", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-learnings-queue-"));
    try {
      const store = join(root, "s");
      const paths = storePaths(store);
      mkdirSync(paths.inbox, { recursive: true });
      ok(!existsSync(paths.queue));
      strictEqual(enqueueJob(store, input(), NOW).status, "enqueued");
      for (const dir of [
        paths.queue,
        paths.processing,
        paths.failed,
        paths.workerCwd,
      ]) {
        strictEqual(statSync(dir).mode & 0o777, 0o700);
      }
      strictEqual(
        statSync(join(paths.queue, `${SID}.json`)).mode & 0o777,
        0o600,
      );
      ensureStateDirs(store); // idempotent
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
