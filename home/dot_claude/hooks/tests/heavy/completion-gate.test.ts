import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCheck } from "../../implementations/completion-gate.ts";

const workDir = realpathSync(
  mkdtempSync(join(tmpdir(), "completion-gate-heavy-")),
);
const strayPids = new Set<number>();
after(() => {
  for (const pid of strayPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

let fileSeq = 0;
function pidFile(): string {
  return join(workDir, `pid-${fileSeq++}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Zombie counts as dead: on WSL the reap can lag. /proc exists on Linux only;
// elsewhere ESRCH is the sole signal.
function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

// The kernel closes a dying process's pipes before it becomes a zombie, so a
// runCheck that resolved on `close` can see its victim for a few more ms.
async function waitUntilDead(pid: number): Promise<boolean> {
  for (let waited = 0; waited <= 1000; waited += 25) {
    if (isDead(pid)) return true;
    await sleep(25);
  }
  return isDead(pid);
}

async function readPid(file: string): Promise<number> {
  for (let waited = 0; waited <= 1000; waited += 25) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf-8").trim();
      if (text !== "") return Number.parseInt(text, 10);
    }
    await sleep(25);
  }
  throw new Error(`pid was not written to ${file} within 1000 ms`);
}

const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;
const hasBun = spawnSync("sh", ["-c", "command -v bun"]).status === 0;

describe("completion-gate runCheck timeout", () => {
  it("reports a command cut off by its timeout as timed out, not as failed", async () => {
    // `exec` makes sleep the direct child, so killing it leaves nothing behind.
    const result = await runCheck("exec sleep 5", "test", { timeoutMs: 200 });
    strictEqual(result?.kind, "timeout");
    ok(result?.text.startsWith("test timed out after 0.2 s"), result?.text);
  });

  it("stops a grandchild of the cut-off run", async () => {
    const file = pidFile();
    await runCheck(`sleep 30 & echo $! > ${file}; sleep 30`, "test", {
      timeoutMs: 200,
    });
    const grandchild = await readPid(file);
    strayPids.add(grandchild);
    ok(
      await waitUntilDead(grandchild),
      `grandchild ${grandchild} is still alive`,
    );
  });

  it("SIGKILLs a descendant that ignores SIGTERM after the shell died of it", async () => {
    const file = pidFile();
    const started = Date.now();
    await runCheck(
      `(trap '' TERM; exec sleep 30) & echo $! > ${file}; sleep 30`,
      "test",
      { timeoutMs: 200, killGraceMs: 300 },
    );
    const elapsed = Date.now() - started;
    const grandchild = await readPid(file);
    strayPids.add(grandchild);
    ok(elapsed < 200 + 2 * 300 + 1500, `took ${elapsed} ms`);
    ok(
      await waitUntilDead(grandchild),
      `grandchild ${grandchild} is still alive`,
    );
  });

  it("SIGKILLs a SIGTERM-ignoring descendant that does not hold the gate's pipes", async () => {
    // Like a test file under `node --test`: its output goes to the runner, not
    // to the gate, so close arrives as soon as the shell dies of SIGTERM.
    const file = pidFile();
    await runCheck(
      `(trap '' TERM; exec sleep 30 >/dev/null 2>&1) & echo $! > ${file}; sleep 30`,
      "test",
      { timeoutMs: 200, killGraceMs: 300 },
    );
    const grandchild = await readPid(file);
    strayPids.add(grandchild);
    ok(
      await waitUntilDead(grandchild),
      `grandchild ${grandchild} is still alive`,
    );
  });

  it("times out when a descendant holds stdout after the direct child exited 0", async () => {
    const file = pidFile();
    const started = Date.now();
    const result = await runCheck(
      `sleep 30 & echo $! > ${file}; exit 0`,
      "test",
      { timeoutMs: 300, killGraceMs: 300 },
    );
    const elapsed = Date.now() - started;
    const grandchild = await readPid(file);
    strayPids.add(grandchild);
    strictEqual(result?.kind, "timeout");
    ok(elapsed < 300 + 2 * 300 + 1500, `took ${elapsed} ms`);
    ok(
      await waitUntilDead(grandchild),
      `grandchild ${grandchild} is still alive`,
    );
  });

  it(
    "gives up on a setsid descendant that holds the pipe, without hanging",
    { skip: !hasSetsid && "setsid is not available" },
    async () => {
      const file = pidFile();
      const started = Date.now();
      const result = await runCheck(
        `setsid sh -c 'echo $$ > ${file}; exec sleep 30' & sleep 30`,
        "test",
        { timeoutMs: 200, killGraceMs: 300 },
      );
      const elapsed = Date.now() - started;
      const escaped = await readPid(file);
      strayPids.add(escaped);
      strictEqual(result?.kind, "timeout");
      ok(elapsed >= 700 && elapsed < 2300, `took ${elapsed} ms`);
    },
  );

  it("leaves a process in another group alone", async () => {
    const bystander = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    });
    ok(bystander.pid !== undefined);
    const bystanderPid = bystander.pid as number;
    strayPids.add(bystanderPid);
    bystander.unref();
    const file = pidFile();
    await runCheck(`sleep 30 & echo $! > ${file}; sleep 30`, "test", {
      timeoutMs: 200,
    });
    strayPids.add(await readPid(file));
    ok(!isDead(bystanderPid), "a process in another group was killed");
  });

  it("stops a grandchild when the output limit cuts the run off", async () => {
    const file = pidFile();
    const command = `sleep 30 & echo $! > ${file}; node -e "process.stdout.write('x'.repeat(4096))"; sleep 30`;
    const result = await runCheck(command, "test", { maxBufferBytes: 1024 });
    const grandchild = await readPid(file);
    strayPids.add(grandchild);
    strictEqual(result?.kind, "output-limit");
    ok(
      await waitUntilDead(grandchild),
      `grandchild ${grandchild} is still alive`,
    );
  });
});

const gateEntry = join(
  import.meta.dirname,
  "..",
  "..",
  "implementations",
  "completion-gate.ts",
);

describe(
  "completion-gate when the gate itself is stopped",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("takes the running group with it on SIGTERM and ends by that signal", async () => {
      const file = pidFile();
      const script = join(workDir, "run-check.ts");
      writeFileSync(
        script,
        `import { runCheck } from ${JSON.stringify(gateEntry)};
await runCheck(${JSON.stringify(`sleep 30 & echo $! > ${file}; sleep 30`)}, "test", { timeoutMs: 30000 });`,
      );
      const child = spawn("bun", [script], { stdio: "ignore" });
      const exited = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolvePromise) =>
        child.on("close", (code, signal) => resolvePromise({ code, signal })),
      );
      const grandchild = await readPid(file);
      strayPids.add(grandchild);
      child.kill("SIGTERM");
      // Ended by the re-raised SIGTERM: the shell-visible status is 143, but
      // node reports a signal death as code null.
      const { code, signal } = await exited;
      ok(code === 143 || signal === "SIGTERM", `code=${code} signal=${signal}`);
      ok(
        await waitUntilDead(grandchild),
        `grandchild ${grandchild} is still alive`,
      );
    });
  },
);

function runStopHook(cwd: string): Promise<{ code: number; stdout: string }> {
  const payload = JSON.stringify({
    hook_event_name: "Stop",
    session_id: "completion-gate-heavy",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    stop_hook_active: false,
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bun", [gateEntry], {
      cwd,
      env: { ...process.env, CLAUDE_TEST_CWD: cwd, HOME: cwd },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout }));
    child.stdin.end(payload);
  });
}

describe(
  "completion-gate hook from a block to the retry-limit notice (as a process)",
  { skip: !hasBun && "bun is not on PATH" },
  () => {
    it("records the reason on a block and reports it at the limit", async () => {
      const repo = mkdtempSync(join(workDir, "repo-"));
      const git = (...args: string[]) =>
        spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { test: "exit 1" } }),
      );
      mkdirSync(join(repo, ".tmp"));
      const counterPath = join(repo, ".tmp", ".completion-gate-retries");
      writeFileSync(counterPath, "2 not-judged");

      const first = await runStopHook(repo);
      strictEqual(first.code, 0);
      strictEqual(JSON.parse(first.stdout).decision, "block", first.stdout);
      strictEqual(readFileSync(counterPath, "utf-8"), "3 failed");

      const second = await runStopHook(repo);
      const output = JSON.parse(second.stdout);
      ok(!("decision" in output), second.stdout);
      ok(output.systemMessage.includes("failing check"), second.stdout);
      deepStrictEqual(readFileSync(counterPath, "utf-8"), "3 failed");
    });
  },
);
