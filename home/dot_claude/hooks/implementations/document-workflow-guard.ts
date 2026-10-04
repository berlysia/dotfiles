#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import {
  createStartIndex,
  type OracleMatcher,
  type TextMatcher,
} from "../lib/linear-match.ts";
import { GUARDED_TOOLS } from "../lib/guarded-tools.ts";
import { hasParentSegment, isUnderRoot } from "../lib/path-containment.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { expandTilde } from "../lib/path-utils.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import { collectTempRoots } from "../lib/temp-roots.ts";
import { appendOffPlanLog } from "../lib/workflow-audit-log.ts";
import {
  APPROVALS_LOG,
  isApprovalLikeQuestion,
  isApprovalShapedPrompt,
} from "../lib/workflow-approval.ts";
import { resolveWithMissingTail } from "../lib/workflow-fs.ts";
import { LENIENT_APPROVED_LINE } from "../lib/workflow-marker.ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import {
  classifyExemption,
  evaluateTarget,
  formatGateDiagnosis,
  isImplementationPhase,
  isWorkflowActive,
  readWorkflowState,
  type TargetEvaluation,
} from "../lib/workflow-gate.ts";
import "../types/tool-schemas.ts";

// Tools that schedule a prompt to fire later. A set of which kind of branch
// the guard takes, not of which tools it is registered for (GUARDED_TOOLS), so
// it lives here.
const SCHEDULING_TOOLS = new Set(["CronCreate", "ScheduleWakeup"]);

/**
 * Appended to every deny so a blocked throwaway write learns where it can go.
 * Literal paths outside the project are already allowed; what was missing was
 * the pointer (session 115e2d54 hit three denies in a row). The destinations
 * are narrowed on purpose -- the model acts on this text, and "anywhere
 * outside the project" would include $HOME and other repositories.
 *
 * Kept in step with the matching rule in rules/workflow.md (CRITICAL section).
 * Not passed through sanitizeForDisplay: that strips the backticks. Why this
 * is a hint rather than an in-project `.tmp/` exemption:
 * docs/decisions/0018-workflow-gate-no-in-project-scratch-exemption.md.
 */
const SCRATCH_HINT =
  "hint: if this is throwaway work, put it only under the session scratchpad or a fresh `mktemp -d` directory — never in other repositories, $HOME, or dotfiles. Run `mktemp -d` first, then write the printed path literally in the next command: targets are read as literal text, so shell variables are not expanded and `cd` is not followed.";

function withScratchHint(reason: string): string {
  return `${reason}\n${SCRATCH_HINT}`;
}

const ASK_PREFILLED_DENY =
  "承認の質問の回答は利用者が選ぶもので、`answers` / `annotations` を model が入れることはできない。`workflow-cli ask-approval` の出力をそのまま AskUserQuestion に渡す";

/** `answers` or `annotations` is present and not undefined. */
function hasPrefilledAnswer(toolInput: unknown): boolean {
  if (typeof toolInput !== "object" || toolInput === null) return false;
  const input = toolInput as { answers?: unknown; annotations?: unknown };
  return input.answers !== undefined || input.annotations !== undefined;
}

interface WriteAnalysis {
  isWriteLike: boolean;
  targets: string[];
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    try {
      const { tool_name, tool_input } = context.input;
      if (!GUARDED_TOOLS.has(tool_name)) {
        return context.success({});
      }

      // AskUserQuestion is handled on its own and always returns: the answer
      // to an approval question is the user's, so a model-supplied `answers`
      // or `annotations` on one is refused (spec K4). Decided from the input
      // alone, before any workflow state is read.
      if (tool_name === "AskUserQuestion") {
        try {
          const questions = (tool_input as { questions?: unknown } | null)
            ?.questions;
          if (
            isApprovalLikeQuestion(questions) &&
            hasPrefilledAnswer(tool_input)
          ) {
            return context.json(createDenyResponse(ASK_PREFILLED_DENY));
          }
          return context.success({});
        } catch {
          // Reading the input itself failed. Treat a present answers /
          // annotations as the thing to refuse, so a model cannot push the
          // check into an exception and get `answers` through.
          try {
            if (hasPrefilledAnswer(tool_input)) {
              return context.json(createDenyResponse(ASK_PREFILLED_DENY));
            }
            return context.json({
              event: "PreToolUse",
              output: {
                systemMessage:
                  "[document-workflow-guard] could not read the AskUserQuestion input to check it for pre-filled answers; allowing the call because it carries no answers.",
              },
            });
          } catch {
            return context.json(createDenyResponse(ASK_PREFILLED_DENY));
          }
        }
      }

      // Issue J: a fired scheduled prompt reaches approval-recorder looking
      // like a typed one (`source` is absent for both in Claude Code
      // 2.1.287), so the only place to refuse it is when it is scheduled.
      // Decided on the prompt text alone, before any workflow state is read,
      // and fail-closed: the outer catch below fails open.
      if (SCHEDULING_TOOLS.has(tool_name)) {
        try {
          const prompt =
            typeof tool_input === "object" && tool_input !== null
              ? (tool_input as { prompt?: unknown }).prompt
              : undefined;
          if (isApprovalShapedPrompt(prompt)) {
            return context.json(
              createDenyResponse(
                "承認は利用者が行うもので、予約したプロンプトでは記録しない（課題 J）。`承認` / `approve` だけのプロンプトは予約できない。承認が必要なら、`workflow-cli ask-approval` の出力で AskUserQuestion を出すか、利用者に会話で `approve` と打ってもらう",
              ),
            );
          }
          return context.success({});
        } catch {
          return context.json(
            createDenyResponse(
              "予約するプロンプトを検査できなかったので予約を止めた（課題 J）。承認は利用者が行うもので、承認が必要なら、`workflow-cli ask-approval` の出力で AskUserQuestion を出すか、利用者に会話で `approve` と打ってもらう",
            ),
          );
        }
      }

      const cwd = getToolCwd();
      const projectRoot = getProjectRoot();
      const resolution = resolveWorkflowDir({
        cwd: projectRoot,
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
                : "[document-workflow-guard] could not verify that the derived workflow directory is a strict descendant of <project root>/.tmp/sessions; the gate is not enforcing for this call.",
          },
        });
      }
      const wfDir = resolution.dir;

      // K9: approval is a human utterance recorded by approval-recorder. A
      // tool write that makes a document read as approved, or touches a
      // ledger, is refused whatever phase the workflow is in -- the gate
      // would still hold (K8), but the document would mislead both the
      // human and the model into thinking it was approved (#221).
      const approvalWriteReason = checkApprovalWrite(
        tool_name,
        tool_input,
        cwd,
        projectRoot,
        wfDir,
      );
      if (approvalWriteReason !== null) {
        return context.json(createDenyResponse(approvalWriteReason));
      }

      const exemptionOf = (path: string) =>
        classifyExemption(resolve(cwd, expandTilde(path)), projectRoot, wfDir);

      const wfPaths = resolveWorkflowPaths(wfDir);
      if (!isWorkflowActive(wfPaths, readWorkflowState(wfPaths.state))) {
        return context.success({});
      }

      const warnOnly = process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1";
      const twoLayer = existsSync(wfPaths.spec);
      const wfDirLabel = sanitizeForDisplay(resolution.relative);
      const docLabel = `${wfDirLabel}/${twoLayer ? "spec.md" : "plan.md"}`;
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

        const targetCount = analysis.targets.length;
        if (
          targetCount > 0 &&
          analysis.targets.every((t) => exemptionOf(t) === "workflow-document")
        ) {
          return context.success({});
        }
        if (
          targetCount > 0 &&
          analysis.targets.every((t) => exemptionOf(t) === "outside-project")
        ) {
          return context.success({});
        }

        // Classified as write-like with zero targets means "could not tell
        // what it writes", not "writes nothing" (research.md §10.14).
        let reasonForThisCall = emptyTargetDenyReason;
        if (analysis.targets.length > 0) {
          const evaluations = analysis.targets.map((target) =>
            evaluateTarget({
              wfDir,
              target: resolve(cwd, expandTilde(target)),
              projectRoot,
              label: target,
            }),
          );
          const blockedIndex = evaluations.findIndex(isBlocked);
          if (blockedIndex === -1) {
            evaluations.forEach((evaluation, i) => {
              if (evaluation.kind !== "no-plan-owner") return;
              const target = analysis.targets[i] ?? "";
              console.error(
                `[document-workflow-guard][off-plan] Bash target \`${target}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
              );
              appendOffPlanLog(wfDir, "Bash", target);
            });
            return context.success({});
          }
          const blocked = evaluations[blockedIndex];
          if (blocked && isBlocked(blocked)) {
            reasonForThisCall = formatGateDiagnosis(
              blocked.diagnosis,
              sanitizeForDisplay(analysis.targets[blockedIndex] ?? ""),
              docLabel,
            );
          }
        }

        if (warnOnly) {
          console.error(
            `[document-workflow-guard][would-block] Bash: ${command}`,
          );
          return context.success({});
        }
        return context.json(
          createDenyResponse(withScratchHint(reasonForThisCall)),
        );
      }

      const targetPath = getTargetFilePath(tool_name, tool_input);
      if (!targetPath) {
        return context.success({});
      }

      if (exemptionOf(targetPath) !== null) {
        return context.success({});
      }

      const evaluation = evaluateTarget({
        wfDir,
        target: resolve(cwd, expandTilde(targetPath)),
        projectRoot,
        label: targetPath,
      });
      if (evaluation.kind === "allow" || evaluation.kind === "inactive") {
        return context.success({});
      }
      if (
        evaluation.kind === "no-plan-owner" &&
        evaluation.implementationPhase
      ) {
        console.error(
          `[document-workflow-guard][off-plan] ${tool_name} target \`${targetPath}\` is not listed in any plan-N.md Files section; allowed under implementation-phase relaxation. Recorded in \`${wfDirLabel}/off-plan-writes.log\`.`,
        );
        appendOffPlanLog(wfDir, tool_name, targetPath);
        return context.success({});
      }

      if (warnOnly) {
        console.error(
          `[document-workflow-guard][would-block] ${tool_name}: ${targetPath}`,
        );
        return context.success({});
      }

      return context.json(
        createDenyResponse(
          withScratchHint(
            formatGateDiagnosis(
              evaluation.diagnosis,
              sanitizeForDisplay(targetPath),
              docLabel,
            ),
          ),
        ),
      );
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

/**
 * The cwd at tool-call time, used to resolve relative paths in tool input.
 * The workflow dir and the inside/outside-project boundary are anchored on
 * getProjectRoot() instead.
 */
function getToolCwd(): string {
  return process.env.CLAUDE_TEST_CWD || process.cwd();
}

/** A target the gate does not let through, even under off-plan relaxation. */
function isBlocked(
  evaluation: TargetEvaluation,
): evaluation is Extract<TargetEvaluation, { kind: "deny" | "no-plan-owner" }> {
  return (
    evaluation.kind === "deny" ||
    (evaluation.kind === "no-plan-owner" && !evaluation.implementationPhase)
  );
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
  // Data-only heredoc bodies are emptied so their text is not read as write
  // targets (spec K3); interpreter and shell bodies are kept.
  const { individualCommands: commands } = await prepareDenyInput(command);

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

const WRITE_MODE_QUOTES = /['"][wa]\+?b?['"]/;

/**
 * Linear equivalent of `open\([^)]*['"][wa]\+?b?['"]`: an `open(` followed by a
 * write-mode string literal before the next `)`. The literal itself has no
 * `)`, so it only has to start before the first `)` at or after the `(`.
 * The oracle is test-only (the super-linear original); see linear-match.ts.
 */
export function openWithWriteMode(): OracleMatcher {
  return {
    oracle: /open\([^)]*['"][wa]\+?b?['"]/,
    test(text) {
      let at = text.indexOf("open(");
      if (at === -1) return false;
      const modes = createStartIndex(text, WRITE_MODE_QUOTES);
      const closers = createStartIndex(text, /\)/);
      for (; at !== -1; at = text.indexOf("open(", at + 1)) {
        const argsStart = at + "open(".length;
        if (
          modes.firstAtOrAfter(argsStart) < closers.firstAtOrAfter(argsStart)
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Linear equivalent of `Path\([^)]*\)\.open\(`: the first `)` after a `Path(`
 * is followed directly by `.open(`.
 * The oracle is test-only (the super-linear original); see linear-match.ts.
 */
export function pathOpen(): OracleMatcher {
  return {
    oracle: /Path\([^)]*\)\.open\(/,
    test(text) {
      let at = text.indexOf("Path(");
      if (at === -1) return false;
      const closers = createStartIndex(text, /\)/);
      for (; at !== -1; at = text.indexOf("Path(", at + 1)) {
        const closer = closers.firstAtOrAfter(at + "Path(".length);
        if (closer !== Infinity && text.startsWith(".open(", closer + 1)) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Substring/pattern indicators that a script body performs a filesystem (or
 * process-spawning) write. Deliberately narrower than "contains .write(":
 * `sys.stdout.write(...)` / `process.stdout.write(...)` are common in
 * read-only scripts and must not trip this classifier (spec K3 read-only
 * allow case). Exported for the differential test
 * (linear-match-equivalence.test.ts). Do not add a regex of the form
 * `X\s+.*Y` / `X.*Y` / `X[^)]*Y` here; use a linear matcher (see Issue #219).
 */
export const INTERPRETER_WRITE_INDICATOR_PATTERNS: ReadonlyArray<TextMatcher> =
  [
    openWithWriteMode(), // open(path, 'w'|'a'|'wb'|'ab'|'w+'|'a+')
    pathOpen(),
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

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

/**
 * `/tmp` and any of `$CLAUDE_JOB_DIR` / `$DOCUMENT_WORKFLOW_DIR` that happen
 * to be set to an absolute path. Checked against literals that are
 * themselves absolute (spec K3).
 */
function absoluteInterpreterScratchRoots(): string[] {
  const roots: string[] = collectTempRoots("", realpathSync);
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
  if (hasParentSegment(literal)) {
    return false;
  }
  const resolvedAgainstCwd = resolve(cwd, literal);
  if (isUnderRoot(resolvedAgainstCwd, wfDir)) {
    return false;
  }
  if (literal.startsWith("/")) {
    return absoluteInterpreterScratchRoots().some((root) =>
      isUnderRoot(literal, root),
    );
  }
  return relativeInterpreterScratchRoots().some((root) =>
    isUnderRoot(literal, root),
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
    // makes the classification explicit (classifyExemption then allows it, same
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

function countApprovedLines(content: string): number {
  return content.match(LENIENT_APPROVED_LINE)?.length ?? 0;
}

/** Paths compare without case: macOS's filesystem ignores it and Node's realpath keeps what was typed. */
function isUnder(path: string, dir: string): boolean {
  return path.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
}

/**
 * Why a Write / Edit / MultiEdit must be refused as an approval write, or
 * null. Approved Approval lines are counted in their lenient form, so a
 * hyphen-less `Approval Status: approved` (which the gate's strict form
 * ignores but a reader would not) is caught, and an old text that merely
 * quotes such a line does not let the real line be flipped. Paths compare
 * as realpaths so a symlinked or aliased path into the workflow dir is
 * judged the same way.
 */
function checkApprovalWrite(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  projectRoot: string,
  wfDir: string,
): string | null {
  // Fail closed: this check runs inside the guard's catch-all, which allows
  // the call on an exception. A write the guard cannot judge is refused.
  try {
    return judgeApprovalWrite(toolName, toolInput, cwd, projectRoot, wfDir);
  } catch (error) {
    return `Could not judge whether this write sets approval or touches a ledger (${sanitizeForDisplay(String(error))}); refused.`;
  }
}

function judgeApprovalWrite(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  projectRoot: string,
  wfDir: string,
): string | null {
  if (!isRecord(toolInput)) return null;
  if (toolName !== "Write" && toolName !== "Edit" && toolName !== "MultiEdit")
    return null;
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string") return null;
  const target = resolve(cwd, expandTilde(filePath));
  const realTarget = resolveWithMissingTail(target) ?? target;

  const sessionsDir = resolve(projectRoot, ".tmp", "sessions");
  const realSessions = resolveWithMissingTail(sessionsDir) ?? sessionsDir;
  if (
    basename(realTarget).toLowerCase() === APPROVALS_LOG &&
    isUnder(realTarget, realSessions)
  ) {
    return `${APPROVALS_LOG} is written only by approval-recorder (the user says 承認 / approve in the conversation) and approval-answer-recorder (the user answers the AskUserQuestion that \`workflow-cli ask-approval\` generates); tool writes to any session's ledger are refused.`;
  }

  const realWfDir = resolveWithMissingTail(wfDir) ?? wfDir;
  if (!isUnder(realTarget, realWfDir) || !/\.md$/i.test(realTarget))
    return null;
  let oldContent: string | null = null;
  try {
    oldContent = existsSync(target) ? readFileSync(target, "utf-8") : null;
  } catch {
    oldContent = null; // unreadable: judge as if new, so an approved write is refused
  }
  const newContent = contentAfterWrite(toolName, toolInput, oldContent);
  if (newContent === null) return null;
  if (countApprovedLines(newContent) <= countApprovedLines(oldContent ?? ""))
    return null;
  return `Approval is recorded only from the user's own action, by approval-recorder (the user writes \`approve ${basename(target)}\` in the conversation) or approval-answer-recorder (the user answers the AskUserQuestion from \`workflow-cli ask-approval\`): run \`workflow-cli ask-approval\` and pass its output to AskUserQuestion, or ask the user to write it. Writes that set \`Approval Status: approved\` are refused; setting it back to pending (revoking) is allowed.`;
}

/** The file content a Write / Edit / MultiEdit would leave, or null when it cannot be told. */
function contentAfterWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  oldContent: string | null,
): string | null {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  const edits =
    toolName === "Edit"
      ? [toolInput]
      : Array.isArray(toolInput.edits)
        ? (toolInput.edits as unknown[])
        : [];
  let content = oldContent ?? "";
  for (const edit of edits) {
    if (
      !isRecord(edit) ||
      typeof edit.old_string !== "string" ||
      typeof edit.new_string !== "string"
    ) {
      return null;
    }
    const replacement = edit.new_string;
    if (!content.includes(edit.old_string)) {
      // The real tool may still match (it normalizes quotes); judge as if the
      // new text were added, so an approved line in it is counted.
      content = `${content}\n${replacement}`;
      continue;
    }
    content =
      edit.replace_all === true
        ? content.split(edit.old_string).join(replacement)
        : content.replace(edit.old_string, () => replacement);
  }
  return content;
}
