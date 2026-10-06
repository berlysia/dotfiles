import { ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  baseEnv,
  cleanupTempDirs,
  fakeBinDir,
  makeTempDir,
  pollForLastRecord,
  runWrapperSync,
  waitForFile,
  wrapper,
} from "../support/hook-timer-helpers.ts";

after(cleanupTempDirs);

describe("hook-timer.sh", () => {
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
});
