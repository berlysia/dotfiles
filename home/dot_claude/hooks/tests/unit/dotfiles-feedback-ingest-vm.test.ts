import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  INGEST_STDERR_REASONS,
  INGEST_STDOUT_REASONS,
  MAX_VM_FILE_BYTES,
} from "../../lib/dotfiles-feedback/constants.ts";
import type { FeedbackFs } from "../../lib/dotfiles-feedback/deps.ts";
import {
  ingestVm,
  retryVmFailed,
  type IngestDeps,
} from "../../lib/dotfiles-feedback/ingest-vm.ts";
import {
  rewriteVmItem,
  vmItemId,
} from "../../lib/dotfiles-feedback/vm-item.ts";

const MACHINE = "agent-test-000000";
const id = (index = 0) =>
  `20261029T090000Z-${index.toString(16).padStart(12, "0")}`;
const validBytes = (index = 0, extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      id: id(index),
      createdAt: "2026-10-29T09:00:00Z",
      title: `title ${index}`,
      target: "target",
      kind: "bug",
      body: "body",
      source: { agent: "claude", repoKey: null, host: "vm", vm: true },
      ...extra,
    }),
  );
const base = { start: Date.parse("2026-10-29T10:00:00Z") };

type Options = {
  mutateFs?: (fs: FeedbackFs, ctx: Ctx) => FeedbackFs;
  clock?: () => number;
  spawn?: boolean;
  skipIntake?: boolean;
};
type Ctx = Awaited<ReturnType<typeof fixture>>;
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  options: Options = {},
) {
  const dir = await nodeFs.mkdtemp(join(tmpdir(), "feedback-ingest-"));
  t.after(() => nodeFs.rm(dir, { recursive: true, force: true }));
  const root = join(dir, "spool");
  const state = join(dir, "state");
  await nodeFs.mkdir(state, { mode: 0o700 });
  const outbox = join(state, "outbox", MACHINE, "dotfiles-feedback");
  await nodeFs.mkdir(outbox, { mode: 0o700, recursive: true });
  let counter = 0;
  let spawned = 0;
  const clockState = { now: base.start };
  const calls: { op: string; path: string }[] = [];
  const realFs: FeedbackFs = {
    ...nodeFs,
    readdirBuffer: (path) => nodeFs.readdir(path, { encoding: "buffer" }),
  };
  const ctx = {
    dir,
    root,
    state,
    outbox,
    calls,
    clockState,
    spawned: () => spawned,
    intakeRoot: join(state, "intake", MACHINE),
    quarantineRoot: join(state, "intake-quarantine", MACHINE),
    deps: undefined as unknown as IngestDeps,
    put: (name: string, content: Buffer | string) =>
      nodeFs.writeFile(join(outbox, name), content),
    run: () => ingestVm({ stateDir: state, machine: MACHINE }, ctx.deps),
    pending: () =>
      nodeFs.readdir(join(root, "pending")).catch(() => [] as string[]),
    failed: (machine = MACHINE) =>
      nodeFs
        .readdir(join(root, "failed", `vm-${machine}`))
        .catch(() => [] as string[]),
  };
  const spy = (fs: FeedbackFs): FeedbackFs =>
    new Proxy(fs, {
      get(target, property: string) {
        const original = Reflect.get(target, property) as unknown;
        if (typeof original !== "function") return original;
        return (...args: unknown[]) => {
          calls.push({
            op: property,
            path: args[0] === undefined ? "" : String(args[0]),
          });
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  ctx.deps = {
    root,
    uid: process.getuid!(),
    now: options.clock
      ? () => new Date(options.clock!())
      : () => new Date(clockState.now),
    pid: 10,
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
    spawnFlush: async () => (spawned++, options.spawn ?? true),
    fs: spy(options.mutateFs ? options.mutateFs(realFs, ctx) : realFs),
  };
  return ctx;
}
const ls = (path: string) => nodeFs.readdir(path).catch(() => [] as string[]);
const exists = (path: string) =>
  nodeFs.lstat(path).then(
    () => true,
    () => false,
  );
const line = (c: Awaited<ReturnType<Ctx["run"]>>) => c.stdout.split("\n")[0];
const summary = (
  ingested: number,
  failed: number,
  discarded: number,
  kept: number,
  reason = "",
) =>
  `dotfiles-feedback ingest-vm: ingested=${ingested} failed=${failed} discarded=${discarded} kept=${kept}${reason ? ` reason=${reason}` : ""}`;

it("ingests a valid item: pending file, outbox gone, intake place gone, flush started once, exact stdout", async (t) => {
  const f = await fixture(t);
  const bytes = validBytes();
  await f.put(`${id()}.json`, bytes);
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(out.stdout, `${summary(1, 0, 0, 0)}\n`);
  strictEqual(out.stderr, "");
  deepStrictEqual(await f.pending(), [`${vmItemId(MACHINE, bytes)}.json`]);
  strictEqual(
    await exists(join(f.state, "outbox", MACHINE, "dotfiles-feedback")),
    false,
  );
  deepStrictEqual(await ls(f.intakeRoot), []);
  strictEqual(f.spawned(), 1);
  const written = JSON.parse(
    await nodeFs.readFile(
      join(f.root, "pending", (await f.pending())[0]!),
      "utf8",
    ),
  );
  strictEqual(written.source.host, MACHINE);
  strictEqual(written.createdAt, "2026-10-29T10:00:00Z");
});
it("does nothing and does not start flush when there is no outbox", async (t) => {
  const f = await fixture(t);
  await nodeFs.rm(join(f.state, "outbox"), { recursive: true });
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(out.stdout, `${summary(0, 0, 0, 0)}\n`);
  strictEqual(f.spawned(), 0);
});
it("removes an empty leftover place without quarantine", async (t) => {
  const f = await fixture(t);
  await nodeFs.mkdir(join(f.intakeRoot, "aaaaaaaaaaaaaaaa"), {
    recursive: true,
    mode: 0o700,
  });
  await nodeFs.rm(f.outbox, { recursive: true });
  const out = await f.run();
  strictEqual(out.stdout, `${summary(0, 0, 0, 0)}\n`);
  deepStrictEqual(await ls(f.intakeRoot), []);
  deepStrictEqual(await ls(f.quarantineRoot), []);
});
it("a failed flush start only warns on stderr and keeps exit code 0", async (t) => {
  const f = await fixture(t, { spawn: false });
  await f.put(`${id()}.json`, validBytes());
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(out.stderr, "dotfiles-feedback: flush-spawn-failed\n");
  strictEqual((await f.pending()).length, 1);
});
it("a symlinked dotfiles-feedback is moved as a link and unlinked; the target stays", async (t) => {
  const f = await fixture(t);
  const target = join(f.dir, "host-secret");
  await nodeFs.mkdir(target);
  await nodeFs.writeFile(join(target, `${id()}.json`), validBytes());
  await nodeFs.rm(f.outbox, { recursive: true });
  await nodeFs.symlink(target, f.outbox);
  const out = await f.run();
  strictEqual(out.code, 0);
  deepStrictEqual(await ls(target), [`${id()}.json`]);
  deepStrictEqual(await ls(f.intakeRoot), []);
  deepStrictEqual(await f.pending(), []);
});
it("symlinks, FIFOs and directories inside the place are removed without being followed", async (t) => {
  const f = await fixture(t);
  const outside = join(f.dir, "outside");
  await nodeFs.mkdir(outside);
  await nodeFs.writeFile(join(outside, "keep.txt"), "keep");
  await nodeFs.symlink(
    join(outside, "keep.txt"),
    join(f.outbox, `${id(1)}.json`),
  );
  execFileSync("mkfifo", [join(f.outbox, `${id(2)}.json`)]);
  await nodeFs.mkdir(join(f.outbox, "dir"));
  await nodeFs.mkdir(join(f.outbox, "dir2"));
  await nodeFs.symlink(outside, join(f.outbox, "dir2", "child"));
  const out = await f.run();
  strictEqual(out.code, 0);
  deepStrictEqual(await ls(outside), ["keep.txt"]);
  strictEqual(line(out), summary(0, 0, 3, 1));
  deepStrictEqual(await ls(f.quarantineRoot), []);
  const left = await ls(f.intakeRoot);
  strictEqual(left.length, 1);
});
it("a regular file swapped for a symlink, FIFO or directory between lstat and open is never followed", async (t) => {
  for (const swap of ["symlink", "fifo", "directory"] as const) {
    const f = await fixture(t, {
      mutateFs: (fs, ctx) => ({
        ...fs,
        open: async (path, flags, mode) => {
          const name = String(path);
          if (name.endsWith(`${id(1)}.json`)) {
            await nodeFs.rm(name);
            if (swap === "symlink")
              await nodeFs.symlink(join(ctx.dir, "outside", "keep.txt"), name);
            else if (swap === "fifo") execFileSync("mkfifo", [name]);
            else await nodeFs.mkdir(name);
          }
          return fs.open(path, flags, mode);
        },
      }),
    });
    await nodeFs.mkdir(join(f.dir, "outside"));
    await nodeFs.writeFile(join(f.dir, "outside", "keep.txt"), "keep");
    await f.put(`${id(1)}.json`, validBytes(1));
    await f.put(`${id(2)}.json`, validBytes(2));
    const out = await f.run();
    strictEqual(out.code, 0, swap);
    deepStrictEqual(await ls(join(f.dir, "outside")), ["keep.txt"], swap);
    strictEqual((await f.pending()).length, 1, swap);
  }
});
it("an item turned into a directory just before unlink gets rmdir only", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => {
      let swapped = false;
      return {
        ...fs,
        unlink: async (path) => {
          if (!swapped && String(path).endsWith("a.txt")) {
            swapped = true;
            await nodeFs.rm(path);
            await nodeFs.mkdir(path);
            await nodeFs.writeFile(join(String(path), "child"), "x");
          }
          return fs.unlink(path);
        },
      };
    },
  });
  await f.put("a.txt", "plain");
  await f.put(`${id(1)}.json`, validBytes(1));
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual((await f.pending()).length, 1);
  // rmdir は空でないので失敗し、その項目は減らせなかったものとして残る。子は消されない。
  const places = await ls(f.intakeRoot);
  const kept = await ls(join(f.intakeRoot, places[0]!, "a.txt"));
  deepStrictEqual(kept, ["child"]);
});
it("never uses a pathname chmod, a readFile of the place, a recursive removal or a following stat", async (t) => {
  const f = await fixture(t);
  await f.put(`${id(1)}.json`, validBytes(1));
  await f.put("a.txt", "x");
  execFileSync("mkfifo", [join(f.outbox, "pipe")]);
  await nodeFs.mkdir(join(f.outbox, "d"));
  await f.run();
  const forbidden = f.calls.filter(
    (call) =>
      ["chmod", "stat", "rm", "cp", "realpath"].includes(call.op) ||
      (call.op === "readFile" && call.path.includes("/intake")),
  );
  deepStrictEqual(forbidden, []);
  ok(f.calls.some((call) => call.op === "readdirBuffer"));
});
it("copies bad items to failed/vm-<machine> with the invalid reason and removes them from the place", async (t) => {
  const f = await fixture(t);
  const big = Buffer.concat([Buffer.from("x"), Buffer.alloc(17 * 1024, 0x20)]);
  await f.put(`${id(1)}.json`, big);
  await f.put("a.txt", validBytes(2));
  await f.put(`${id(3)}.json`, validBytes(3, { kind: "nope" }));
  const out = await f.run();
  strictEqual(line(out), summary(0, 3, 0, 0));
  const names = await f.failed();
  strictEqual(names.length, 3);
  for (const name of names) {
    const wrapped = JSON.parse(
      await nodeFs.readFile(
        join(f.root, "failed", `vm-${MACHINE}`, name),
        "utf8",
      ),
    );
    strictEqual(wrapped.reason, "invalid");
    strictEqual(typeof wrapped.item, "string");
    strictEqual(wrapped.at, "2026-10-29T10:00:00Z".replace("Z", ".000Z"));
  }
  deepStrictEqual(await ls(f.intakeRoot), []);
  // 17KB の件は先頭 16KB + 1 バイトで切られた形で写る。
  const bigName = `${vmItemId(MACHINE, big.subarray(0, MAX_VM_FILE_BYTES + 1))}.json`;
  ok(names.includes(bigName));
});
it("discards invalid UTF-8 without copying it", async (t) => {
  const f = await fixture(t);
  await f.put(`${id(1)}.json`, Buffer.from([0x7b, 0xff, 0x7d]));
  const out = await f.run();
  strictEqual(line(out), summary(0, 0, 1, 0));
  deepStrictEqual(await f.failed(), []);
});
it("reads at most 16KB + 1 bytes from a 1GB sparse file", async (t) => {
  const f = await fixture(t);
  const path = join(f.outbox, `${id(1)}.json`);
  const handle = await nodeFs.open(path, "w");
  await handle.truncate(1024 * 1024 * 1024);
  await handle.close();
  const out = await f.run();
  strictEqual(line(out), summary(0, 1, 0, 0));
  const [name] = await f.failed();
  const wrapped = JSON.parse(
    await nodeFs.readFile(
      join(f.root, "failed", `vm-${MACHINE}`, name!),
      "utf8",
    ),
  );
  strictEqual(Buffer.byteLength(wrapped.item), MAX_VM_FILE_BYTES + 1);
});
it("keeps a newer-version item as unsupported-version, and still ingests readable items", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++)
    await f.put(
      `${id(100 + i)}.json`,
      validBytes(100 + i, { schemaVersion: 2 }),
    );
  await f.put(`${id(1)}.json`, validBytes(1));
  const out = await f.run();
  strictEqual(line(out), summary(1, 3, 0, 0));
  strictEqual((await f.pending()).length, 1);
  const wrapped = JSON.parse(
    await nodeFs.readFile(
      join(f.root, "failed", `vm-${MACHINE}`, (await f.failed())[0]!),
      "utf8",
    ),
  );
  strictEqual(wrapped.reason, "unsupported-version");
});
it("ingests at most the item limit (5 of 6 with the limit injected) and finishes the rest next time without a new rename", async (t) => {
  const f = await fixture(t);
  f.deps.limits = { scanEntries: 200, ingestItems: 5 };
  for (let i = 0; i < 6; i++) await f.put(`${id(i)}.json`, validBytes(i));
  const first = await f.run();
  strictEqual(line(first), summary(5, 0, 0, 1));
  strictEqual((await f.pending()).length, 5);
  const placeBefore = await ls(f.intakeRoot);
  strictEqual(placeBefore.length, 1);
  for (const name of await f.pending())
    await nodeFs.rm(join(f.root, "pending", name));
  await nodeFs
    .writeFile(join(f.outbox, "later.txt"), "later outbox content")
    .catch(() => undefined);
  const second = await f.run();
  strictEqual(line(second), summary(1, 0, 0, 0));
  deepStrictEqual(await ls(f.intakeRoot), []);
});
it("scans only the scan limit (5 of 8 with the limit injected), then the rest next time", async (t) => {
  const f = await fixture(t);
  f.deps.limits = { scanEntries: 5, ingestItems: 50 };
  for (let i = 0; i < 8; i++)
    await f.put(`n${i.toString().padStart(3, "0")}.txt`, `{"i":${i}}`);
  strictEqual(line(await f.run()), summary(0, 5, 0, 3));
  strictEqual(line(await f.run()), summary(0, 3, 0, 0));
  deepStrictEqual(await ls(f.intakeRoot), []);
});
it("handles a listing of 100000 names by processing only 200 entries", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      readdirBuffer: async (path) =>
        String(path).includes("/intake/") &&
        !String(path).includes("intake-quarantine")
          ? Array.from({ length: 100_000 }, (_, i) => Buffer.from(`x${i}.txt`))
          : fs.readdirBuffer(path),
    }),
  });
  await f.put("a.txt", "{}");
  let lstats = 0;
  const real = f.deps.fs.lstat;
  f.deps.fs = {
    ...f.deps.fs,
    lstat: async (path) => {
      lstats++;
      return real(path);
    },
  };
  const out = await f.run();
  strictEqual(out.code, 0);
  ok(lstats < 1000, `lstat calls: ${lstats}`);
  ok(line(out)!.includes("kept=200"));
});

const lockFile = (f: Ctx) => join(f.root, "state", "ingest.lock");
async function seedLock(f: Ctx, pid: number, ageMs: number) {
  await nodeFs.mkdir(join(f.root, "state"), { recursive: true, mode: 0o700 });
  await nodeFs.writeFile(
    lockFile(f),
    JSON.stringify({
      v: 1,
      pid,
      startTime: "s",
      acquiredAt: new Date(f.clockState.now - ageMs).toISOString(),
    }),
  );
}
const errno = (code: string) => Object.assign(new Error(code), { code });
const onlyRoot = process.getuid?.() === 0;

it("disposes of non-UTF-8 names as Buffers: 250 files with 0xff in the name leave no stuck place", async (t) => {
  if (process.platform === "darwin")
    return t.skip("APFS rejects invalid UTF-8 names");
  const f = await fixture(t);
  for (let i = 0; i < 250; i++)
    await nodeFs.writeFile(
      Buffer.concat([
        Buffer.from(join(f.outbox, `${i.toString().padStart(3, "0")}-`)),
        Buffer.from([0xff]),
      ]),
      Buffer.from([0xff, 0xfe]),
    );
  strictEqual(line(await f.run()), summary(0, 0, 200, 50));
  strictEqual(line(await f.run()), summary(0, 0, 50, 0));
  deepStrictEqual(await ls(f.intakeRoot), []);
  deepStrictEqual(await ls(f.quarantineRoot), []);
});
it("items whose first lstat says ENOENT are not reduced: the place is quarantined and the next run is not stuck", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      lstat: async (path) => {
        const name = String(path);
        if (/\/intake\/[^/]+\/[0-9a-f]{16}\/[^/]+$/.test(name))
          throw errno("ENOENT");
        return fs.lstat(path);
      },
    }),
  });
  for (let i = 0; i < 200; i++) await f.put(`${id(i)}.json`, validBytes(i));
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(line(out), summary(0, 0, 0, 200, "quarantined"));
  strictEqual((await ls(f.quarantineRoot)).length, 1);
  ok(out.stdout.includes(`quarantined: ${f.quarantineRoot}/`));
  deepStrictEqual(await ls(f.intakeRoot), []);
  await nodeFs.mkdir(f.outbox, { recursive: true, mode: 0o700 });
  await f.put(`${id(1000)}.json`, validBytes(1000));
  f.deps.fs = { ...f.deps.fs, lstat: nodeFs.lstat };
  const next = await f.run();
  strictEqual(line(next), summary(1, 0, 0, 0));
});
it("a live ingest.lock holder gives reason=busy and exit 0", async (t) => {
  const f = await fixture(t);
  await seedLock(f, 99, 1000);
  await f.put(`${id()}.json`, validBytes());
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(out.stdout, `${summary(0, 0, 0, 0, "busy")}\n`);
  deepStrictEqual(await f.pending(), []);
  ok(await exists(join(f.outbox, `${id()}.json`)));
});
it("a dead-pid lock and a live lock older than 5 minutes are stolen", async (t) => {
  const dead = await fixture(t);
  await seedLock(dead, 99, 1000);
  dead.deps.isPidAlive = (pid) => pid !== 99;
  await dead.put(`${id()}.json`, validBytes());
  strictEqual(line(await dead.run()), summary(1, 0, 0, 0));
  const old = await fixture(t);
  await seedLock(old, 99, 6 * 60 * 1000);
  await old.put(`${id()}.json`, validBytes());
  strictEqual(line(await old.run()), summary(1, 0, 0, 0));
});
it("two places named like hex: only the first is processed, the second in the next run", async (t) => {
  const f = await fixture(t);
  for (const [name, index] of [
    ["aaaaaaaaaaaaaaaa", 1],
    ["bbbbbbbbbbbbbbbb", 2],
  ] as const) {
    await nodeFs.mkdir(join(f.intakeRoot, name), {
      recursive: true,
      mode: 0o700,
    });
    await nodeFs.writeFile(
      join(f.intakeRoot, name, `${id(index)}.json`),
      validBytes(index),
    );
  }
  await nodeFs.rm(f.outbox, { recursive: true });
  strictEqual(line(await f.run()), summary(1, 0, 0, 0));
  deepStrictEqual(await ls(f.intakeRoot), ["bbbbbbbbbbbbbbbb"]);
  strictEqual(line(await f.run()), summary(1, 0, 0, 0));
  strictEqual((await f.pending()).length, 2);
});
it("a hex-named symlink in intake/<m> is unlinked, not followed, and a fresh rename takes the outbox", async (t) => {
  const f = await fixture(t);
  const target = join(f.dir, "elsewhere");
  await nodeFs.mkdir(target);
  await nodeFs.writeFile(join(target, "x"), "x");
  await nodeFs.mkdir(f.intakeRoot, { recursive: true, mode: 0o700 });
  await nodeFs.symlink(target, join(f.intakeRoot, "cccccccccccccccc"));
  await f.put(`${id()}.json`, validBytes());
  strictEqual(line(await f.run()), summary(1, 0, 0, 0));
  deepStrictEqual(await ls(target), ["x"]);
});
it("a second ingest on a place left after pending/ was written (removal failed) does not duplicate", async (t) => {
  let failUnlink = true;
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      unlink: async (path) => {
        if (failUnlink && String(path).includes("/intake/")) throw errno("EIO");
        return fs.unlink(path);
      },
    }),
  });
  await f.put(`${id()}.json`, validBytes());
  const first = await f.run();
  strictEqual(line(first), summary(1, 0, 0, 1, "quarantined"));
  failUnlink = false;
  // 隔離された置き場を元に戻して、前回の残りを処理し直す。
  const [quarantined] = await ls(f.quarantineRoot);
  await nodeFs.rename(
    join(f.quarantineRoot, quarantined!),
    join(f.intakeRoot, quarantined!),
  );
  const second = await f.run();
  strictEqual(line(second), summary(0, 0, 1, 0));
  strictEqual((await f.pending()).length, 1);
});
it("one item whose unlink is denied is skipped and the rest is processed", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      unlink: async (path) => {
        if (String(path).endsWith("a.txt")) throw errno("EACCES");
        return fs.unlink(path);
      },
    }),
  });
  await f.put("a.txt", "x");
  await f.put(`${id(1)}.json`, validBytes(1));
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual((await f.pending()).length, 1);
  strictEqual(line(out), summary(1, 1, 0, 1));
});
it("unlink denied on every item of three: the place goes to quarantine with kept=3", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      unlink: async (path) => {
        if (String(path).includes("/intake/")) throw errno("EACCES");
        return fs.unlink(path);
      },
    }),
  });
  for (let i = 0; i < 3; i++) await f.put(`${id(i)}.json`, validBytes(i));
  const out = await f.run();
  strictEqual(line(out), summary(3, 0, 0, 3, "quarantined"));
  strictEqual((await ls(f.quarantineRoot)).length, 1);
});
it("a full VM pending queue leaves the items in place with reason=pending-full and no quarantine", async (t) => {
  const f = await fixture(t);
  await nodeFs.mkdir(join(f.root, "pending"), { recursive: true, mode: 0o700 });
  await nodeFs.chmod(f.root, 0o700);
  for (let i = 0; i < 50; i++)
    await nodeFs.writeFile(
      join(f.root, "pending", `vm-${i.toString(16).padStart(24, "0")}.json`),
      "{}",
    );
  await f.put(`${id()}.json`, validBytes());
  const out = await f.run();
  strictEqual(line(out), summary(0, 0, 0, 1, "pending-full"));
  strictEqual(out.code, 0);
  deepStrictEqual(await ls(f.quarantineRoot), []);
  strictEqual((await ls(f.intakeRoot)).length, 1);
  strictEqual(f.spawned(), 0);
});
it("the same content twice stays one pending item; another machine gets another id", async (t) => {
  const f = await fixture(t);
  await f.put(`${id()}.json`, validBytes());
  await f.run();
  await nodeFs.mkdir(f.outbox, { recursive: true, mode: 0o700 });
  await f.put(`${id()}.json`, validBytes());
  strictEqual(line(await f.run()), summary(0, 0, 1, 0));
  strictEqual((await f.pending()).length, 1);
  const other = "agent-other-111111";
  await nodeFs.mkdir(join(f.state, "outbox", other, "dotfiles-feedback"), {
    recursive: true,
    mode: 0o700,
  });
  await nodeFs.writeFile(
    join(f.state, "outbox", other, "dotfiles-feedback", `${id()}.json`),
    validBytes(),
  );
  await ingestVm({ stateDir: f.state, machine: other }, f.deps);
  strictEqual((await f.pending()).length, 2);
});
it("a place whose mode is 200 cannot be opened: quarantined, and the next run takes a fresh outbox", async (t) => {
  if (onlyRoot) return t.skip("root ignores modes");
  const f = await fixture(t);
  await f.put(`${id()}.json`, validBytes());
  await nodeFs.chmod(f.outbox, 0o200);
  const out = await f.run();
  strictEqual(line(out), summary(0, 0, 0, 0, "quarantined"));
  ok(out.stdout.split("\n")[1]!.startsWith("quarantined: "));
  await nodeFs.mkdir(f.outbox, { recursive: true, mode: 0o700 });
  await f.put(`${id(2)}.json`, validBytes(2));
  strictEqual(line(await f.run()), summary(1, 0, 0, 0));
  for (const dir of await ls(f.quarantineRoot))
    await nodeFs.chmod(join(f.quarantineRoot, dir), 0o700);
});
it("a quarantine rename denied by EACCES leaves the place with reason=quarantine-denied and exit 0", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      unlink: async (path) => {
        if (String(path).includes("/intake/")) throw errno("EACCES");
        return fs.unlink(path);
      },
      rename: async (from, to) => {
        if (String(to).includes("intake-quarantine")) throw errno("EACCES");
        return fs.rename(from, to);
      },
    }),
  });
  await f.put("a.txt", "x");
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(line(out), summary(0, 1, 0, 1, "quarantine-denied"));
  strictEqual((await ls(f.intakeRoot)).length, 1);
});
it("with 3 quarantined places an irreducible place is not moved: reason=quarantine-full, exit 0", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      unlink: async (path) => {
        if (String(path).includes("/intake/")) throw errno("EACCES");
        return fs.unlink(path);
      },
    }),
  });
  for (const n of ["1", "2", "3"])
    await nodeFs.mkdir(join(f.quarantineRoot, n.repeat(16)), {
      recursive: true,
      mode: 0o700,
    });
  await f.put("a.txt", "x");
  const out = await f.run();
  strictEqual(out.code, 0);
  strictEqual(line(out), summary(0, 1, 0, 1, "quarantine-full"));
  strictEqual((await ls(f.quarantineRoot)).length, 3);
  strictEqual((await ls(f.intakeRoot)).length, 1);
  const again = await f.run();
  strictEqual(line(again), summary(0, 0, 1, 1, "quarantine-full"));
});
it("a clock past 60 seconds stops with reason=timeout and does not quarantine", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs, ctx) => ({
      ...fs,
      unlink: async (path) => {
        await fs.unlink(path);
        if (String(path).includes("/intake/")) ctx.clockState.now += 61_000;
      },
    }),
  });
  for (let i = 0; i < 3; i++) await f.put(`${id(i)}.json`, validBytes(i));
  const out = await f.run();
  strictEqual(line(out), summary(1, 0, 0, 2, "timeout"));
  deepStrictEqual(await ls(f.quarantineRoot), []);
});
it("an outbox rename denied by EACCES prints rename-denied, exits 1 and never chmods", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      rename: async (from, to) => {
        if (String(from).includes("/outbox/")) throw errno("EACCES");
        return fs.rename(from, to);
      },
    }),
  });
  const out = await f.run();
  strictEqual(out.code, 1);
  strictEqual(out.stdout, "");
  strictEqual(out.stderr, "dotfiles-feedback: rename-denied\n");
  strictEqual(f.calls.filter((call) => call.op === "chmod").length, 0);
});
it("other rename errors print an errno word and exit 1", async (t) => {
  const f = await fixture(t, {
    mutateFs: (fs) => ({
      ...fs,
      rename: async (from, to) => {
        if (String(from).includes("/outbox/")) throw errno("EXDEV");
        return fs.rename(from, to);
      },
    }),
  });
  const out = await f.run();
  strictEqual(out.code, 1);
  strictEqual(out.stderr, "dotfiles-feedback: EXDEV\n");
});
it("machines x and x.y keep separate places", async (t) => {
  const f = await fixture(t);
  for (const machine of ["x", "x.y"]) {
    await nodeFs.mkdir(join(f.state, "outbox", machine, "dotfiles-feedback"), {
      recursive: true,
      mode: 0o700,
    });
    await nodeFs.writeFile(
      join(f.state, "outbox", machine, "dotfiles-feedback", `${id()}.json`),
      validBytes(),
    );
    const out = await ingestVm({ stateDir: f.state, machine }, f.deps);
    strictEqual(line(out), summary(1, 0, 0, 0));
  }
  strictEqual((await f.pending()).length, 2);
  deepStrictEqual(await ls(join(f.state, "intake", "x")), []);
  deepStrictEqual(await ls(join(f.state, "intake", "x.y")), []);
});
it("rejects bad arguments and unsafe state directories without doing anything", async (t) => {
  const f = await fixture(t);
  for (const machine of ["../x", "A", ""]) {
    const out = await ingestVm({ stateDir: f.state, machine }, f.deps);
    strictEqual(out.code, 1, machine);
    strictEqual(out.stderr, "dotfiles-feedback: invalid-argument\n");
  }
  const relative = await ingestVm(
    { stateDir: "state", machine: MACHINE },
    f.deps,
  );
  strictEqual(relative.code, 1);
  const link = join(f.dir, "state-link");
  await nodeFs.symlink(f.state, link);
  const linked = await ingestVm({ stateDir: link, machine: MACHINE }, f.deps);
  strictEqual(linked.stderr, "dotfiles-feedback: unsafe-state-dir\n");
  await nodeFs.chmod(f.state, 0o770);
  const loose = await f.run();
  strictEqual(loose.code, 1);
  strictEqual(loose.stderr, "dotfiles-feedback: unsafe-state-dir\n");
  await nodeFs.chmod(f.state, 0o700);
  strictEqual(await exists(join(f.state, "intake")), false);
  strictEqual(await exists(f.root), false);
});
it("refuses intake/<m> as a symlink or mode 755", async (t) => {
  const symlinked = await fixture(t);
  await nodeFs.mkdir(join(symlinked.state, "intake"), { mode: 0o700 });
  await nodeFs.mkdir(join(symlinked.dir, "elsewhere"));
  await nodeFs.symlink(join(symlinked.dir, "elsewhere"), symlinked.intakeRoot);
  const a = await symlinked.run();
  strictEqual(a.code, 1);
  strictEqual(a.stderr, "dotfiles-feedback: unsafe-state-dir\n");
  const loose = await fixture(t);
  await nodeFs.mkdir(loose.intakeRoot, { recursive: true, mode: 0o755 });
  await nodeFs.chmod(loose.intakeRoot, 0o755);
  const b = await loose.run();
  strictEqual(b.code, 1);
  ok(await exists(join(loose.outbox)));
});
it("never prints names or contents of VM files, whatever path they take", async (t) => {
  const f = await fixture(t);
  const marker = "SECRETNAME";
  await f.put(`\x1b[31m${marker}\n${"n".repeat(200)}.tmp-x`, "content-marker");
  await f.put(`.tmp-${marker}`, "content-marker");
  await nodeFs.symlink("/etc/hostname", join(f.outbox, `${marker}-link`));
  await f.put(`${marker}.json`, `{"title":"content-marker"}`);
  await f.put(`${id(7)}.json`, validBytes(7, { kind: `content-marker` }));
  const out = await f.run();
  for (const text of [out.stdout, out.stderr]) {
    ok(!text.includes(marker), text);
    ok(!text.includes("content-marker"), text);
    ok(!text.includes("\x1b"), text);
  }
  strictEqual(out.code, 0);
});
it("only prints reason words that the shared constants list", async (t) => {
  const stdoutWord = /reason=([a-z-]+)/;
  const f = await fixture(t);
  await seedLock(f, 99, 1000);
  const busy = await f.run();
  ok(
    (INGEST_STDOUT_REASONS as readonly string[]).includes(
      stdoutWord.exec(busy.stdout)![1]!,
    ),
  );
  const bad = await ingestVm({ stateDir: f.state, machine: "../x" }, f.deps);
  const word = /^dotfiles-feedback: (.+)\n$/.exec(bad.stderr)![1]!;
  ok((INGEST_STDERR_REASONS as readonly string[]).includes(word));
});

// --- flush --retry の振り分け（plan-5 T6）---
async function failedItem(f: Ctx, bytes: Buffer, reason: string) {
  const key = vmItemId(MACHINE, bytes);
  const dir = join(f.root, "failed", `vm-${MACHINE}`);
  await nodeFs.mkdir(dir, { recursive: true, mode: 0o700 });
  await nodeFs.mkdir(join(f.root, "pending"), { recursive: true, mode: 0o700 });
  const path = join(dir, `${key}.json`);
  await nodeFs.writeFile(
    path,
    JSON.stringify({ reason, item: bytes.toString("utf8"), at: "x" }),
  );
  return { key, path };
}
const okAsNewCli = (bytes: Uint8Array, machine: string, now: Date) => {
  // 新しい CLI を模す: 同じバイト列を、版が読める件として検査し直した結果にする。
  const text = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const result = rewriteVmItem(
    Buffer.from(JSON.stringify({ ...text, schemaVersion: 1 })),
    machine,
    now,
  );
  return result.kind === "ok"
    ? {
        kind: "ok" as const,
        item: { ...result.item, id: vmItemId(machine, bytes) },
      }
    : result;
};

it("retry: a newer-version item stays in failed with 'update the CLI' until a newer CLI accepts it", async (t) => {
  const f = await fixture(t);
  const { key, path } = await failedItem(
    f,
    validBytes(1, { schemaVersion: 2 }),
    "unsupported-version",
  );
  const refused = await retryVmFailed(f.deps, key);
  strictEqual(refused.code, 1);
  ok(refused.stderr.includes("CLI を更新する"));
  ok(await exists(path));
  const accepted = await retryVmFailed(f.deps, key, okAsNewCli);
  strictEqual(accepted.code, 0);
  deepStrictEqual(await f.pending(), [`${key}.json`]);
  strictEqual(await exists(path), false);
});
it("retry: an item that still fails the checks stays and tells the user to drop it", async (t) => {
  const f = await fixture(t);
  const { key, path } = await failedItem(
    f,
    validBytes(1, { kind: "nope" }),
    "invalid",
  );
  const out = await retryVmFailed(f.deps, key);
  strictEqual(out.code, 1);
  ok(out.stderr.includes(`drop ${key}`));
  ok(await exists(path));
});
it("retry: a wrapper whose bytes hash to another id is refused", async (t) => {
  const f = await fixture(t);
  const { key, path } = await failedItem(f, validBytes(1), "invalid");
  await nodeFs.writeFile(
    path,
    JSON.stringify({ reason: "invalid", item: validBytes(2).toString("utf8") }),
  );
  const out = await retryVmFailed(f.deps, key);
  strictEqual(out.code, 1);
  deepStrictEqual(await f.pending(), []);
  ok(await exists(path));
});
it("retry: the id found elsewhere (pending or sent.jsonl) removes the failed file and exits 0", async (t) => {
  for (const place of ["pending", "sent"] as const) {
    const f = await fixture(t);
    const bytes = validBytes(1);
    const { key, path } = await failedItem(f, bytes, "invalid");
    if (place === "pending")
      await nodeFs.writeFile(join(f.root, "pending", `${key}.json`), "{}");
    else
      await nodeFs.writeFile(
        join(f.root, "sent.jsonl"),
        `${JSON.stringify({ v: 1, id: key, issue: 3, at: "2026-10-29T10:00:00Z" })}\n`,
      );
    const out = await retryVmFailed(f.deps, key);
    strictEqual(out.code, 0, place);
    ok(out.stdout.includes("すでに取り込み済み"));
    strictEqual(await exists(path), false);
  }
});
it("retry: a full VM pending queue leaves the failed file with pending-full", async (t) => {
  const f = await fixture(t);
  const { key, path } = await failedItem(f, validBytes(1), "invalid");
  for (let i = 0; i < 50; i++)
    await nodeFs.writeFile(
      join(
        f.root,
        "pending",
        `vm-${(i + 1000).toString(16).padStart(24, "0")}.json`,
      ),
      "{}",
    );
  const out = await retryVmFailed(f.deps, key);
  strictEqual(out.code, 1);
  ok(out.stderr.includes("pending-full"));
  ok(await exists(path));
});
it("retry: a valid item of at most 16KB is rewritten and queued", async (t) => {
  const f = await fixture(t);
  const bytes = validBytes(1);
  const { key, path } = await failedItem(f, bytes, "invalid");
  const out = await retryVmFailed(f.deps, key);
  strictEqual(out.code, 0, out.stderr);
  deepStrictEqual(await f.pending(), [`${key}.json`]);
  strictEqual(await exists(path), false);
});
it("retry: an oversized copy (16KB + 1) is never admitted", async (t) => {
  const f = await fixture(t);
  const exact = validBytes(1);
  const padded = Buffer.concat([
    exact,
    Buffer.alloc(MAX_VM_FILE_BYTES + 1 - exact.length, 0x20),
  ]);
  const { key } = await failedItem(f, padded, "invalid");
  const out = await retryVmFailed(f.deps, key);
  strictEqual(out.code, 1);
  deepStrictEqual(await f.pending(), []);
});
