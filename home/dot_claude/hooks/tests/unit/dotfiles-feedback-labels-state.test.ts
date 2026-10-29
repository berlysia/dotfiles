import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { it, mock } from "node:test";
import {
  FEEDBACK_LABELS,
  FEEDBACK_REPO,
  LABELS_STATE_FILE,
} from "../../lib/dotfiles-feedback/constants.ts";
import {
  clearLabelsState,
  readLabelsState,
  writeLabelsState,
  type LabelsStateDeps,
} from "../../lib/dotfiles-feedback/labels-state.ts";
import { openSpool } from "../../lib/dotfiles-feedback/spool.ts";

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  repo: string = FEEDBACK_REPO,
) {
  const base = await fs.mkdtemp(join(import.meta.dirname, ".feedback-labels-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, "spool");
  let counter = 0;
  await fs.mkdir(root, { mode: 0o700 });
  const deps: LabelsStateDeps = {
    root,
    repo,
    fs,
    uid: (await fs.lstat(root)).uid,
    now: () => new Date("2026-10-29T10:00:00Z"),
    pid: 1,
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
  };
  await openSpool(root, deps);
  const path = join(root, LABELS_STATE_FILE);
  return { base, root, deps, path };
}
function captureStderr() {
  const lines: string[] = [];
  const stub = mock.method(console, "error", (...args: unknown[]) => {
    // openSpool が自分でも 1 行出すので、labels-state の行だけを数える。
    if (String(args[0]).startsWith("dotfiles-feedback: labels state"))
      lines.push(args.join(" "));
  });
  return { lines, restore: () => stub.mock.restore() };
}

it("labels-state: write then read matches, and the file records repo and labels", async (t) => {
  const f = await fixture(t);
  strictEqual(await readLabelsState(f.deps), false);
  await writeLabelsState(f.deps);
  strictEqual(await readLabelsState(f.deps), true);
  deepStrictEqual(JSON.parse(await fs.readFile(f.path, "utf8")), {
    v: 1,
    repo: FEEDBACK_REPO,
    labels: [...FEEDBACK_LABELS],
  });
  strictEqual((await fs.stat(f.path)).mode & 0o777, 0o600);
});

it("labels-state: anything that does not match the current constants means not prepared", async (t) => {
  const f = await fixture(t);
  const cases: unknown[] = [
    { v: 1, repo: FEEDBACK_REPO, labels: ["dotfiles-feedback"] },
    { v: 1, repo: "someone/else", labels: [...FEEDBACK_LABELS] },
    { v: 2, repo: FEEDBACK_REPO, labels: [...FEEDBACK_LABELS] },
    { v: 1, repo: FEEDBACK_REPO, labels: FEEDBACK_LABELS.map((_, i) => i) },
    { v: 1, repo: FEEDBACK_REPO, labels: "dotfiles-feedback" },
    null,
    [],
  ];
  for (const value of cases) {
    await fs.writeFile(f.path, JSON.stringify(value));
    strictEqual(await readLabelsState(f.deps), false, JSON.stringify(value));
  }
  await fs.writeFile(f.path, "{broken");
  strictEqual(await readLabelsState(f.deps), false);
});

it("labels-state: a repo other than the one in deps is not a match", async (t) => {
  const f = await fixture(t);
  await writeLabelsState(f.deps);
  strictEqual(await readLabelsState({ ...f.deps, repo: "x/y" }), false);
});

it("labels-state: over 4KB, a symlink and a FIFO are treated as not matching", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.path,
    JSON.stringify({
      v: 1,
      repo: FEEDBACK_REPO,
      labels: [...FEEDBACK_LABELS],
      pad: "x".repeat(5000),
    }),
  );
  strictEqual(await readLabelsState(f.deps), false);
  await fs.rm(f.path);
  await writeLabelsState(f.deps);
  const real = join(f.base, "real.json");
  await fs.rename(f.path, real);
  await fs.symlink(real, f.path);
  strictEqual(await readLabelsState(f.deps), false);
  await fs.rm(f.path);
  strictEqual(spawnSync("mkfifo", [f.path]).status, 0);
  // 開いて止まらないことを確かめる（O_NONBLOCK）。止まればこのテストが時間切れになる。
  strictEqual(await readLabelsState(f.deps), false);
});

it("labels-state: clear removes the file, and only the link when it is a symlink", async (t) => {
  const f = await fixture(t);
  await writeLabelsState(f.deps);
  await clearLabelsState(f.deps);
  strictEqual(await readLabelsState(f.deps), false);
  await clearLabelsState(f.deps);
  const target = join(f.base, "target.json");
  await fs.writeFile(target, "keep");
  await fs.symlink(target, f.path);
  await clearLabelsState(f.deps);
  strictEqual(await fs.readFile(target, "utf8"), "keep");
  await rejectsLstat(f.path);
});
async function rejectsLstat(path: string) {
  try {
    await fs.lstat(path);
  } catch (error) {
    strictEqual((error as { code?: string }).code, "ENOENT");
    return;
  }
  throw new Error("expected the path to be gone");
}

it("labels-state: an unsafe state directory is neither read, written nor cleared, with one stderr line each", async (t) => {
  const f = await fixture(t);
  await writeLabelsState(f.deps);
  await fs.chmod(join(f.root, "state"), 0o770);
  const err = captureStderr();
  try {
    strictEqual(await readLabelsState(f.deps), false);
    await clearLabelsState(f.deps);
    await fs.rm(f.path);
    await writeLabelsState(f.deps);
  } finally {
    err.restore();
  }
  strictEqual(err.lines.length, 3);
  await fs.chmod(join(f.root, "state"), 0o700);
  strictEqual(await readLabelsState(f.deps), false, "write was refused");
  await writeLabelsState(f.deps);
  await fs.chmod(join(f.root, "state"), 0o770);
  const again = captureStderr();
  try {
    await clearLabelsState(f.deps);
  } finally {
    again.restore();
  }
  await fs.chmod(join(f.root, "state"), 0o700);
  strictEqual(await readLabelsState(f.deps), true, "clear was refused");
});

it("labels-state: a state directory that is a symlink is refused", async (t) => {
  const f = await fixture(t);
  const elsewhere = join(f.base, "elsewhere");
  await fs.mkdir(elsewhere, { mode: 0o700 });
  await fs.rm(join(f.root, "state"), { recursive: true });
  await fs.symlink(elsewhere, join(f.root, "state"));
  const err = captureStderr();
  try {
    await writeLabelsState(f.deps);
    strictEqual(await readLabelsState(f.deps), false);
  } finally {
    err.restore();
  }
  deepStrictEqual(await fs.readdir(elsewhere), []);
  ok(err.lines.length >= 1);
});

it("labels-state: a failing write is reported on stderr and does not throw", async (t) => {
  const f = await fixture(t);
  await fs.chmod(join(f.root, "state"), 0o500);
  t.after(() => fs.chmod(join(f.root, "state"), 0o700).catch(() => undefined));
  const err = captureStderr();
  try {
    await writeLabelsState(f.deps);
  } finally {
    err.restore();
  }
  strictEqual(err.lines.length, 1);
  strictEqual(await readLabelsState(f.deps), false);
});
