import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cleanupEntry,
  createEntry,
  hasBun,
  runBun,
} from "../support/claude-worktree-entry-fixture.ts";

// Real-process tests of the two entries. They need bun (the production
// runtime); without it the whole file is skipped with that reason.

describe(
  "worktree entries as processes",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("E03: broken or empty input exits 0 for cleanup and 1 with empty stdout for create", () => {
      for (const input of [
        "{broken",
        "",
        '{"hook_event_name":"WorktreeRemove"',
      ]) {
        const cleanup = runBun(cleanupEntry, input);
        assert.equal(cleanup.status, 0, `cleanup ${JSON.stringify(input)}`);
        assert.equal(cleanup.stdout, "");
      }
      const create = runBun(createEntry, "");
      assert.equal(create.status, 1);
      assert.equal(create.stdout, "");
      assert.notEqual(create.stderr, "");
    });
  },
);
