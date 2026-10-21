// Upper bound only. The same scenario without the bound is in
// heavy/agent-learnings-cli.test.ts; it starts git, so the timing lives here
// where the machine is not loaded by parallel tests.
import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { runLearningsCli } from "../../cli/learnings.ts";
import { writeInboxRequest } from "../../lib/agent-learnings/core/inbox.ts";
import { store, withEnv } from "../support/agent-learnings-cli-fixture.ts";

describe("runLearningsCli", () => {
  it("applies a pending inbox request on the next add without waiting on its own lock (elapsed < 3 s)", () =>
    withEnv(async (deps) => {
      await runLearningsCli(["init"], deps);
      writeInboxRequest(
        store(deps),
        {
          op: "add",
          repoKey: "github.com/foo/bar",
          title: "from inbox",
          body: "b",
          reader: "codex",
        },
        new Date(),
      );
      const started = Date.now();
      strictEqual(
        (
          await runLearningsCli(["add", "--title", "t", "--body", "b"], {
            ...deps,
            lockWaitMs: 10_000,
          })
        ).exitCode,
        0,
      );
      ok(Date.now() - started < 3_000);
    }));
});
