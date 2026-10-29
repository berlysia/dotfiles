import { strictEqual, ok } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  acquireLock,
  type LockDeps,
} from "../../lib/dotfiles-feedback/lock.ts";

const now = new Date("2026-10-29T10:00:00Z");
for (const scenario of [
  "dead",
  "live",
  "old",
  "reused",
  "unknown",
  "broken",
  "broken-old",
  "race",
  "third",
] as const) {
  it(`lock: ${scenario}`, async () => {
    const dir = await fs.mkdtemp(join(import.meta.dirname, ".feedback-lock-"));
    const path = join(dir, "lock");
    const deps: LockDeps = {
      fs,
      now: () => now,
      pid: 2,
      randomBytes: (size) => new Uint8Array(size).fill(2),
      isPidAlive: () => (scenario === "dead" ? false : true),
      getPidStartTime: async () => (scenario === "unknown" ? null : "new"),
    };
    try {
      const old = ["old", "broken-old", "race", "third"].includes(scenario);
      await fs.writeFile(
        path,
        scenario.startsWith("broken")
          ? "{"
          : JSON.stringify({
              v: 1,
              pid: 1,
              startTime: scenario === "reused" ? "old" : "new",
              acquiredAt: new Date(
                now.getTime() - (old ? 36 : 1) * 60000,
              ).toISOString(),
            }),
      );
      await fs.utimes(
        path,
        now,
        new Date(now.getTime() - (old ? 36 : 1) * 60000),
      );
      let owner: (() => Promise<void>) | null = null;
      if (scenario === "race" || scenario === "third") {
        deps.fs = {
          ...fs,
          rename: async (from, to) => {
            owner = await acquireLock(
              path,
              { staleMs: 35 * 60000 },
              { ...deps, fs },
            );
            ok(owner);
            await fs.rename(from, to);
          },
          link: async (from, to) => {
            if (scenario === "third")
              await fs.writeFile(path, "third", { flag: "wx" });
            await fs.link(from, to);
          },
        };
      }
      const release = await acquireLock(path, { staleMs: 35 * 60000 }, deps);
      if (["live", "unknown", "broken", "race", "third"].includes(scenario))
        strictEqual(release, null);
      else {
        ok(release);
        await release();
        strictEqual((await fs.readdir(dir)).length, 0);
      }
      if (scenario === "race") {
        strictEqual(JSON.parse(await fs.readFile(path, "utf8")).pid, 2);
        ok(owner);
      }
      if (scenario === "third")
        strictEqual(await fs.readFile(path, "utf8"), "third");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
it("creates exclusive private locks and releases only its own contents", async () => {
  const dir = await fs.mkdtemp(join(import.meta.dirname, ".feedback-lock-"));
  const path = join(dir, "lock");
  const deps: LockDeps = {
    fs,
    now: () => now,
    pid: 1,
    randomBytes: (size) => new Uint8Array(size),
    isPidAlive: () => true,
    getPidStartTime: async () => "start",
  };
  try {
    const release = await acquireLock(path, { staleMs: 1000 }, deps);
    ok(release);
    strictEqual((await fs.lstat(path)).mode & 0o777, 0o600);
    strictEqual(await acquireLock(path, { staleMs: 1000 }, deps), null);
    await fs.writeFile(path, "replacement");
    await release();
    strictEqual(await fs.readFile(path, "utf8"), "replacement");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
