import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const wrapper = join(here, "..", "..", "executable_hook-timer.sh");

// Every temp dir is removed by the absolute path mkdtempSync returned.
const tempDirs: string[] = [];

/** Removes every dir makeTempDir created; register with after() in each test file. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hook-timer-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Blocks the current thread for `ms` without spawning a process. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A directory holding only symlinks to the named real binaries. */
export function buildMinimalBinDir(names: string[]): string {
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
export function fakeBinDir(name: string, body: string): string {
  const dir = makeTempDir();
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

export type HookTimingRecord = {
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

// Elapsed-time assertions use performance.now(): Date.now() follows the wall
// clock, which WSL2 time sync can step mid-test (seen as elapsed=3836ms for a
// test node itself timed at 1312ms).

/**
 * Resolves once `path` exists, polling every 10ms for up to `timeoutMs`.
 * The signal cases wait for a marker the child writes, so the kill timer
 * starts after the wrapper has taken start_ms and the child is running,
 * not after a wrapper startup whose length depends on load.
 */
export async function waitForFile(
  path: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`${path} did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Polls `<dir>/hook-timing.jsonl` for its last line, up to 3000ms at 50ms intervals. */
export function pollForLastRecord(
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
export function pollUntilEmpty(
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

export function runWrapperSync(
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

export function baseEnv(logDir: string): Record<string, string | undefined> {
  return { ...process.env, CLAUDE_LOGS_DIR: logDir };
}
