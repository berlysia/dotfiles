#!/usr/bin/env -S bun run --silent

/**
 * Sends an AskUserQuestion back once per user input, with a checklist, so the
 * model can tell whether it needs to ask at all. The bounce is a deny, which
 * only stops: nothing is approved by it, so the trust root of ADR-0023 (a
 * user's choice) is untouched. See docs/decisions/0044-*.md.
 *
 * One definition serves PreToolUse(AskUserQuestion), which bounces and
 * records, and UserPromptSubmit, which clears the bounce mark and, once, tells
 * the user how the bounces fared.
 *
 * It is registered without run-guard.sh and without `|| exit 2`: a failure
 * here must let the question through, never stop it. It also does not use
 * cc-hooks-ts's runHook, which exits 1 on input it cannot parse; this entry
 * exits 0 with nothing on stdout for everything except a bounce or the
 * one-time notice. Passing means printing nothing: an explicit `allow` or
 * `ask` would override the permission rules and document-workflow-guard.
 */

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  buildNotificationMessage,
  DECISIONS_MAX_BYTES,
  type DecisionRow,
  formatDecisionRow,
  judgeAskPreflight,
  NOTIFY_AT_BOUNCES,
  parseDecisionRows,
  type PreflightVerdict,
  PREFLIGHT_REASON,
  questionHash,
  summarizeDecisions,
} from "../lib/ask-preflight.ts";
import { logDecision, logEvent } from "../lib/centralized-logging.ts";
import {
  hasMarker as hasSignFailureMarker,
  signFailureMarkerDir,
} from "../lib/commit-sign-failure.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";
import { isSafeSessionId } from "../lib/session-id.ts";
import {
  createMarker,
  readMarker,
  removeMarker,
} from "../lib/session-marker.ts";
import { listApprovalCandidates } from "../lib/workflow-gate.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;
const HOUR_MS = 60 * 60 * 1000;
const BOUNCE_LIFETIME_MS = HOUR_MS;
const SWEEP_AFTER_MS = 24 * HOUR_MS;
const LOG_TAG = "[ask-preflight]";

export interface AskPreflightDeps {
  stateDir: string;
  signFailureMarkerDir: string;
  hasApprovalCandidates: (sessionId: string) => boolean;
  now: () => Date;
}

function defaultStateDir(): string {
  return (
    process.env["ASK_PREFLIGHT_STATE_DIR"] ||
    join(getHomeDir(), ".claude", "state", "ask-preflight")
  );
}

/** Never creates the workflow dir: a project that does not use the workflow has none. */
function defaultHasApprovalCandidates(sessionId: string): boolean {
  const projectRoot = getProjectRoot();
  const resolution = resolveWorkflowDir({ cwd: projectRoot, sessionId });
  if (resolution.source === "unresolvable") return false;
  return listApprovalCandidates(resolution.dir, projectRoot).length > 0;
}

function defaultDeps(): AskPreflightDeps {
  return {
    stateDir: defaultStateDir(),
    signFailureMarkerDir: signFailureMarkerDir(),
    hasApprovalCandidates: defaultHasApprovalCandidates,
    now: () => new Date(),
  };
}

// Logging, recording and counting are side channels: a failure in any of them
// must not change what the hook decides or prints.
function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // intentionally empty
  }
}

function logFailure(sessionId: string | undefined, what: string): void {
  quietly(() => logEvent("Error", sessionId, `${LOG_TAG} ${what}`));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const bounceDir = (deps: AskPreflightDeps) => join(deps.stateDir, "bounce");
const saltDir = (deps: AskPreflightDeps) => join(deps.stateDir, "salt");
const notifiedDir = (deps: AskPreflightDeps) => join(deps.stateDir, "notified");
const decisionsPath = (deps: AskPreflightDeps) =>
  join(deps.stateDir, "decisions.jsonl");

function isNotified(deps: AskPreflightDeps): boolean {
  return readMarker(notifiedDir(deps), "done") !== null;
}

/** null when no salt could be read or made; the caller then keeps the row out of decisions.jsonl. */
function sessionSalt(deps: AskPreflightDeps, sessionId: string): string | null {
  const existing = readMarker(saltDir(deps), sessionId);
  if (existing !== null && existing !== "") return existing;
  createMarker({
    dir: saltDir(deps),
    name: sessionId,
    maxAgeMs: null,
    sweepAfterMs: SWEEP_AFTER_MS,
    content: randomBytes(16).toString("hex"),
    now: deps.now(),
  });
  const made = readMarker(saltDir(deps), sessionId);
  return made === null || made === "" ? null : made;
}

/** One append of one line; skipped once notified or once the file is over its cap. */
function appendRow(deps: AskPreflightDeps, row: DecisionRow): void {
  try {
    if (isNotified(deps)) return;
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    const path = decisionsPath(deps);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // not created yet
    }
    if (size > DECISIONS_MAX_BYTES) return;
    appendFileSync(path, formatDecisionRow(row), { mode: 0o600 });
  } catch {
    logFailure(row.sessionId, "could not append to decisions.jsonl");
  }
}

function readDecisionRows(deps: AskPreflightDeps): DecisionRow[] {
  let fd: number;
  try {
    fd = openSync(decisionsPath(deps), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const buffer = Buffer.alloc(DECISIONS_MAX_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return parseDecisionRows(buffer.subarray(0, read).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function denyOutput() {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: PREFLIGHT_REASON,
    },
  };
}

function handleAsk(
  root: Record<string, unknown>,
  deps: AskPreflightDeps,
): object | null {
  if (root["tool_name"] !== "AskUserQuestion") return null;
  if (root["agent_id"]) return null;
  const sessionId = root["session_id"];
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) return null;
  const toolInput = root["tool_input"];

  let verdict: PreflightVerdict;
  try {
    verdict = judgeAskPreflight({
      toolInput,
      hasAgentId: false,
      hasApprovalCandidates: deps.hasApprovalCandidates(sessionId),
      hasSignFailureMarker: hasSignFailureMarker(
        deps.signFailureMarkerDir,
        sessionId,
        deps.now(),
      ),
    });
  } catch {
    verdict = { kind: "pass", reason: "judge-failed" };
  }

  let hash: string | undefined;
  let salted = false;
  quietly(() => {
    const salt = sessionSalt(deps, sessionId);
    if (salt === null) return;
    salted = true;
    hash = questionHash(toolInput, salt) ?? undefined;
  });
  const at = deps.now().toISOString();
  const record = (kind: "bounce" | "pass", reason: string) => {
    if (!salted) return;
    appendRow(deps, {
      at,
      sessionId,
      kind,
      reason,
      ...(hash === undefined ? {} : { hash }),
    });
  };
  const pass = (reason: string) => {
    quietly(() =>
      logDecision("AskUserQuestion", "pass", `${LOG_TAG} ${reason}`, sessionId),
    );
    record("pass", reason);
    return null;
  };

  if (verdict.kind === "pass") return pass(verdict.reason);

  const created = createMarker({
    dir: bounceDir(deps),
    name: sessionId,
    maxAgeMs: BOUNCE_LIFETIME_MS,
    sweepAfterMs: SWEEP_AFTER_MS,
    now: deps.now(),
  });
  if (!created) return pass("already-bounced");

  quietly(() =>
    logDecision("AskUserQuestion", "deny", `${LOG_TAG} bounce`, sessionId),
  );
  record("bounce", "preflight");
  return denyOutput();
}

function handlePrompt(
  root: Record<string, unknown>,
  deps: AskPreflightDeps,
): object | null {
  const sessionId = root["session_id"];
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) return null;

  const cleared = removeMarker(bounceDir(deps), sessionId);
  quietly(() =>
    logEvent(
      cleared ? "UserPromptSubmit" : "Error",
      sessionId,
      `${LOG_TAG} prompt branch ran; bounce mark cleared=${cleared}`,
    ),
  );
  if (isNotified(deps)) return null;

  // Read before this prompt's own row goes in, so that "no prompt row after
  // the recent bounces" can still tell a missing registration from a working one.
  let summary: ReturnType<typeof summarizeDecisions> | null = null;
  try {
    summary = summarizeDecisions(readDecisionRows(deps));
  } catch {
    logFailure(sessionId, "could not summarize decisions.jsonl");
  }
  appendRow(deps, {
    at: deps.now().toISOString(),
    sessionId,
    kind: "prompt",
  });

  if (summary === null || summary.bounces < NOTIFY_AT_BOUNCES) return null;
  const mayNotify = createMarker({
    dir: notifiedDir(deps),
    name: "done",
    maxAgeMs: null,
    now: deps.now(),
  });
  if (!mayNotify) return null;
  try {
    return { systemMessage: buildNotificationMessage(summary) };
  } catch {
    logFailure(sessionId, "could not build the notification");
    return null;
  }
}

/** The JSON to print on stdout, or null to print nothing. Never throws. */
export function run(input: unknown, deps: AskPreflightDeps): object | null {
  try {
    const root = asRecord(input);
    if (root === null) return null;
    switch (root["hook_event_name"]) {
      case "PreToolUse":
        return handleAsk(root, deps);
      case "UserPromptSubmit":
        return handlePrompt(root, deps);
      default:
        return null;
    }
  } catch {
    logFailure(undefined, "internal error");
    return null;
  }
}

if (import.meta.main) {
  try {
    const raw = await readStdinLimited(MAX_STDIN_BYTES, WATCHDOG_MS);
    if (raw !== null) {
      const output = run(JSON.parse(raw), defaultDeps());
      if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    // print nothing and let the question through
  }
  process.exitCode = 0;
}
