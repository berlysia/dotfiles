// Upper bound only. The unit test of the same name keeps the logic with a
// bound that does not depend on elapsed time.
import { ok, strictEqual } from "node:assert";
import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { touchLock } from "../../lib/agent-learnings/core/lock.ts";
import { withTempDir } from "../support/agent-learnings-lock-fixture.ts";

describe("touchLock", () => {
  it("refreshes the mtime only when the lock is ours (mtime age < 5 s)", () =>
    withTempDir(async (dir) => {
      const lock = join(dir, "worker.lock");
      const old = new Date(Date.now() - 25 * 60_000);
      writeFileSync(lock, `${process.pid} 1`);
      utimesSync(lock, old, old);
      strictEqual(touchLock(dir, { lockName: "worker.lock" }), true);
      ok(Date.now() - statSync(lock).mtimeMs < 5_000);
    }));
});
