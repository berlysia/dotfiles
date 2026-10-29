import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  openSpool,
  PendingFullError,
  type SpoolDeps,
} from "../../lib/dotfiles-feedback/spool.ts";
import { openRetry } from "../../lib/dotfiles-feedback/retry.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import { parseItem } from "../../lib/dotfiles-feedback/item.ts";
import { readInbox } from "../../lib/dotfiles-feedback/cache.ts";
import { FEEDBACK_REPO } from "../../lib/dotfiles-feedback/constants.ts";
import { refresh } from "../../lib/dotfiles-feedback/refresh.ts";
import { fakeGh } from "../support/dotfiles-feedback-fake-gh.ts";

const now = new Date("2026-10-29T10:00:00Z");
const id = (index = 0) =>
  `20261029T100000Z-${index.toString(16).padStart(12, "0")}`;
function item(key = id()): FeedbackItemV1 {
  return {
    schemaVersion: 1,
    id: key,
    createdAt: "2026-10-29T10:00:00Z",
    title: "title",
    target: "target",
    kind: "bug",
    body: "body",
    source: {
      agent: "human",
      repoKey: null,
      host: "host",
      vm: key.startsWith("vm-"),
    },
  };
}
async function fixture() {
  const root = await fs.mkdtemp(join(import.meta.dirname, ".feedback-spool-"));
  let counter = 0;
  const deps: SpoolDeps = {
    fs,
    uid: (await fs.lstat(root)).uid,
    now: () => now,
    pid: 1,
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    isPidAlive: () => true,
    getPidStartTime: async () => "start",
  };
  return { root, deps };
}
for (const unsafe of [
  "root-mode",
  "root-link",
  "uid",
  "pending-link",
  "sending-mode",
] as const) {
  it(`rejects unsafe spool without writing: ${unsafe}`, async () => {
    const { root, deps } = await fixture();
    const path = join(root, "spool");
    try {
      await fs.mkdir(path, { mode: 0o700 });
      if (unsafe === "root-mode") await fs.chmod(path, 0o755);
      if (unsafe === "root-link") {
        await fs.rmdir(path);
        await fs.symlink(root, path);
      }
      if (unsafe === "uid") deps.uid++;
      if (unsafe === "pending-link")
        await fs.symlink(root, join(path, "pending"));
      if (unsafe === "sending-mode") {
        await fs.mkdir(join(path, "sending"));
        await fs.chmod(join(path, "sending"), 0o777);
      }
      const before = await fs.readdir(path);
      await rejects(openSpool(path, deps), /unsafe/);
      deepStrictEqual(await fs.readdir(path), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
for (const scenario of [
  "permissions",
  "capacity",
  "versions",
  "claim",
  "sent",
  "sent-corrupt",
  "failed",
  "corrupt-failed",
  "drop",
  "held",
  "vm-failed",
  "invalid",
] as const) {
  it(`spool: ${scenario}`, async () => {
    const { root, deps } = await fixture();
    try {
      const spool = await openSpool(root, deps);
      const retry = openRetry(root, deps);
      if (scenario === "permissions") {
        await spool.writePending(item(), { origin: "local" });
        for (const name of ["pending", "held", "sending", "failed", "state"])
          strictEqual((await fs.lstat(join(root, name))).mode & 0o777, 0o700);
        strictEqual(
          (await fs.lstat(join(root, "pending", `${id()}.json`))).mode & 0o777,
          0o600,
        );
      } else if (scenario === "capacity") {
        await Promise.all(
          Array.from({ length: 50 }, (_, i) =>
            fs.writeFile(
              join(root, "pending", `${id(i)}.json`),
              JSON.stringify(item(id(i))),
            ),
          ),
        );
        await rejects(
          spool.writePending(item(id(51)), { origin: "local" }),
          /full/,
        );
        await spool.writePending(item("vm-0123456789abcdef01234567"), {
          origin: "vm",
        });
      } else if (scenario === "versions") {
        await Promise.all(
          Array.from({ length: 51 }, (_, i) =>
            fs.writeFile(
              join(root, "pending", `${id(i)}.json`),
              JSON.stringify({ ...item(id(i)), schemaVersion: 2 }),
            ),
          ),
        );
        await retry.recordFailure(id(), now);
        await spool.sortPending();
        strictEqual((await fs.readdir(join(root, "held"))).length, 50);
        strictEqual((await fs.readdir(join(root, "failed"))).length, 1);
        strictEqual(
          JSON.parse(
            await fs.readFile(join(root, "failed", `${id(50)}.json`), "utf8"),
          ).reason,
          "unsupported-version",
        );
        strictEqual(await retry.isDue(id(), now), true);
        strictEqual(await spool.hasId(id()), true);
        await fs.writeFile(
          join(root, "held", `${id()}.json`),
          JSON.stringify(item()),
        );
        await retry.recordFailure(id(), now);
        await spool.sortPending();
        strictEqual((await fs.readdir(join(root, "pending"))).length, 1);
        strictEqual(await retry.isDue(id(), now), true);
      } else if (scenario === "claim") {
        await spool.writePending(item(), { origin: "local" });
        await retry.recordFailure(id(), now);
        await fs.utimes(
          join(root, "pending", `${id()}.json`),
          now,
          new Date(now.getTime() - 6 * 3600000),
        );
        const outcomes = await Promise.all([
          spool.claim(id()),
          spool.claim(id()),
        ]);
        strictEqual(outcomes.filter(Boolean).length, 1);
        const first = outcomes.find((value) => value !== null)!;
        await spool.reclaimStale(now);
        strictEqual(await spool.stillClaimed(first), true);
        await fs.writeFile(join(root, "sending", "x.abc.json"), "bad");
        await fs.utimes(join(root, "sending", "x.abc.json"), now, new Date(0));
        await spool.reclaimStale(new Date(now.getTime() + 11 * 60000));
        const second = await spool.claim(id());
        ok(second);
        strictEqual(await spool.stillClaimed(first), false);
        strictEqual(await spool.stillClaimed(second), true);
        strictEqual(await retry.isDue(id(), now), false);
        strictEqual(
          await fs.readFile(join(root, "sending", "x.abc.json"), "utf8"),
          "bad",
        );
      } else if (scenario === "sent-corrupt") {
        await fs.writeFile(
          join(root, "sent.jsonl"),
          `bad\n${JSON.stringify({ v: 1, id: id(), issue: "bad", at: now.toISOString() })}\n`,
        );
        strictEqual(await spool.hasId(id()), false);
        await fs.appendFile(
          join(root, "sent.jsonl"),
          `${JSON.stringify({ v: 1, id: id(), issue: 42, at: now.toISOString() })}\n`,
        );
        strictEqual(await spool.hasId(id()), true);
      } else if (scenario === "vm-failed") {
        await fs.mkdir(join(root, "failed/vm-m1"), { mode: 0o700 });
        await fs.writeFile(join(root, "failed/vm-m1", `${id()}.json`), "{}");
        strictEqual(await spool.hasId(id()), true);
      } else if (scenario === "invalid") {
        await rejects(spool.drop("../x"), /invalid id/);
        await rejects(spool.claim("x"), /invalid id/);
        await rejects(spool.hasId("../x"), /invalid id/);
      } else {
        await spool.writePending(item(), { origin: "local" });
        await retry.recordFailure(id(), now);
        const claimed = await spool.claim(id());
        ok(claimed);
        if (scenario === "sent") {
          await fs.writeFile(join(root, "sent.jsonl"), 'bad\n{"v":1}\n');
          await spool.markSent(claimed, 42);
          strictEqual(await spool.hasId(id()), true);
          const lines = (await fs.readFile(join(root, "sent.jsonl"), "utf8"))
            .trim()
            .split("\n");
          strictEqual(lines.length, 3);
          strictEqual(JSON.parse(lines[2]!).issue, 42);
        }
        if (scenario === "failed") {
          await spool.moveToFailed(claimed, "invalid");
          await spool.retryFailed(id());
          strictEqual(await spool.hasId(id()), true);
          strictEqual(
            parseItem(
              await fs.readFile(join(root, "pending", `${id()}.json`), "utf8"),
            ).kind,
            "ok",
          );
          await spool.moveToFailed(id(), "invalid");
        }
        if (scenario === "corrupt-failed") {
          await fs.writeFile(
            join(root, "sending", `${claimed.id}.${claimed.nonce}.json`),
            "{",
          );
          await spool.moveToFailed(claimed, "invalid");
          await spool.retryFailed(id());
          strictEqual(
            await fs.readFile(join(root, "pending", `${id()}.json`), "utf8"),
            "{",
          );
        }
        if (scenario === "drop") {
          await spool.drop(id());
          strictEqual(await spool.hasId(id()), false);
        }
        if (scenario === "held") {
          await spool.holdClaimed(claimed);
          strictEqual(await spool.hasId(id()), true);
        }
        strictEqual(await spool.stillClaimed(claimed), false);
        strictEqual(await retry.isDue(id(), now), true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

// plan-3 T3: 掃除と一覧。flush.lock の解放関数は、持っている印として引数に受ける。
const held = async () => undefined;
const DAY = 24 * 3600 * 1000;
const ageFile = (path: string, ageMs: number) =>
  fs.utimes(
    path,
    new Date(now.getTime() - ageMs),
    new Date(now.getTime() - ageMs),
  );
async function withSpool(
  run: (
    ctx: Awaited<ReturnType<typeof fixture>> & {
      spool: Awaited<ReturnType<typeof openSpool>>;
      retry: ReturnType<typeof openRetry>;
    },
  ) => Promise<void>,
) {
  const base = await fixture();
  try {
    const spool = await openSpool(base.root, base.deps);
    await run({ ...base, spool, retry: openRetry(base.root, base.deps) });
  } finally {
    await fs.rm(base.root, { recursive: true, force: true });
  }
}
const failedWrap = (key: string, reason = "invalid") =>
  JSON.stringify({ reason, item: JSON.stringify(item(key)) });

it("spool: pruneFailed removes failed items older than 30 days, vm included, idempotently", () =>
  withSpool(async ({ root, spool, retry, deps }) => {
    const [a, b, c, d, e] = [id(1), id(2), id(3), id(4), id(5)];
    await fs.mkdir(join(root, "failed/vm-m1"), { mode: 0o700 });
    const files = {
      a: join(root, "failed", `${a}.json`),
      b: join(root, "failed", `${b}.json`),
      c: join(root, "failed/vm-m1", `${c}.json`),
      d: join(root, "failed", `${d}.json`),
      e: join(root, "failed", `${e}.json`),
    };
    for (const [key, path] of Object.entries(files))
      await fs.writeFile(
        path,
        failedWrap(id({ a: 1, b: 2, c: 3, d: 4, e: 5 }[key] as number)),
      );
    await ageFile(files.a, 31 * DAY);
    await ageFile(files.b, 29 * DAY);
    await ageFile(files.c, 31 * DAY);
    await ageFile(files.d, 30 * DAY);
    await ageFile(files.e, 30 * DAY + 1000);
    for (const key of [a, b, c, d, e]) await retry.recordFailure(key, now);
    await spool.pruneFailed(now, held);
    const exists = async (path: string) =>
      fs.lstat(path).then(
        () => true,
        () => false,
      );
    deepStrictEqual(
      [
        await exists(files.a),
        await exists(files.b),
        await exists(files.c),
        await exists(files.d),
        await exists(files.e),
      ],
      [false, true, false, true, false],
    );
    await retry.prune(
      async () =>
        new Set(
          [
            ...(await fs.readdir(join(root, "pending"))),
            ...(await fs.readdir(join(root, "sending"))),
          ].map((n) => n.replace(/\..*$/, "")),
        ),
      held,
    );
    strictEqual(await retry.isDue(a, now), true);
    strictEqual(await retry.isDue(c, now), true);
    await spool.pruneFailed(now, held);
    strictEqual(await exists(files.b), true);
    void deps;
  }));

it("spool: listLocal reports place, title, reason and days until deletion", () =>
  withSpool(async ({ root, spool }) => {
    await spool.writePending(item(id(1)), { origin: "local" });
    await fs.writeFile(join(root, "pending", `${id(2)}.json`), "{");
    await fs.writeFile(
      join(root, "held", `${id(3)}.json`),
      JSON.stringify({ ...item(id(3)), schemaVersion: 2 }),
    );
    const claimed = join(root, "sending", `${id(4)}.0a.json`);
    await fs.writeFile(claimed, JSON.stringify(item(id(4))));
    await fs.writeFile(
      join(root, "failed", `${id(5)}.json`),
      failedWrap(id(5), "invalid"),
    );
    await ageFile(join(root, "failed", `${id(5)}.json`), 29 * DAY);
    await fs.writeFile(
      join(root, "failed", `${id(6)}.json`),
      failedWrap(id(6), "unsupported-version"),
    );
    await ageFile(join(root, "failed", `${id(6)}.json`), 29.5 * DAY);
    const list = await spool.listLocal(now);
    const by = (key: string) => list.find((entry) => entry.id === key);
    deepStrictEqual(by(id(1)), { id: id(1), place: "pending", title: "title" });
    deepStrictEqual(by(id(2)), { id: id(2), place: "pending", title: null });
    deepStrictEqual(by(id(3)), { id: id(3), place: "held", title: null });
    deepStrictEqual(by(id(4)), { id: id(4), place: "sending", title: "title" });
    deepStrictEqual(by(id(5)), {
      id: id(5),
      place: "failed",
      title: "title",
      reason: "invalid",
      daysUntilDeleted: 1,
    });
    strictEqual(by(id(6))?.daysUntilDeleted, 0);
    strictEqual(list.length, 6);
  }));

it("spool: countLocal counts pending+sending, failed including vm, and held", () =>
  withSpool(async ({ root, spool }) => {
    await spool.writePending(item(id(1)), { origin: "local" });
    await fs.writeFile(join(root, "sending", `${id(2)}.0a.json`), "{}");
    await fs.writeFile(join(root, "sending", "junk.json"), "{}");
    await fs.writeFile(join(root, "failed", `${id(3)}.json`), "{}");
    await fs.mkdir(join(root, "failed/vm-m1"), { mode: 0o700 });
    await fs.writeFile(join(root, "failed/vm-m1", `${id(4)}.json`), "{}");
    await fs.writeFile(join(root, "held", `${id(5)}.json`), "{}");
    deepStrictEqual(await spool.countLocal(), {
      unsent: 2,
      failed: 2,
      held: 1,
      failedVmUnsupported: 0,
    });
  }));

it("spool: truncateSent keeps the last 1000 lines and leaves 999 untouched", () =>
  withSpool(async ({ root, spool }) => {
    const path = join(root, "sent.jsonl");
    const line = (n: number) =>
      JSON.stringify({ v: 1, id: id(n), issue: n + 1, at: now.toISOString() });
    await fs.writeFile(
      path,
      Array.from({ length: 999 }, (_, n) => line(n)).join("\n") + "\n",
    );
    await ageFile(path, 5 * DAY);
    const before = (await fs.lstat(path)).mtimeMs;
    await spool.truncateSent(held);
    strictEqual((await fs.lstat(path)).mtimeMs, before);
    await fs.writeFile(
      path,
      Array.from({ length: 1005 }, (_, n) => line(n)).join("\n") + "\n",
    );
    await spool.truncateSent(held);
    const lines = (await fs.readFile(path, "utf8")).trim().split("\n");
    strictEqual(lines.length, 1000);
    strictEqual(lines[0], line(5));
    strictEqual(lines[999], line(1004));
    strictEqual((await fs.lstat(path)).mode & 0o777, 0o600);
  }));

it("spool: truncateSent without sent.jsonl is a no-op", () =>
  withSpool(async ({ spool }) => {
    await spool.truncateSent(held);
  }));

it("spool: findSent returns the last valid line for an id", () =>
  withSpool(async ({ root, spool }) => {
    strictEqual(await spool.findSent(id(1)), null);
    const line = (key: string, issue: number) =>
      JSON.stringify({ v: 1, id: key, issue, at: now.toISOString() });
    await fs.writeFile(
      join(root, "sent.jsonl"),
      [
        line(id(1), 3),
        "bad",
        '{"v":1,"id":"' + id(1) + '","issue":"x"}',
        line(id(2), 4),
        line(id(1), 9),
      ].join("\n") + "\n",
    );
    strictEqual(await spool.findSent(id(1)), 9);
    strictEqual(await spool.findSent(id(2)), 4);
    strictEqual(await spool.findSent(id(3)), null);
  }));

it("spool: cleanup functions require the flush.lock release function", () =>
  withSpool(async ({ spool, retry }) => {
    // @ts-expect-error 解放関数の引数を省くと型の誤りになる
    await spool.pruneFailed(now);
    // @ts-expect-error 同上
    await spool.truncateSent();
    // @ts-expect-error 同上
    await retry.prune(async () => new Set<string>());
  }));

// --- VM 由来の件（plan-5 T3）---
const vmId = (index = 0) => `vm-${index.toString(16).padStart(24, "0")}`;
const wrap = (reason: string, at = "2026-10-29T10:00:00Z") =>
  JSON.stringify({ reason, item: "{}", at });
async function withVmSpool(
  run: (ctx: {
    root: string;
    deps: SpoolDeps;
    spool: Awaited<ReturnType<typeof openSpool>>;
  }) => Promise<void>,
  mutate: (deps: SpoolDeps) => void = () => undefined,
) {
  const { root, deps } = await fixture();
  try {
    mutate(deps);
    const spool = await openSpool(root, deps);
    await run({ root, deps, spool });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
const seedVm = async (
  root: string,
  machine: string,
  key: string,
  reason: string,
  ageDays = 0,
) => {
  const dir = join(root, "failed", `vm-${machine}`);
  await fs.mkdir(dir, { mode: 0o700, recursive: true });
  const path = join(dir, `${key}.json`);
  await fs.writeFile(path, wrap(reason));
  const mtime = new Date(now.getTime() - ageDays * 24 * 3600 * 1000);
  await fs.utimes(path, mtime, mtime);
  return path;
};

it("writeVmFailed creates failed/vm-<machine> with mode 700 and writes the wrapper", () =>
  withVmSpool(async ({ root, spool }) => {
    strictEqual(
      await spool.writeVmFailed("m", vmId(1), wrap("invalid"), "invalid"),
      "written",
    );
    const dir = join(root, "failed", "vm-m");
    strictEqual((await fs.lstat(dir)).mode & 0o777, 0o700);
    const file = join(dir, `${vmId(1)}.json`);
    strictEqual((await fs.lstat(file)).mode & 0o777, 0o600);
    strictEqual(await fs.readFile(file, "utf8"), wrap("invalid"));
  }));
it("writeVmFailed refuses an unsafe directory without writing", () =>
  withVmSpool(async ({ root, spool }) => {
    const loose = join(root, "failed", "vm-loose");
    await fs.mkdir(loose, { mode: 0o755 });
    await fs.chmod(loose, 0o755);
    await rejects(
      spool.writeVmFailed("loose", vmId(1), wrap("invalid"), "invalid"),
      /unsafe/,
    );
    deepStrictEqual(await fs.readdir(loose), []);
    const target = join(root, "elsewhere");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, join(root, "failed", "vm-link"));
    await rejects(
      spool.writeVmFailed("link", vmId(1), wrap("invalid"), "invalid"),
      /unsafe/,
    );
    deepStrictEqual(await fs.readdir(target), []);
  }));
it("writeVmFailed returns exists for a name that is already there", () =>
  withVmSpool(async ({ spool }) => {
    await spool.writeVmFailed("m", vmId(1), wrap("invalid"), "invalid");
    strictEqual(
      await spool.writeVmFailed("m", vmId(1), wrap("invalid"), "invalid"),
      "exists",
    );
  }));
it("writeVmFailed caps invalid at 100 and unsupported-version at 50 per machine, separately", () =>
  withVmSpool(async ({ root, deps, spool }) => {
    const dir = join(root, "failed", "vm-m");
    await fs.mkdir(dir, { mode: 0o700 });
    for (let i = 0; i < 100; i++)
      await fs.writeFile(join(dir, `${vmId(i)}.json`), wrap("invalid"));
    strictEqual(
      await spool.writeVmFailed("m", vmId(500), wrap("invalid"), "invalid"),
      "full",
    );
    strictEqual(
      await spool.writeVmFailed(
        "m",
        vmId(501),
        wrap("unsupported-version"),
        "unsupported-version",
      ),
      "written",
    );
    strictEqual(
      await spool.writeVmFailed("other", vmId(500), wrap("invalid"), "invalid"),
      "written",
    );
    for (let i = 0; i < 49; i++)
      await fs.writeFile(
        join(dir, `${vmId(1000 + i)}.json`),
        wrap("unsupported-version"),
      );
    // 枠の数は spool ごとに最初の 1 回だけ数える。直接足した分は開き直した spool が数える。
    const reopened = await openSpool(root, deps);
    strictEqual(
      await reopened.writeVmFailed(
        "m",
        vmId(600),
        wrap("unsupported-version"),
        "unsupported-version",
      ),
      "full",
    );
  }));
it("writeVmFailed rejects a bad machine name and a local-form id", () =>
  withVmSpool(async ({ root, spool }) => {
    await rejects(
      spool.writeVmFailed("../x", vmId(1), wrap("invalid"), "invalid"),
      /invalid machine/,
    );
    await rejects(
      spool.writeVmFailed("m", id(), wrap("invalid"), "invalid"),
      /invalid id/,
    );
    deepStrictEqual(await fs.readdir(join(root, "failed")), []);
  }));
it("writeVmFailed recreates the directory once when the first write finds it gone", () => {
  let tripped = false;
  return withVmSpool(
    async ({ root, spool }) => {
      strictEqual(
        await spool.writeVmFailed("m", vmId(1), wrap("invalid"), "invalid"),
        "written",
      );
      ok(tripped);
      deepStrictEqual(await fs.readdir(join(root, "failed", "vm-m")), [
        `${vmId(1)}.json`,
      ]);
    },
    (deps) => {
      const real = deps.fs;
      deps.fs = {
        ...real,
        open: async (path, flags, mode) => {
          if (!tripped && String(path).includes("/failed/vm-m/")) {
            tripped = true;
            await fs.rm(join(String(path), ".."), {
              recursive: true,
              force: true,
            });
          }
          return real.open(path, flags, mode);
        },
      };
    },
  );
});

it("findVmFailed returns machine, path and text, and null for the top level or a symlinked directory", () =>
  withVmSpool(async ({ root, spool }) => {
    const path = await seedVm(root, "m", vmId(1), "invalid");
    deepStrictEqual(await spool.findVmFailed(vmId(1)), {
      machine: "m",
      path,
      text: wrap("invalid"),
    });
    await fs.writeFile(join(root, "failed", `${vmId(2)}.json`), wrap("x"));
    strictEqual(await spool.findVmFailed(vmId(2)), null);
    strictEqual(await spool.findVmFailed(vmId(3)), null);
    strictEqual(await spool.findVmFailed(id()), null);
    await fs.rename(join(root, "failed", "vm-m"), join(root, "real-m"));
    await fs.symlink(join(root, "real-m"), join(root, "failed", "vm-m"));
    strictEqual(await spool.findVmFailed(vmId(1)), null);
  }));

it("hasId except does not count the named file but counts every other place", () =>
  withVmSpool(async ({ root, spool }) => {
    const path = await seedVm(root, "m", vmId(1), "unsupported-version");
    strictEqual(await spool.hasId(vmId(1)), true);
    strictEqual(await spool.hasId(vmId(1), { except: path }), false);
    await fs.writeFile(join(root, "pending", `${vmId(1)}.json`), "{}");
    strictEqual(await spool.hasId(vmId(1), { except: path }), true);
    await fs.rm(join(root, "pending", `${vmId(1)}.json`));
    const other = await seedVm(root, "n", vmId(2), "invalid");
    strictEqual(await spool.hasId(vmId(1), { except: other }), true);
  }));

it("writePending throws a PendingFullError when the origin is full", () =>
  withVmSpool(async ({ root, spool }) => {
    for (let i = 0; i < 50; i++)
      await fs.writeFile(join(root, "pending", `${vmId(i)}.json`), "{}");
    const error = await spool
      .writePending(item(vmId(99)), { origin: "vm" })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    ok(error instanceof PendingFullError);
    ok(error instanceof Error);
    strictEqual(error.message, "dotfiles-feedback: pending full");
  }));

it("pruneFailed keeps old unsupported-version VM items and prunes the rest after 30 days", () =>
  withVmSpool(async ({ root, spool }) => {
    const keep = await seedVm(root, "m", vmId(1), "unsupported-version", 31);
    const drop = await seedVm(root, "m", vmId(2), "invalid", 31);
    const top = join(root, "failed", `${id(1)}.json`);
    await fs.writeFile(top, wrap("unsupported-version"));
    const old = new Date(now.getTime() - 31 * 24 * 3600 * 1000);
    await fs.utimes(top, old, old);
    await spool.pruneFailed(now, async () => undefined);
    strictEqual(
      await fs.lstat(keep).then(
        () => true,
        () => false,
      ),
      true,
    );
    strictEqual(
      await fs.lstat(drop).then(
        () => true,
        () => false,
      ),
      false,
    );
    strictEqual(
      await fs.lstat(top).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));
it("pruneFailed removes a vm directory it emptied, and only that", () =>
  withVmSpool(async ({ root, spool }) => {
    await seedVm(root, "gone", vmId(1), "invalid", 31);
    await seedVm(root, "stays", vmId(2), "unsupported-version", 31);
    await spool.pruneFailed(now, async () => undefined);
    deepStrictEqual((await fs.readdir(join(root, "failed"))).sort(), [
      "vm-stays",
    ]);
  }));

it("countLocal keeps failed as the whole count and reports failedVmUnsupported separately", () =>
  withVmSpool(async ({ root, spool }) => {
    await seedVm(root, "m", vmId(1), "unsupported-version");
    await seedVm(root, "m", vmId(2), "unsupported-version");
    await seedVm(root, "m", vmId(3), "invalid");
    let counts = await spool.countLocal();
    strictEqual(counts.failed, 3);
    strictEqual(counts.failedVmUnsupported, 2);
    await fs.writeFile(join(root, "pending", `${vmId(1)}.json`), "{}");
    counts = await spool.countLocal();
    strictEqual(counts.failed, 3);
    strictEqual(counts.failedVmUnsupported, 1);
  }));
it("countLocal counts 50 unsupported-version items", () =>
  withVmSpool(async ({ root, spool }) => {
    for (let i = 0; i < 50; i++)
      await seedVm(root, "m", vmId(i), "unsupported-version");
    const counts = await spool.countLocal();
    strictEqual(counts.failedVmUnsupported, 50);
  }));
it("drop removes a failed/vm-<machine> item", () =>
  withVmSpool(async ({ root, spool }) => {
    const path = await seedVm(root, "m", vmId(1), "invalid");
    await spool.drop(vmId(1));
    strictEqual(
      await fs.lstat(path).then(
        () => true,
        () => false,
      ),
      false,
    );
  }));

it("refresh keeps failedLocal as the whole failed count for unsupported-version VM items", () =>
  withVmSpool(async ({ root, deps }) => {
    for (let i = 0; i < 50; i++)
      await seedVm(root, "m", vmId(i), "unsupported-version");
    const result = await refresh({
      ...deps,
      root,
      home: "/h",
      repo: FEEDBACK_REPO,
      runGh: fakeGh().run,
      spawnFlush: async () => true,
      log: () => undefined,
    });
    strictEqual(result.kind, "done");
    const inbox = readInbox(join(root, "state", "inbox.json"), now);
    if (inbox.state === "missing" || inbox.state === "invalid")
      throw new Error(inbox.state);
    strictEqual(inbox.value.failedLocal, 50);
    deepStrictEqual(Object.keys(inbox.value).sort(), [
      "failedLocal",
      "fetchedAt",
      "heldLocal",
      "pendingLocal",
      "unprocessed",
      "v",
    ]);
  }));
