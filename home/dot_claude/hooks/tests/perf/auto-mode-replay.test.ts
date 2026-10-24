#!/usr/bin/env node --test

import { ok } from "node:assert";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { replayOne } from "../../../scripts/auto-mode-experiment-report.ts";

// replayOne spawns auto-approve.ts without the test preload, so the child
// parses under the production 100 ms budget. The serial perf run keeps the
// CPU quiet enough for that budget; the parallel unit run does not.
describe("replayOne under the production parse budget", () => {
  it("allows a plain ls", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "replay-perf-")));
    try {
      const outcome = await replayOne({
        id: "toolu_test",
        name: "Bash",
        input: { command: "ls" },
        cwd: dir,
        sessionId: "s1",
        transcriptPath: join(dir, "t.jsonl"),
      });
      ok(
        ["allow", "pass"].includes(outcome.verdict.kind),
        JSON.stringify(outcome.verdict),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
