import { ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isStale,
  stealIfStale,
  touchLock,
  withStoreLock,
} from "../../lib/agent-learnings/core/lock.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agent-learnings-lock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const DEAD_PID = 2 ** 22 + 12345; // Linux の pid_max の上限を超えるので存在しない

describe("withStoreLock", () => {
  it("runs fn and removes the lock", () =>
    withTempDir(async (dir) => {
      const r = await withStoreLock(dir, { waitMs: 0 }, () => 42);
      ok(r.ok);
      strictEqual(r.value, 42);
      ok(!existsSync(join(dir, "lock")));
    }));
  it("times out while a live process holds it", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "lock"), `${process.pid} ${Date.now()}`);
      const r = await withStoreLock(dir, { waitMs: 200 }, () => 1);
      strictEqual(r.ok, false);
      ok(existsSync(join(dir, "lock")));
    }));
  it("steals a lock whose pid is dead", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "lock"), `${DEAD_PID} ${Date.now()}`);
      const r = await withStoreLock(dir, { waitMs: 0 }, () => "stolen");
      ok(r.ok);
      strictEqual(r.value, "stolen");
    }));
  it("steals a lock older than 10 minutes even if the pid is alive", () =>
    withTempDir(async (dir) => {
      const lock = join(dir, "lock");
      writeFileSync(lock, `${process.pid} 0`);
      const old = new Date(Date.now() - 11 * 60_000);
      utimesSync(lock, old, old);
      const r = await withStoreLock(dir, { waitMs: 0 }, () => "old");
      ok(r.ok);
    }));
  it("does not steal an unparseable fresh lock", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "lock"), "");
      const r = await withStoreLock(dir, { waitMs: 100 }, () => 1);
      strictEqual(r.ok, false);
    }));
});

describe("stealIfStale", () => {
  it("restores a lock that changed between observation and rename, without clobbering", () =>
    withTempDir(async (dir) => {
      const lock = join(dir, "lock");
      writeFileSync(lock, `${process.pid} 999`); // 別のプロセスが作り直した、生きた lock
      const stolen = stealIfStale(dir, `${DEAD_PID} 1`); // 観測したのは死んだ pid の lock
      strictEqual(stolen, false);
      strictEqual(readFileSync(lock, "utf8"), `${process.pid} 999`);
    }));
});

describe("lock options", () => {
  it("uses lockName and a custom stale threshold (20 min kept, 31 min stolen)", () =>
    withTempDir(async (dir) => {
      const lock = join(dir, "worker.lock");
      const age = (minutes: number): void => {
        writeFileSync(lock, `${process.pid} 0`);
        const t = new Date(Date.now() - minutes * 60_000);
        utimesSync(lock, t, t);
      };
      const opts = { lockName: "worker.lock", staleMs: 30 * 60_000 };
      age(20);
      const kept = await withStoreLock(dir, { waitMs: 0, ...opts }, () => 1);
      strictEqual(kept.ok, false);
      ok(existsSync(lock));
      age(31);
      const stolen = await withStoreLock(dir, { waitMs: 0, ...opts }, () => 2);
      ok(stolen.ok);
      ok(!existsSync(lock));
      ok(!existsSync(join(dir, "lock")));
    }));
  it("isStale honours staleMs", () => {
    const now = Date.now();
    const alive = `${process.pid} 1`;
    strictEqual(
      isStale(alive, now - 20 * 60_000, now, { staleMs: 30 * 60_000 }),
      false,
    );
    strictEqual(
      isStale(alive, now - 31 * 60_000, now, { staleMs: 30 * 60_000 }),
      true,
    );
    strictEqual(isStale(alive, now - 11 * 60_000, now), true); // 既定は 10 分
  });
  it("stealIfStale works on a named lock", () =>
    withTempDir(async (dir) => {
      writeFileSync(join(dir, "worker.lock"), `${DEAD_PID} 1`);
      strictEqual(
        stealIfStale(dir, `${DEAD_PID} 1`, { lockName: "worker.lock" }),
        true,
      );
      ok(!existsSync(join(dir, "worker.lock")));
    }));
});

describe("touchLock", () => {
  it("refreshes the mtime only when the lock is ours", () =>
    withTempDir(async (dir) => {
      const lock = join(dir, "worker.lock");
      const old = new Date(Date.now() - 25 * 60_000);
      writeFileSync(lock, `${process.pid} 1`);
      utimesSync(lock, old, old);
      strictEqual(touchLock(dir, { lockName: "worker.lock" }), true);
      ok(Date.now() - statSync(lock).mtimeMs < 5_000);

      writeFileSync(lock, `${DEAD_PID} 1`);
      utimesSync(lock, old, old);
      strictEqual(touchLock(dir, { lockName: "worker.lock" }), false);
      ok(Date.now() - statSync(lock).mtimeMs > 20 * 60_000);
      strictEqual(touchLock(join(dir, "nope"), { lockName: "x" }), false);
    }));
});
