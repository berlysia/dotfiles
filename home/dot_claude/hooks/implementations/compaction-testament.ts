#!/usr/bin/env -S bun run --silent

/**
 * Compaction testament: before an auto-compact, ask the model to write a
 * hand-over note (PostToolUse / Stop), snapshot machine-known state
 * (PreCompact), and feed both back as reference data afterwards
 * (SessionStart(compact)). Decisions live in lib/compaction-testament.ts; this
 * file owns every side effect (transcript reads, settings, state files, git).
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { getHomeDir } from "../lib/path-utils.ts";
import { defineHook } from "cc-hooks-ts";
import {
  buildRestoreContext,
  buildSnapshot,
  buildTestamentRequest,
  decidePostToolUse,
  decideStop,
  extractRecentUserUtterances,
  getThresholds,
  isWrittenThisCycle,
  parseState,
  parseTokenCount,
  parseWrittenRecord,
  readContextTokens,
  resolveCompactAt,
  updateUsageHealth,
  USAGE_MISS_NOTIFY_STREAK,
  type RequestKind,
  type TestamentState,
  type Thresholds,
  type TokenReading,
} from "../lib/compaction-testament.ts";
import { logEvent } from "../lib/centralized-logging.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { COMPACTION_EXTRA_PATTERNS, sanitize } from "../lib/redact-secrets.ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import "../types/tool-schemas.ts";

// Widening tail windows: a single huge tool result can push the newest usage
// entry far from the end, but the common case must stay a cheap small read.
const TAIL_WINDOWS = [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
const UTTERANCE_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_TESTAMENT_BYTES = 64 * 1024;
const MAX_SMALL_FILE_BYTES = 64 * 1024;
const GIT_TIMEOUT_MS = 2000;
const GIT_STATUS_MAX_LINES = 40;
const SNAPSHOT_UTTERANCES = 5;

const TESTAMENT_FILE = "testament.md";
const WRITTEN_FILE = "testament-written.json";
const STATE_FILE = "testament-state.json";
const SNAPSHOT_FILE = "snapshot.md";

type WorkflowPaths = {
  wfDir: string;
  testament: string;
  written: string;
  state: string;
  snapshot: string;
};

// --- fs primitives ---------------------------------------------------------

/** O_NOFOLLOW + fstat so a swapped-in symlink or device is never read. */
function readRegularFile(path: string, maxBytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readSmallText(path: string): string | null {
  return readRegularFile(path, MAX_SMALL_FILE_BYTES)?.toString("utf8") ?? null;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone or not removable; callers tolerate both.
  }
}

/** tmp + rename so readers never see a partial file and a symlink at `path` is replaced, not followed. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(
      tmp,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeSync(fd, content);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    removeQuietly(tmp);
    throw error;
  }
}

function writeStateIfChanged(
  paths: WorkflowPaths,
  before: TestamentState,
  after: TestamentState,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  mkdirSync(paths.wfDir, { recursive: true });
  writeFileAtomic(paths.state, JSON.stringify(after));
}

// --- transcript ------------------------------------------------------------

function readTailBuffer(
  path: string,
  window: number,
): {
  text: string;
  wholeFile: boolean;
} | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - window);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(
        fd,
        buffer,
        offset,
        buffer.length - offset,
        start + offset,
      );
      if (n === 0) break;
      offset += n;
    }
    let body = buffer.subarray(0, offset);
    if (start > 0) {
      // Drop the cut-off first line at byte level: decoding first could
      // turn a split multi-byte sequence into replacement characters.
      const newline = body.indexOf(0x0a);
      body =
        newline === -1
          ? body.subarray(body.length)
          : body.subarray(newline + 1);
    }
    return { text: body.toString("utf8"), wholeFile: start === 0 };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readUsage(transcriptPath: string): {
  reading: TokenReading;
  exhausted: boolean;
} {
  for (const window of TAIL_WINDOWS) {
    const tail = readTailBuffer(transcriptPath, window);
    // An unreadable transcript says nothing about the format, so it is not
    // counted toward the degradation streak.
    if (tail === null) {
      return {
        reading: { kind: "none", reason: "no-entry" },
        exhausted: false,
      };
    }
    const reading = readContextTokens(tail.text);
    if (reading.kind === "tokens" || reading.reason === "after-compact") {
      return { reading, exhausted: false };
    }
    if (tail.wholeFile) return { reading, exhausted: true };
  }
  return { reading: { kind: "none", reason: "no-entry" }, exhausted: true };
}

// --- environment -----------------------------------------------------------

function getWorkingDirectory(inputCwd: string | undefined): string {
  return process.env["CLAUDE_TEST_CWD"] || inputCwd || process.cwd();
}

function getThresholdsFromEnvironment(): Thresholds {
  let settings: unknown = null;
  // Settings are only consulted when the env value does not already decide.
  if (
    parseTokenCount(process.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) === null
  ) {
    const configDir =
      process.env["CLAUDE_CONFIG_DIR"] || join(getHomeDir(), ".claude");
    const text = readSmallText(join(configDir, "settings.json"));
    if (text !== null) {
      try {
        settings = JSON.parse(text);
      } catch {
        settings = null;
      }
    }
  }
  return getThresholds(resolveCompactAt(process.env, settings));
}

function resolvePaths(cwd: string, sessionId: string): WorkflowPaths | null {
  const resolution = resolveWorkflowDir({ cwd, sessionId });
  if (
    resolution.source === "unresolvable" ||
    resolution.source === "env-rejected"
  ) {
    return null;
  }
  const wfDir = resolution.dir;
  return {
    wfDir,
    testament: join(wfDir, TESTAMENT_FILE),
    written: join(wfDir, WRITTEN_FILE),
    state: join(wfDir, STATE_FILE),
    snapshot: join(wfDir, SNAPSHOT_FILE),
  };
}

// --- testament write detection (K7) ----------------------------------------

function isTestamentWrite(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  paths: WorkflowPaths,
): boolean {
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit") {
    return false;
  }
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const filePath = (toolInput as Record<string, unknown>)["file_path"];
  if (typeof filePath !== "string" || filePath === "") return false;
  let realWfDir: string;
  try {
    // realpathInsideWorkflowDir compares against the wfDir as spelled, so
    // an aliased path (macOS /var -> /private/var) never matches unless wfDir
    // is resolved first.
    realWfDir = realpathSync(paths.wfDir);
  } catch {
    return false;
  }
  const written = realpathInsideWorkflowDir(resolve(cwd, filePath), realWfDir);
  const expected = realpathInsideWorkflowDir(paths.testament, realWfDir);
  return written !== null && expected !== null && written === expected;
}

function recordTestamentWrite(
  paths: WorkflowPaths,
  tokens: number | null,
): void {
  const body = readRegularFile(paths.testament, MAX_TESTAMENT_BYTES);
  if (body === null) return;
  const sha256 = createHash("sha256").update(body).digest("hex");
  writeFileAtomic(
    paths.written,
    JSON.stringify({ version: 1, sha256, tokens }),
  );
}

// --- health notification (K9) ----------------------------------------------

function buildDegradedMessage(sessionId: string): string {
  const message = [
    `compaction-testament: transcript から使用量を ${USAGE_MISS_NOTIFY_STREAK} 回連続で読めなかった。遺言の自動依頼は止まっている（PreCompact のスナップショットは動く）。`,
    "recovery: transcript の形式が変わった可能性。tests/__fixtures__/compaction-testament-transcript.jsonl を実物に合わせて更新し、lib の解析を直す",
  ].join("\n");
  logEvent("Error", sessionId, message);
  return message;
}

// --- event handlers (plain data in, plain data out) ------------------------

type PostToolUseResult = { additionalContext?: string; systemMessage?: string };

function handlePostToolUse(input: {
  sessionId: string;
  projectDir: string;
  toolCwd: string;
  transcriptPath: string;
  toolName: string;
  toolInput: unknown;
}): PostToolUseResult {
  const paths = resolvePaths(input.projectDir, input.sessionId);
  if (paths === null) return {};

  const { reading, exhausted } = readUsage(input.transcriptPath);
  const stateBefore = parseState(readSmallText(paths.state));
  const health = updateUsageHealth(stateBefore, reading, exhausted);
  const tokens = reading.kind === "tokens" ? reading.value : null;

  if (isTestamentWrite(input.toolName, input.toolInput, input.toolCwd, paths)) {
    recordTestamentWrite(paths, tokens);
  }

  let stateAfter = health.next;
  let additionalContext: string | undefined;
  if (tokens !== null) {
    const th = getThresholdsFromEnvironment();
    const record = parseWrittenRecord(readSmallText(paths.written));
    const decision = decidePostToolUse(
      tokens,
      th,
      health.next,
      isWrittenThisCycle(record, th),
    );
    if (decision.dropRecord) removeQuietly(paths.written);
    stateAfter = decision.next;
    if (decision.request !== null) {
      additionalContext = buildTestamentRequest({
        kind: decision.request satisfies RequestKind,
        testamentPath: paths.testament,
      });
    }
  }
  writeStateIfChanged(paths, stateBefore, stateAfter);

  const result: PostToolUseResult = {};
  if (additionalContext !== undefined)
    result.additionalContext = additionalContext;
  if (health.notify)
    result.systemMessage = buildDegradedMessage(input.sessionId);
  return result;
}

type StopResult = { reason?: string; systemMessage?: string };

function handleStop(input: {
  sessionId: string;
  projectDir: string;
  transcriptPath: string;
  stopHookActive: boolean;
}): StopResult {
  const paths = resolvePaths(input.projectDir, input.sessionId);
  if (paths === null) return {};

  const { reading, exhausted } = readUsage(input.transcriptPath);
  const stateBefore = parseState(readSmallText(paths.state));
  const health = updateUsageHealth(stateBefore, reading, exhausted);
  const tokens = reading.kind === "tokens" ? reading.value : null;

  const th = tokens === null ? null : getThresholdsFromEnvironment();
  const record = parseWrittenRecord(readSmallText(paths.written));
  const decision = decideStop({
    tokens,
    th: th ?? { triggerAt: Infinity, updateAt: Infinity },
    state: health.next,
    writtenThisCycle: th === null ? false : isWrittenThisCycle(record, th),
    stopHookActive: input.stopHookActive,
  });
  if (decision.dropRecord) removeQuietly(paths.written);
  writeStateIfChanged(paths, stateBefore, decision.next);

  const result: StopResult = {};
  if (decision.block && tokens !== null && th !== null) {
    result.reason = buildTestamentRequest({
      kind: tokens >= th.updateAt ? "write-urgent" : "write",
      testamentPath: paths.testament,
    });
  }
  if (health.notify)
    result.systemMessage = buildDegradedMessage(input.sessionId);
  return result;
}

// K8: git is only ever spawned with array args, no shell, a short timeout and
// no optional locks, so the hook cannot hang or be steered by repo content.
function runGit(
  cwd: string,
  args: string[],
):
  | { ok: true; stdout: string }
  | { ok: false; status: number | null; stderr: string } {
  try {
    const stdout = execFileSync(
      "git",
      ["-c", "core.fsmonitor=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
    );
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { status?: number | null; stderr?: unknown };
    return {
      ok: false,
      status: typeof err.status === "number" ? err.status : null,
      stderr:
        typeof err.stderr === "string" ? err.stderr : String(err.stderr ?? ""),
    };
  }
}

type GitContext = {
  /** True when snapshot content may include sensitive-ish text (ignored or outside any repo). */
  safeToWriteDetails: boolean;
  insideRepo: boolean;
};

function classifyGit(cwd: string, snapshotPath: string): GitContext {
  const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.ok) {
    const ignored = runGit(cwd, ["check-ignore", "-q", snapshotPath]);
    return { safeToWriteDetails: ignored.ok, insideRepo: true };
  }
  if (inside.status === 128 && inside.stderr.includes("not a git repository")) {
    return { safeToWriteDetails: true, insideRepo: false };
  }
  // Anything else (broken repo, timeout, spawn failure) is "not ignored".
  return { safeToWriteDetails: false, insideRepo: false };
}

function redact(text: string): string {
  return sanitize(text, COMPACTION_EXTRA_PATTERNS).text;
}

function collectWorkflowStatus(wfDir: string): string[] {
  const lines: string[] = [];
  let names: string[];
  try {
    names = readdirSync(wfDir)
      .filter((n) => /^(?:spec|plan|plan-\d+)\.md$/.test(n))
      .sort();
  } catch {
    return lines;
  }
  for (const name of names) {
    const text = readSmallText(join(wfDir, name));
    if (text === null) continue;
    const parts: string[] = [];
    for (const label of ["Plan", "Review", "Approval"]) {
      const m = new RegExp(`^- ${label} Status:\\s*(.+)$`, "m").exec(text);
      if (m?.[1] !== undefined) parts.push(`${label}=${m[1].trim()}`);
    }
    lines.push(
      redact(`${name}: ${parts.length > 0 ? parts.join(", ") : "(no status)"}`),
    );
  }
  return lines;
}

function handlePreCompact(input: {
  sessionId: string;
  projectDir: string;
  transcriptPath: string;
  trigger: string;
  customInstructions: string | null;
}): void {
  const paths = resolvePaths(input.projectDir, input.sessionId);
  if (paths === null) return;
  mkdirSync(paths.wfDir, { recursive: true });
  // git must see the same spelling it resolves the repo with.
  const realSnapshot = join(realpathSync(paths.wfDir), SNAPSHOT_FILE);
  const git = classifyGit(input.projectDir, realSnapshot);

  let gitBranch: string | null = null;
  let gitStatus: string | null = null;
  if (git.insideRepo) {
    const branch = runGit(input.projectDir, ["branch", "--show-current"]);
    if (branch.ok) gitBranch = redact(branch.stdout.trim()) || null;
    if (git.safeToWriteDetails) {
      const status = runGit(input.projectDir, ["status", "--short"]);
      if (status.ok) {
        gitStatus = redact(
          status.stdout
            .split("\n")
            .slice(0, GIT_STATUS_MAX_LINES)
            .join("\n")
            .trim(),
        );
      }
    }
  }

  let utterances: string[] = [];
  if (git.safeToWriteDetails) {
    const tail = readTailBuffer(input.transcriptPath, UTTERANCE_TAIL_BYTES);
    if (tail !== null) {
      utterances = extractRecentUserUtterances(
        tail.text,
        SNAPSHOT_UTTERANCES,
      ).map(redact);
    }
  }

  const snapshot = buildSnapshot({
    at: new Date().toISOString(),
    trigger: input.trigger,
    ignored: git.safeToWriteDetails,
    customInstructions:
      input.customInstructions === null
        ? null
        : redact(input.customInstructions),
    utterances,
    gitBranch,
    gitStatus,
    workflowStatus: collectWorkflowStatus(paths.wfDir),
  });

  removeQuietly(paths.snapshot);
  const fd = openSync(
    paths.snapshot,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, snapshot);
  } finally {
    closeSync(fd);
  }
}

function handleSessionStartCompact(input: {
  sessionId: string;
  projectDir: string;
}): string | null {
  const paths = resolvePaths(input.projectDir, input.sessionId);
  if (paths === null) return null;

  // Single read: size check, hash and the injected text all come from this
  // buffer, so a swap between check and use cannot inject unverified bytes.
  const body = readRegularFile(paths.testament, MAX_TESTAMENT_BYTES);
  const record = parseWrittenRecord(readSmallText(paths.written));
  const verified =
    body !== null &&
    record !== null &&
    createHash("sha256").update(body).digest("hex") === record.sha256;
  const snapshot = readSmallText(paths.snapshot);

  const context = buildRestoreContext({
    snapshot,
    testament: verified && body !== null ? body.toString("utf8") : null,
    testamentTokens: verified && record !== null ? record.tokens : null,
    testamentPath: paths.testament,
    snapshotPath: paths.snapshot,
  });

  // Deletion order keeps leftovers consistent if we die midway; failures are
  // swallowed because the output above is already decided.
  removeQuietly(paths.written);
  removeQuietly(paths.snapshot);
  try {
    if (readSmallText(paths.state) !== null) {
      writeFileAtomic(paths.state, JSON.stringify(parseState(null)));
    }
  } catch {
    // Stale state is harmless: the next below-threshold reading resets it.
  }
  return context;
}

// --- hook ------------------------------------------------------------------

function hasAgentId(input: object): boolean {
  const value = (input as { agent_id?: unknown }).agent_id;
  return typeof value === "string" && value !== "";
}

const hook = defineHook({
  trigger: {
    PostToolUse: true,
    Stop: true,
    PreCompact: true,
    SessionStart: true,
  },
  run: (context) => {
    try {
      const input = context.input;
      if (hasAgentId(input)) return context.success({});
      const projectDir = getProjectRoot(input.cwd);

      if (input.hook_event_name === "PostToolUse") {
        const result = handlePostToolUse({
          sessionId: input.session_id,
          projectDir,
          toolCwd: getWorkingDirectory(input.cwd),
          transcriptPath: input.transcript_path,
          toolName: input.tool_name,
          toolInput: input.tool_input,
        });
        if (
          result.additionalContext === undefined &&
          result.systemMessage === undefined
        ) {
          return context.success({});
        }
        return context.json({
          event: "PostToolUse",
          output: {
            ...(result.additionalContext !== undefined
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PostToolUse" as const,
                    additionalContext: result.additionalContext,
                  },
                }
              : {}),
            ...(result.systemMessage !== undefined
              ? { systemMessage: result.systemMessage }
              : {}),
          },
        });
      }

      if (input.hook_event_name === "Stop") {
        const result = handleStop({
          sessionId: input.session_id,
          projectDir,
          transcriptPath: input.transcript_path,
          stopHookActive: input.stop_hook_active === true,
        });
        if (result.reason === undefined && result.systemMessage === undefined) {
          return context.success({});
        }
        return context.json({
          event: "Stop",
          output: {
            ...(result.reason !== undefined
              ? { decision: "block" as const, reason: result.reason }
              : {}),
            ...(result.systemMessage !== undefined
              ? { systemMessage: result.systemMessage }
              : {}),
          },
        });
      }

      if (input.hook_event_name === "PreCompact") {
        handlePreCompact({
          sessionId: input.session_id,
          projectDir,
          transcriptPath: input.transcript_path,
          trigger: input.trigger,
          customInstructions: input.custom_instructions ?? null,
        });
        return context.success({});
      }

      if (
        input.hook_event_name === "SessionStart" &&
        input.source === "compact"
      ) {
        const additionalContext = handleSessionStartCompact({
          sessionId: input.session_id,
          projectDir,
        });
        if (additionalContext === null) return context.success({});
        return context.json({
          event: "SessionStart",
          output: {
            hookSpecificOutput: {
              hookEventName: "SessionStart" as const,
              additionalContext,
            },
          },
        });
      }

      return context.success({});
    } catch (error) {
      // Never echo transcript or utterance fragments: error text can embed them.
      const code = (error as { code?: unknown })?.code;
      console.error(
        `[compaction-testament] error: ${error instanceof Error ? error.name : "unknown"}${typeof code === "string" ? ` (${code})` : ""}`,
      );
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
