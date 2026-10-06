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
  it("returns within 10 s and kills descendants that hold stdout", () => {
    const pidFile = join(makeTempDir(), "child.pid");
    const dir = fakeBunDir(`sleep 30 &\necho $! >${pidFile}\nwait`);
    const started = performance.now();
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      // The fake bun must start and record its child before the timeout fires; 1 s raced that under load.
      RUN_GUARD_TIMEOUT: "5",
    });
    const elapsed = performance.now() - started;
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
    ok(elapsed < 10_000, `took ${elapsed}ms`);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    ok(isGone(childPid), `descendant ${childPid} is still running`);
  });

  it("does not wait for the timeout when the hook finishes early", () => {
    const dir = fakeBunDir("exit 0");
    const started = performance.now();
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "30",
    });
    const elapsed = performance.now() - started;
    strictEqual(result.status, 0);
    ok(elapsed < 10_000, `took ${elapsed}ms`);
  });
});
