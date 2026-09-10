#!/usr/bin/env -S bun run --silent

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { extractCommandsStructured } from "../lib/bash-parser.ts";
import { computeDocumentHash, SPEC_NORMALIZERS } from "../lib/document-hash.ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { expandTilde } from "../lib/path-utils.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import { appendOffPlanLog } from "../lib/workflow-audit-log.ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import {
  type AutoReviewMarker,
  parseLatestAutoReviewMarker,
  STRICT_APPROVAL_STATUS,
  STRICT_PLAN_STATUS,
  STRICT_REVIEW_STATUS,
} from "../lib/workflow-marker.ts";
import {
  diagnoseGate,
  formatGateDiagnosis,
  isImplementationPhase,
} from "../lib/workflow-gate.ts";
import "../types/tool-schemas.ts";

// Status regexes and the marker parser now live in the shared workflow-marker
// module so the guard and plan-review-automation cannot drift (spec K4/N7).
// Aliased to the original names for a minimal diff at the call sites below.
const PLAN_STATUS_REGEX = STRICT_PLAN_STATUS;
const REVIEW_STATUS_REGEX = STRICT_REVIEW_STATUS;
const APPROVAL_STATUS_REGEX = STRICT_APPROVAL_STATUS;
const PLAN_NUMBERED_FILENAME_REGEX = /^plan-[0-9]+\.md$/;
const GUARDED_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);
export const GUARDED_TOOLS_FOR_TESTING = GUARDED_TOOLS;

interface WriteAnalysis {
  isWriteLike: boolean;
  targets: string[];
}

interface WorkflowState {
  mode?: string;
  approved?: boolean;
}

interface ApprovalCheckResult {
  approved: boolean;
  reason?: string;
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    try {
      const { tool_name, tool_input } = context.input;
      if (!GUARDED_TOOLS.has(tool_name)) {
        return context.success({});
      }

      const cwd = getWorkingDirectory();
      const resolution = resolveWorkflowDir({
        cwd,
        sessionId: context.input.session_id,
      });
      // The `unresolvable` early return is deliberately not silent here, unlike
      // the other four hooks that share this shape. Two reasons: (1) fs
      // failures (ELOOP/EACCES on the containment check) land here because
      // `workflow-fs.ts` folds them into the predicate's `false`, so this is
      // the only place K10's exception visibility can reach them -- nothing
      // throws. (2) `resolution.reason` already names which check failed, and
      // `workflow-resolve.ts`'s docstring requires that a message built from it
      // name the check, not a guessed cause.
      if (resolution.source === "unresolvable") {
        return context.json({
          event: "PreToolUse",
          output: {
            systemMessage:
              resolution.reason === "invalid-session-id"
                ? "[document-workflow-guard] the session id is malformed, so no workflow directory could be derived; the gate is not enforcing for this call."
                : "[document-workflow-guard] could not verify that the derived workflow directory is a strict descendant of <cwd>/.tmp/sessions; the gate is not enforcing for this call.",
          },
        });
      }
      const wfDir = resolution.dir;

      const wfPaths = resolveWorkflowPaths(wfDir);
      const state = readWorkflowState(wfPaths.state);
      const workflowActive = isWorkflowActiveForTesting(wfPaths, state);
      if (!workflowActive) {
        return context.success({});
      }

      const warnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1";
      const researched = existsSync(wfPaths.research);
      const twoLayer = existsSync(wfPaths.spec);
      const wfDirLabel = sanitizeForDisplay(resolution.relative);
      const denyReasonSingle = `Document workflow gate: implementation is blocked until \`${wfDirLabel}/research.md\` exists and \`${wfDirLabel}/plan.md\` has \`- Plan Status: complete\`, \`- Review Status: pass\`, \`- Approval Status: approved\`, and \`<!-- auto-review: verdict=pass; hash=... -->\` with a matching hash.`;
      const denyReasonTwoLayer = `Document workflow gate (two-layer): implementation is blocked until \`${wfDirLabel}/spec.md\` is approved (Plan Status: complete + Review Status: pass + Approval Status: approved + matching hash), AND the plan-N.md whose Files section lists the target file is approved with matching \`parent-spec-hash\` for the current spec.md.`;
      const denyReason = twoLayer ? denyReasonTwoLayer : denyReasonSingle;
      const emptyTargetDenyReason = sanitizeForDisplay(
        "Document workflow gate: this command was classified as write-like but the guard could not determine which files it writes, so it was refused conservatively. Re-run with the target paths written explicitly.",
      );

      if (tool_name === "Bash") {
        const command = getCommandFromToolInput("Bash", tool_input) || "";
        // K3's interpreter-write check only fires while the design gate is
        // closed (spec K3): once implementation phase is active, a Write/Edit
        // to an owned target already goes through the normal (non-conservative)
        // per-target check below, so hard-blocking every interpreter
        // invocation regardless of approval would add friction without
        // preventing anything the gate still protects.
        const gateClosed = !isImplementationPhase(wfDir, wfPaths, twoLayer);
        const analysis = await analyzeBashWrite(
          command,
          cwd,
          wfDir,
          gateClosed,
        );
        if (!analysis.isWriteLike) {
          return context.success({});
        }

        if (areAllTargetsDocumentPaths(cwd, analysis.targets, wfDir)) {
          return context.success({});
        }

        if (areAllTargetsOutsideProject(cwd, analysis.targets)) {
          return context.success({});
        }

        // [].every() is vacuous true. The two shortcuts above
        // (areAllTargetsDocumentPaths / areAllTargetsOutsideProject) already
        // refuse an empty target list with `false`, but the checkTarget path
        // below did not: a write-like command whose targets could not be
        // extracted fell through `.every()` on an empty array and was
        // allowed (research.md §10.14). Being classified as write-like with
        // zero targets means "could not tell what it writes", not "writes
        // nothing".
        let reasonForThisCall = denyReason;
        if (analysis.targets.length === 0) {
          reasonForThisCall = emptyTargetDenyReason;
        } else if (researched) {
          const decisions = analysis.targets.map((target) =>
            checkTarget(cwd, target, wfDir, wfPaths, twoLayer),
          );
          if (decisions.every((d) => d === "allow")) {
            return context.success({});
          }
          if (
            decisions.every((d) => d === "allow" || d === "no-plan-owner") &&
            isImplementationPhase(wfDir, wfPaths, twoLayer)
          ) {
            for (let i = 0; i < decisions.length; i++) {
              if (decisions[i] !== "no-plan-owner") continue;
              const target = analysis.targets[i] ?? "";
              console.error(
                `[document-workflow-guard][off-plan] Bash target \`${target}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
              );
              appendOffPlanLog(wfDir, "Bash", target);
            }
            return context.success({});
          }
        }

        if (warnOnly) {
          console.error(
            `[document-workflow-guard][would-block] Bash: ${command}`,
          );
          return context.success({});
        }

        // Diagnostic deny (spec K4): when a target is known, replace the fixed
        // gate text with a per-condition diagnosis so the model can see which
        // condition failed and on which line (research P4/P5). The empty-target
        // deny keeps its own message (there is nothing to diagnose against).
        if (reasonForThisCall !== emptyTargetDenyReason) {
          const diagTarget = analysis.targets[0] ?? "";
          const docLabel = `${wfDirLabel}/${twoLayer ? "spec.md" : "plan.md"}`;
          reasonForThisCall = formatGateDiagnosis(
            diagnoseGate(wfDir, diagTarget),
            sanitizeForDisplay(diagTarget),
            docLabel,
          );
        }
        return context.json(createDenyResponse(reasonForThisCall));
      }

      const targetPath = getTargetFilePath(tool_name, tool_input);
      if (!targetPath) {
        return context.success({});
      }

      if (isDocumentPath(cwd, targetPath, wfDir)) {
        return context.success({});
      }

      if (isOutsideProject(cwd, targetPath)) {
        return context.success({});
      }

      if (researched) {
        const decision = checkTarget(cwd, targetPath, wfDir, wfPaths, twoLayer);
        if (decision === "allow") {
          return context.success({});
        }
        if (
          decision === "no-plan-owner" &&
          isImplementationPhase(wfDir, wfPaths, twoLayer)
        ) {
          console.error(
            `[document-workflow-guard][off-plan] ${tool_name} target \`${targetPath}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
          );
          appendOffPlanLog(wfDir, tool_name, targetPath);
          return context.success({});
        }
      }

      if (warnOnly) {
        console.error(
          `[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`,
        );
        return context.success({});
      }

      // Diagnostic deny (spec K4): describe which gate condition failed on the
      // owning document and how to clear it, instead of the fixed gate text.
      const docLabel = `${wfDirLabel}/${twoLayer ? "spec.md" : "plan.md"}`;
      const diagnosticReason = formatGateDiagnosis(
        diagnoseGate(wfDir, targetPath),
        sanitizeForDisplay(targetPath),
        docLabel,
      );
      return context.json(createDenyResponse(diagnosticReason));
    } catch (error) {
      // fail-open is preserved (matching what runHook already does when a
      // throw escapes to it: convert to exit 1). What changes is that the
      // call is no longer allowed silently. context.success() would discard
      // systemMessage, so context.json is used instead (research.md §10.3).
      //
      // console.error is kept alongside. Today an escaping exception reaches
      // runHook and prints a stack trace to stderr; catching it here and
      // returning context.json would otherwise lose that. Root-causing a
      // fail-open gate needs exactly this trail, so it is not trimmed to a
      // 256-character single line. PreToolUse exits 0, so stderr does not
      // reach the model here -- this does not add a model-input surface.
      console.error("[document-workflow-guard] internal error:", error);
      return context.json({
        event: "PreToolUse",
        output: {
          systemMessage: `[document-workflow-guard] internal error, allowing the call: ${sanitizeForDisplay(String(error))}`,
        },
      });
    }
  },
});

function getWorkingDirectory(): string {
  return process.env.CLAUDE_TEST_CWD || process.cwd();
}

type WorkflowPaths = ReturnType<typeof resolveWorkflowPaths>;

/**
 * Markdown under the workflow directory is a workflow document, never
 * implementation: the directory is session-scoped scratch under `.tmp/`, so
 * nothing written there is deployed or committed. The predicate is stated as a
 * property of the directory rather than as a list of filenames because naming
 * the artifacts individually (plan.md / spec.md / research.md /
 * lessons-learned.md — including P12's out-of-lifecycle writes per spec K7 /
 * DI4 — and plan-N.md) sent every other note the workflow legitimately produces
 * (handoff memos such as NEXT-SESSION.md, plan drafts, split research notes)
 * into the implementation gate, where an unapproved plan denied them.
 *
 * Non-markdown inside the directory stays gated on purpose:
 * `plan-review.cache.json` and `off-plan-writes.log` are hook-managed state, and
 * a tool-driven write to them could forge a cached verdict or rewrite the audit
 * trail the off-plan relaxation depends on.
 */
function isDocumentPath(cwd: string, path: string, wfDir: string): boolean {
  const normalized = resolve(cwd, expandTilde(path));
  return normalized.startsWith(`${wfDir}/`) && normalized.endsWith(".md");
}

function areAllTargetsDocumentPaths(
  cwd: string,
  targets: string[],
  wfDir: string,
): boolean {
  if (targets.length === 0) {
    return false;
  }
  return targets.every((target) => isDocumentPath(cwd, target, wfDir));
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

/**
 * Exported so `session.ts`'s local copy of this predicate (armed vs inactive
 * in the startup summary) can be checked for drift against the real thing in
 * `session.test.ts`. No production module imports this export -- `session.ts`
 * keeps its own copy specifically to avoid depending on the module it exists
 * to observe (spec K5).
 */
export function isWorkflowActiveForTesting(
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

type TargetDecision = "allow" | "no-plan-owner" | "deny-other";

/**
 * Categorize the allowance state for a specific implementation target.
 * - "allow": target is owned by an approved plan (or single-layer plan.md is approved).
 * - "no-plan-owner": two-layer mode only; spec.md is approved but no plan-N.md
 *   Files section lists the target. This represents files discovered during
 *   implementation that haven't been retroactively recorded in any plan yet.
 *   Eligible for warn+log relaxation when implementation phase is active.
 * - "deny-other": all structural failures that must remain strict (spec not
 *   approved, hash drift, parent-spec-hash mismatch, owning plan not approved).
 *   These signal the design or plan is still moving and should not be bypassed.
 */
function checkTarget(
  cwd: string,
  targetPath: string,
  wfDir: string,
  wfPaths: WorkflowPaths,
  twoLayer: boolean,
): TargetDecision {
  if (!twoLayer) {
    return hasApprovedPlan(wfPaths.plan) ? "allow" : "deny-other";
  }

  // Two-layer mode: verify spec.md approval first.
  if (!existsSync(wfPaths.spec)) {
    return "deny-other";
  }
  let specContent: string;
  try {
    specContent = readFileSync(wfPaths.spec, "utf-8");
  } catch {
    return "deny-other";
  }
  if (!isContentApproved(specContent)) {
    return "deny-other";
  }
  const specMarker = extractLatestAutoReviewMarker(specContent);
  if (!specMarker || specMarker.verdict !== "pass") {
    return "deny-other";
  }
  const specHash = computePlanHash(specContent);
  if (specMarker.hash !== specHash) {
    return "deny-other";
  }

  // Find plan-N.md files whose Files section lists the target.
  const planFiles = findPlanNumberedFiles(wfDir);
  if (planFiles.length === 0) {
    return "no-plan-owner";
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
      return "deny-other";
    }
    const planMarker = extractLatestAutoReviewMarker(planContent);
    if (!planMarker || planMarker.verdict !== "pass") {
      return "deny-other";
    }
    if (planMarker.hash !== computePlanHash(planContent)) {
      return "deny-other";
    }
    // parent-spec-hash absence = conservative deny (bypass防止)
    if (planMarker.parentSpecHash === null) {
      return "deny-other";
    }
    if (planMarker.parentSpecHash !== specHash) {
      return "deny-other";
    }
    return "allow";
  }

  // No plan-N.md owns this target. Eligible for implementation-phase relaxation.
  return "no-plan-owner";
}

// appendOffPlanLog moved to lib/workflow-audit-log.ts (plan-2 T4) so
// workflow-bash-sync.ts's tripwire can share the exact same appender
// (including its O_NOFOLLOW hardening) without an
// implementations->implementations import. The log's shape and purpose --
// discovery trail folded back into plan-N.md before commit -- are documented
// there now.

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

async function analyzeBashWrite(
  command: string,
  cwd: string,
  wfDir: string,
  gateClosed: boolean,
): Promise<WriteAnalysis> {
  const result = await extractCommandsStructured(command);
  const commands = result.individualCommands;

  const targets: string[] = [];
  let isWriteLike = false;

  for (const cmd of commands) {
    const analysis = analyzeSingleCommand(cmd, cwd, wfDir, gateClosed);
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

/**
 * Interpreter names whose inline-script invocation forms (`-c`/`-e`/`-p`/`-`
 * / heredoc) are checked for a write indicator (plan-2 T3, spec K3). ruby and
 * php are intentionally excluded from this set -- narrowing the trigger
 * surface to the interpreters actually observed running inline write scripts
 * in this workflow keeps the false-positive rate on ordinary read-only Bash
 * usage low.
 */
const INTERPRETER_NAMES = new Set(["python", "python3", "node", "bun", "deno"]);

/**
 * Substring/pattern indicators that a script body performs a filesystem (or
 * process-spawning) write. Deliberately narrower than "contains .write(":
 * `sys.stdout.write(...)` / `process.stdout.write(...)` are common in
 * read-only scripts and must not trip this classifier (spec K3 read-only
 * allow case).
 */
const INTERPRETER_WRITE_INDICATOR_PATTERNS: RegExp[] = [
  /open\([^)]*['"][wa]\+?b?['"]/, // open(path, 'w'|'a'|'wb'|'ab'|'w+'|'a+')
  /Path\([^)]*\)\.open\(/,
  /write_text\s*\(/,
  /write_bytes\s*\(/,
  /writeFileSync\s*\(/,
  /\bwriteFile\s*\(/,
  /appendFile\s*\(/,
  /createWriteStream\s*\(/,
  /fs\.promises/,
  /Bun\.write/,
  /Deno\.write/,
  /os\.remove/,
  /os\.rename/,
  /os\.system/,
  /subprocess/,
  /shutil\./,
  /child_process/,
  /execSync/,
];

const HEREDOC_MARKER_REGEX = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

/**
 * Extract the inline script text this interpreter invocation will execute,
 * from a `-c`/`-e`/`-p` argument and/or a heredoc body embedded in the raw
 * command string. Returns null when this invocation is not one of those
 * script-carrying forms (e.g. `python3 script.py`, which is out of scope for
 * this narrow, conservative check).
 */
function extractInterpreterScriptText(
  rawCommand: string,
  args: string[],
): string | null {
  let scriptText = "";
  let triggered = false;

  const flagIndex = args.findIndex(
    (arg) => arg === "-c" || arg === "-e" || arg === "-p",
  );
  if (flagIndex !== -1) {
    triggered = true;
    const inline = args[flagIndex + 1];
    if (inline !== undefined) {
      scriptText += `${inline}\n`;
    }
  }
  if (args.some((arg) => arg === "-" || arg === "eval")) {
    triggered = true;
  }

  const heredocMatch = rawCommand.match(HEREDOC_MARKER_REGEX);
  if (heredocMatch?.[0]) {
    triggered = true;
    const markerEnd =
      rawCommand.indexOf(heredocMatch[0]) + heredocMatch[0].length;
    scriptText += `${rawCommand.slice(markerEnd)}\n`;
  }

  return triggered ? scriptText : null;
}

function hasInterpreterWriteIndicator(scriptText: string): boolean {
  return INTERPRETER_WRITE_INDICATOR_PATTERNS.some((re) => re.test(scriptText));
}

function extractQuotedStringLiterals(scriptText: string): string[] {
  const literals: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(scriptText)) !== null) {
    const value = match[1] !== undefined ? match[1] : match[2];
    if (value !== undefined) {
      literals.push(value);
    }
  }
  return literals;
}

function isUnderSegmentRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * `/tmp` and any of `$CLAUDE_JOB_DIR` / `$DOCUMENT_WORKFLOW_DIR` that happen
 * to be set to an absolute path. Checked against literals that are
 * themselves absolute (spec K3).
 */
function absoluteInterpreterScratchRoots(): string[] {
  const roots: string[] = ["/tmp"];
  for (const envVar of ["CLAUDE_JOB_DIR", "DOCUMENT_WORKFLOW_DIR"]) {
    const value = process.env[envVar]?.trim();
    if (value && value.startsWith("/")) {
      roots.push(stripTrailingSlash(expandTilde(value)));
    }
  }
  return roots;
}

/**
 * `.tmp` and any of `$CLAUDE_JOB_DIR` / `$DOCUMENT_WORKFLOW_DIR` that happen
 * to be set to a relative path. Checked against literals that are themselves
 * relative -- as the literal's own written text, NOT resolved against `cwd`.
 *
 * This split (absolute-vs-absolute, relative-vs-relative-text) is
 * deliberate: resolving every literal against `cwd` before comparing to
 * `/tmp` would make the check vacuous whenever the project itself happens to
 * be checked out under `/tmp` (true of every mkdtemp-based test fixture in
 * this suite) -- a relative literal like `src/x.ts` would then trivially
 * read as "under /tmp" and never be denied. Comparing the literal's own text
 * against the relative roots sidesteps that, and matches how `.tmp/` reads
 * in spec K3 to begin with: a project-root-relative prefix, not an absolute
 * path fragment.
 */
function relativeInterpreterScratchRoots(): string[] {
  const roots: string[] = [".tmp"];
  for (const envVar of ["CLAUDE_JOB_DIR", "DOCUMENT_WORKFLOW_DIR"]) {
    const value = process.env[envVar]?.trim();
    if (value && !value.startsWith("/")) {
      roots.push(stripTrailingSlash(value));
    }
  }
  return roots;
}

/**
 * A path literal is "provably scratch" only when it is not itself inside
 * wfDir, and either (a) it is absolute and falls under an absolute scratch
 * root, or (b) it is relative and its own text falls under a relative
 * scratch root prefix.
 *
 * The wfDir exclusion is checked first via `resolve(cwd, literal)` -- safe
 * here (unlike the broad roots above) because wfDir is one specific,
 * narrow directory rather than something every fixture might coincidentally
 * sit inside of. wfDir is generally a descendant of `.tmp/`, so without this
 * exclusion a script writing straight into plan.md/spec.md would read as
 * "scratch" and be silently allowed, bypassing the Write/Edit path that
 * triggers `plan-review-automation`. Denying it here routes the model back
 * to Write/Edit (or a plain heredoc redirect), which does trigger review.
 */
function isPathWithinInterpreterScratch(
  literal: string,
  cwd: string,
  wfDir: string,
): boolean {
  if (literal.includes("..")) {
    return false;
  }
  const resolvedAgainstCwd = resolve(cwd, literal);
  if (isUnderSegmentRoot(resolvedAgainstCwd, wfDir)) {
    return false;
  }
  if (literal.startsWith("/")) {
    return absoluteInterpreterScratchRoots().some((root) =>
      isUnderSegmentRoot(literal, root),
    );
  }
  return relativeInterpreterScratchRoots().some((root) =>
    isUnderSegmentRoot(literal, root),
  );
}

/**
 * True when this interpreter invocation should be conservatively denied:
 * its script text contains a write indicator AND at least one of {no
 * path-like literal is present, a path-like literal resolves outside every
 * scratch root, a path literal contains ".."} holds. Path-like means the
 * literal contains "/" -- a bare mode flag ('w') or file content ('h') never
 * qualifies, so only literals that plausibly denote a path drive this
 * decision (spec K3, plan-2 T3).
 */
function isInterpreterWriteDenyWorthy(
  rawCommand: string,
  args: string[],
  cwd: string,
  wfDir: string,
): boolean {
  const scriptText = extractInterpreterScriptText(rawCommand, args);
  if (scriptText === null || !hasInterpreterWriteIndicator(scriptText)) {
    return false;
  }
  const pathLikeLiterals = extractQuotedStringLiterals(scriptText).filter(
    (lit) => lit.includes("/"),
  );
  if (pathLikeLiterals.length === 0) {
    return true;
  }
  return pathLikeLiterals.some(
    (lit) => !isPathWithinInterpreterScratch(lit, cwd, wfDir),
  );
}

/**
 * `round`/`stamp`/`triage`, the three `workflow-cli` subcommands that write
 * to a workflow document (spec K5). `status` is deliberately excluded — it
 * only reads.
 */
const WORKFLOW_CLI_WRITE_SUBCOMMANDS = new Set(["round", "stamp", "triage"]);
const WORKFLOW_DOC_FILENAME_REGEX = /^(plan-[0-9]+\.md|spec\.md)$/;

/**
 * True for the `workflow-cli` wrapper by name, or a direct
 * `bun .../cli/workflow.ts` invocation of the same script (spec K5's
 * `home/dot_local/bin/executable_workflow-cli` wrapper execs the latter).
 */
function isWorkflowCliInvocation(lowerName: string, args: string[]): boolean {
  if (lowerName === "workflow-cli") {
    return true;
  }
  if (lowerName === "bun") {
    return args.some(
      (arg) => arg === "cli/workflow.ts" || arg.endsWith("/cli/workflow.ts"),
    );
  }
  return false;
}

/**
 * Find `round|stamp|triage <doc>` in the command's args and, if `<doc>` is a
 * bare `plan-N.md`/`spec.md` filename, resolve it against `wfDir` (not cwd —
 * that is the CLI's own argument convention, spec K5). Returns null when no
 * write subcommand is present or its doc argument is not a bare workflow
 * document filename.
 */
function extractWorkflowCliDocTarget(
  args: string[],
  wfDir: string,
): string | null {
  const subIndex = args.findIndex((arg) =>
    WORKFLOW_CLI_WRITE_SUBCOMMANDS.has(arg),
  );
  if (subIndex === -1) {
    return null;
  }
  const docArg = args[subIndex + 1];
  if (!docArg || !WORKFLOW_DOC_FILENAME_REGEX.test(docArg)) {
    return null;
  }
  return resolve(wfDir, docArg);
}

function analyzeSingleCommand(
  command: string,
  cwd: string,
  wfDir: string,
  gateClosed: boolean,
): WriteAnalysis {
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
  } else if (["cp", "mv", "install", "ln"].includes(lower)) {
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
  } else if (isWorkflowCliInvocation(lower, args)) {
    // spec K5: `workflow-cli round|stamp|triage <plan-N.md|spec.md>` writes
    // are always a wfDir document write, resolved against wfDir (not cwd) —
    // the CLI's own argument convention takes a bare doc filename. This
    // makes the classification explicit (isDocumentPath then allows it, same
    // as a direct Write/Edit to the doc would) rather than leaving the call
    // unclassified and falling through by accident.
    const docTarget = extractWorkflowCliDocTarget(args, wfDir);
    if (docTarget) {
      isWriteLike = true;
      commandTargets.push(docTarget);
    }
  } else if (
    gateClosed &&
    INTERPRETER_NAMES.has(lower) &&
    isInterpreterWriteDenyWorthy(command, args, cwd, wfDir)
  ) {
    // Deliberately no target push: this routes through the existing
    // "write-like with no extractable target" conservative-deny path
    // (spec K3) rather than the normal per-target plan-ownership check.
    isWriteLike = true;
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

// Delegates to the single shared canonical hash (lib/document-hash.ts) so the
// guard holds no private copy of the invariant it enforces (spec K4). The
// call sites keep the original single-arg signature for a minimal diff.
function computePlanHash(content: string): string {
  return computeDocumentHash(content, SPEC_NORMALIZERS);
}

// The marker scanner is shared with plan-review-automation via workflow-marker
// (spec K4/N7). Re-exported under the original name so existing tests and call
// sites are unchanged; the returned shape now also carries `designHash`, which
// the guard's judgment paths (hasApprovedPlan/checkTarget) do not read.
const extractLatestAutoReviewMarker: (
  content: string,
) => AutoReviewMarker | null = parseLatestAutoReviewMarker;

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
