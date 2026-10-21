// Upper bound only. The same scenario without the bound is in
// heavy/agent-learnings-worker.test.ts; it starts git, so the timing lives
// here where the machine is not loaded by parallel tests.
import { ok, strictEqual } from "node:assert";
import { statSync, utimesSync } from "node:fs";
import { describe, it } from "node:test";
import { runWorker } from "../../../scripts/learnings-worker.ts";
import { storePaths } from "../../lib/agent-learnings/core/store.ts";
import {
  fenced,
  sidN,
  utterances,
  withWorld,
} from "../support/agent-learnings-worker-fixture.ts";

describe("runWorker batch and single-instance", () => {
  it("refreshes worker.lock for each job so a running worker is not taken over (lock age < 5 s)", async () =>
    withWorld(async (w) => {
      w.writeTranscript(utterances("x", 3), sidN(1));
      w.writeTranscript(utterances("y", 3), sidN(2));
      w.enqueue(sidN(1));
      w.enqueue(sidN(2));
      const lock = storePaths(w.store).workerLock;
      const ages: number[] = [];
      const q = w.queryFor(async (call) => {
        if (call === 0) {
          const old = new Date(Date.now() - 29 * 60_000);
          utimesSync(lock, old, old);
        } else {
          ages.push(Date.now() - statSync(lock).mtimeMs);
        }
        return fenced([]);
      });
      await runWorker(w.deps(q));
      strictEqual(ages.length, 1);
      ok((ages[0] ?? Infinity) < 5_000);
    }));
});
