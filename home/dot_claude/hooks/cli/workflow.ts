#!/usr/bin/env -S bun run --silent

/**
 * `workflow-cli`: the only writer of Document Workflow bookkeeping (spec K5).
 * Before this, the model itself computed hashes and copied them into marker
 * text by hand — a transcription surface that produced stuck sessions when a
 * digit was mistyped (research P5). `stamp` also verifies, from the reviewer
 * ledger `reviewer-run-recorder.ts` writes, that the reviewers it is about to
 * credit with a verdict actually ran this session (spec K5 / R4) — a model
 * cannot claim "reviews done" without the Agent tool calls to back it up.
 *
 * `runWorkflowCli` is a pure function: no `process.exit`, no ambient
 * `process.cwd()` reads inside it. All environment facts arrive via `deps`,
 * so `node --test` can call it directly (spec K5's architecture-strategist
 * finding: "no spawn needed"). `resolveCliDeps` and the `import.meta.main`
 * block below are the only places this file reads the real process
 * environment; `runWorkflowCli` itself stays pure.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { expandTilde } from "../lib/path-utils.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import {
  buildApprovalQuestions,
  MAX_DOCS_PER_QUESTION,
  readLatestApprovals,
} from "../lib/workflow-approval.ts";
import {
  classifyExemption,
  diagnoseGate,
  evaluateApprovalReadiness,
  evaluateTarget,
  formatGateChecklist,
  formatTargetEvaluation,
  listApprovalCandidates,
  summarizePlans,
} from "../lib/workflow-gate.ts";
import { isStrictlyUnderProjectSubdir } from "../lib/workflow-fs.ts";
import { lastPassMarkerRound } from "../lib/workflow-marker.ts";
import {
  getWorkflowDocumentType,
  resolveWorkflowPaths,
  type WorkflowDocumentType,
} from "../lib/workflow-paths.ts";
import {
  bareSlug,
  computeDesignHash,
  computeDocumentHash,
  countReviewerOutputsRounds,
  type ExtensionApprover,
  formatExtensionLogLine,
  formatRoundBudgetGuidance,
  formatRoundBudgetHeadline,
  getReframerReviewFileName,
  getRoundBudgetPhase,
  getRoundsInCycle,
  isExtensionAllowed,
  PLAN_NORMALIZERS,
  parseLatestReframerReview,
  planRoundReviewers,
  REFRAMER_AGENT,
  ROUND_BUDGET,
  ROUND_REFRAMER_CAP,
  ROUND_SELF_CAP,
  type RoundReviewerPlan,
  reviewersForDocumentType,
  sanitizeExtensionReason,
  SPEC_NORMALIZERS,
} from "../lib/workflow-review-core.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

/** Where a workflow dir came from. `override` is a --wf-dir flag. */
export type WfDirSource = "derived" | "env" | "override";

export interface RunWorkflowCliDeps {
  cwd: string;
  /** Default/fallback workflow dir (e.g. already resolved via `resolveWorkflowDir`). */
  wfDir: string;
  /**
   * Where `wfDir` came from: derived from the session id, a startup pin, or
   * `none` when nothing resolved and only a --wf-dir flag can name the dir
   * (`wfDir` is then empty and every command requires the flag).
   */
  wfDirSource: Exclude<WfDirSource, "override"> | "none";
  sessionId: string;
  now: Date;
  /** Test-only override for the ledger path; defaults to `<wfDir>/reviewer-runs.log`. */
  ledgerPath?: string | undefined;
}

export interface RunWorkflowCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const SESSIONS_SUBDIR = ".tmp/sessions";
const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;
const APPROVAL_STATUS_LINE_REGEX = /^- Approval Status:.*$/m;
const REVIEW_STATUS_FIND_REGEX = /^\s*-?\s*Review Status:.*$/m;
const VALID_VERDICTS = new Set(["pass", "needs-work", "blocker"]);

export type ResolvedCliDeps =
  | { deps: RunWorkflowCliDeps; warning: string | null }
  | { error: string };

const RESTART_HINT =
  "restart Claude Code if this session started before the hooks were deployed (and do not rely on the DOCUMENT_WORKFLOW_DIR value the old SessionStart exported), or pass --wf-dir <dir> from the project root.";

/**
 * The CLI's root, session and workflow dir, taken from the same inputs the
 * hooks use (spec K3): the root from getProjectRoot(), the session from
 * CLAUDE_CODE_SESSION_ID (Claude Code passes it to the Bash tool and it
 * follows /clear, unlike the CLAUDE_SESSION_ID the SessionStart hook used to
 * export), the dir from resolveWorkflowDir. Without those values the CLI
 * fails instead of guessing from process.cwd(), unless --wf-dir names the
 * dir -- then the root is process.cwd() (a human at a terminal in the
 * project root) and resolveTargetWfDir validates the flag.
 */
export function resolveCliDeps(argv: string[], now: Date): ResolvedCliDeps {
  const hasWfDirFlag = Boolean(parseArgs(argv).flags["wf-dir"]);
  const rootEnv = process.env.CLAUDE_TEST_CWD || process.env.CLAUDE_PROJECT_DIR;
  if (!rootEnv && !hasWfDirFlag) {
    return {
      error: `CLAUDE_PROJECT_DIR is not set. The SessionStart hook exports it; ${RESTART_HINT}`,
    };
  }
  if (rootEnv && !isExistingAbsoluteDir(rootEnv)) {
    return {
      error: `CLAUDE_PROJECT_DIR="${sanitizeForDisplay(rootEnv)}" is not an existing absolute directory; ${RESTART_HINT}`,
    };
  }
  const cwd = getProjectRoot();
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (!sessionId) {
    if (hasWfDirFlag) {
      return {
        deps: { cwd, wfDir: "", wfDirSource: "none", sessionId, now },
        warning: null,
      };
    }
    return {
      error:
        "CLAUDE_CODE_SESSION_ID is not set (Claude Code passes it to its Bash tool). Outside Claude Code, pass --wf-dir <dir>.",
    };
  }
  const resolution = resolveWorkflowDir({ cwd, sessionId });
  if (resolution.source === "unresolvable") {
    if (hasWfDirFlag) {
      return {
        deps: { cwd, wfDir: "", wfDirSource: "none", sessionId, now },
        warning: null,
      };
    }
    return {
      error:
        resolution.reason === "invalid-session-id"
          ? `CLAUDE_CODE_SESSION_ID="${sanitizeForDisplay(sessionId)}" is not a valid session id; pass --wf-dir <dir>.`
          : `could not verify that the derived workflow dir is a strict descendant of ${cwd}/${SESSIONS_SUBDIR}; pass --wf-dir <dir>.`,
    };
  }
  return {
    deps: {
      cwd,
      wfDir: resolution.dir,
      wfDirSource: resolution.source === "env" ? "env" : "derived",
      sessionId,
      now,
    },
    warning:
      resolution.source === "env-rejected"
        ? `DOCUMENT_WORKFLOW_DIR="${sanitizeForDisplay(process.env.DOCUMENT_WORKFLOW_DIR ?? "")}" is not a verified descendant of ${cwd}/${SESSIONS_SUBDIR}; using the session-derived dir.`
        : null,
  };
}

function isExistingAbsoluteDir(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function runWorkflowCli(
  argv: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return cmdStatus(rest, deps);
    case "dir":
      return cmdDir(rest, deps);
    case "round":
      return cmdRound(rest, deps);
    case "stamp":
      return cmdStamp(rest, deps);
    case "triage":
      return cmdTriage(rest, deps);
    case "ask-approval":
      return cmdAskApproval(rest, deps);
    default:
      return err(
        `unknown command: ${command ?? "<none>"}\nusage: workflow-cli <status|dir|round|stamp|triage|ask-approval> [doc] [--flags]`,
      );
  }
}

function err(message: string): RunWorkflowCliResult {
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}

function ok(stdout: string, warning: string | null): RunWorkflowCliResult {
  return { exitCode: 0, stdout, stderr: warning ? `${warning}\n` : "" };
}

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

/** Flags that take no value, so `round --full spec.md` keeps `spec.md` positional. */
const BOOLEAN_FLAGS = new Set([
  "full",
  "extend",
  "self-extend",
  "reframer-extend",
]);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
        continue;
      }
      const value = args[i + 1];
      flags[key] = value ?? "";
      i++;
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

/**
 * Which wfDir this invocation targets: a --wf-dir flag (validated as a strict
 * descendant of .tmp/sessions) wins over the resolved `deps.wfDir`. A flag
 * that differs from the resolved dir is honoured with a warning; an invalid
 * or empty flag is an error rather than a fallback, since the operator named
 * a target (a smoke test once inserted a round into an approved spec by
 * falling back).
 */
function resolveTargetWfDir(
  flags: Record<string, string>,
  deps: RunWorkflowCliDeps,
):
  | {
      wfDir: string;
      source: WfDirSource;
      warning: string | null;
      error?: undefined;
    }
  | { error: string } {
  if ("wf-dir" in flags && !flags["wf-dir"]) {
    return { error: "--wf-dir needs a value" };
  }
  const flagValue = flags["wf-dir"];
  if (!flagValue) {
    if (deps.wfDirSource === "none") {
      return {
        error:
          "no workflow dir was resolved for this session; pass --wf-dir <dir>",
      };
    }
    return { wfDir: deps.wfDir, source: deps.wfDirSource, warning: null };
  }
  const candidate = resolve(deps.cwd, flagValue);
  if (!isStrictlyUnderProjectSubdir(deps.cwd, SESSIONS_SUBDIR, candidate)) {
    return {
      error: `--wf-dir "${sanitizeForDisplay(flagValue)}" is not a strict descendant of ${SESSIONS_SUBDIR}; refusing rather than falling back`,
    };
  }
  const warning =
    deps.wfDirSource !== "none" && candidate !== deps.wfDir
      ? `--wf-dir points at ${candidate}, not the resolved dir ${deps.wfDir} (source=${deps.wfDirSource})`
      : null;
  return { wfDir: candidate, source: "override", warning };
}

function approvalStatusLine(content: string): string | null {
  const m = content.match(APPROVAL_STATUS_LINE_REGEX);
  return m ? m[0] : null;
}

/**
 * Safety net shared by round/stamp/triage: none of them is allowed to write
 * a diff that touches the Approval Status line — approval is human-only
 * (spec R9). Structurally, none of the three write paths below ever edits
 * that line; this check exists so a future change to any of them that
 * accidentally does gets caught here rather than shipping.
 */
export function wouldTouchApprovalStatus(
  oldContent: string,
  newContent: string,
): boolean {
  return approvalStatusLine(oldContent) !== approvalStatusLine(newContent);
}

function normalizersFor(documentType: WorkflowDocumentType) {
  return documentType === "plan-numbered" ? PLAN_NORMALIZERS : SPEC_NORMALIZERS;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const { positional, flags } = parseArgs(args);
  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, warning } = resolvedDir;
  const wfPaths = resolveWorkflowPaths(wfDir);
  const twoLayer = existsSync(wfPaths.spec);
  const targetArg = positional[0];
  const docLabel = twoLayer ? "spec.md" : "plan.md";
  const lines: string[] = [];
  if (targetArg) {
    // The decision the guard makes for a write to this path (#209-2): its
    // shortcuts first, then the gate. The path is relative to where the CLI
    // runs, like any shell argument.
    const target = resolve(deps.cwd, expandTilde(targetArg));
    const label = sanitizeForDisplay(target);
    const exemption = classifyExemption(target, deps.cwd, wfDir);
    lines.push(
      exemption
        ? `Document workflow gate: \`${label}\` is not gated (${exemption === "workflow-document" ? "a workflow document" : "outside the project"}).`
        : formatTargetEvaluation(
            evaluateTarget({ projectRoot: deps.cwd, wfDir, target }),
            label,
            docLabel,
          ),
    );
  } else {
    // No target means no allow/deny verdict to state: in two-layer mode the
    // plan-N.md side is not evaluated here, so even a passing spec.md does
    // not mean a write is allowed.
    const primary = twoLayer ? wfPaths.spec : wfPaths.plan;
    const diagnosis = diagnoseGate(wfDir, primary, deps.cwd);
    lines.push(
      `Document workflow gate${twoLayer ? " (two-layer)" : ""}: conditions on \`${sanitizeForDisplay(docLabel)}\`:`,
      formatGateChecklist(diagnosis),
    );
    // The plan-N.md side, one line each, so the reader can tell which plans
    // are ready without asking about a path.
    if (twoLayer) {
      for (const plan of summarizePlans(wfDir, deps.cwd)) {
        const mark = plan.blockedBy
          ? `✗ ${plan.blockedBy}`
          : plan.via === "delegation"
            ? "✓ (delegated)"
            : "✓";
        lines.push(`plan: ${plan.name} ${mark}`);
      }
    }
  }

  if (existsSync(resolve(wfDir, ".tripwire-disabled"))) {
    lines.push("tripwire: disabled (see .tripwire-disabled for the reason)");
  } else if (existsSync(resolve(wfDir, ".tripwire-baseline"))) {
    lines.push("tripwire: armed");
  } else {
    lines.push("tripwire: not yet armed");
  }

  // The route of the latest recorded approval per document, so a human can
  // tell an utterance-recorded approval from an AskUserQuestion one.
  const { latest } = readLatestApprovals(wfDir);
  for (const [doc, record] of latest) {
    lines.push(
      `approval via: ${sanitizeForDisplay(doc)} via=${record.via ?? "unknown"}`,
    );
  }

  return ok(`${lines.join("\n")}\n`, warning);
}

// ---------------------------------------------------------------------------
// dir
// ---------------------------------------------------------------------------

/**
 * The workflow dir and where it came from, for the model to write documents
 * into (rules/workflow.md). A derived dir that does not exist yet is the
 * normal first use; a pinned or overridden one that does not exist is
 * probably a typo or an old session's dir, so that is warned about.
 */
function cmdDir(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const resolvedDir = resolveTargetWfDir(parseArgs(args).flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const warnings = [resolvedDir.warning];
  if (resolvedDir.source !== "derived" && !existsSync(resolvedDir.wfDir)) {
    warnings.push(
      `${resolvedDir.wfDir} does not exist (source=${resolvedDir.source})`,
    );
  }
  return ok(
    `wfDir=${resolvedDir.wfDir}\nsource=${resolvedDir.source}\n`,
    warnings.filter(Boolean).join("\n") || null,
  );
}

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

function insertBeforeLatestMarker(content: string, insertion: string): string {
  const matches = [...content.matchAll(REVIEW_MARKER_REGEX)];
  const trimmedInsertion = insertion.trimEnd();
  if (matches.length === 0) {
    return `${content.trimEnd()}\n\n${trimmedInsertion}\n`;
  }
  const last = matches[matches.length - 1];
  const idx = last?.index ?? content.length;
  const before = content.slice(0, idx).trimEnd();
  const after = content.slice(idx);
  return `${before}\n\n${trimmedInsertion}\n\n${after}`;
}

function appendRoundBaseline(wfDir: string, round: number, now: Date): void {
  try {
    const path = resolve(wfDir, ".round-baseline");
    const fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${round}\t${now.toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort
  }
}

const EXTENSION_NOTES: Record<ExtensionApprover, string> = {
  human: `extended beyond round budget (${ROUND_BUDGET})`,
  self: `self-extended beyond round budget (${ROUND_BUDGET}); self cap ${ROUND_SELF_CAP}`,
  reframer: `reframer-extended beyond self cap (${ROUND_SELF_CAP}); reframer cap ${ROUND_REFRAMER_CAP}`,
};

function isBareMarkdownName(name: string): boolean {
  return name.endsWith(".md") && name.length > ".md".length;
}

/**
 * Write commands take a bare document name only: the reframer record file
 * and the extension log are keyed by it, and a path like `../plan.md` would
 * write outside the workflow dir (spec K5).
 */
function bareDocumentNameError(docName: string): string | null {
  if (basename(docName) !== docName || !isBareMarkdownName(docName)) {
    return `invalid document name "${docName}": the document name must be a bare file name ending in .md (e.g. plan-1.md), not a path`;
  }
  return null;
}

/** The provenance lines every successful write command ends with (spec K5). */
function provenanceLines(wfDir: string, source: string, wrote: string): string {
  return `wfDir=${wfDir}\nsource=${source}\nwrote=${wrote}\n`;
}

/**
 * Why a `--reframer-extend` is not backed, or null when it is. The claim that
 * the reframer recommended continuing rests on two artifacts: the record file
 * section the main loop wrote, and the ledger line the launch hook wrote. The
 * section must be the cycle's single consultation (round = cycle start + self
 * cap), so appending a later section cannot redo it. Neither artifact proves
 * the recommendation was truthfully transcribed (an accepted limitation).
 */
function checkReframerBacking(
  wfDir: string,
  docName: string,
  docContent: string,
  deps: RunWorkflowCliDeps,
): string | null {
  const recordName = getReframerReviewFileName(docName);
  const recordPath = resolve(wfDir, recordName);
  if (!existsSync(recordPath)) {
    return `reframer record file ${recordName} not found; consult ${REFRAMER_AGENT} and record its result first`;
  }
  const review = parseLatestReframerReview(readFileSync(recordPath, "utf-8"));
  if (review === null) {
    return `${recordName} has no valid "Reframer Review (Round N)" section (the last section needs exactly one "- agent:" and one "- recommendation:" line)`;
  }
  const expectedRound = lastPassMarkerRound(docContent) + ROUND_SELF_CAP;
  if (review.round !== expectedRound) {
    return `the Reframer Review section is for round ${review.round}, but this cycle's consultation must be round ${expectedRound}`;
  }
  if (review.agent !== REFRAMER_AGENT) {
    return `"- agent:" in ${recordName} must be exactly ${REFRAMER_AGENT} (found "${review.agent}")`;
  }
  if (review.recommendation !== "(a)") {
    return `"- recommendation:" in ${recordName} must be exactly (a) to continue (found "${review.recommendation}"); other recommendations go to the human`;
  }
  const baseline = readRoundBaselineTime(wfDir, review.round);
  if (baseline === null) {
    return `baseline missing for round ${review.round}, so the ${REFRAMER_AGENT} launch cannot be verified`;
  }
  const ledgerPath = deps.ledgerPath ?? resolve(wfDir, "reviewer-runs.log");
  if (!readLedgerSlugsAtOrAfter(ledgerPath, baseline).has(REFRAMER_AGENT)) {
    return `no ${REFRAMER_AGENT} run recorded since the round ${review.round} baseline; launch it with the Agent tool`;
  }
  return null;
}

function cmdRound(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const { positional, flags } = parseArgs(args);
  const docName = positional[0];
  if (!docName) {
    return err("round requires a document name (plan-N.md or spec.md)");
  }
  const nameError = bareDocumentNameError(docName);
  if (nameError) return err(nameError);
  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, source, warning } = resolvedDir;
  const docPath = resolve(wfDir, docName);
  if (!existsSync(docPath)) {
    return err(`document not found: ${docPath}`);
  }
  const oldContent = readFileSync(docPath, "utf-8");
  const documentType = getWorkflowDocumentType(docPath) ?? "plan";
  const currentRound = countReviewerOutputsRounds(oldContent);
  const nextRound = currentRound + 1;

  const requested: ExtensionApprover[] = [];
  if (flags["extend"] === "true") requested.push("human");
  if (flags["self-extend"] === "true") requested.push("self");
  if (flags["reframer-extend"] === "true") requested.push("reframer");
  if (requested.length > 1) {
    return err(
      "use only one of --extend, --self-extend, --reframer-extend (who approved the extension would be ambiguous)",
    );
  }
  const approver = requested[0] ?? null;
  if (approver !== null && approver !== "human" && flags["full"] === "true") {
    return err(
      `--${approver === "self" ? "self-extend" : "reframer-extend"} cannot be combined with --full: changing Key Decisions is outside the self/reframer mandate; ask the human for --extend`,
    );
  }
  const reason = sanitizeExtensionReason(flags["reason"] ?? "");
  if (approver !== null && reason === "") {
    return err(
      `--${approver === "human" ? "extend" : `${approver}-extend`} requires --reason "<why>"`,
    );
  }

  // A cycle resets at the last verdict=pass marker (approval), so re-review
  // after approval gets a fresh budget while unstamped `round` calls keep
  // counting against it (spec K1).
  const phase = getRoundBudgetPhase(getRoundsInCycle(oldContent));
  if (phase !== "open") {
    if (approver === null || !isExtensionAllowed(phase, approver)) {
      return err(
        `refusing: ${docName}: ${formatRoundBudgetHeadline(phase)} since the last pass. ${formatRoundBudgetGuidance(phase, docName)}`,
      );
    }
    if (approver === "reframer") {
      const backing = checkReframerBacking(wfDir, docName, oldContent, deps);
      if (backing !== null) {
        return err(`refusing: ${docName}: --reframer-extend: ${backing}`);
      }
    }
  }

  const roundPlan: RoundReviewerPlan =
    flags["full"] === "true"
      ? { kind: "full" }
      : planRoundReviewers(oldContent, documentType, currentRound);

  const skeletonLines = [`## Reviewer Outputs (Round ${nextRound})`, ""];
  const rerun =
    roundPlan.kind === "delta"
      ? roundPlan.rerun
      : reviewersForDocumentType(documentType).map((r) => r.slug as string);
  for (const slug of rerun) {
    skeletonLines.push(`### ${slug}`, "- verdict: ", "- 主指摘: ", "");
  }
  if (roundPlan.kind === "delta") {
    for (const slug of roundPlan.carried) {
      skeletonLines.push(
        `### ${slug}`,
        `- verdict: pass (carried from Round ${currentRound})`,
        `- 主指摘: Round ${currentRound} で pass、再実行なし`,
        "",
      );
    }
  }

  const newContent = insertBeforeLatestMarker(
    oldContent,
    skeletonLines.join("\n"),
  );

  if (wouldTouchApprovalStatus(oldContent, newContent)) {
    return err(
      "refusing: this change would touch the Approval Status line (approval is human-only)",
    );
  }

  writeFileSync(docPath, newContent);
  appendRoundBaseline(wfDir, nextRound, deps.now);

  // Below the budget an extension flag is unnecessary, so nothing is logged
  // or announced: the log stays a record of actual overruns.
  let extensionNote = "";
  if (phase !== "open" && approver !== null) {
    appendFileSync(
      resolve(wfDir, "round-extensions.log"),
      `${formatExtensionLogLine({ at: deps.now, doc: docName, round: nextRound, approver, reason })}\n`,
    );
    extensionNote = `${EXTENSION_NOTES[approver]}\n`;
  }

  const summary =
    roundPlan.kind === "delta"
      ? `re-run: ${roundPlan.rerun.join(", ")}; carried: ${roundPlan.carried.join(", ") || "none"}`
      : `re-run: all always-on reviewers${currentRound > 0 ? " (full round)" : ""}`;
  return ok(
    `inserted "## Reviewer Outputs (Round ${nextRound})" into ${docName}\n${summary}\n${extensionNote}${provenanceLines(wfDir, source, docPath)}`,
    warning,
  );
}

// ---------------------------------------------------------------------------
// stamp
// ---------------------------------------------------------------------------

/**
 * Latest baseline time recorded for `round` in `.round-baseline` (format:
 * `<round>\t<ISO>` per line, appended by `cmdRound`). Returns null when no
 * line for this round exists yet — Round 1 stamped without ever calling
 * `round` first, which falls back to wfDir's own creation time (`cmdStamp`
 * notes this on stderr; spec K5 N5/N17).
 */
function readRoundBaselineTime(wfDir: string, round: number): string | null {
  const path = resolve(wfDir, ".round-baseline");
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let latest: string | null = null;
  for (const line of content.split("\n")) {
    if (!line) continue;
    const [roundStr, at] = line.split("\t");
    if (roundStr === undefined || at === undefined) continue;
    if (Number(roundStr) === round && (latest === null || at > latest)) {
      latest = at;
    }
  }
  return latest;
}

/**
 * Baseline used when `.round-baseline` has no entry for the round (typically
 * Round 1 stamped without running `round` first). The ledger is already
 * session-scoped, so accepting every entry of this session is the correct
 * window. A directory mtime is deliberately NOT used: the dir's mtime moves
 * whenever the cache, baseline or ledger itself is written, which would push
 * the window past legitimate reviewer runs recorded moments earlier.
 */
function sessionWideBaseline(): string {
  return new Date(0).toISOString();
}

/** Bare-slug-normalized set of reviewer subagent_types recorded at or after `baselineIso`. */
function readLedgerSlugsAtOrAfter(
  ledgerPath: string,
  baselineIso: string,
): Set<string> {
  const slugs = new Set<string>();
  if (!existsSync(ledgerPath)) return slugs;
  let content: string;
  try {
    content = readFileSync(ledgerPath, "utf-8");
  } catch {
    return slugs;
  }
  for (const line of content.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const subagentType = parts[1];
    const at = parts[2];
    if (!subagentType || !at) continue;
    if (at >= baselineIso) {
      slugs.add(bareSlug(subagentType));
    }
  }
  return slugs;
}

function replaceReviewStatusLine(
  content: string,
  verdict: string,
): string | null {
  if (!REVIEW_STATUS_FIND_REGEX.test(content)) {
    return null;
  }
  return content.replace(
    REVIEW_STATUS_FIND_REGEX,
    `- Review Status: ${verdict}`,
  );
}

function buildMarkerLine(fields: {
  verdict: string;
  hash: string;
  designHash: string;
  round: number;
  parentSpecHash: string | null;
  at: string;
  reviewers: string;
}): string {
  const parts = [
    `verdict=${fields.verdict}`,
    `hash=${fields.hash}`,
    `design-hash=${fields.designHash}`,
    `round=${fields.round}`,
  ];
  if (fields.parentSpecHash !== null) {
    parts.push(`parent-spec-hash=${fields.parentSpecHash}`);
  }
  parts.push(`at=${fields.at}`, `reviewers=${fields.reviewers}`);
  return `<!-- auto-review: ${parts.join("; ")} -->`;
}

function cmdStamp(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const { positional, flags } = parseArgs(args);
  const docName = positional[0];
  const verdict = flags["verdict"];
  const reviewersFlag = flags["reviewers"];
  if (!docName) {
    return err("stamp requires a document name (plan-N.md or spec.md)");
  }
  const stampNameError = bareDocumentNameError(docName);
  if (stampNameError) return err(stampNameError);
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    return err("stamp requires --verdict <pass|needs-work|blocker>");
  }
  if (!reviewersFlag) {
    return err("stamp requires --reviewers a+b+c");
  }

  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, source, warning } = resolvedDir;
  const docPath = resolve(wfDir, docName);
  if (!existsSync(docPath)) {
    return err(`document not found: ${docPath}`);
  }

  const oldContent = readFileSync(docPath, "utf-8");
  const documentType = getWorkflowDocumentType(docPath) ?? "plan";
  const currentRound = countReviewerOutputsRounds(oldContent);
  if (currentRound === 0) {
    return err(
      `no "## Reviewer Outputs (Round N)" section found in ${docName}; run \`workflow-cli round ${docName}\` first`,
    );
  }

  // Round N is held to the always-on reviewers Round N-1 left unresolved
  // (spec K6); anything ambiguous in Round N-1 falls back to the full set.
  // Content-selected reviewers are recommended for re-run but never required,
  // same as in Round 1, so a delta round is never stricter than a full one.
  const alwaysOnSlugs = reviewersForDocumentType(documentType).map(
    (r) => r.slug as string,
  );
  const roundPlan = planRoundReviewers(
    oldContent,
    documentType,
    currentRound - 1,
  );
  const mandatorySlugs =
    roundPlan.kind === "delta"
      ? roundPlan.rerun.filter((slug) => alwaysOnSlugs.includes(slug))
      : alwaysOnSlugs;
  const ledgerPath = deps.ledgerPath ?? resolve(wfDir, "reviewer-runs.log");
  const baselineFromRound = readRoundBaselineTime(wfDir, currentRound);
  const usedFallback = baselineFromRound === null;
  const baselineTime = baselineFromRound ?? sessionWideBaseline();

  const ranSlugs = readLedgerSlugsAtOrAfter(ledgerPath, baselineTime);
  const missing = mandatorySlugs.filter((slug) => !ranSlugs.has(slug));

  const stderrParts: string[] = [];
  if (warning) stderrParts.push(warning);
  if (usedFallback) {
    stderrParts.push(
      `no .round-baseline entry for round ${currentRound}; accepting every reviewer run recorded in this session as the baseline (run \`workflow-cli round\` first to scope it to the round)`,
    );
  }

  if (missing.length > 0) {
    stderrParts.push(
      `missing reviewer run(s) in the ledger for round ${currentRound}: ${missing.join(", ")}. Run them via Agent tool (reviewer-run-recorder logs each run), then retry — do not hand-edit reviewer-runs.log.`,
    );
    return { exitCode: 1, stdout: "", stderr: `${stderrParts.join("\n")}\n` };
  }

  let parentSpecHash: string | null = null;
  if (documentType === "plan-numbered") {
    const specPath = resolveWorkflowPaths(wfDir).spec;
    if (!existsSync(specPath)) {
      return err(
        `${docName} is a plan-N.md but no spec.md exists in ${wfDir}; parent-spec-hash cannot be computed`,
      );
    }
    parentSpecHash = computeDocumentHash(
      readFileSync(specPath, "utf-8"),
      SPEC_NORMALIZERS,
    );
  }

  const withStatus = replaceReviewStatusLine(oldContent, verdict);
  if (withStatus === null) {
    return err(`no "- Review Status:" line found in ${docName}`);
  }

  const normalizers = normalizersFor(documentType);
  const hash = computeDocumentHash(withStatus, normalizers);
  const designHash = computeDesignHash(withStatus) ?? "<no design sections>";
  const markerLine = buildMarkerLine({
    verdict,
    hash,
    designHash,
    round: currentRound,
    parentSpecHash,
    at: deps.now.toISOString(),
    reviewers: reviewersFlag,
  });
  const finalContent = `${withStatus.trimEnd()}\n\n${markerLine}\n`;

  if (wouldTouchApprovalStatus(oldContent, finalContent)) {
    return err(
      "refusing: this change would touch the Approval Status line (approval is human-only)",
    );
  }

  writeFileSync(docPath, finalContent);

  return {
    exitCode: 0,
    stdout: `stamped ${docName}: verdict=${verdict} hash=${hash}\n${provenanceLines(wfDir, source, docPath)}`,
    stderr: stderrParts.length > 0 ? `${stderrParts.join("\n")}\n` : "",
  };
}

// ---------------------------------------------------------------------------
// triage
// ---------------------------------------------------------------------------

function cmdTriage(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const { positional, flags } = parseArgs(args);
  const docName = positional[0];
  const adopted = flags["adopted"];
  const excluded = flags["excluded"];
  if (!docName) {
    return err("triage requires a document name");
  }
  const triageNameError = bareDocumentNameError(docName);
  if (triageNameError) return err(triageNameError);
  if (adopted === undefined || excluded === undefined) {
    return err("triage requires --adopted N --excluded M");
  }

  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, source, warning } = resolvedDir;
  const docPath = resolve(wfDir, docName);
  if (!existsSync(docPath)) {
    return err(`document not found: ${docPath}`);
  }

  const oldContent = readFileSync(docPath, "utf-8");
  const marker = `<!-- intent-triage: adopted=${adopted}; excluded=${excluded}; at=${deps.now.toISOString()} -->`;
  const newContent = `${oldContent.trimEnd()}\n${marker}\n`;

  if (wouldTouchApprovalStatus(oldContent, newContent)) {
    return err(
      "refusing: this change would touch the Approval Status line (approval is human-only)",
    );
  }

  writeFileSync(docPath, newContent);
  return ok(
    `appended intent-triage marker to ${docName}\nnext: pass the output of \`workflow-cli ask-approval\` to AskUserQuestion to ask for approval\n${provenanceLines(wfDir, source, docPath)}`,
    warning,
  );
}

// ---------------------------------------------------------------------------
// ask-approval
// ---------------------------------------------------------------------------

/**
 * Print the AskUserQuestion input for the documents waiting for approval.
 * Hashes are read here, at question time; the PostToolUse recorder rebuilds
 * the question from the current files and rejects a response that differs, so
 * a document edited after this call is never recorded at the old hash.
 */
function cmdAskApproval(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const resolvedDir = resolveTargetWfDir(parseArgs(args).flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, warning } = resolvedDir;
  // The listing and the readiness read are separate disk reads; drop anything
  // that changed in between rather than ask about it.
  const ready = listApprovalCandidates(wfDir, deps.cwd).flatMap((name) => {
    const readiness = evaluateApprovalReadiness(wfDir, name);
    return readiness.ready && !readiness.alreadyApproved
      ? [{ name, hash: readiness.hash }]
      : [];
  });
  if (ready.length === 0) {
    return err("no documents are waiting for approval");
  }
  const asked = ready.slice(0, MAX_DOCS_PER_QUESTION);
  const rest = ready.length - asked.length;
  const notes = [
    "After the answer, an [approval-answer-recorder] reply confirms the record; if there is none, nothing was recorded. Check with workflow-cli status.",
  ];
  if (rest > 0) {
    notes.push(
      `残り ${rest} 件は記録の後にもう一度呼ぶと出る (the remaining ${rest} document(s) appear when this is called again after recording).`,
    );
  }
  if (warning) notes.push(warning);
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ questions: buildApprovalQuestions(asked) })}\n`,
    stderr: `${notes.join("\n")}\n`,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const resolved = resolveCliDeps(argv, new Date());
  if ("error" in resolved) {
    process.stderr.write(`workflow-cli: ${resolved.error}\n`);
    process.exitCode = 1;
  } else {
    if (resolved.warning) {
      process.stderr.write(`workflow-cli: ${resolved.warning}\n`);
    }
    const result = runWorkflowCli(argv, resolved.deps);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    // Not process.exit(): see docs/decisions/0002 (no-process-exit under hooks/).
    process.exitCode = result.exitCode;
  }
}
