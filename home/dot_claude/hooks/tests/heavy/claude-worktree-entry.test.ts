import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import {
  createRepo,
  createTempTracker,
  git,
} from "../support/claude-worktree-fixture.ts";

import {
  cleanupEntry,
  createEntry,
  hasBun,
  hooksDir,
  runBun,
} from "../support/claude-worktree-entry-fixture.ts";

// Real-process tests of the two entries. They need bun (the production
// runtime); without it the whole file is skipped with that reason.

const temp = createTempTracker();
after(() => temp.cleanup());

const hookTimer = join(hooksDir, "executable_hook-timer.sh");

function createPayload(cwd: string, name: string): string {
  return JSON.stringify({ hook_event_name: "WorktreeCreate", name, cwd });
}

describe(
  "worktree entries as processes",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("E01: worktree-create prints the path alone on stdout and exits 0", () => {
      const repo = createRepo(temp);
      const result = runBun(
        createEntry,
        createPayload(repo.dir, "bold-oak-a3f2"),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout,
        `${join(repo.commonDir, "worktree", "worktree-bold-oak-a3f2")}\n`,
      );
    });

    it("E02: through hook-timer.sh the last non-empty stdout line and the exit code are the same", () => {
      const repo = createRepo(temp);
      const logs = temp.make("cwt-timer-logs-");
      const result = spawnSync(
        "sh",
        [hookTimer, "WorktreeCreate", "0", `bun ${createEntry}`],
        {
          input: createPayload(repo.dir, "bold-oak-a3f2"),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_LOGS_DIR: logs },
          timeout: 60_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const lastLine = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .at(-1);
      assert.equal(
        lastLine,
        join(repo.commonDir, "worktree", "worktree-bold-oak-a3f2"),
      );

      const failing = spawnSync(
        "sh",
        [hookTimer, "WorktreeCreate", "0", `bun ${createEntry}`],
        {
          input: "",
          encoding: "utf8",
          env: { ...process.env, CLAUDE_LOGS_DIR: logs },
          timeout: 60_000,
        },
      );
      assert.equal(failing.status, 1);
      assert.equal(failing.stdout, "");
    });

    it("E06: importing an entry runs nothing", () => {
      const repo = createRepo(temp);
      const dir = temp.make("cwt-import-");
      for (const [entry, payload] of [
        [createEntry, createPayload(repo.dir, "never")],
        [
          cleanupEntry,
          JSON.stringify({
            hook_event_name: "SubagentStop",
            agent_id: "abc",
            cwd: repo.dir,
          }),
        ],
      ] as const) {
        const script = join(dir, "import.mjs");
        writeFileSync(
          script,
          `await import(${JSON.stringify(pathToFileURL(entry).href)});\n`,
        );
        // The payload would make a running entry create / look for a worktree.
        const result = runBun(script, payload);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
      }
      assert.equal(git(repo.dir, "branch", "--list", "worktree-*"), "");
    });
  },
);
