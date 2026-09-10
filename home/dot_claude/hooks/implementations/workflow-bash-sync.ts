#!/usr/bin/env -S bun run --silent

/**
 * PostToolUse(Bash) counterpart to `plan-review-automation.ts` (spec K1) plus
 * a gate-closed-write tripwire (spec K2).
 *
 * `plan-review-automation.ts` only fires on Write/Edit/MultiEdit/NotebookEdit,
 * so a workflow document edited through Bash (heredoc, `sed -i`, an
 * interpreter one-liner, etc.) never gets its content hash compared against
 * the review cache -- the model's next edit via Write/Edit would still catch
 * it, but nothing does after a Bash-only edit. This hook re-derives the same
 * "does this doc's current hash have review coverage" judgment after every
 * *main-loop* Bash call, using the exact same per-doc cache
 * (`readDocCache`/`writeDocCache`, spec K1) and recommendation builder
 * (`buildRecommendation`) as plan-review-automation, so the two hooks cannot
 * disagree about what counts as reviewed.
 *
 * The tripwire (spec K2) is unrelated in mechanism but shares this hook
 * because both need the same "is this a main-loop Bash call, and is the gate
 * currently closed" precondition: it snapshots `git status --porcelain`
 * against a rolling baseline file and reports repo changes outside the
 * workflow dir that a gate-closed session should not have been able to make
 * through the guarded tools.
 */

import { execFile } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { defineHook } from "cc-hooks-ts";
import {
  computeDocumentHash,
  PLAN_NORMALIZERS,
  SPEC_NORMALIZERS,
} from "../lib/document-hash.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import { appendOffPlanLog } from "../lib/workflow-audit-log.ts";
import { parseLatestAutoReviewMarker } from "../lib/workflow-marker.ts";
import { isImplementationPhase } from "../lib/workflow-gate.ts";
import {
  getWorkflowDocumentType,
  resolveWorkflowPaths,
  type WorkflowDocumentType,
} from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import {
  buildRecommendation,
  canSkip,
  countReviewerOutputsRounds,
  readDocCache,
  scanPlaceholders,
  writeDocCache,
} from "../lib/workflow-review-core.ts";
import "../types/tool-schemas.ts";

const execFileAsync = promisify(execFile);

const PLAN_NUMBERED_FILENAME_REGEX = /^plan-[0-9]+\.md$/;
const TRIPWIRE_GIT_TIMEOUT_MS = 200;
const TRIPWIRE_MAX_SHOWN_PATHS = 10;
const TRIPWIRE_LOG_CAP = 200;

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    // Subagent-originated Bash calls are not the main loop's own document
    // edits and are not what the tripwire is watching for (a subagent cannot
    // itself have bypassed the gate that governs the main loop's session) --
    // skip all work rather than pay for a git status + doc scan on every
    // subagent tool call.
    if (context.input.agent_id) {
      return context.success({});
    }

    const cwd = getWorkingDirectory();
    const resolution = resolveWorkflowDir({
      cwd,
      sessionId: context.input.session_id,
    });
    if (resolution.source === "unresolvable") {
      return context.json(
        additionalContextPayload(
          "[workflow-bash-sync] could not resolve the workflow directory for this session; skipping doc-sync and tripwire for this call.",
        ),
      );
    }
    const wfDir = resolution.dir;
    const wfPaths = resolveWorkflowPaths(wfDir);
    const workflowActive =
      existsSync(wfPaths.research) ||
      existsSync(wfPaths.plan) ||
      existsSync(wfPaths.spec);
    if (!workflowActive) {
      return context.success({});
    }

    const sections: string[] = [];
    sections.push(...collectDocRecommendations(wfDir, wfPaths));

    const twoLayer = existsSync(wfPaths.spec);
    if (!isImplementationPhase(wfDir, wfPaths, twoLayer)) {
      const tripwireMessage = await checkTripwire(wfDir, cwd);
      if (tripwireMessage) {
        sections.push(tripwireMessage);
      }
    }

    if (sections.length === 0) {
      return context.success({});
    }
    return context.json(additionalContextPayload(sections.join("\n\n---\n\n")));
  },
});

function additionalContextPayload(additionalContext: string) {
  return {
    event: "PostToolUse" as const,
    output: {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext,
      },
    },
  };
}

function getWorkingDirectory(): string {
  return process.env.CLAUDE_TEST_CWD || process.cwd();
}

/**
 * Enumerate spec.md / plan.md / plan-N.md directly under wfDir. For each one
 * whose current content hash is not already covered by the per-doc review
 * cache or an in-document `verdict=pass` marker (`canSkip`), build the same
 * recommendation `plan-review-automation.ts` would emit for a Write/Edit,
 * append any placeholder-scan findings, and record the hash in the cache so
 * repeated Bash calls do not re-emit the same recommendation (research P8).
 */
function collectDocRecommendations(
  wfDir: string,
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
): string[] {
  const candidates = [
    wfPaths.spec,
    wfPaths.plan,
    ...findPlanNumberedFiles(wfDir),
  ];
  const hasResearch = existsSync(wfPaths.research);
  const hasSpec = existsSync(wfPaths.spec);

  const parts: string[] = [];
  for (const absPath of candidates) {
    if (!existsSync(absPath)) {
      continue;
    }
    const documentType = getWorkflowDocumentType(absPath);
    if (!documentType) {
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    const normalizers = normalizersForDocumentType(documentType);
    const hash = computeDocumentHash(content, normalizers);
    const docName = basename(absPath);
    const marker = parseLatestAutoReviewMarker(content);
    const cache = readDocCache(wfDir, docName);
    if (canSkip(cache, hash, marker)) {
      continue;
    }

    let parentSpecHash: string | null = null;
    if (documentType === "plan-numbered" && hasSpec) {
      try {
        parentSpecHash = computeDocumentHash(
          readFileSync(wfPaths.spec, "utf-8"),
          SPEC_NORMALIZERS,
        );
      } catch {
        parentSpecHash = null;
      }
    }

    const recommendation = buildRecommendation(
      absPath,
      hasResearch ? wfPaths.research : null,
      content,
      {
        documentType,
        specPath: hasSpec ? wfPaths.spec : null,
        parentSpecHash,
        fullTextEmittedForRound: cache?.fullTextEmittedForRound,
      },
    );

    const placeholders = scanPlaceholders(content);
    const placeholderNote =
      placeholders.length > 0
        ? `\n\nPlaceholder scan found ${placeholders.length} finding(s) in ${docName}: ${placeholders
            .map((p) => `line ${p.line} (${p.name})`)
            .join(", ")}`
        : "";

    writeDocCache(wfDir, docName, {
      planHash: hash,
      recommendedAt: new Date().toISOString(),
      fullTextEmittedForRound: countReviewerOutputsRounds(content),
    });

    parts.push(`${recommendation}${placeholderNote}`);
  }
  return parts;
}

function normalizersForDocumentType(type: WorkflowDocumentType) {
  return type === "plan-numbered" ? PLAN_NORMALIZERS : SPEC_NORMALIZERS;
}

function findPlanNumberedFiles(wfDir: string): string[] {
  if (!existsSync(wfDir)) {
    return [];
  }
  try {
    return readdirSync(wfDir)
      .filter((name) => PLAN_NUMBERED_FILENAME_REGEX.test(name))
      .map((name) => resolve(wfDir, name))
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tripwire (spec K2)
// ---------------------------------------------------------------------------

/**
 * Snapshot `git status --porcelain` and compare against a rolling baseline
 * file at `<wfDir>/.tripwire-baseline`. Returns additionalContext text when
 * gate-closed changes outside wfDir were found, or a re-arm notice when no
 * baseline existed yet, or null when there is nothing to report.
 *
 * Disables itself (writing `<wfDir>/.tripwire-disabled`) the first time `git`
 * is unavailable, times out, or otherwise fails, and stays silent on every
 * call after that -- the disabled marker's existence is the "already
 * notified" record so this cannot spam every subsequent Bash call.
 */
async function checkTripwire(
  wfDir: string,
  cwd: string,
): Promise<string | null> {
  const disabledPath = resolve(wfDir, ".tripwire-disabled");
  if (existsSync(disabledPath)) {
    return null;
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-C",
        cwd,
        "-c",
        "core.fsmonitor=",
        "status",
        "--porcelain=v1",
        "-z",
        "-uall",
      ],
      { timeout: TRIPWIRE_GIT_TIMEOUT_MS, encoding: "utf-8" },
    );
    stdout = result.stdout;
  } catch (error) {
    writeDisabledMarker(disabledPath, describeGitFailure(error));
    return "[workflow-bash-sync] tripwire disabled: `git status` was unavailable or timed out for this repo. Gate-closed off-plan write detection will not run again this session (see `.tripwire-disabled`).";
  }

  const baselinePath = resolve(wfDir, ".tripwire-baseline");
  const baseline = readBaselineSafely(baselinePath);

  if (baseline === null) {
    writeBaselineSafely(baselinePath, stdout);
    return "[workflow-bash-sync] tripwire re-armed: no prior baseline was found for this workflow dir, so the current repo state was captured as the new baseline. Off-plan changes will be reported starting from the next Bash call.";
  }

  const current = parsePorcelainMap(stdout);
  const changedRelPaths: string[] = [];
  for (const [relPath, status] of current) {
    if (baseline.get(relPath) !== status) {
      changedRelPaths.push(relPath);
    }
  }

  writeBaselineSafely(baselinePath, stdout);

  if (changedRelPaths.length === 0) {
    return null;
  }

  const outside = changedRelPaths.filter(
    (relPath) => !isUnderWfDir(resolve(cwd, relPath), wfDir),
  );
  if (outside.length === 0) {
    return null;
  }

  for (const relPath of outside.slice(0, TRIPWIRE_LOG_CAP)) {
    appendOffPlanLog(wfDir, "Bash-tripwire", relPath);
  }

  const shown = outside
    .slice(0, TRIPWIRE_MAX_SHOWN_PATHS)
    .map((p) => `- ${sanitizeForDisplay(p)}`);
  const remaining = outside.length - shown.length;
  const moreLine = remaining > 0 ? `\n… ${remaining} more` : "";

  return `[workflow-bash-sync] tripwire: gate-closed repo changes outside the workflow dir were detected and recorded in \`off-plan-writes.log\`:\n${shown.join("\n")}${moreLine}`;
}

function isUnderWfDir(absPath: string, wfDir: string): boolean {
  return absPath === wfDir || absPath.startsWith(`${wfDir}/`);
}

function describeGitFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    if (err.code === "ENOENT") {
      return "git binary not found";
    }
    if (err.killed) {
      return `git status timed out after ${TRIPWIRE_GIT_TIMEOUT_MS}ms`;
    }
    if (typeof err.message === "string") {
      return err.message.slice(0, 500);
    }
  }
  return "unknown git failure";
}

function writeDisabledMarker(path: string, reason: string): void {
  try {
    if (existsSync(path)) {
      return;
    }
    const st = lstatIfExists(path);
    if (st?.isSymbolicLink()) {
      return;
    }
    const fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${new Date().toISOString()}\t${reason}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort; disabling the tripwire must not block the tool call
  }
}

/**
 * Read the baseline file, refusing to follow it if it is a symlink (treated
 * as "no baseline", which forces a re-arm rather than trusting a redirected
 * file). `null` also covers "does not exist" and "unparsable".
 */
function readBaselineSafely(path: string): Map<string, string> | null {
  const st = lstatIfExists(path);
  if (!st || st.isSymbolicLink()) {
    return null;
  }
  try {
    return parsePorcelainMap(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write the baseline file with `O_NOFOLLOW`, refusing outright (not
 * following, not overwriting through) if the path is already a symlink --
 * the write-side half of the same defense `readBaselineSafely` applies on
 * read. Best-effort: a failed baseline write must not block the tool call.
 */
function writeBaselineSafely(path: string, content: string): void {
  try {
    const st = lstatIfExists(path);
    if (st?.isSymbolicLink()) {
      return;
    }
    const fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_TRUNC |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Parse `git status --porcelain=v1 -z` output into `relativePath -> XY`.
 * Rename/copy entries (`R`/`C` in either status column) carry an extra
 * NUL-separated "from" path after the "to" path; it is consumed and dropped
 * (only the current path matters for baseline diffing).
 */
function parsePorcelainMap(output: string): Map<string, string> {
  const tokens = output.split("\0").filter((t) => t.length > 0);
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 3) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    map.set(path, status);
    if (status[0] === "R" || status[0] === "C") {
      i++; // skip the paired "from" path token
    }
  }
  return map;
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
