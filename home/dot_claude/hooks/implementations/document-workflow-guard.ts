#!/usr/bin/env -S bun run --silent

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { extractCommandsStructured } from "../lib/bash-parser.ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde } from "../lib/path-utils.ts";
import {
  getWorkflowDir,
  getWorkflowDirRelative,
  isLessonsLearnedPath,
  isWorkflowDocument,
  resolveWorkflowPaths,
} from "../lib/workflow-paths.ts";
import "../types/tool-schemas.ts";

const PLAN_STATUS_REGEX = /^- Plan Status:\s*complete\s*$/m;
const REVIEW_STATUS_REGEX = /^- Review Status:\s*pass\s*$/m;
const APPROVAL_STATUS_REGEX = /^- Approval Status:\s*approved\s*$/m;
const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;
const PLAN_NUMBERED_FILENAME_REGEX = /^plan-[0-9]+\.md$/;
const GUARDED_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);

interface WriteAnalysis {
  isWriteLike: boolean;
  targets: string[];
}

interface WorkflowState {
  mode?: string;
  approved?: boolean;
}

interface AutoReviewMarker {
  verdict: string;
  hash: string;
  parentSpecHash: string | null;
}

interface ApprovalCheckResult {
  approved: boolean;
  reason?: string;
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;
    if (!GUARDED_TOOLS.has(tool_name)) {
      return context.success({});
    }

    const cwd = getWorkingDirectory();
    const wfDir = getWorkflowDir(cwd);
    if (!wfDir) {
      console.error(
        "[document-workflow-guard] DOCUMENT_WORKFLOW_DIR is not set, skipping guard",
      );
      return context.success({});
    }

    const wfPaths = resolveWorkflowPaths(wfDir);
    const state = readWorkflowState(wfPaths.state);
    const workflowActive = isWorkflowActive(wfPaths, state);
    if (!workflowActive) {
      return context.success({});
    }

    const warnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1";
    const researched = existsSync(wfPaths.research);
    const twoLayer = existsSync(wfPaths.spec);
    const wfDirLabel = getWorkflowDirRelative() ?? "(unknown)";
    const denyReasonSingle = `Document workflow gate: implementation is blocked until \`${wfDirLabel}/research.md\` exists and \`${wfDirLabel}/plan.md\` has \`- Plan Status: complete\`, \`- Review Status: pass\`, \`- Approval Status: approved\`, and \`<!-- auto-review: verdict=pass; hash=... -->\` with a matching hash.`;
    const denyReasonTwoLayer = `Document workflow gate (two-layer): implementation is blocked until \`${wfDirLabel}/spec.md\` is approved (Plan Status: complete + Review Status: pass + Approval Status: approved + matching hash), AND the plan-N.md whose Files section lists the target file is approved with matching \`parent-spec-hash\` for the current spec.md.`;
    const denyReason = twoLayer ? denyReasonTwoLayer : denyReasonSingle;

    if (tool_name === "Bash") {
      const command = getCommandFromToolInput("Bash", tool_input) || "";
      const analysis = await analyzeBashWrite(command);
      if (!analysis.isWriteLike) {
        return context.success({});
      }

      if (areAllTargetsDocumentPaths(cwd, analysis.targets, wfPaths, wfDir)) {
        return context.success({});
      }

      if (areAllTargetsOutsideProject(cwd, analysis.targets)) {
        return context.success({});
      }

      if (
        researched &&
        analysis.targets.every((target) =>
          isTargetAllowed(cwd, target, wfDir, wfPaths, twoLayer),
        )
      ) {
        return context.success({});
      }

      if (warnOnly) {
        console.error(
          `[document-workflow-guard][would-block] Bash: ${command}`,
        );
        return context.success({});
      }

      return context.json(createDenyResponse(denyReason));
    }

    const targetPath = getTargetFilePath(tool_name, tool_input);
    if (!targetPath) {
      return context.success({});
    }

    if (isDocumentPath(cwd, targetPath, wfPaths, wfDir)) {
      return context.success({});
    }

    if (isOutsideProject(cwd, targetPath)) {
      return context.success({});
    }

    if (
      researched &&
      isTargetAllowed(cwd, targetPath, wfDir, wfPaths, twoLayer)
    ) {
      return context.success({});
    }

    if (warnOnly) {
      console.error(
        `[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`,
      );
      return context.success({});
    }

    return context.json(createDenyResponse(denyReason));
  },
});

function getWorkingDirectory(): string {
  return process.env.CLAUDE_TEST_CWD || process.cwd();
}

type WorkflowPaths = ReturnType<typeof resolveWorkflowPaths>;

function isDocumentPath(
  cwd: string,
  path: string,
  wfPaths: WorkflowPaths,
  wfDir: string,
): boolean {
  const normalized = resolve(cwd, expandTilde(path));
  if (
    normalized === wfPaths.plan ||
    normalized === wfPaths.research ||
    normalized === wfPaths.spec
  ) {
    return true;
  }
  // lessons-learned.md is written by the P12 hook (lessons-learned-extractor.ts)
  // outside of the regular approval lifecycle, so it must be allowed regardless
  // of plan approval state. See spec K7 / DI4.
  if (isLessonsLearnedPath(normalized, wfDir)) {
    return true;
  }
  // plan-N.md (N is one or more digits) within the workflow directory
  if (normalized.startsWith(`${wfDir}/`)) {
    const filename = normalized.slice(wfDir.length + 1);
    if (PLAN_NUMBERED_FILENAME_REGEX.test(filename)) {
      return true;
    }
  }
  return false;
}

function areAllTargetsDocumentPaths(
  cwd: string,
  targets: string[],
  wfPaths: WorkflowPaths,
  wfDir: string,
): boolean {
  if (targets.length === 0) {
    return false;
  }
  return targets.every((target) => isDocumentPath(cwd, target, wfPaths, wfDir));
}

function isOutsideProject(cwd: string, path: string): boolean {
  const normalized = resolve(cwd, expandTilde(path));
  return !normalized.startsWith(`${cwd}/`) && normalized !== cwd;
}

function areAllTargetsOutsideProject(cwd: string, targets: string[]): boolean {
  if (targets.length === 0) {
    return false;
  }
  return targets.every((target) => isOutsideProject(cwd, target));
}

function readWorkflowState(statePath: string): WorkflowState | null {
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const content = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(content) as WorkflowState;
    return parsed;
  } catch {
    return null;
  }
}

function isWorkflowActive(
  wfPaths: WorkflowPaths,
  state: WorkflowState | null,
): boolean {
  if (state?.mode === "document-workflow") {
    return true;
  }
  return existsSync(wfPaths.plan) || existsSync(wfPaths.research);
}

function hasApprovedPlan(planPath: string): boolean {
  if (!existsSync(planPath)) {
    return false;
  }

  try {
    const content = readFileSync(planPath, "utf-8");
    const hasCompletePlan = PLAN_STATUS_REGEX.test(content);
    const hasReviewPass = REVIEW_STATUS_REGEX.test(content);
    const hasHumanApproval = APPROVAL_STATUS_REGEX.test(content);
    if (!hasCompletePlan || !hasReviewPass || !hasHumanApproval) {
      return false;
    }

    const marker = extractLatestAutoReviewMarker(content);
    if (!marker || marker.verdict !== "pass") {
      return false;
    }

    const actualHash = computePlanHash(content);
    return marker.hash === actualHash;
  } catch {
    return false;
  }
}

/**
 * Check whether a specific implementation target file is allowed.
 * - Single-layer mode (spec.md absent): falls back to global plan.md approval (current behavior).
 * - Two-layer mode (spec.md exists): requires (a) spec.md approved + matching hash,
 *   (b) the plan-N.md whose Files section contains the target is approved + matching hash,
 *   (c) the plan-N.md `parent-spec-hash` field is present and equals the current spec.md hash.
 *   parent-spec-hash absence is treated as mismatch (conservative deny, bypass防止).
 */
function isTargetAllowed(
  cwd: string,
  targetPath: string,
  wfDir: string,
  wfPaths: WorkflowPaths,
  twoLayer: boolean,
): boolean {
  if (!twoLayer) {
    return hasApprovedPlan(wfPaths.plan);
  }

  // Two-layer mode: verify spec.md approval first.
  if (!existsSync(wfPaths.spec)) {
    return false;
  }
  let specContent: string;
  try {
    specContent = readFileSync(wfPaths.spec, "utf-8");
  } catch {
    return false;
  }
  if (!isContentApproved(specContent)) {
    return false;
  }
  const specHash = computePlanHash(specContent);

  // Find plan-N.md files whose Files section lists the target.
  const planFiles = findPlanNumberedFiles(wfDir);
  if (planFiles.length === 0) {
    return false;
  }
  const normalizedTarget = resolve(cwd, expandTilde(targetPath));

  for (const planPath of planFiles) {
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      continue;
    }
    const filesInPlan = parseFilesSection(planContent, cwd);
    if (!filesInPlan.includes(normalizedTarget)) {
      continue;
    }

    if (!isContentApproved(planContent)) {
      return false;
    }
    const planMarker = extractLatestAutoReviewMarker(planContent);
    if (!planMarker || planMarker.verdict !== "pass") {
      return false;
    }
    if (planMarker.hash !== computePlanHash(planContent)) {
      return false;
    }
    // parent-spec-hash absence = conservative deny (bypass防止)
    if (planMarker.parentSpecHash === null) {
      return false;
    }
    if (planMarker.parentSpecHash !== specHash) {
      return false;
    }
    return true;
  }

  // No plan-N.md owns this target → conservative deny
  return false;
}

function isContentApproved(content: string): boolean {
  return (
    PLAN_STATUS_REGEX.test(content) &&
    REVIEW_STATUS_REGEX.test(content) &&
    APPROVAL_STATUS_REGEX.test(content)
  );
}

/**
 * Enumerate plan-N.md files (where N is one or more digits) directly within wfDir.
 * Strict regex match excludes plan-draft.md, plan-1.md.bak, plan-2-draft.md, etc.
 */
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

/**
 * Parse the `## Files` section of a plan-N.md as fenced code blocks containing
 * one path per line (relative to project root). `#` lines and blank lines are
 * skipped. Other non-path lines (indented, embedded whitespace, etc.) cause the
 * code block to be ignored conservatively. Returns absolute paths.
 */
function parseFilesSection(planContent: string, cwd: string): string[] {
  // Split on `## ` H2 headings, find the section starting with "Files".
  // `\Z` doesn't exist in JS regex, so we partition the document into sections
  // and pick the Files one explicitly.
  const sections = planContent.split(/^##\s+/m);
  const filesSection = sections.find((s) =>
    /^Files\s*$/m.test(s.split("\n")[0] ?? ""),
  );
  if (!filesSection) {
    return [];
  }
  // Drop the "Files" heading line and use the rest as body.
  const sectionBody = filesSection.replace(/^Files\s*\n/, "");
  const codeBlocks: string[] = [];
  const codeBlockRegex = /^```[^\n]*\n([\s\S]*?)\n```/gm;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(sectionBody)) !== null) {
    if (match[1] !== undefined) {
      codeBlocks.push(match[1]);
    }
  }

  const collected: string[] = [];
  for (const block of codeBlocks) {
    const blockPaths: string[] = [];
    let blockValid = true;
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      if (line.startsWith("#")) continue;
      // Reject lines with internal whitespace (tabs, spaces) or other non-path
      // characters that suggest formatting issues.
      if (/\s/.test(line)) {
        blockValid = false;
        break;
      }
      blockPaths.push(line);
    }
    if (!blockValid) {
      continue; // Conservative deny: ignore blocks with format violations.
    }
    for (const p of blockPaths) {
      collected.push(resolve(cwd, expandTilde(p)));
    }
  }
  return collected;
}

function getTargetFilePath(
  tool_name: string,
  tool_input: unknown,
): string | null {
  if (!isRecord(tool_input)) {
    return null;
  }

  if (
    (tool_name === "Write" ||
      tool_name === "Edit" ||
      tool_name === "MultiEdit") &&
    typeof tool_input.file_path === "string"
  ) {
    return tool_input.file_path;
  }

  if (
    tool_name === "NotebookEdit" &&
    typeof tool_input.notebook_path === "string"
  ) {
    return tool_input.notebook_path;
  }

  return null;
}

async function analyzeBashWrite(command: string): Promise<WriteAnalysis> {
  const result = await extractCommandsStructured(command);
  const commands = result.individualCommands;

  const targets: string[] = [];
  let isWriteLike = false;

  for (const cmd of commands) {
    const analysis = analyzeSingleCommand(cmd);
    if (analysis.isWriteLike) {
      isWriteLike = true;
      targets.push(...analysis.targets);
    }
  }

  return {
    isWriteLike,
    targets: dedupe(targets),
  };
}

function analyzeSingleCommand(command: string): WriteAnalysis {
  const words = splitShellWords(command);
  if (words.length === 0) {
    return { isWriteLike: false, targets: [] };
  }

  const redirectionTargets = extractRedirectionTargets(words);
  const main = extractMainCommand(words);
  if (!main) {
    if (redirectionTargets.length > 0) {
      return { isWriteLike: true, targets: redirectionTargets };
    }
    return { isWriteLike: false, targets: [] };
  }

  const { name, args } = main;
  const lower = name.toLowerCase();
  const commandTargets: string[] = [];
  let isWriteLike = redirectionTargets.length > 0;

  if (lower === "tee") {
    const files = args.filter((arg) => !arg.startsWith("-"));
    if (files.length > 0) {
      isWriteLike = true;
      commandTargets.push(...files);
    }
  } else if (["touch", "mkdir", "rm", "rmdir", "truncate"].includes(lower)) {
    const files = args.filter((arg) => !arg.startsWith("-"));
    if (files.length > 0) {
      isWriteLike = true;
      commandTargets.push(...files);
    }
  } else if (["cp", "mv", "install"].includes(lower)) {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (positional.length >= 2) {
      isWriteLike = true;
      commandTargets.push(positional[positional.length - 1] || "");
    }
  } else if (lower === "sed" || lower === "perl") {
    if (args.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
      const positional = args.filter((arg) => !arg.startsWith("-"));
      const last = positional[positional.length - 1];
      if (last) {
        isWriteLike = true;
        commandTargets.push(last);
      }
    }
  }

  if (!isWriteLike) {
    return { isWriteLike: false, targets: [] };
  }

  return {
    isWriteLike: true,
    targets: dedupe([...redirectionTargets, ...commandTargets]).filter(
      (target) => target.length > 0,
    ),
  };
}

function extractMainCommand(
  words: string[],
): { name: string; args: string[] } | null {
  let index = 0;
  while (index < words.length) {
    const token = words[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (isVariableAssignment(token)) {
      index += 1;
      continue;
    }
    return {
      name: token,
      args: words.slice(index + 1),
    };
  }
  return null;
}

function isVariableAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function extractRedirectionTargets(words: string[]): string[] {
  const targets: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    if (!token) {
      continue;
    }

    if (isRedirectionToken(token)) {
      const next = words[i + 1];
      if (
        next &&
        !next.startsWith("&") &&
        !isStderrRedirection(token) &&
        next !== "/dev/null"
      ) {
        targets.push(next);
      }
      continue;
    }

    const inline = token.match(/^(\d*)(>>?|>\|)(.+)$/);
    if (inline?.[3] && !inline[3].startsWith("&")) {
      if (inline[1] !== "2" && inline[3] !== "/dev/null") {
        targets.push(inline[3]);
      }
    }
  }

  return targets;
}

function isRedirectionToken(token: string): boolean {
  return /^(?:\d*>>?|\d*>\|)$/.test(token);
}

function isStderrRedirection(token: string): boolean {
  return /^2(>>?|>\|)$/.test(token);
}

function splitShellWords(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((word) => stripQuotes(word));
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function computePlanHash(content: string): string {
  const normalized = content
    .replace(REVIEW_MARKER_REGEX, "")
    .replace(/^(- Approval Status:)\s*.*$/m, "$1")
    .replace(/^(\s*- )\[x\]/gm, "$1[ ]")
    .trimEnd();
  return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

function extractLatestAutoReviewMarker(
  content: string,
): AutoReviewMarker | null {
  const matches = content.match(REVIEW_MARKER_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }

  const latest = matches[matches.length - 1];
  if (!latest) {
    return null;
  }

  let verdict = "";
  let hash = "";
  let parentSpecHash: string | null = null;
  // Match keys with optional hyphens (e.g., parent-spec-hash). Values are anything
  // up to the next semicolon or end of marker.
  const fields = latest.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)=([^;]+)/g);
  for (const field of fields) {
    const key = field[1]?.trim();
    const value = field[2]?.trim();
    if (!key || !value) {
      continue;
    }
    if (key === "verdict") {
      verdict = value;
    } else if (key === "hash") {
      hash = value;
    } else if (key === "parent-spec-hash") {
      parentSpecHash = value;
    }
  }

  if (verdict.length === 0 || hash.length === 0) {
    return null;
  }

  return { verdict, hash, parentSpecHash };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
