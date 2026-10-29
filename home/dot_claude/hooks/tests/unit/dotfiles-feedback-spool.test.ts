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
