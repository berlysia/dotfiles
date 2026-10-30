#!/usr/bin/env node

import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRunGit, type GitResult } from "../lib/run-git.ts";
import { logEvent } from "../lib/centralized-logging.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";
import type { ScanOptions } from "../lib/skill-requires.ts";
import {
  createGuideMarker,
  createSkillGuideDeadline,
  guideMarkerName,
  logSkillGuideEvent,
  resolveSkillGuidePaths,
  scanSkillReads,
  skillReadStatus,
  SKILL_GUIDE_HOOK_DEADLINE_MS,
  type SkillGuideDeadline,
  type SkillGuidePaths,
} from "../lib/skill-guide.ts";
import { readMarker } from "../lib/session-marker.ts";

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;
const SCAN_DEADLINE_MS = 600;
const GIT_TIMEOUT_MS = 1000;
const LOG_TAG = "[skill-guide-after]";

const AFTER_GUIDE_LINES = {
  debugging: "この Bash の失敗を直す前に debugging を読む。",
  "defect-triage": "レビュー指摘に対応する前に defect-triage を読む。",
  "model-offloading": "Agent に委譲する前に model-offloading を読む。",
  "delivery-policy": "作業を届ける前に delivery-policy を読む。",
  "context-md": "この repo の作業前に context-md を読む。",
} as const;

type AfterGuide = keyof typeof AFTER_GUIDE_LINES;

/** Agent subagent_types emitted by plan-review-automation. */
export const REVIEWER_AGENT_TYPES = [
  "logic-validator",
  "scope-justification-reviewer",
  "decision-quality-reviewer",
  "greenfield-perspective-reviewer",
  "architecture-boundary-analyzer",
  "security-vulnerability-analyzer",
  "data-contract-evolution-evaluator",
  "resilience-analyzer",
  "test-quality-evaluator",
  "deployment-readiness-evaluator",
] as const;

const REVIEWER_AGENT_TYPE_SET: ReadonlySet<string> = new Set(
  REVIEWER_AGENT_TYPES,
);

export type SkillGuideAfterGit = (
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => GitResult;

export interface SkillGuideAfterDeps extends SkillGuidePaths {
  cwd?: string;
  deadline?: SkillGuideDeadline;
  now?: () => Date;
  runGit?: SkillGuideAfterGit;
  scan?: Partial<ScanOptions>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logInternalError(): void {
  try {
    logEvent("Error", undefined, `${LOG_TAG} internal error`);
  } catch (error) {
    process.stderr.write(
      `${LOG_TAG} failed to log internal error: ${String(error)}\n`,
    );
  }
}

function logTimeout(): void {
  logSkillGuideEvent("timeout");
}

function skillFileExists(skillsRoot: string, skill: AfterGuide): boolean {
  try {
    return lstatSync(join(skillsRoot, skill, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function afterMarkerExists(
  stateDir: string,
  sessionId: string,
  skill: AfterGuide,
): boolean {
  return (
    readMarker(
      stateDir,
      guideMarkerName("after", sessionId, undefined, skill),
    ) !== null
  );
}

function hasContextDocument(cwd: string): boolean {
  return [".tmp/docs/CONTEXT.md", "CONTEXT.md", "docs/CONTEXT.md"].some(
    (relativePath) => {
      try {
        return statSync(join(cwd, relativePath)).isFile();
      } catch {
        return false;
      }
    },
  );
}

function sceneGuides(
  input: Record<string, unknown>,
  cwd: string,
): AfterGuide[] {
  const event = input["hook_event_name"];
  if (event === "PostToolUseFailure" && input["tool_name"] === "Bash") {
    return ["debugging"];
  }
  if (event === "PostToolUse" && input["tool_name"] === "Agent") {
    const toolInput = input["tool_input"];
    if (!isRecord(toolInput)) return [];
    const guides: AfterGuide[] = [];
    if (
      typeof toolInput["subagent_type"] === "string" &&
      REVIEWER_AGENT_TYPE_SET.has(toolInput["subagent_type"])
    ) {
      guides.push("defect-triage");
    }
    if (!("model" in toolInput)) guides.push("model-offloading");
    return guides;
  }
  if (event === "SessionStart") {
    return hasContextDocument(cwd) ? ["context-md"] : [];
  }
  return [];
}

function isStopInput(input: Record<string, unknown>): boolean {
  return input["hook_event_name"] === "Stop";
}

function hasUncommittedOrUnpushedWork(
  cwd: string,
  deadline: SkillGuideDeadline,
  runGit: SkillGuideAfterGit,
): boolean {
  const timeoutMs = deadline.remaining(GIT_TIMEOUT_MS);
  if (timeoutMs <= 0) {
    logTimeout();
    return false;
  }
  const result = runGit(
    ["status", "--porcelain=v2", "--branch"],
    cwd,
    timeoutMs,
  );
  if (deadline.expired()) {
    logTimeout();
    return false;
  }
  if (!result.ok) {
    if (result.status === null) logTimeout();
    return false;
  }
  const lines = result.stdout.split("\n").filter((line) => line !== "");
  const dirtyOrAhead = lines.some((line) => {
    if (!line.startsWith("#")) return true;
    const ahead = /^# branch\.ab \+(\d+) -\d+$/.exec(line);
    return ahead !== null && Number(ahead[1]) > 0;
  });
  if (dirtyOrAhead) return true;
  // A freshly created work branch has no upstream, so branch.ab is absent;
  // ask whether HEAD has commits that no remote-tracking ref contains.
  const hasUpstream = lines.some((line) =>
    line.startsWith("# branch.upstream "),
  );
  const detached = lines.includes("# branch.head (detached)");
  if (hasUpstream || detached) return false;
  return hasCommitsOutsideRemotes(cwd, deadline, runGit);
}

function hasCommitsOutsideRemotes(
  cwd: string,
  deadline: SkillGuideDeadline,
  runGit: SkillGuideAfterGit,
): boolean {
  const timeoutMs = deadline.remaining(GIT_TIMEOUT_MS);
  if (timeoutMs <= 0) {
    logTimeout();
    return false;
  }
  const result = runGit(
    ["rev-list", "--count", "--max-count=1", "HEAD", "--not", "--remotes"],
    cwd,
    timeoutMs,
  );
  if (deadline.expired()) {
    logTimeout();
    return false;
  }
  if (!result.ok) {
    if (result.status === null) logTimeout();
    return false;
  }
  return Number(result.stdout.trim()) > 0;
}

function createRunGitWithTimeout(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): GitResult {
  return createRunGit(timeoutMs, { isolateGlobalConfig: true })(args, cwd);
}

function outputFor(
  event: string,
  guides: readonly AfterGuide[],
): object | null {
  const additionalContext = guides
    .map((guide) => AFTER_GUIDE_LINES[guide])
    .join("\n");
  if (additionalContext.length === 0) return null;
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

/** The PostToolUse / PostToolUseFailure / Stop / SessionStart output, or null to pass through. */
export async function run(
  input: unknown,
  deps?: SkillGuideAfterDeps,
): Promise<object | null> {
  const deadline = deps?.deadline ?? createSkillGuideDeadline();
  try {
    if (!isRecord(input)) return null;
    const agentId = input["agent_id"];
    if (typeof agentId === "string" && agentId.length > 0) return null;
    const event = input["hook_event_name"];
    if (typeof event !== "string") return null;
    const sessionId = input["session_id"];
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;

    const paths = deps ?? resolveSkillGuidePaths();
    const cwd =
      deps?.cwd ??
      (typeof input["cwd"] === "string" ? input["cwd"] : process.cwd());
    const stopScene = isStopInput(input);
    let guides: AfterGuide[];
    if (stopScene) {
      if (input["stop_hook_active"] === true) return null;
      guides = ["delivery-policy"];
    } else {
      guides = sceneGuides(input, cwd);
    }
    if (guides.length === 0 || deadline.expired()) {
      if (deadline.expired()) logTimeout();
      return null;
    }

    guides = guides.filter(
      (guide) =>
        skillFileExists(paths.skillsRoot, guide) &&
        !afterMarkerExists(paths.stateDir, sessionId, guide),
    );
    if (guides.length === 0) return null;

    let scanUndetermined = false;
    const transcriptPath = input["transcript_path"];
    const isContextStart =
      event === "SessionStart" &&
      guides.length === 1 &&
      guides[0] === "context-md";
    if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
      if (!isContextStart) return null;
    } else {
      const scanCapMs = Math.min(
        SCAN_DEADLINE_MS,
        deps?.scan?.deadlineMs ?? SCAN_DEADLINE_MS,
      );
      const scanBudgetMs = deadline.remaining(scanCapMs);
      if (scanBudgetMs <= 0) {
        logTimeout();
        return null;
      }
      const scan = scanSkillReads(transcriptPath, paths.skillsRoot, guides, {
        ...deps?.scan,
        deadlineMs: scanBudgetMs,
      });
      if (scan.readable && (scan.timedOut || !scan.complete)) {
        logTimeout();
        scanUndetermined = true;
        if (!stopScene) return null;
      }
      if (!scan.readable && !isContextStart) return null;
      guides = guides.filter(
        (guide) => skillReadStatus(scan, guide).status !== "read",
      );
      if (guides.length === 0) return null;
    }
    if (deadline.expired()) {
      logTimeout();
      return null;
    }

    if (stopScene) {
      const stopRunGit = deps?.runGit ?? createRunGitWithTimeout;
      if (!hasUncommittedOrUnpushedWork(cwd, deadline, stopRunGit)) return null;
      if (scanUndetermined) return null;
    }

    const emitted: AfterGuide[] = [];
    for (const guide of guides) {
      if (deadline.expired()) {
        logTimeout();
        return null;
      }
      const created = createGuideMarker({
        stateDir: paths.stateDir,
        sessionId,
        target: guide,
        kind: "after",
        ...(deps?.now !== undefined ? { now: deps.now() } : {}),
      });
      if (created) emitted.push(guide);
    }
    if (deadline.expired()) {
      logTimeout();
      return null;
    }
    return outputFor(event, emitted);
  } catch {
    logInternalError();
    return null;
  }
}

if (import.meta.main) {
  const deadline = createSkillGuideDeadline(SKILL_GUIDE_HOOK_DEADLINE_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logTimeout();
      resolve(null);
    }, WATCHDOG_MS);
    timer.unref();
  });

  try {
    const work = (async () => {
      const stdinBudgetMs = deadline.remaining(WATCHDOG_MS);
      if (stdinBudgetMs <= 0) {
        logTimeout();
        return null;
      }
      const raw = await readStdinLimited(MAX_STDIN_BYTES, stdinBudgetMs);
      if (raw === null) {
        logInternalError();
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      return run(parsed, { ...resolveSkillGuidePaths(), deadline });
    })();
    const output = await Promise.race([work, watchdog]);
    if (output !== null && !deadline.expired()) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    logInternalError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
