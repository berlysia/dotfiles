import { deepStrictEqual, strictEqual, ok, rejects } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import {
  openSpool,
  type SpoolDeps,
} from "../../lib/dotfiles-feedback/spool.ts";
import { openRetry } from "../../lib/dotfiles-feedback/retry.ts";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import { parseItem } from "../../lib/dotfiles-feedback/item.ts";

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
