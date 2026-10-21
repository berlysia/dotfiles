#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  cleanupTempDirs,
  fakeBunDir,
  isGone,
  makeTempDir,
  runWrapper,
  throwingHook,
} from "../support/run-guard-helpers.ts";

after(cleanupTempDirs);

describe("run-guard.sh", () => {
  it("blocks with exit 2 when the hook exceeds the timeout, with only /usr/bin:/bin on PATH", () => {
    const dir = fakeBunDir("exec sleep 30");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "1",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
  });

  it("returns within the timeout and kills descendants that hold stdout", () => {
    const pidFile = join(makeTempDir(), "child.pid");
    const dir = fakeBunDir(`sleep 30 &\necho $! >${pidFile}\nwait`);
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      // The fake bun must start and record its child before the timeout fires; 1 s raced that under load.
      RUN_GUARD_TIMEOUT: "5",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    ok(isGone(childPid), `descendant ${childPid} is still running`);
  });
});
