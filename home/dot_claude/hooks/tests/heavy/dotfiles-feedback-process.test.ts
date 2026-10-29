import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildCliDeps } from "../../cli/dotfiles-feedback.ts";
import { renderIssue } from "../../lib/dotfiles-feedback/issue-body.ts";

const HOOKS = join(import.meta.dirname, "../..");
const CHILD = join(HOOKS, "tests/support/dotfiles-feedback-child.ts");
const WRAPPER = join(HOOKS, "../../dot_local/bin/executable_dotfiles-feedback");

// 呼び出しを記録する偽の gh。状態は自分のあるディレクトリのファイルに置く。
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const argv = process.argv.slice(2);
const log = (phase) =>
  fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify({ phase, pid: process.pid, t: Date.now(), argv: argv.slice(0, 2) }) + "\\n");
const stdin = argv.includes("create") && argv[0] === "issue" ? fs.readFileSync(0, "utf8") : "";
log("start");
const sleepFile = path.join(dir, "sleep-ms");
const finish = () => {
  const issues = path.join(dir, "issues.jsonl");
  const lines = fs.existsSync(issues) ? fs.readFileSync(issues, "utf8").split("\\n").filter(Boolean) : [];
  let out = "";
  if (argv[0] === "api" && argv.includes("user")) out = JSON.stringify({ login: "berlysia" });
  else if (argv[0] === "repo") out = JSON.stringify({ isPrivate: true, owner: { login: "berlysia" } });
  else if (argv[0] === "api") out = lines.join("\\n");
  else if (argv[0] === "issue") {
    const number = lines.length + 1;
    fs.appendFileSync(issues, JSON.stringify({ number, state: "open", title: "", body: stdin, user: "berlysia", pull_request: false, labels: ["dotfiles-feedback"], updatedAt: "2026-10-29T00:00:00Z" }) + "\\n");
    out = "https://github.com/berlysia/dotfiles-feedback/issues/" + number + "\\n";
  }
  process.stdout.write(out);
  log("end");
};
if (fs.existsSync(sleepFile)) setTimeout(finish, Number(fs.readFileSync(sleepFile, "utf8")));
else finish();
`;

// 読み取り用の偽の gh。呼び出しの argv を全部記録し、issues.jsonl の行をそのまま一覧として返す。
const FAKE_GH_READ = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(fs.realpathSync(process.argv[1]));
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(argv) + "\\n");
const issues = path.join(dir, "issues.jsonl");
const lines = fs.existsSync(issues) ? fs.readFileSync(issues, "utf8").split("\\n").filter(Boolean) : [];
let out = "";
if (argv[0] === "api" && argv.includes("user")) out = JSON.stringify({ login: "berlysia" });
else if (argv[0] === "repo") out = JSON.stringify({ isPrivate: true, owner: { login: "berlysia" } });
else if (argv[0] === "api" && argv.some((a) => a.endsWith("/comments"))) out = "";
else if (argv[0] === "api") out = lines.join("\\n");
process.stdout.write(out);
`;

describe("dotfiles-feedback as a process", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      try {
        for (const pid of readFileSync(join(dir, "spawned.pids"), "utf8")
          .split("\n")
          .filter(Boolean))
          process.kill(-Number(pid), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(sleepMs?: number) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "feedback-proc-")));
    dirs.push(base);
    const fakeDir = join(base, "bin");
    mkdirSync(fakeDir);
    writeFileSync(join(fakeDir, "gh"), FAKE_GH);
    chmodSync(join(fakeDir, "gh"), 0o755);
    if (sleepMs !== undefined)
      writeFileSync(join(fakeDir, "sleep-ms"), String(sleepMs));
    const home = join(base, "home");
    mkdirSync(home);
    const root = join(base, "spool");
    return { base, fakeDir, home, root };
  }
  const childEnv = (fakeDir: string, home: string) => ({
    PATH: `${fakeDir}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  });
  // 子を起動し、stdout のパイプが閉じるまでの時間を測る。
  function runChild(
    s: ReturnType<typeof setup>,
    args: string[],
    input = "body text",
  ): Promise<{ ms: number; code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const child = spawn("bun", [CHILD, s.root, s.home, ...args], {
        cwd: s.base,
        env: childEnv(s.fakeDir, s.home),
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      let closedAt = 0;
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stdout.on("close", () => (closedAt = performance.now()));
      child.stdin.end(input);
      child.on("close", (code) =>
        resolve({
          ms: (closedAt || performance.now()) - startedAt,
          code,
          stdout,
        }),
      );
    });
  }
  const SEND = ["send", "--title", "t", "--target", "x", "--kind", "bug"];
  const files = (root: string, dir: string) =>
    existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : [];

  it("send returns before a slow gh finishes", async (t) => {
    const s = setup(10_000);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runChild(s, SEND);
      strictEqual(r.code, 0, r.stdout);
      times.push(r.ms);
    }
    const median = [...times].sort((a, b) => a - b)[1]!;
    t.diagnostic(
      `send pipe-close median: ${median.toFixed(0)}ms (${times.map((x) => x.toFixed(0)).join(", ")})`,
    );
    ok(median <= 500, `median ${median}ms`);
    strictEqual(
      files(s.root, "pending").length + files(s.root, "sending").length,
      3,
    );
  });

  it("five sends are delivered by one flush at a time", async () => {
    const s = setup();
    for (let i = 0; i < 5; i++)
      strictEqual((await runChild(s, SEND, `body ${i}`)).code, 0);
    const issues = join(s.fakeDir, "issues.jsonl");
    const deadline = Date.now() + 25_000;
    const count = () =>
      existsSync(issues)
        ? readFileSync(issues, "utf8").split("\n").filter(Boolean).length
        : 0;
    while (count() < 5 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    strictEqual(count(), 5);
    const calls = readFileSync(join(s.fakeDir, "calls.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (l) => JSON.parse(l) as { phase: string; pid: number; argv: string[] },
      );
    ok(calls.length > 0);
    // issue create の呼び出しが同時に動かない
    let running = 0;
    let max = 0;
    for (const c of calls) {
      if (c.argv[0] !== "issue") continue;
      running += c.phase === "start" ? 1 : -1;
      max = Math.max(max, running);
    }
    strictEqual(max, 1);
    deepStrictEqual(files(s.root, "pending"), []);
    // label は最初の回の 7 件だけ。以後の回は state/labels.json の記録で飛ばす。
    strictEqual(
      calls.filter((c) => c.phase === "start" && c.argv[0] === "label").length,
      7,
    );
  });

  it("the wrapper prints usage for --help", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "feedback-wrap-")));
    dirs.push(home);
    mkdirSync(join(home, ".claude"));
    symlinkSync(HOOKS, join(home, ".claude/hooks"));
    const r = spawnSync("bash", [WRAPPER, "--help"], {
      cwd: home,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes("使い方"), r.stdout);
    deepStrictEqual(readdirSync(home), [".claude"]);
  });

  // list / triage / refresh: 偽の gh を PATH に置いて起動する。HOME と spool は一時ディレクトリ。
  const targetIssue = (number: number, title: string) =>
    JSON.stringify({
      number,
      state: "open",
      title,
      body: renderIssue({
        schemaVersion: 1,
        id: `20261029T010203Z-00000000000${number}`,
        createdAt: "2026-10-29T01:02:03Z",
        title,
        target: "target",
        kind: "bug",
        body: "本文",
        source: { agent: "human", repoKey: null, host: "host", vm: false },
      }).body,
      user: "berlysia",
      pull_request: false,
      labels: ["dotfiles-feedback"],
      updatedAt: "2026-10-29T01:02:03Z",
    });
  function setupReader(title = "偽の題") {
    const s = setup();
    writeFileSync(join(s.fakeDir, "gh"), FAKE_GH_READ);
    writeFileSync(
      join(s.fakeDir, "issues.jsonl"),
      `${targetIssue(1, title)}\n`,
    );
    return s;
  }
  const calls = (s: ReturnType<typeof setup>) =>
    existsSync(join(s.fakeDir, "calls.log"))
      ? readFileSync(join(s.fakeDir, "calls.log"), "utf8")
          .split("\n")
          .filter(Boolean)
      : [];

  it("list prints the fake issue title and exits 0", async () => {
    const s = setupReader("偽の題");
    const r = await runChild(s, ["list"], "");
    strictEqual(r.code, 0, r.stdout);
    ok(r.stdout.includes("偽の題"), r.stdout);
  });

  it("triage --to issue without a TTY exits non-zero and never calls gh", async () => {
    const s = setupReader();
    const r = await runChild(s, ["triage", "#1", "--to", "issue"], "");
    ok(r.code !== 0 && r.code !== null);
    deepStrictEqual(calls(s), []);
  });

  it("refresh writes state/inbox.json with the open count", async () => {
    const s = setupReader();
    const r = await runChild(s, ["refresh"], "");
    strictEqual(r.code, 0, r.stdout);
    const inbox = JSON.parse(
      readFileSync(join(s.root, "state", "inbox.json"), "utf8"),
    );
    strictEqual(inbox.unprocessed, 1);
    strictEqual(inbox.v, 1);
  });

  it("confirm is false in a process without a controlling terminal", async () => {
    const s = setup();
    const script = join(s.base, "confirm.ts");
    writeFileSync(
      script,
      `import { buildCliDeps } from ${JSON.stringify(join(HOOKS, "cli/dotfiles-feedback.ts"))};
process.stdout.write(String(await buildCliDeps(${JSON.stringify(s.home)}).confirm("x")));`,
    );
    // detached は setsid を呼ぶので、子は制御端末を持たない。
    const out = await new Promise<string>((resolve) => {
      const child = spawn("bun", [script], {
        cwd: s.base,
        env: childEnv(s.fakeDir, s.home),
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
      let text = "";
      child.stdout.on("data", (c: Buffer) => (text += c.toString()));
      child.on("close", () => resolve(text));
    });
    strictEqual(out, "false");
  });

  it("resolveToplevel maps the worktree home/ directory to the repository root", async () => {
    const root = realpathSync(join(HOOKS, "../../.."));
    const deps = buildCliDeps("/passwd/home");
    const top = await deps.resolveToplevel(join(root, "home"));
    ok(top !== null);
    strictEqual(realpathSync(top), root);
  });
});

describe("dotfiles-feedback SessionStart section as a process", () => {
  const SECTION = join(
    HOOKS,
    "tests/support/dotfiles-feedback-session-section.ts",
  );
  // 起動した子は 10 秒眠って自分の pid を書くだけ。実機の refresh は起動しない。
  const SLEEPER = `const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "sleeper.pids"), process.pid + "\\n");
setTimeout(() => {}, 10000);
`;
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      try {
        for (const pid of readFileSync(join(dir, "sleeper.pids"), "utf8")
          .split("\n")
          .filter(Boolean))
          process.kill(-Number(pid), "SIGKILL");
      } catch {
        // 起動していない、または既に終わっている。
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runOnce(): {
    ms: number;
    stages: Record<string, number>;
    line: string | null;
    root: string;
    dir: string;
  } {
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), "feedback-session-section-")),
    );
    dirs.push(dir);
    const home = join(dir, "home");
    const root = join(home, ".local/share/dotfiles-feedback");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      join(root, "state", "inbox.json"),
      JSON.stringify({
        v: 1,
        fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        unprocessed: 3,
        pendingLocal: 0,
        failedLocal: 0,
        heldLocal: 0,
      }),
    );
    const sleeper = join(dir, "sleeper.cjs");
    writeFileSync(sleeper, SLEEPER);
    const env = { ...process.env, CLAUDE_HOOKS_DISABLE_FEEDBACK_NOTICE: "" };
    const result = spawnSync(
      process.execPath,
      [SECTION, home, sleeper, HOOKS],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    strictEqual(result.status, 0, result.stderr);
    return { ...JSON.parse(result.stdout), dir };
  }

  it("returns within 50ms (median of 3) and leaves the spawned child running", () => {
    const runs = [runOnce(), runOnce(), runOnce()];
    const times = runs.map((run) => run.ms).sort((a, b) => a - b);
    console.error(
      `session section ms: ${runs.map((run) => run.ms.toFixed(1)).join(", ")} stages: ${JSON.stringify(runs.map((run) => run.stages))}`,
    );
    for (const run of runs) {
      ok(
        run.line?.includes("未処理 3 件"),
        `line should show the count: ${run.line}`,
      );
      // 本物の repo-key が dotfiles と判定し、子が実際に起動した。
      let waited = 0;
      while (!existsSync(join(run.dir, "sleeper.pids")) && waited < 3000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        waited += 25;
      }
      ok(existsSync(join(run.dir, "sleeper.pids")), "child did not start");
    }
    ok(times[1]! <= 50, `median ${times[1]}ms > 50ms`);
  });
});

describe("dotfiles-feedback ingest-vm as a process", () => {
  const dirs: string[] = [];
  after(() => {
    for (const dir of dirs) {
      spawnSync("chmod", ["-R", "u+rwX", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 取り込みが起動する flush は、失敗する gh に当たって pending/ に件を残す（件の有無を確かめられるように）。
  function setup() {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "feedback-ingest-")));
    dirs.push(base);
    const fakeDir = join(base, "bin");
    mkdirSync(fakeDir);
    writeFileSync(join(fakeDir, "gh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeDir, "gh"), 0o755);
    const home = join(base, "home");
    mkdirSync(home);
    const state = join(base, "state");
    mkdirSync(state, { mode: 0o700 });
    const machine = "agent-test-000000";
    const outbox = join(state, "outbox", machine, "dotfiles-feedback");
    mkdirSync(outbox, { recursive: true, mode: 0o700 });
    return {
      base,
      fakeDir,
      home,
      root: join(base, "spool"),
      state,
      machine,
      outbox,
    };
  }
  const validItem = (index: number) =>
    JSON.stringify({
      schemaVersion: 1,
      id: `20261029T090000Z-${index.toString(16).padStart(12, "0")}`,
      createdAt: "2026-10-29T09:00:00Z",
      title: `title ${index}`,
      target: "target",
      kind: "bug",
      body: "body",
      source: { agent: "claude", repoKey: null, host: "vm", vm: true },
    });
  const itemName = (index: number) =>
    `20261029T090000Z-${index.toString(16).padStart(12, "0")}.json`;
  function ingest(s: ReturnType<typeof setup>) {
    return spawnSync(
      "bun",
      [
        CHILD,
        s.root,
        s.home,
        "ingest-vm",
        `--state-dir=${s.state}`,
        `--machine=${s.machine}`,
      ],
      {
        cwd: s.base,
        env: {
          PATH: `${s.fakeDir}:${process.env["PATH"] ?? ""}`,
          HOME: s.home,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
  }
  const FIXTURE = join(
    HOOKS,
    "../../../tests/agent-vm/fixtures/dotfiles-feedback-ingest-ok.txt",
  );

  it("ingests a valid item and prints the line that agent-vm's stub also prints", () => {
    const s = setup();
    writeFileSync(join(s.outbox, itemName(1)), validItem(1));
    const r = ingest(s);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout, readFileSync(FIXTURE, "utf8"));
    strictEqual(readdirSync(join(s.root, "pending")).length, 1);
    ok(!existsSync(join(s.state, "outbox", s.machine, "dotfiles-feedback")));
  });

  it("with the real limits, 60 readable items give ingested=50 kept=10", () => {
    const s = setup();
    for (let i = 0; i < 60; i++)
      writeFileSync(join(s.outbox, itemName(i)), validItem(i));
    const r = ingest(s);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(
      r.stdout,
      "dotfiles-feedback ingest-vm: ingested=50 failed=0 discarded=0 kept=10\n",
    );
    strictEqual(readdirSync(join(s.root, "pending")).length, 50);
  });

  it("an outbox whose parent denies the rename prints rename-denied and exits 1", (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores modes");
    const s = setup();
    writeFileSync(join(s.outbox, itemName(1)), validItem(1));
    chmodSync(join(s.state, "outbox", s.machine), 0o500);
    const r = ingest(s);
    strictEqual(r.status, 1);
    strictEqual(r.stderr, "dotfiles-feedback: rename-denied\n");
    strictEqual(r.stdout, "");
  });

  it("a leftover place with mode 200 is quarantined and the path is printed", (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores modes");
    const s = setup();
    const place = join(s.state, "intake", s.machine, "aaaaaaaaaaaaaaaa");
    mkdirSync(place, { recursive: true, mode: 0o700 });
    writeFileSync(join(place, itemName(1)), validItem(1));
    chmodSync(place, 0o200);
    rmSync(join(s.state, "outbox"), { recursive: true });
    const r = ingest(s);
    strictEqual(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n");
    ok(lines[0]!.endsWith("reason=quarantined"), r.stdout);
    ok(lines[1]!.startsWith("quarantined: "), r.stdout);
  });

  it("a file whose name holds 0xff is removed under bun and does not block a valid item", (t) => {
    if (process.platform !== "linux")
      return t.skip("APFS cannot create invalid UTF-8 names");
    const s = setup();
    writeFileSync(join(s.outbox, itemName(1)), validItem(1));
    writeFileSync(
      Buffer.concat([Buffer.from(`${s.outbox}/bad-`), Buffer.from([0xff])]),
      Buffer.from([0xff, 0xfe]),
    );
    const r = ingest(s);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(
      r.stdout,
      "dotfiles-feedback ingest-vm: ingested=1 failed=0 discarded=1 kept=0\n",
    );
    strictEqual(readdirSync(join(s.root, "pending")).length, 1);
    deepStrictEqual(readdirSync(join(s.state, "intake", s.machine)), []);
    ok(!existsSync(join(s.state, "outbox", s.machine, "dotfiles-feedback")));
  });
});
