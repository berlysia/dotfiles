import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEADLINE_MS,
  createGit,
  stripControlChars,
} from "../../lib/claude-worktree-git.ts";
import type { Deps } from "../../lib/claude-worktree-git.ts";

function fakeDeps(now: () => number): {
  deps: Deps;
  calls: { timeoutMs: number; kind: string }[];
} {
  const calls: { timeoutMs: number; kind: string }[] = [];
  return {
    deps: {
      now,
      runGit: (_args, opts) => {
        calls.push({ timeoutMs: opts.timeoutMs, kind: opts.kind });
        return { ok: true, stdout: "" };
      },
    },
    calls,
  };
}

describe("createGit", () => {
  it("C03: does not call git once the deadline has passed", () => {
    const { deps, calls } = fakeDeps(() => DEADLINE_MS + 1);
    const run = createGit(deps, 0);
    const result = run(["status"], "read", "/");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.timedOut, true);
    assert.equal(calls.length, 0);
  });

  it("C04: caps timeoutMs at the time left and at the per-kind limit", () => {
    const { deps, calls } = fakeDeps(() => DEADLINE_MS - 5_000);
    const run = createGit(deps, 0);
    run(["worktree", "add"], "add", "/");
    run(["status"], "read", "/");
    assert.deepEqual(
      calls.map((call) => call.timeoutMs),
      [5_000, 5_000],
    );

    const early = fakeDeps(() => 0);
    const earlyRun = createGit(early.deps, 0);
    earlyRun(["a"], "read", "/");
    earlyRun(["a"], "branch", "/");
    earlyRun(["a"], "update-ref", "/");
    earlyRun(["a"], "add", "/");
    earlyRun(["a"], "remove", "/");
    assert.deepEqual(
      early.calls.map((call) => call.timeoutMs),
      [10_000, 10_000, 10_000, 120_000, 120_000],
    );
  });

  it("DEADLINE_MS stays below the 240 s hook timeout", () => {
    assert.ok(DEADLINE_MS < 240_000);
  });
});

describe("stripControlChars", () => {
  it("C05: removes C0 controls except newline, and DEL", () => {
    assert.equal(stripControlChars("a\x1b[31mb\r\x00c\x07\x7f\n"), "a[31mbc\n");
  });

  it("keeps C1 controls and U+2028/2029", () => {
    assert.equal(stripControlChars("a\x85b c "), "a\x85b c ");
  });
});
