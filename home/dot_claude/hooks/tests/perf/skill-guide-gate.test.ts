#!/usr/bin/env node --test

import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const HOOK = join(
  import.meta.dirname,
  "../../implementations/skill-guide-gate.ts",
);
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Kept out of tests/unit: it waits for the real 2000 ms watchdog and bounds
// the wall-clock time, which the unit layout rule forbids.
describe("skill-guide-gate.ts watchdog", () => {
  it("exits 0 with empty stdout after the watchdog when stdin remains open", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "skill-guide-perf-")));
    dirs.push(home);
    const startedAt = performance.now();
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [HOOK], {
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          CLAUDE_LOGS_DIR: join(home, "logs"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
    const elapsedMs = performance.now() - startedAt;
    strictEqual(result.code, 0, result.stderr);
    strictEqual(result.stdout, "");
    ok(elapsedMs >= 1800 && elapsedMs < 3000, `${elapsedMs} ms`);
  });
});
