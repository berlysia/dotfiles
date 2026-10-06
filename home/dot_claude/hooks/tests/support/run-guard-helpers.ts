import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const wrapper = join(here, "..", "..", "executable_run-guard.sh");
export const throwingHook = join(
  here,
  "..",
  "__fixtures__",
  "throwing-guard-hook.ts",
);

// Every temp dir is removed by the absolute path mkdtempSync returned.
const tempDirs: string[] = [];

/** Removes every dir makeTempDir created; register with after() in each test file. */
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "run-guard-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A directory holding a fake `bun` executable with the given sh body. */
export function fakeBunDir(body: string): string {
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
export function isGone(pid: number): boolean {
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();
  return stat === "" || stat.startsWith("Z");
}

export function runWrapper(
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
