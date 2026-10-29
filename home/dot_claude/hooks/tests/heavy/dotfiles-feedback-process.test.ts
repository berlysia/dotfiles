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
    fs.appendFileSync(issues, JSON.stringify({ number, state: "open", body: stdin, user: "berlysia", pull_request: false }) + "\\n");
    out = "https://github.com/berlysia/dotfiles-feedback/issues/" + number + "\\n";
  }
  process.stdout.write(out);
  log("end");
};
if (fs.existsSync(sleepFile)) setTimeout(finish, Number(fs.readFileSync(sleepFile, "utf8")));
else finish();
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
});
