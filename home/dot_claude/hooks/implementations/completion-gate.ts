#!/usr/bin/env -S bun run --silent

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getHomeDir } from "../lib/path-utils.ts";
import { defineHook } from "cc-hooks-ts";
import { logQuality } from "../lib/centralized-logging.ts";
import {
  checkTreeChange,
  computeTreeFingerprint,
  pruneStaleBaselines,
  saveBaseline,
} from "../lib/working-tree-fingerprint.ts";
import "../types/tool-schemas.ts";

/**
 * Stop hook that runs tests/typecheck before allowing completion.
 *
 * If the project has its own Stop hooks in .claude/settings.json,
 * this hook skips execution to avoid redundant test/typecheck runs.
 *
 * Uses a file-based retry counter (.tmp/.completion-gate-retries) to
 * prevent infinite loops. After MAX_RETRIES failures, switches to
 * warning-only mode.
 */

const MAX_RETRIES = 3;
const COUNTER_FILENAME = ".completion-gate-retries";
// Outside the project so the baseline itself never shows up as an untracked file.
function getBaselineStateDir(): string {
  return join(getHomeDir(), ".claude", "state", "completion-gate");
}
const BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getCounterPath(): string {
  const cwd = process.cwd();
  return join(cwd, ".tmp", COUNTER_FILENAME);
}

export type BlockReason = "failed" | "not-judged";

/**
 * The counter file holds `<count> <reason>`. The reason is only the last
 * block's, overwritten each time: the notice at the limit needs to say what
 * the final block was, not the history. A bare number (the old format) or an
 * unknown word reads as an unknown reason. Pure.
 */
export function parseCounterContent(content: string): {
  count: number;
  reason: BlockReason | undefined;
} {
  const [first = "", second] = content.trim().split(/\s+/);
  const count = Number.parseInt(first, 10);
  return {
    count: Number.isNaN(count) ? 0 : count,
    reason: second === "failed" || second === "not-judged" ? second : undefined,
  };
}

function readCounterState(): {
  count: number;
  reason: BlockReason | undefined;
} {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) {
      return parseCounterContent(readFileSync(counterPath, "utf-8"));
    }
  } catch {
    // ignore read errors
  }
  return { count: 0, reason: undefined };
}

function incrementRetryCount(reason: BlockReason): number {
  const counterPath = getCounterPath();
  const newCount = readCounterState().count + 1;
  try {
    const dir = dirname(counterPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(counterPath, `${newCount} ${reason}`, "utf-8");
  } catch {
    // ignore write errors
  }
  return newCount;
}

/**
 * Any check that failed on its own makes the block "failed". Only when every
 * check was cut off is it "not-judged": the notice at the limit must not call
 * a run unjudged when part of it showed a real problem. Pure.
 */
export function decideBlockReason(failures: CheckFailure[]): BlockReason {
  return failures.some((failure) => failure.kind === "failure")
    ? "failed"
    : "not-judged";
}

/** The user-facing notice for stopping without passing the checks. Pure. */
export function describeRetryLimit(reason: BlockReason | undefined): string {
  const base = `[completion-gate] Blocked ${MAX_RETRIES} times this turn; stopping without passing checks.`;
  if (reason === "not-judged") {
    return `${base} The last block was a timeout or output cut-off: the code was not judged.`;
  }
  if (reason === "failed") return `${base} The last block was a failing check.`;
  return base;
}

function resetRetryCount(): void {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) unlinkSync(counterPath);
  } catch {
    // ignore unlink errors
  }
}

function hasScript(scriptName: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return Boolean(pkg.scripts?.[scriptName]);
  } catch {
    return false;
  }
}

// Detect package manager from lockfile so commands like `typecheck` run via
// the same tool that installed node_modules. Mismatched PMs (e.g. running
// `pnpm` in a bun workspace) trigger destructive deps-status-check behavior.
function detectPackageManager(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    return "bun";
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return "pnpm";
}

/**
 * Check if the project's .claude/settings.json has its own Stop hooks.
 * If so, the project handles completion checks itself and this hook
 * should skip to avoid redundant execution.
 */
function projectHasStopHooks(): boolean {
  try {
    const settingsPath = join(process.cwd(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return false;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const stopHooks = settings?.hooks?.Stop;
    return Array.isArray(stopHooks) && stopHooks.length > 0;
  } catch {
    return false;
  }
}

// The hook test suite alone prints over 1 MiB, execSync's default maxBuffer.
// Past the limit execSync kills the child with ENOBUFS and a passing run
// reads as a failure, so leave ample room.
const CHECK_MAX_BUFFER = 64 * 1024 * 1024;

const DEFAULT_CHECK_TIMEOUT_MS = 120000;

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  return "";
}

/**
 * The text the gate shows for a failed check. A timeout is told apart from a
 * failure because the gate kills the run at the limit and the output so far
 * says nothing about whether the code is right: the model must not "fix" code
 * for it. Decided by `code`, never by the message, since a timed-out
 * spawnSync error can carry other words. Pure: importing this file runs nothing.
 */
export function describeCheckFailure(
  error: unknown,
  label: string,
  timeoutMs: number,
  maxBufferBytes: number = CHECK_MAX_BUFFER,
): string {
  const err = (typeof error === "object" && error !== null ? error : {}) as {
    stdout?: unknown;
    stderr?: unknown;
    code?: unknown;
  };
  if (err.code === "ENOBUFS") {
    return `${label} failed: output exceeded ${maxBufferBytes} bytes (ENOBUFS); the run was cut off, not judged`;
  }
  // stdout last: test runners print the failure summary at the end of stdout,
  // and the tail below would otherwise show only stderr.
  const output = (outputText(err.stderr) + outputText(err.stdout)).trim();
  const tail = output.split("\n").slice(-20).join("\n");
  if (err.code === "ETIMEDOUT") {
    return [
      `${label} timed out after ${timeoutMs / 1000} s: the run was cut off, not judged`,
      "This is not a code failure. Do not change code because of it. Check for machine load, then run the check once more. If it times out again, report that to the user instead of retrying.",
      "The gate stopped the run's process group. Only processes that left the group (setsid) can remain.",
      `Output until the cut-off (last 20 lines):\n${tail}`,
    ].join("\n");
  }
  return `${label} failed:\n${tail}`;
}

export type CheckFailureKind = "failure" | "timeout" | "output-limit";
export type CheckFailure = { kind: CheckFailureKind; text: string };

const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Runs a check in its own process group and returns null when it passes.
 * execSync is not used: its timeout kills only the shell, and the node/git
 * processes under `bun run test` kept running. The group is what lets the
 * gate stop them. `maxBufferBytes` is counted by hand because spawn has no
 * maxBuffer. Wrapping the command in GNU `timeout` was rejected: macOS ships
 * no `timeout`.
 */
export function runCheck(
  command: string,
  label: string,
  options: {
    timeoutMs?: number;
    maxBufferBytes?: number;
    killGraceMs?: number;
  } = {},
): Promise<CheckFailure | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? CHECK_MAX_BUFFER;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid === undefined) {
      // No pid means nothing to signal; a kill(-undefined) must never be sent.
      child.on("error", (error) => {
        resolve({
          kind: "failure",
          text: `${label} failed: could not start: ${error.message}`,
        });
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let cutoff: "timeout" | "output-limit" | null = null;
    let closed = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        // ESRCH: the group is already gone.
        return false;
      }
    };

    // The gate being stopped must take the group with it. No SIGTERM grace:
    // the harness stopping the gate wants it gone now, and the gate may be
    // SIGKILLed during a grace period, leaving the descendants behind.
    // process.exit is banned in hooks (no-process-exit lint). Leaving the
    // promise pending and setting process.exitCode was tried: under bun the
    // process then spins instead of exiting. Re-raising the signal with our
    // handlers removed ends the process by that signal, which is what the
    // caller sent in the first place (a shell reports it as 143 / 130).
    const stopWithSignal = (signal: NodeJS.Signals) => () => {
      signalGroup("SIGKILL");
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      process.kill(process.pid, signal);
    };
    const onSigterm = stopWithSignal("SIGTERM");
    const onSigint = stopWithSignal("SIGINT");
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);

    // A destroyed stream can still emit error; unhandled, it would crash the
    // hook and the outer catch would pass the gate with no verdict.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const finish = (result: CheckFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      process.off("SIGTERM", onSigterm);
      process.off("SIGINT", onSigint);
      resolve(result);
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (cutoff !== null) return;
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBufferBytes) startCutoff("output-limit");
    };
    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));

    function startCutoff(kind: "timeout" | "output-limit") {
      if (cutoff !== null || settled) return;
      cutoff = kind;
      signalGroup("SIGTERM");
      graceTimer = setTimeout(() => {
        // Not tied to the direct child: a shell that died on SIGTERM can leave
        // a descendant that ignores it.
        if (signalGroup(0)) signalGroup("SIGKILL");
        if (closed) return finish(cutoffResult());
        graceTimer = setTimeout(() => {
          // A descendant outside the group (setsid) may still hold the pipes,
          // so close never comes; give up waiting for it.
          child.stdout.destroy();
          child.stderr.destroy();
          finish(cutoffResult());
        }, killGraceMs);
      }, killGraceMs);
    }

    const output = () => ({
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks),
    });

    function cutoffResult(): CheckFailure {
      if (cutoff === "output-limit") {
        return {
          kind: "output-limit",
          text: describeCheckFailure(
            { code: "ENOBUFS" },
            label,
            timeoutMs,
            maxBufferBytes,
          ),
        };
      }
      return {
        kind: "timeout",
        text: describeCheckFailure(
          { code: "ETIMEDOUT", ...output() },
          label,
          timeoutMs,
        ),
      };
    }

    // Kept until close: a descendant still holding the pipes after the direct
    // child exited means the run is not over and cannot be judged.
    timeoutTimer = setTimeout(() => startCutoff("timeout"), timeoutMs);

    child.on("error", (error) => {
      finish({
        kind: "failure",
        text: `${label} failed: could not start: ${error.message}`,
      });
    });
    child.on("close", (code, signal) => {
      closed = true;
      // Not finished here: close only means nobody holds the gate's pipes. A
      // SIGTERM-ignoring descendant writing elsewhere (a test file under
      // `node --test` writes to the runner) is still in the group and waits
      // for the SIGKILL after the grace period.
      if (cutoff !== null) return;
      if (code === 0) return finish(null);
      finish({
        kind: "failure",
        text: describeCheckFailure(
          { status: code, signal, ...output() },
          label,
          timeoutMs,
        ),
      });
    });
  });
}

const hook = defineHook({
  trigger: { Stop: true, UserPromptSubmit: true },
  run: async (context) => {
    try {
      // 新しいユーザー入力 = 新しいターン。カウンタを reset しないと
      // 一度 MAX に到達した時点で永続無効化される。
      if (context.input.hook_event_name === "UserPromptSubmit") {
        resetRetryCount();
        pruneStaleBaselines(getBaselineStateDir(), BASELINE_MAX_AGE_MS);
        saveBaseline(
          getBaselineStateDir(),
          context.input.session_id,
          computeTreeFingerprint(process.cwd()),
        );
        return context.success({});
      }

      if (projectHasStopHooks()) {
        console.error(
          "[completion-gate] Project has its own Stop hooks. Skipping to avoid redundant execution.",
        );
        return context.success({});
      }

      const { session_id } = context.input;
      const { count: retryCount, reason: lastReason } = readCounterState();

      if (retryCount >= MAX_RETRIES) {
        console.error(
          `[completion-gate] Max retries (${MAX_RETRIES}) reached. Allowing completion with warning.`,
        );
        // Stderr is not shown to the user on Stop; the notice must be.
        return context.json({
          event: "Stop",
          output: { systemMessage: describeRetryLimit(lastReason) },
        });
      }

      const treeChange = checkTreeChange(
        getBaselineStateDir(),
        session_id,
        process.cwd(),
      );
      if (treeChange.state === "unchanged") {
        console.error(
          "[completion-gate] No working-tree change since the prompt. Skipping checks.",
        );
        return context.success({});
      }
      if (treeChange.state === "unknown") {
        console.error(
          `[completion-gate] Tree change unknown (${treeChange.reason}). Running checks.`,
        );
      }

      const failures: CheckFailure[] = [];
      const pm = detectPackageManager();

      if (hasScript("typecheck")) {
        const result = await runCheck(`${pm} run typecheck`, "typecheck");
        if (result) {
          failures.push(result);
          logQuality("completion-gate", "typecheck", result.text, session_id);
        }
      }

      if (hasScript("test")) {
        const result = await runCheck(`${pm} run test`, "test");
        if (result) {
          failures.push(result);
          logQuality("completion-gate", "test", result.text, session_id);
        }
      }

      if (failures.length === 0) {
        return context.success({});
      }

      const count = incrementRetryCount(decideBlockReason(failures));
      const remaining = MAX_RETRIES - count;

      return context.json({
        event: "Stop",
        output: {
          decision: "block" as const,
          reason: `COMPLETION BLOCKED (attempt ${count}/${MAX_RETRIES}, ${remaining} remaining):\n\n${failures.map((failure) => failure.text).join("\n\n")}\n\nFix these issues before completing.`,
        },
      });
    } catch (error) {
      console.error(`[completion-gate] Error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
