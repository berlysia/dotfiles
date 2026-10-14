import { ok, strictEqual } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  stealIfStale,
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
