import { deepStrictEqual, ok, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { FeedbackItemV1 } from "../../lib/dotfiles-feedback/item.ts";
import {
  countVmOutbox,
  sendFromVm,
  type VmOutboxDeps,
} from "../../lib/dotfiles-feedback/vm-outbox.ts";

const id = (index = 0) =>
  `20261029T100000Z-${index.toString(16).padStart(12, "0")}`;
const item = (key = id()): FeedbackItemV1 => ({
  schemaVersion: 1,
  id: key,
  createdAt: "2026-10-29T10:00:00Z",
  title: "title",
  target: "target",
  kind: "bug",
  body: "body",
  source: { agent: "claude", repoKey: null, host: "vm", vm: false },
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = await fs.mkdtemp(join(tmpdir(), "feedback-vm-outbox-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  let counter = 0;
  const dir = join(base, "outbox", "dotfiles-feedback");
  const deps: VmOutboxDeps = {
    vmOutboxDir: dir,
    uid: process.getuid!(),
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    fs,
  };
  return { base, dir, deps };
}
const names = (dir: string) => fs.readdir(dir);

it("writes <id>.json with source.vm true and mode 600, creating the directory with mode 700", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.base, "outbox"), { mode: 0o755 });
  deepStrictEqual(await sendFromVm(item(), f.deps), { kind: "queued" });
  strictEqual((await fs.lstat(f.dir)).mode & 0o777, 0o700);
  deepStrictEqual(await names(f.dir), [`${id()}.json`]);
  const file = join(f.dir, `${id()}.json`);
  strictEqual((await fs.lstat(file)).mode & 0o777, 0o600);
  const written = JSON.parse(await fs.readFile(file, "utf8"));
  strictEqual(written.source.vm, true);
  strictEqual(written.id, id());
});
it("refuses a symlink, a group-writable directory and another owner without writing", async (t) => {
  const link = await fixture(t);
  await fs.mkdir(join(link.base, "real"), { mode: 0o700 });
  await fs.mkdir(join(link.base, "outbox"));
  await fs.symlink(join(link.base, "real"), link.dir);
  deepStrictEqual(await sendFromVm(item(), link.deps), { kind: "unsafe" });
  deepStrictEqual(await names(join(link.base, "real")), []);

  const loose = await fixture(t);
  await fs.mkdir(loose.dir, { recursive: true, mode: 0o700 });
  await fs.chmod(loose.dir, 0o770);
  deepStrictEqual(await sendFromVm(item(), loose.deps), { kind: "unsafe" });
  deepStrictEqual(await names(loose.dir), []);

  const foreign = await fixture(t);
  foreign.deps.uid = foreign.deps.uid + 1;
  deepStrictEqual(await sendFromVm(item(), foreign.deps), { kind: "unsafe" });
});
it("refuses at 50 id-shaped files and ignores .tmp- files and other names; 49 is accepted", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.dir, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 49; i++)
    await fs.writeFile(join(f.dir, `${id(i + 10)}.json`), "{}");
  await fs.writeFile(join(f.dir, ".tmp-x"), "");
  await fs.writeFile(join(f.dir, "a.txt"), "");
  strictEqual(await countVmOutbox(f.deps), 49);
  deepStrictEqual(await sendFromVm(item(id(1)), f.deps), { kind: "queued" });
  strictEqual(await countVmOutbox(f.deps), 50);
  deepStrictEqual(await sendFromVm(item(id(2)), f.deps), { kind: "full" });
  ok(!(await names(f.dir)).includes(`${id(2)}.json`));
});
it("retries once from mkdir when the first rename fails because the host took the directory", async (t) => {
  const f = await fixture(t);
  let renames = 0;
  f.deps.fs = {
    ...fs,
    rename: async (from, to) => {
      if (++renames === 1) {
        await fs.rm(f.dir, { recursive: true, force: true });
        return fs.rename(from, to);
      }
      return fs.rename(from, to);
    },
  };
  deepStrictEqual(await sendFromVm(item(), f.deps), { kind: "queued" });
  strictEqual(renames, 2);
  deepStrictEqual(await names(f.dir), [`${id()}.json`]);
});
it("reports the id and an errno word after two failures and leaves no .tmp- file", async (t) => {
  const f = await fixture(t);
  f.deps.fs = {
    ...fs,
    rename: async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
  deepStrictEqual(await sendFromVm(item(), f.deps), {
    kind: "failed",
    errno: "EACCES",
  });
  deepStrictEqual(await names(f.dir), []);
});
it("counts 0 when the directory does not exist", async (t) => {
  const f = await fixture(t);
  strictEqual(await countVmOutbox(f.deps), 0);
});
