#!/usr/bin/env node --test

// hook-timer.sh wraps every command hook to record wall-clock timing (see
// hooks/README.md "Hook telemetry" and plan T1). Most cases here use
// spawnSync, mirroring run-guard.test.ts. The three signal-delivery cases
// need an async spawn + delayed kill(), since spawnSync cannot deliver a
// signal mid-execution.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
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
  source: string | null;
  prompt_id: string | null;
  terminated: string | null;
};

/**
 * Resolves once `path` exists, polling every 10ms for up to `timeoutMs`.
 * The signal cases wait for a marker the child writes, so the kill timer
 * starts after the wrapper has taken start_ms and the child is running,
 * not after a wrapper startup whose length depends on load.
 */
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`${path} did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

/**
 * Polls until `dir` is empty, up to `timeoutMs`, and returns what remains.
 * The wrapper creates its scratch dir before exiting and only the detached
 * recorder removes it, so "empty" can only be reached by the cleanup under test.
 */
function pollUntilEmpty(
  dir: string,
  timeoutMs = 3500,
  intervalMs = 50,
): string[] {
  const deadline = performance.now() + timeoutMs;
  let entries = readdirSync(dir);
  while (entries.length > 0 && performance.now() < deadline) {
    sleepSync(intervalMs);
    entries = readdirSync(dir);
  }
  return entries;
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
    strictEqual(record.source, null);
    strictEqual(record.prompt_id, null);
  });

  it("records exactly the 15-key schema and never leaks tool_input content", () => {
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
      "source",
      "prompt_id",
      "terminated",
    ].sort();
    strictEqual(Object.keys(record).sort().join(","), expectedKeys.join(","));
  });

  it("records source and prompt_id strings but never the prompt itself", () => {
    const logDir = makeTempDir();
    const input = JSON.stringify({
      session_id: "s4",
      source: "schedule_wakeup",
      prompt_id: "p4",
      prompt: "SECRET_PROMPT_Y",
    });
    runWrapperSync("UserPromptSubmit", "0", "exit 0", {
      input,
      env: baseEnv(logDir),
    });
    const record = pollForLastRecord(logDir);
    const rawLine =
      readFileSync(join(logDir, "hook-timing.jsonl"), "utf8")
        .trim()
        .split("\n")
        .pop() ?? "";
    strictEqual(record.source, "schedule_wakeup");
    strictEqual(record.prompt_id, "p4");
    ok(!rawLine.includes("SECRET_PROMPT_Y"), rawLine);
  });

  it("records null for object-valued source and prompt_id without leaking them", () => {
    const logDir = makeTempDir();
    const input = JSON.stringify({
      source: { x: "SECRET_OBJ_Z" },
      prompt_id: { y: "SECRET_OBJ_V" },
    });
    runWrapperSync("UserPromptSubmit", "0", "exit 0", {
      input,
      env: baseEnv(logDir),
    });
    const record = pollForLastRecord(logDir);
    const rawLine =
      readFileSync(join(logDir, "hook-timing.jsonl"), "utf8")
        .trim()
        .split("\n")
        .pop() ?? "";
    strictEqual(record.source, null);
    strictEqual(record.prompt_id, null);
    ok(!rawLine.includes("SECRET_OBJ_Z"), rawLine);
    ok(!rawLine.includes("SECRET_OBJ_V"), rawLine);
  });

  it("truncates source and prompt_id to 64 characters", () => {
    const logDir = makeTempDir();
    const input = JSON.stringify({
      source: "a".repeat(100),
      prompt_id: "b".repeat(100),
    });
    runWrapperSync("UserPromptSubmit", "0", "exit 0", {
      input,
      env: baseEnv(logDir),
    });
    const record = pollForLastRecord(logDir);
    strictEqual(record.source?.length, 64);
    strictEqual(record.prompt_id?.length, 64);
  });

  for (const nonObject of ["[]", '"x"', "123", "null"]) {
    it(`records null source/prompt_id and the full 15 keys for JSON input ${nonObject}`, () => {
      const logDir = makeTempDir();
      runWrapperSync("UserPromptSubmit", "0", "exit 0", {
        input: nonObject,
        env: baseEnv(logDir),
      });
      const record = pollForLastRecord(logDir);
      strictEqual(record.source, null);
      strictEqual(record.prompt_id, null);
      strictEqual(Object.keys(record).length, 15);
    });
  }

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
    const marker = join(makeTempDir(), "started");
    const child = spawn(
      "sh",
      [wrapper, "PreToolUse", "0", `touch '${marker}'; sleep 5`],
      { env: baseEnv(logDir) },
    );
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.write("{}");
    child.stdin.end();

    // The wrapper takes start_ms before it runs the child, so once the marker
    // exists, a kill 300ms later lands at least 300ms after start_ms however
    // long the wrapper took to start.
    await waitForFile(marker);
    setTimeout(() => child.kill("SIGTERM"), 300);
    const result = await closed;
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
    deepStrictEqual(pollUntilEmpty(tmpDir), []);
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
    deepStrictEqual(pollUntilEmpty(tmpDir), []);
  });

  it("leaves no scratch dir behind (unwritable CLAUDE_LOGS_DIR)", () => {
    const tmpDir = makeTempDir();
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: { ...baseEnv("/proc/nonexistent"), TMPDIR: tmpDir },
    });
    strictEqual(result.status, 0);
    deepStrictEqual(pollUntilEmpty(tmpDir), []);
  });

  it("waits for a child that traps TERM before flushing stdout", async () => {
    const logDir = makeTempDir();
    const marker = join(makeTempDir(), "trapped");
    const child = spawn(
      "sh",
      [
        wrapper,
        "PreToolUse",
        "0",
        `trap "echo bye; exit 0" TERM; touch '${marker}'; sleep 5 & wait`,
      ],
      { env: baseEnv(logDir) },
    );
    child.stdin.write("{}");
    child.stdin.end();

    let stdoutData = "";
    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    // Kill only after the trap is installed; a blind delay can land first.
    await waitForFile(marker);
    child.kill("SIGTERM");
    await closed;
    ok(stdoutData.includes("bye"), stdoutData);
  });

  it("escalates to SIGKILL after its 1s grace when the child ignores TERM", async () => {
    const logDir = makeTempDir();
    const marker = join(makeTempDir(), "trapped");
    const child = spawn(
      "sh",
      [wrapper, "PreToolUse", "0", `trap "" TERM; touch '${marker}'; sleep 5`],
      { env: baseEnv(logDir) },
    );
    const closed = new Promise<{ code: number | null }>((resolve) => {
      child.on("close", (code) => resolve({ code }));
    });
    child.stdin.write("{}");
    child.stdin.end();

    // Kill only after the child has ignored TERM; otherwise TERM could reach
    // it before the trap and end it without exercising the escalation.
    await waitForFile(marker);
    const killedAt = performance.now();
    child.kill("SIGTERM");
    const result = await closed;
    const elapsed = performance.now() - killedAt;
    strictEqual(result.code, 143);
    // The grace is 10 x `sleep 0.1`, so reaching SIGKILL takes at least 1s.
    // The upper bound only catches a wrapper that never escalates (the child
    // sleeps 5s); fork and exec delays under load stay well inside it.
    ok(elapsed >= 1000 && elapsed < 4000, `elapsed=${elapsed}ms`);

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
