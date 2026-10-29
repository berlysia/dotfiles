import { deepStrictEqual, ok, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  buildCliDeps,
  runCli,
  startCli,
  type CliDeps,
} from "../../cli/dotfiles-feedback.ts";
import { FEEDBACK_REPO } from "../../lib/dotfiles-feedback/constants.ts";
import { fakeGh } from "../support/dotfiles-feedback-fake-gh.ts";

const start = Date.parse("2026-10-29T10:00:00Z");
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  overrides: Partial<CliDeps> = {},
) {
  const dir = await fs.mkdtemp(join(tmpdir(), "feedback-cli-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = join(dir, "spool");
  const fake = fakeGh();
  const out: string[] = [];
  const err: string[] = [];
  const spawned: (readonly string[])[] = [];
  let counter = 0;
  const deps: CliDeps = {
    root,
    home: "/passwd/home",
    uid: process.getuid!(),
    fs,
    repo: FEEDBACK_REPO,
    runGh: fake.run,
    spawnFlush: async () => true,
    now: () => new Date(start),
    randomBytes: (size) => new Uint8Array(size).fill(++counter),
    hostname: () => "host",
    pid: 10,
    isPidAlive: () => true,
    getPidStartTime: async () => "s",
    isVm: false,
    readStdin: async () => "body text",
    envNames: [],
    resolveRepoKey: async () => null,
    cliPath: "/abs/cli.ts",
    cwd: "/",
    stdinIsTty: false,
    spawnDetached: async (argv) => (spawned.push(argv), true),
    stdout: (s) => void out.push(s),
    stderr: (s) => void err.push(s),
    ...overrides,
  };
  return { deps, root, fake, out, err, spawned };
}
const SEND = ["send", "--title", "t", "--target", "x", "--kind", "bug"];
const pending = async (root: string) =>
  existsSync(join(root, "pending")) ? fs.readdir(join(root, "pending")) : [];

it("send writes pending and spawns flush without waiting", async (t) => {
  const f = await fixture(t);
  strictEqual(await runCli(SEND, f.deps), 0);
  const files = await pending(f.root);
  strictEqual(files.length, 1);
  deepStrictEqual(f.spawned, [[process.execPath, "/abs/cli.ts", "flush"]]);
  ok(f.out.join("").includes(files[0]!.replace(".json", "")));
});
it("send rejects key-like bodies and writes nothing", async (t) => {
  const f = await fixture(t, {
    readStdin: async () => "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0",
  });
  strictEqual(await runCli(SEND, f.deps), 1);
  deepStrictEqual(await pending(f.root), []);
  strictEqual(f.spawned.length, 0);
});
it("send redacts secrets and reports it", async (t) => {
  const f = await fixture(t, {
    readStdin: async () => `token ghp_${"a".repeat(36)}`,
  });
  strictEqual(await runCli(SEND, f.deps), 0);
  const name = (await pending(f.root))[0]!;
  const text = await fs.readFile(join(f.root, "pending", name), "utf8");
  ok(!text.includes("ghp_"));
  ok(f.out.join("").includes("伏せた箇所: あり"));
});
it("send warns but exits 0 when the flush cannot start", async (t) => {
  const f = await fixture(t, { spawnDetached: async () => false });
  strictEqual(await runCli(SEND, f.deps), 0);
  ok(f.err.join("").includes("警告"));
  strictEqual((await pending(f.root)).length, 1);
});
it("send refuses a TTY stdin and an oversized stdin", async (t) => {
  const tty = await fixture(t, { stdinIsTty: true });
  strictEqual(await runCli(SEND, tty.deps), 1);
  const big = await fixture(t, {
    readStdin: async () => "a".repeat(64 * 1024 + 1),
  });
  strictEqual(await runCli(SEND, big.deps), 1);
  const thrown = await fixture(t, {
    readStdin: async () => {
      throw new Error("too large");
    },
  });
  strictEqual(await runCli(SEND, thrown.deps), 1);
  for (const f of [tty, big, thrown])
    deepStrictEqual(await pending(f.root), []);
});
it("send records the agent from env names", async (t) => {
  const f = await fixture(t, { envNames: ["CLAUDECODE"] });
  strictEqual(await runCli(SEND, f.deps), 0);
  const name = (await pending(f.root))[0]!;
  const item = JSON.parse(
    await fs.readFile(join(f.root, "pending", name), "utf8"),
  );
  strictEqual(item.source.agent, "claude");
});
it("builds the root from the passwd home, not from HOME", () => {
  const saved = process.env["HOME"];
  process.env["HOME"] = "/tmp/other-home";
  try {
    const deps = buildCliDeps("/passwd/home");
    strictEqual(deps.root, "/passwd/home/.local/share/dotfiles-feedback");
    strictEqual(deps.home, "/passwd/home");
  } finally {
    if (saved === undefined) delete process.env["HOME"];
    else process.env["HOME"] = saved;
  }
});
it("startCli reports a home failure without building deps", async () => {
  const err: string[] = [];
  let built = 0;
  const code = await startCli(["status"], {
    resolveHome: () => ({ ok: false, reason: "no passwd" }),
    buildDeps: () => {
      built++;
      throw new Error("must not run");
    },
    stderr: (s) => void err.push(s),
  });
  strictEqual(code, 1);
  strictEqual(built, 0);
  ok(err.join("").includes("no passwd"));
});
it("startCli passes the resolved home to buildDeps", async (t) => {
  const f = await fixture(t);
  let seen = "";
  const code = await startCli(["--help"], {
    resolveHome: () => ({ ok: true, home: "/h" }),
    buildDeps: (home) => ((seen = home), f.deps),
    stderr: () => {},
  });
  strictEqual(code, 0);
  strictEqual(seen, "/h");
});
it("a VM rejects everything except status", async (t) => {
  const f = await fixture(t, { isVm: true });
  strictEqual(await runCli(SEND, f.deps), 1);
  strictEqual(await runCli(["flush"], f.deps), 1);
  strictEqual(
    await runCli(["drop", "20261029T100000Z-000000000001"], f.deps),
    1,
  );
  strictEqual(await runCli(["status"], f.deps), 0);
  strictEqual(f.fake.calls.length, 0);
  deepStrictEqual(await pending(f.root), []);
});
it("status shows counts and the last flush reason", async (t) => {
  const f = await fixture(t);
  strictEqual(await runCli(SEND, f.deps), 0);
  await fs.writeFile(
    join(f.root, "state", "last-flush.json"),
    JSON.stringify({ v: 1, at: "2026-10-29T09:00:00Z", error: "not-private" }),
  );
  f.out.length = 0;
  strictEqual(await runCli(["status"], f.deps), 0);
  const text = f.out.join("");
  ok(text.includes("未送: 1 件"), text);
  ok(text.includes("not-private"), text);
});
it("drop removes a local item and refuses a bad id", async (t) => {
  const f = await fixture(t);
  await runCli(SEND, f.deps);
  const name = (await pending(f.root))[0]!;
  strictEqual(await runCli(["drop", "../x"], f.deps), 1);
  strictEqual((await pending(f.root)).length, 1);
  strictEqual(await runCli(["drop", name.replace(".json", "")], f.deps), 0);
  deepStrictEqual(await pending(f.root), []);
});
it("flush --retry returns a failed item to pending with attempts reset", async (t) => {
  const f = await fixture(t, { spawnDetached: async () => true });
  await runCli(SEND, f.deps);
  const name = (await pending(f.root))[0]!;
  const id = name.replace(".json", "");
  const text = await fs.readFile(join(f.root, "pending", name), "utf8");
  await fs.unlink(join(f.root, "pending", name));
  await fs.writeFile(
    join(f.root, "failed", name),
    JSON.stringify({ reason: "x", item: text }),
  );
  await fs.writeFile(
    join(f.root, "state", "retry.json"),
    JSON.stringify({
      v: 1,
      items: { [id]: { attempts: 5, nextAt: "2099-01-01T00:00:00.000Z" } },
    }),
  );
  strictEqual(await runCli(["flush", "--retry", id], f.deps), 0);
  // 偽の gh へ届けて sent になる。手元の pending / failed からは消える
  deepStrictEqual(await pending(f.root), []);
  ok(!existsSync(join(f.root, "failed", name)));
  strictEqual(f.fake.issues.length, 1);
});
it("unimplemented commands exit 1", async (t) => {
  const f = await fixture(t);
  strictEqual(await runCli(["list"], f.deps), 1);
  ok(f.err.join("").includes("未実装"));
});
it("--help exits 0 without opening the spool", async (t) => {
  const f = await fixture(t);
  strictEqual(await runCli(["--help"], f.deps), 0);
  ok(!existsSync(f.root));
});
