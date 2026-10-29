import { deepStrictEqual, ok, strictEqual } from "node:assert";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { readInbox, writeInbox } from "../../lib/dotfiles-feedback/cache.ts";
import { FEEDBACK_REPO } from "../../lib/dotfiles-feedback/constants.ts";
import { flush } from "../../lib/dotfiles-feedback/flush.ts";
import { renderIssue } from "../../lib/dotfiles-feedback/issue-body.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import {
  refresh,
  type RefreshDeps,
} from "../../lib/dotfiles-feedback/refresh.ts";
import { openRetry } from "../../lib/dotfiles-feedback/retry.ts";
import { openSpool } from "../../lib/dotfiles-feedback/spool.ts";
import {
  fakeGh,
  type FakeIssue,
} from "../support/dotfiles-feedback-fake-gh.ts";

const now = new Date("2026-10-29T10:00:00Z");
const DAY = 24 * 3600 * 1000;
const id = (index = 0) =>
  `20261029T010203Z-${index.toString(16).padStart(12, "0")}`;
function item(key: string): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: key,
    createdAt: "2026-10-29T01:02:03Z",
    title: "title",
    target: "target",
    kind: "bug",
    body: "body",
    source: { agent: "human", repoKey: null, host: "host", vm: false },
  };
}
const issue = (
  number: number,
  key: string,
  over: Partial<FakeIssue> = {},
): FakeIssue => ({
  number,
  state: "open",
  title: "t",
  body: renderIssue(item(key)).body,
  user: "berlysia",
  pull_request: false,
  labels: ["dotfiles-feedback"],
  ...over,
});
type Ctx = {
  root: string;
  fake: ReturnType<typeof fakeGh>;
  deps: RefreshDeps;
  logs: string[];
  depsFor(pid: number, fsOverride?: Partial<RefreshDeps["fs"]>): RefreshDeps;
  inbox(): ReturnType<typeof readInbox>;
};
async function fixture(run: (ctx: Ctx) => Promise<void>) {
  const root = await nodeFs.mkdtemp(
    join(import.meta.dirname, ".feedback-refresh-"),
  );
  const fake = fakeGh();
  const logs: string[] = [];
  const uid = (await nodeFs.lstat(root)).uid;
  const depsFor = (
    pid: number,
    fsOverride: Partial<RefreshDeps["fs"]> = {},
  ): RefreshDeps => ({
    root,
    home: "/h",
    uid,
    fs: { ...nodeFs, ...fsOverride },
    repo: FEEDBACK_REPO,
    runGh: fake.run,
    spawnFlush: async () => true,
    now: () => now,
    pid,
    randomBytes: (size) => new Uint8Array(size).fill(pid),
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
    log: (text) => void logs.push(text),
  });
  const ctx: Ctx = {
    root,
    fake,
    deps: depsFor(1),
    logs,
    depsFor,
    inbox: () => readInbox(join(root, "state", "inbox.json"), now),
  };
  try {
    await openSpool(root, ctx.deps);
    await run(ctx);
  } finally {
    await nodeFs.rm(root, { recursive: true, force: true });
  }
}
const lockJson = (pid: number, ageMs: number) =>
  JSON.stringify({
    v: 1,
    pid,
    startTime: "s",
    acquiredAt: new Date(now.getTime() - ageMs).toISOString(),
  });
const exists = (path: string) =>
  nodeFs.lstat(path).then(
    () => true,
    () => false,
  );
const listCalls = (fake: ReturnType<typeof fakeGh>) =>
  fake.calls.filter((c) => c.argv.includes("state=open")).length;
const value = (r: ReturnType<typeof readInbox>) => {
  if (r.state === "missing" || r.state === "invalid") throw new Error(r.state);
  return r.value;
};

it("refresh: counts open targets and local holds", () =>
  fixture(async ({ root, fake, deps, inbox }) => {
    fake.issues.push(
      issue(1, id(1)),
      issue(2, id(2)),
      issue(3, id(3)),
      issue(4, id(4), { body: "no marker" }),
      issue(5, id(5), {
        body: `<!-- dotfiles-feedback id=${id(5)} v=2 {} -->`,
      }),
      issue(6, id(6), { user: "other" }),
      issue(7, id(7), { state: "closed" }),
    );
    for (const n of [1, 2])
      await nodeFs.writeFile(join(root, "held", `${id(20 + n)}.json`), "{}");
    const result = await refresh(deps);
    strictEqual(result.kind, "done");
    deepStrictEqual(value(inbox()), {
      v: 1,
      fetchedAt: "2026-10-29T10:00:00Z",
      unprocessed: 3,
      pendingLocal: 0,
      failedLocal: 0,
      heldLocal: 2,
    });
  }));

for (const [name, previous, expected] of [
  [
    "stale previous inbox",
    { fetchedAt: "2026-10-28T04:00:00Z", unprocessed: 4 },
    { fetchedAt: "2026-10-28T04:00:00Z", unprocessed: 4 },
  ],
  [
    "ok previous inbox",
    { fetchedAt: "2026-10-29T09:00:00Z", unprocessed: 5 },
    { fetchedAt: "2026-10-29T09:00:00Z", unprocessed: 5 },
  ],
  ["no previous inbox", null, { fetchedAt: null, unprocessed: null }],
] as const)
  it(`refresh: a failing listing keeps the counts (${name})`, () =>
    fixture(async ({ root, fake, deps, inbox }) => {
      if (previous)
        writeInbox(join(root, "state", "inbox.json"), {
          v: 1,
          ...previous,
          pendingLocal: 9,
          failedLocal: 9,
          heldLocal: 9,
        });
      fake.failWhen((argv) => argv.includes("state=open"), "network");
      await nodeFs.writeFile(join(root, "failed", `${id(1)}.json`), "{}");
      await refresh(deps);
      deepStrictEqual(value(inbox()), {
        v: 1,
        ...expected,
        pendingLocal: 0,
        failedLocal: 1,
        heldLocal: 0,
        error: "network",
      });
    }));
it("refresh: a corrupt previous inbox is treated as missing", () =>
  fixture(async ({ root, fake, deps, inbox }) => {
    await nodeFs.writeFile(join(root, "state", "inbox.json"), "{");
    fake.failWhen((argv) => argv.includes("state=open"), "network");
    await refresh(deps);
    strictEqual(value(inbox()).unprocessed, null);
  }));
it("refresh: not-private records the error and never lists", () =>
  fixture(async ({ fake, deps, inbox }) => {
    fake.isPrivate = false;
    await refresh(deps);
    strictEqual(value(inbox()).error, "not-private");
    strictEqual(listCalls(fake), 0);
  }));

it("refresh: a live refresh.lock holder makes this run leave a mark and stop", () =>
  fixture(async ({ root, fake, deps }) => {
    await nodeFs.writeFile(
      join(root, "state", "refresh.lock"),
      lockJson(99, 60_000),
    );
    await nodeFs.writeFile(join(root, "failed", `${id(1)}.json`), "{}");
    await nodeFs.utimes(
      join(root, "failed", `${id(1)}.json`),
      new Date(now.getTime() - 31 * DAY),
      new Date(now.getTime() - 31 * DAY),
    );
    strictEqual((await refresh(deps)).kind, "busy");
    ok(await exists(join(root, "state", "refresh.rerun")));
    strictEqual(listCalls(fake), 0);
    ok(await exists(join(root, "failed", `${id(1)}.json`)));
    strictEqual((await refresh(deps)).kind, "busy");
  }));
it("refresh: steals a lock of a dead pid and of a live pid older than 5 minutes", () =>
  fixture(async ({ root, depsFor, inbox }) => {
    await nodeFs.writeFile(
      join(root, "state", "refresh.lock"),
      lockJson(99, 60_000),
    );
    const dead = { ...depsFor(1), isPidAlive: (pid: number) => pid !== 99 };
    strictEqual((await refresh(dead)).kind, "done");
    strictEqual(inbox().state, "ok");
    await nodeFs.rm(join(root, "state", "inbox.json"));
    await nodeFs.writeFile(
      join(root, "state", "refresh.lock"),
      lockJson(99, 6 * 60_000),
    );
    strictEqual((await refresh(depsFor(1))).kind, "done");
    strictEqual(inbox().state, "ok");
  }));

it("refresh: cleanups run under flush.lock and are skipped while another process holds it", () =>
  fixture(async ({ root, deps, inbox }) => {
    const old = join(root, "failed", `${id(1)}.json`);
    await nodeFs.writeFile(old, "{}");
    const t = new Date(now.getTime() - 31 * DAY);
    await nodeFs.utimes(old, t, t);
    await nodeFs.writeFile(
      join(root, "state", "flush.lock"),
      lockJson(99, 1000),
    );
    strictEqual((await refresh(deps)).kind, "done");
    ok(await exists(old));
    strictEqual(inbox().state, "ok");
    await nodeFs.rm(join(root, "state", "flush.lock"));
    await refresh(deps);
    ok(!(await exists(old)));
    ok(!(await exists(join(root, "state", "flush.lock"))));
  }));
it("refresh: prunes orphan retry entries but keeps sending ids", () =>
  fixture(async ({ root, deps }) => {
    const retry = openRetry(root, deps);
    await retry.recordFailure(id(1), now);
    await retry.recordFailure(id(2), now);
    await nodeFs.writeFile(join(root, "sending", `${id(2)}.0a.json`), "{}");
    await refresh(deps);
    strictEqual(await retry.isDue(id(1), now), true);
    strictEqual(await retry.isDue(id(2), now), false);
  }));
it("refresh: a flush started while cleanups hold flush.lock returns and leaves the item for the next refresh", () =>
  fixture(async ({ root, fake, depsFor }) => {
    const old = join(root, "failed", `${id(1)}.json`);
    await nodeFs.writeFile(old, "{}");
    const t = new Date(now.getTime() - 31 * DAY);
    await nodeFs.utimes(old, t, t);
    const spool = await openSpool(root, depsFor(2));
    let fired = false;
    const hooked = depsFor(1, {
      lstat: async (path: string) => {
        if (!fired && path === old) {
          fired = true;
          await spool.writePending(item(id(7)), { origin: "local" });
          await flush(depsFor(2));
        }
        return nodeFs.lstat(path);
      },
    });
    await refresh(hooked);
    ok(fired);
    ok(await exists(join(root, "pending", `${id(7)}.json`)));
    ok(!(await exists(join(root, "state", "last-flush.json"))));
    strictEqual(fake.issues.length, 0);
    await refresh(depsFor(1));
    strictEqual(fake.issues.length, 1);
    ok(!(await exists(join(root, "pending", `${id(7)}.json`))));
  }));
it("refresh: sends pending items first and the inbox shows none left", () =>
  fixture(async ({ root, fake, deps, inbox }) => {
    const spool = await openSpool(root, deps);
    await spool.writePending(item(id(1)), { origin: "local" });
    await refresh(deps);
    strictEqual(fake.issues.length, 1);
    strictEqual(value(inbox()).pendingLocal, 0);
    strictEqual(value(inbox()).unprocessed, 1);
  }));
it("refresh: concurrent flush and refresh create one issue", () =>
  fixture(async ({ root, fake, depsFor }) => {
    const spool = await openSpool(root, depsFor(1));
    await spool.writePending(item(id(1)), { origin: "local" });
    await Promise.all([flush(depsFor(1)), refresh(depsFor(2))]);
    strictEqual(fake.issues.length, 1);
  }));
it("refresh: an inbox write failure is reported and refresh.lock is released", () =>
  fixture(async ({ root, deps }) => {
    await nodeFs.mkdir(join(root, "state", "inbox.json"));
    const result = await refresh(deps);
    strictEqual(result.kind, "failed");
    ok(!(await exists(join(root, "state", "refresh.lock"))));
  }));

// 順序は、実時間ではなく注入した fs と gh の呼び出しの位置で決める。
const rerunMark = (root: string) => join(root, "state", "refresh.rerun");
it("refresh: a mark made during step 4 (i) triggers one more count", () =>
  fixture(async ({ root, fake, depsFor, inbox }) => {
    let fired = false;
    fake.intercept = async (call) => {
      if (!fired && call.argv.includes("state=open")) {
        fired = true;
        strictEqual((await refresh(depsFor(2))).kind, "busy");
      }
      return null;
    };
    strictEqual((await refresh(depsFor(1))).kind, "done");
    strictEqual(listCalls(fake), 2);
    ok(!(await exists(rerunMark(root))));
    strictEqual(inbox().state, "ok");
  }));
it("refresh: a mark made after step 4 but before release (ii) is picked up after release", () =>
  fixture(async ({ root, fake, depsFor }) => {
    const lock = join(root, "state", "refresh.lock");
    let fired = false;
    const a = depsFor(1, {
      readFile: (async (path: string, enc: "utf8") => {
        if (!fired && path === lock) {
          fired = true;
          strictEqual((await refresh(depsFor(2))).kind, "busy");
        }
        return nodeFs.readFile(path, enc);
      }) as typeof nodeFs.readFile,
    });
    strictEqual((await refresh(a)).kind, "done");
    ok(fired);
    strictEqual(listCalls(fake), 2);
    ok(!(await exists(rerunMark(root))));
  }));
it("refresh: a run that starts after the final mark check (iii) takes the lock and counts last", () =>
  fixture(async ({ root, fake, depsFor }) => {
    const mark = rerunMark(root);
    let fired = false;
    const a = depsFor(1, {
      lstat: async (path: string) => {
        if (path === mark && !fired) {
          fired = true;
          fake.issues.push(issue(1, id(1)));
          strictEqual((await refresh(depsFor(2))).kind, "done");
        }
        return nodeFs.lstat(path);
      },
    });
    strictEqual((await refresh(a)).kind, "done");
    ok(fired);
    strictEqual(listCalls(fake), 2);
  }));
it("refresh: step 4 stops after 3 runs when marks keep coming and the mark stays", () =>
  fixture(async ({ root, fake, deps }) => {
    fake.intercept = async (call) => {
      if (call.argv.includes("state=open"))
        await nodeFs.writeFile(rerunMark(root), "");
      return null;
    };
    const result = await refresh(deps);
    strictEqual(result.kind, "done");
    strictEqual(listCalls(fake), 3);
    ok(await exists(rerunMark(root)));
    fake.intercept = null;
    await refresh(deps);
    ok(!(await exists(rerunMark(root))));
  }));
it("refresh: a mark that cannot be written is logged and the second attempt still runs", () =>
  fixture(async ({ root, logs, depsFor }) => {
    await nodeFs.writeFile(
      join(root, "state", "refresh.lock"),
      lockJson(99, 1000),
    );
    const failing = depsFor(1, {
      open: (async (path: string, ...rest: unknown[]) => {
        if (path === rerunMark(root)) throw new Error("denied");
        return (nodeFs.open as (...a: unknown[]) => unknown)(path, ...rest);
      }) as typeof nodeFs.open,
    });
    strictEqual((await refresh(failing)).kind, "busy");
    strictEqual(logs.length, 1);
  }));
