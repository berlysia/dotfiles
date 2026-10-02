#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, "..", "..", "executable_run-guard.sh");
const throwingHook = join(here, "..", "__fixtures__", "throwing-guard-hook.ts");

// Every temp dir is removed by the absolute path mkdtempSync returned.
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-guard-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A directory holding a fake `bun` executable with the given sh body. */
function fakeBunDir(body: string): string {
  const dir = makeTempDir();
  const bin = join(dir, "bun");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

/**
 * True when the process is gone or only a zombie waiting for its reaper
 * (a container without an init process may leave zombies around).
 */
function isGone(pid: number): boolean {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return stat === "" || stat.startsWith("Z");
}

function runWrapper(
  implPath: string,
  env: Record<string, string>,
  input = '{"tool_name":"Bash"}',
) {
  return spawnSync("sh", [wrapper, implPath], {
    input,
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
}

describe("run-guard.sh", () => {
  it("blocks with exit 2 when bun cannot be found", () => {
    const emptyHome = makeTempDir();
    const result = runWrapper(throwingHook, {
      PATH: "/usr/bin:/bin",
      HOME: emptyHome,
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("bun"), result.stderr);
  });

  it("blocks with exit 2 and drops stdout when the hook exits 1", () => {
    const dir = fakeBunDir("echo partial\nexit 1");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("exit code 1"), result.stderr);
    strictEqual(result.stdout, "");
  });

  it("passes stdout and exit 0 through", () => {
    const dir = fakeBunDir(`cat >/dev/null\necho '{"ok":true}'`);
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 0);
    strictEqual(result.stdout.trim(), '{"ok":true}');
  });

  it("passes exit 2 through", () => {
    const dir = fakeBunDir("exit 2");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 2);
  });

  it("forwards stdin byte for byte", () => {
    const dir = fakeBunDir("cat");
    const payload = `{"command":"echo \\"a b\\" '$HOME' \`x\`\\nnext"}`;
    const result = runWrapper(
      throwingHook,
      { PATH: `${dir}:/usr/bin:/bin`, HOME: makeTempDir() },
      payload,
    );
    strictEqual(result.status, 0);
    strictEqual(result.stdout.trim(), payload);
  });

  it("blocks with exit 2 when the hook exceeds the timeout, with only /usr/bin:/bin on PATH", () => {
    const dir = fakeBunDir("exec sleep 30");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "1",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
  });

  it("returns within the timeout and kills descendants that hold stdout", () => {
    const pidFile = join(makeTempDir(), "child.pid");
    const dir = fakeBunDir(`sleep 30 &\necho $! >${pidFile}\nwait`);
    const started = performance.now();
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "1",
    });
    const elapsed = performance.now() - started;
    strictEqual(result.status, 2);
    ok(result.stderr.includes("timed out"), result.stderr);
    ok(elapsed < 10_000, `took ${elapsed}ms`);
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    ok(isGone(childPid), `descendant ${childPid} is still running`);
  });

  it("does not wait for the timeout when the hook finishes early", () => {
    const dir = fakeBunDir("exit 0");
    const started = performance.now();
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
      RUN_GUARD_TIMEOUT: "30",
    });
    const elapsed = performance.now() - started;
    strictEqual(result.status, 0);
    ok(elapsed < 10_000, `took ${elapsed}ms`);
  });

  it("reports a hook that exits 124 by itself as abnormal, not as a timeout", () => {
    const dir = fakeBunDir("exit 124");
    const result = runWrapper(throwingHook, {
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: makeTempDir(),
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("exit code 124"), result.stderr);
    ok(!result.stderr.includes("timed out"), result.stderr);
  });

  for (const value of ["abc", "0"]) {
    it(`blocks with exit 2 when RUN_GUARD_TIMEOUT is ${JSON.stringify(value)}`, () => {
      const dir = fakeBunDir("exit 0");
      const result = runWrapper(throwingHook, {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: makeTempDir(),
        RUN_GUARD_TIMEOUT: value,
      });
      strictEqual(result.status, 2);
      ok(result.stderr.includes("RUN_GUARD_TIMEOUT"), result.stderr);
    });
  }

  it("exits 2 and stops the hook when the wrapper itself is terminated", async () => {
    const pidFile = join(makeTempDir(), "hook.pid");
    const dir = fakeBunDir(`echo $$ >${pidFile}\nexec sleep 30`);
    const child = spawn("sh", [wrapper, throwingHook], {
      env: { PATH: `${dir}:/usr/bin:/bin`, HOME: makeTempDir() },
    });
    child.stdin.end('{"tool_name":"Bash"}');
    // Wait until the hook is running, so the signal lands on the wrapper's wait.
    const deadline = performance.now() + 5_000;
    while (!existsSync(pidFile) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ok(existsSync(pidFile), "the hook did not start within 5s");
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    strictEqual(code, 2);
    const hookPid = Number(readFileSync(pidFile, "utf8").trim());
    ok(isGone(hookPid), `hook ${hookPid} is still running`);
  });

  it("blocks with exit 2 when sleep is not on PATH", () => {
    // Only the fake bun directory is on PATH, so the timer cannot be started.
    const dir = fakeBunDir("exit 0");
    const result = spawnSync("/bin/sh", [wrapper, throwingHook], {
      input: "{}",
      encoding: "utf8",
      env: { PATH: dir, HOME: makeTempDir() },
      timeout: 15_000,
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("sleep not found"), result.stderr);
  });

  it("blocks with exit 2 through the settings command form when the wrapper itself is missing", () => {
    // Mirrors the command in .settings.hooks.json.tmpl: `sh <wrapper> <hook> || exit 2`.
    const missing = join(makeTempDir(), "run-guard.sh");
    const result = spawnSync(
      "sh",
      ["-c", `sh ${missing} ${throwingHook} || exit 2`],
      {
        input: "{}",
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    strictEqual(result.status, 2);
  });

  it("blocks with exit 2 when a real cc-hooks-ts hook throws", (t) => {
    const probe = spawnSync("sh", ["-c", "command -v bun"], {
      encoding: "utf8",
      env: process.env,
    });
    if (probe.status !== 0) {
      t.skip("bun is not on PATH");
      return;
    }
    const result = runWrapper(throwingHook, {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    });
    strictEqual(result.status, 2);
    ok(result.stderr.includes("exit code 1"), result.stderr);
  });
});

describe("deny-node-modules through run-guard", () => {
  it("is wired through run-guard in the settings template", () => {
    const template = readFileSync(
      join(here, "..", "..", "..", ".settings.hooks.json.tmpl"),
      "utf8",
    );
    const line = template
      .split("\n")
      .find((l) => l.includes("deny-node-modules.ts"));
    ok(line, "deny-node-modules.ts is registered in the template");
    ok(line.includes("run-guard.sh"), line);
    ok(/\|\| exit 2"?,?\s*$/.test(line), line);
  });

  it("passes the hook's JSON deny through the wrapper unchanged", (t) => {
    const probe = spawnSync("sh", ["-c", "command -v bun"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    if (probe.status !== 0) {
      t.skip("bun is not on PATH");
      return;
    }
    const cwd = makeTempDir();
    const hookPath = join(
      here,
      "..",
      "..",
      "implementations",
      "deny-node-modules.ts",
    );
    const input = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
      session_id: "test",
      tool_use_id: "toolu_test",
      transcript_path: join(cwd, "transcript.jsonl"),
      cwd,
    });
    const result = spawnSync("sh", [wrapper, hookPath], {
      input,
      encoding: "utf8",
      cwd,
      env: { ...process.env, HOME: makeTempDir(), RUN_GUARD_TIMEOUT: "30" },
      timeout: 45_000,
    });
    strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    strictEqual(parsed.hookSpecificOutput?.permissionDecision, "deny");
  });
});
