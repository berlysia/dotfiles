#!/usr/bin/env node --test

// hook-timer.sh wraps every command hook to record wall-clock timing (see
// hooks/README.md "Hook telemetry" and plan T1). Most cases here use
// spawnSync, mirroring run-guard.test.ts. The three signal-delivery cases
// need an async spawn + delayed kill(), since spawnSync cannot deliver a
// signal mid-execution.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  baseEnv,
  buildMinimalBinDir,
  cleanupTempDirs,
  makeTempDir,
  pollForLastRecord,
  pollUntilEmpty,
  runWrapperSync,
  waitForFile,
  wrapper,
} from "../support/hook-timer-helpers.ts";

after(cleanupTempDirs);

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

  it("leaves the child's own status and stdout unchanged when CLAUDE_LOGS_DIR is unwritable", () => {
    const result = runWrapperSync("PreToolUse", "0", "echo hi", {
      input: "{}",
      env: baseEnv("/proc/nonexistent"),
    });
    strictEqual(result.stdout, "hi\n");
    strictEqual(result.status, 0);
  });
});
