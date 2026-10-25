#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { replayOne } from "../../../scripts/auto-mode-experiment-report.ts";

describe("replayOne", () => {
  // The verdict is asserted in tests/perf/auto-mode-replay.test.ts: the child
  // process does not get the preload, so it parses under the production
  // 100 ms budget and can give up and deny when the parallel unit run loads
  // the CPU. Only the isolation is checked here.
  it("leaves the real decisions log alone", async () => {
    const real = join(homedir(), ".claude", "logs", "decisions.jsonl");
    const before = existsSync(real) ? statSync(real) : null;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "replay-test-")));
    try {
      await replayOne({
        id: "toolu_test",
        name: "Bash",
        input: { command: "ls" },
        cwd: dir,
        sessionId: "s1",
        transcriptPath: join(dir, "t.jsonl"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const after = existsSync(real) ? statSync(real) : null;
    strictEqual(after?.size, before?.size);
    strictEqual(after?.mtimeMs, before?.mtimeMs);
  });
});
