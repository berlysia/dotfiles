#!/usr/bin/env node --test

// hook-timer.sh wraps every command hook to record wall-clock timing (see
// hooks/README.md "Hook telemetry" and plan T1). Most cases here use
// spawnSync, mirroring run-guard.test.ts. The three signal-delivery cases
// need an async spawn + delayed kill(), since spawnSync cannot deliver a
// signal mid-execution.

import { ok, strictEqual } from "node:assert";
import { execSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Elapsed-time assertions use performance.now(): Date.now() follows the wall
// clock, which WSL2 time sync can step mid-test (seen as elapsed=3836ms for a
// test node itself timed at 1312ms).

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = join(here, "..", "..", "executable_hook-timer.sh");

// Every temp dir is removed by the absolute path mkdtempSync returned.
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-timer-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Blocks the current thread for `ms` without spawning a process. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A directory holding only symlinks to the named real binaries. */
function buildMinimalBinDir(names: string[]): string {
  const dir = makeTempDir();
  for (const name of names) {
    const real = execSync(`command -v ${name}`, { shell: "/bin/sh" })
      .toString()
      .trim();
    symlinkSync(real, join(dir, name));
  }
  return dir;
}

/** A directory holding a fake executable named `name` with the given sh body. */
function fakeBinDir(name: string, body: string): string {
  const dir = makeTempDir();
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

type HookTimingRecord = {
  ts: string;
  start_ms: number | null;
  duration_ms: number | null;
  event: string;
  async: boolean;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number | null;
  command: string;
  session_id: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  terminated: string | null;
};

/** Polls `<dir>/hook-timing.jsonl` for its last line, up to 3000ms at 50ms intervals. */
function pollForLastRecord(
  dir: string,
  timeoutMs = 3000,
  intervalMs = 50,
): HookTimingRecord {
  const logPath = join(dir, "hook-timing.jsonl");
  const deadline = performance.now() + timeoutMs;
  let lines: string[] = [];
  while (performance.now() < deadline) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, "utf8");
      lines = content.split("\n").filter((l) => l.length > 0);
      if (lines.length > 0) break;
    }
    sleepSync(intervalMs);
  }
  if (lines.length === 0) {
    throw new Error(`no record appeared in ${logPath} within ${timeoutMs}ms`);
  }
  return JSON.parse(lines[lines.length - 1]);
}

function runWrapperSync(
  event: string,
  isAsync: "0" | "1",
  cmd: string,
  opts: {
    input: string;
    env: Record<string, string | undefined>;
    timeout?: number;
  },
) {
  return spawnSync("sh", [wrapper, event, isAsync, cmd], {
    input: opts.input,
    encoding: "utf8",
    env: opts.env,
    timeout: opts.timeout ?? 10_000,
  });
}

function baseEnv(logDir: string): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_LOGS_DIR: logDir };
}

describe("hook-timer.sh", () => {
  it("forwards stdin to stdout byte for byte and exits 0", () => {
    const logDir = makeTempDir();
    const input = '{"session_id":"s1","tool_name":"Bash","tool_use_id":"t1"}';
    const result = runWrapperSync("PreToolUse", "0", "cat", {
      input,
      env: baseEnv(logDir),
    });
    strictEqual(result.stdout, input);
    strictEqual(result.status, 0);
  });

  it("passes stdout, stderr and exit code through, and records the invocation", () => {
    const logDir = makeTempDir();
    const input = '{"session_id":"s2","tool_name":"Bash","tool_use_id":"t2"}';
    const result = runWrapperSync(
      "PreToolUse",
      "0",
      "echo out; echo err >&2; exit 2",
      { input, env: baseEnv(logDir) },
    );
    strictEqual(result.stdout, "out\n");
    strictEqual(result.stderr, "err\n");
    strictEqual(result.status, 2);

    const record = pollForLastRecord(logDir);
    strictEqual(record.event, "PreToolUse");
    strictEqual(record.async, false);
    strictEqual(record.exit_code, 2);
    strictEqual(record.stdout_bytes, 4);
    strictEqual(record.stderr_bytes, 4);
    strictEqual(record.session_id, "s2");
    strictEqual(record.tool_use_id, "t2");
    strictEqual(typeof record.duration_ms, "number");
    ok(
      (record.duration_ms as number) >= 0,
      `duration_ms=${record.duration_ms}`,
    );
  });

  it("passes a bare exit code through", () => {
    const logDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "exit 7", {
      input: "{}",
      env: baseEnv(logDir),
    });
    strictEqual(result.status, 7);
  });

  it("passes stdout through and records session_id:null when input is not JSON", () => {
    const logDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "cat", {
      input: "not json",
      env: baseEnv(logDir),
    });
    strictEqual(result.stdout, "not json");
    strictEqual(result.status, 0);

    const record = pollForLastRecord(logDir);
    strictEqual(record.session_id, null);
  });

  it("records exactly the 13-key schema and never leaks tool_input content", () => {
    const logDir = makeTempDir();
    const input = JSON.stringify({
      session_id: "s3",
      tool_name: "Bash",
      tool_use_id: "t3",
      tool_input: { command: "echo SECRET_TOKEN_X" },
    });
    const result = runWrapperSync("PreToolUse", "0", "exit 0", {
      input,
      env: baseEnv(logDir),
    });
    strictEqual(result.status, 0);

    const logPath = join(logDir, "hook-timing.jsonl");
    let rawLine = "";
    const record = pollForLastRecord(logDir);
    rawLine = readFileSync(logPath, "utf8").trim().split("\n").pop() ?? "";
    ok(!rawLine.includes("SECRET_TOKEN_X"), rawLine);

    const expectedKeys = [
      "ts",
      "start_ms",
      "duration_ms",
      "event",
      "async",
      "exit_code",
      "stdout_bytes",
      "stderr_bytes",
      "command",
      "session_id",
      "tool_name",
      "tool_use_id",
      "terminated",
    ].sort();
    strictEqual(Object.keys(record).sort().join(","), expectedKeys.join(","));
  });

  it("creates the log file with mode 0o600", () => {
    const logDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "exit 0", {
      input: "{}",
      env: baseEnv(logDir),
    });
    strictEqual(result.status, 0);
    pollForLastRecord(logDir);
    const mode = statSync(join(logDir, "hook-timing.jsonl")).mode & 0o777;
    strictEqual(mode, 0o600);
  });

  it("records a SIGTERM'd child as terminated with exit_code null", async () => {
    const logDir = makeTempDir();
    const child = spawn("sh", [wrapper, "PreToolUse", "0", "sleep 5"], {
      env: baseEnv(logDir),
    });
    child.stdin.write("{}");
    child.stdin.end();

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      setTimeout(() => child.kill("SIGTERM"), 300);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    strictEqual(result.code, 143);

    const record = pollForLastRecord(logDir);
    strictEqual(record.terminated, "TERM");
    strictEqual(record.exit_code, null);
    ok(
      typeof record.duration_ms === "number" &&
        record.duration_ms >= 250 &&
        record.duration_ms < 2000,
      `duration_ms=${record.duration_ms}`,
    );
  });

  it("does not block on a slow jq (recording is detached)", () => {
    const logDir = makeTempDir();
    const slowJqDir = fakeBinDir("jq", "sleep 3");
    const env = {
      ...baseEnv(logDir),
      PATH: `${slowJqDir}:${process.env.PATH}`,
    };
    const start = performance.now();
    const result = runWrapperSync("PreToolUse", "0", "true", {
      input: "{}",
      env,
    });
    const elapsed = performance.now() - start;
    strictEqual(result.status, 0);
    ok(elapsed < 1500, `elapsed=${elapsed}ms`);
  });

  it("leaves no scratch dir behind (with jq available)", () => {
    const logDir = makeTempDir();
    const tmpDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: { ...baseEnv(logDir), TMPDIR: tmpDir },
    });
    strictEqual(result.status, 0);
    sleepSync(3500);
    strictEqual(readdirSync(tmpDir).length, 0);
  });

  it("leaves no scratch dir behind (PATH without jq)", () => {
    const logDir = makeTempDir();
    const tmpDir = makeTempDir();
    const minimalPath = buildMinimalBinDir([
      "sh",
      "date",
      "cat",
      "mktemp",
      "wc",
      "tr",
      "rm",
      "mkdir",
      "mv",
    ]);
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: { CLAUDE_LOGS_DIR: logDir, TMPDIR: tmpDir, PATH: minimalPath },
    });
    strictEqual(result.status, 0);
    sleepSync(3500);
    strictEqual(readdirSync(tmpDir).length, 0);
  });

  it("leaves no scratch dir behind (unwritable CLAUDE_LOGS_DIR)", () => {
    const tmpDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: { ...baseEnv("/proc/nonexistent"), TMPDIR: tmpDir },
    });
    strictEqual(result.status, 0);
    sleepSync(3500);
    strictEqual(readdirSync(tmpDir).length, 0);
  });

  it("waits for a child that traps TERM before flushing stdout", async () => {
    const logDir = makeTempDir();
    const child = spawn(
      "sh",
      [
        wrapper,
        "PreToolUse",
        "0",
        'trap "echo bye; exit 0" TERM; sleep 5 & wait',
      ],
      { env: baseEnv(logDir) },
    );
    child.stdin.write("{}");
    child.stdin.end();

    let stdoutData = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => child.kill("SIGTERM"), 300);
      child.on("close", () => resolve());
    });
    ok(stdoutData.includes("bye"), stdoutData);
  });

  it("escalates to SIGKILL within 2s when the child ignores TERM", async () => {
    const logDir = makeTempDir();
    const child = spawn(
      "sh",
      [wrapper, "PreToolUse", "0", 'trap "" TERM; sleep 5'],
      { env: baseEnv(logDir) },
    );
    child.stdin.write("{}");
    child.stdin.end();

    const start = performance.now();
    const result = await new Promise<{ code: number | null }>((resolve) => {
      setTimeout(() => child.kill("SIGTERM"), 300);
      child.on("close", (code) => resolve({ code }));
    });
    const elapsed = performance.now() - start;
    strictEqual(result.code, 143);
    ok(elapsed < 2000, `elapsed=${elapsed}ms`);

    const record = pollForLastRecord(logDir);
    strictEqual(record.terminated, "TERM");
  });

  it("leaves the child's own status and stdout unchanged when CLAUDE_LOGS_DIR is unwritable", () => {
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: baseEnv("/proc/nonexistent"),
    });
    strictEqual(result.stdout, "hi\n");
    strictEqual(result.status, 0);
  });
});
