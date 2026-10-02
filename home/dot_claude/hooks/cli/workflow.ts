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
 * finding: "no spawn needed"). The `import.meta.main` block below is the only
 * place this file touches the real process.
 */

import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { expandTilde } from "../lib/path-utils.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import {
  classifyExemption,
  diagnoseGate,
  evaluateTarget,
  formatGateDiagnosis,
  formatTargetEvaluation,
} from "../lib/workflow-gate.ts";
import { isStrictlyUnderProjectSubdir } from "../lib/workflow-fs.ts";
import { lastPassMarkerRound } from "../lib/workflow-marker.ts";
import {
  deriveDefaultWorkflowDir,
  getWorkflowDocumentType,
  isValidSessionId,
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

export interface RunWorkflowCliDeps {
  cwd: string;
  /** Default/fallback workflow dir (e.g. already resolved via `resolveWorkflowDir`). */
  wfDir: string;
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

export function runWorkflowCli(
  argv: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const [command, ...rest] = argv;
  switch (command) {
    case "status":
      return cmdStatus(rest, deps);
    case "round":
      return cmdRound(rest, deps);
    case "stamp":
      return cmdStamp(rest, deps);
    case "triage":
      return cmdTriage(rest, deps);
    default:
      return err(
        `unknown command: ${command ?? "<none>"}\nusage: workflow-cli <status|round|stamp|triage> [doc] [--flags]`,
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
 * Resolve which wfDir this invocation targets: `--wf-dir` (validated against
 * `.tmp/sessions`) wins over `deps.wfDir`. Warns (does not fail) when the
 * resolved dir diverges from the session-derived dir, since a stale pin from
 * before `/clear` is a real, recoverable operator mistake (spec K5 security
 * 15) rather than something the CLI should refuse to run under.
 *
 * An invalid `--wf-dir` is different: the operator named a target, so writing
 * to the default dir instead would silently edit documents they did not ask
 * about (a smoke test once inserted a round into an approved spec this way).
 * That case is an error.
 */
function resolveTargetWfDir(
  flags: Record<string, string>,
  deps: RunWorkflowCliDeps,
):
  | { wfDir: string; warning: string | null; error?: undefined }
  | { error: string } {
  let wfDir = deps.wfDir;
  const flagValue = flags["wf-dir"];
  if (flagValue) {
    const candidate = resolve(deps.cwd, flagValue);
    if (!isStrictlyUnderProjectSubdir(deps.cwd, SESSIONS_SUBDIR, candidate)) {
      return {
        error: `--wf-dir "${flagValue}" is not a strict descendant of ${SESSIONS_SUBDIR}; refusing rather than falling back to ${deps.wfDir}`,
      };
    }
    wfDir = candidate;
  }

  if (deps.sessionId && isValidSessionId(deps.sessionId)) {
    const derived = resolve(deps.cwd, deriveDefaultWorkflowDir(deps.sessionId));
    if (derived !== wfDir) {
      return {
        wfDir,
        warning: `wfDir (${wfDir}) diverges from the session-derived dir (${derived}) — this may be a stale pin from before /clear; see \`workflow-cli status\``,
      };
    }
  }
  return { wfDir, warning: null };
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
    const primary = twoLayer ? wfPaths.spec : wfPaths.plan;
    lines.push(
      formatGateDiagnosis(diagnoseGate(wfDir, primary), primary, docLabel),
    );
  }

  if (existsSync(resolve(wfDir, ".tripwire-disabled"))) {
    lines.push("tripwire: disabled (see .tripwire-disabled for the reason)");
  } else if (existsSync(resolve(wfDir, ".tripwire-baseline"))) {
    lines.push("tripwire: armed");
  } else {
    lines.push("tripwire: not yet armed");
  }

  return ok(`${lines.join("\n")}\n`, warning);
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
  // A bare file name only: the reframer record file and the extension log are
  // keyed by it, so a path like `../plan.md` would move the record outside the
  // workflow dir and split the log's doc column across spellings.
  if (basename(docName) !== docName || !isBareMarkdownName(docName)) {
    return err(
      `invalid document name "${docName}": the document name must be a bare file name ending in .md (e.g. plan-1.md), not a path`,
    );
  }
  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, warning } = resolvedDir;
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
    `inserted "## Reviewer Outputs (Round ${nextRound})" into ${docName}\n${summary}\n${extensionNote}`,
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
  if (!verdict || !VALID_VERDICTS.has(verdict)) {
    return err("stamp requires --verdict <pass|needs-work|blocker>");
  }
  if (!reviewersFlag) {
    return err("stamp requires --reviewers a+b+c");
  }

  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, warning } = resolvedDir;
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
    stdout: `stamped ${docName}: verdict=${verdict} hash=${hash}\n`,
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
  if (adopted === undefined || excluded === undefined) {
    return err("triage requires --adopted N --excluded M");
  }

  const resolvedDir = resolveTargetWfDir(flags, deps);
  if (resolvedDir.error !== undefined) return err(resolvedDir.error);
  const { wfDir, warning } = resolvedDir;
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
  return ok(`appended intent-triage marker to ${docName}\n`, warning);
}

if (import.meta.main) {
  const cwd = process.cwd();
  const sessionId = process.env.CLAUDE_SESSION_ID ?? "";
  const envWfDir = process.env.DOCUMENT_WORKFLOW_DIR;
  let wfDir: string;
  if (
    envWfDir &&
    isStrictlyUnderProjectSubdir(cwd, SESSIONS_SUBDIR, resolve(cwd, envWfDir))
  ) {
    wfDir = resolve(cwd, envWfDir);
  } else if (sessionId && isValidSessionId(sessionId)) {
    wfDir = resolve(cwd, deriveDefaultWorkflowDir(sessionId));
  } else {
    wfDir = resolve(cwd, SESSIONS_SUBDIR);
  }
  if (!existsSync(wfDir)) {
    process.stderr.write(
      `workflow-cli: workflow dir ${wfDir} does not exist; pass --wf-dir explicitly\n`,
    );
  }
  const result = runWorkflowCli(process.argv.slice(2), {
    cwd,
    wfDir,
    sessionId,
    now: new Date(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // Not process.exit(): this CLI file lives under hooks/ so the repo's
  // no-process-exit lint rule (guarding against a Claude Code hook process
  // killing itself mid-flight, docs/decisions/0002) flags it there. Setting
  // exitCode and letting the event loop drain naturally achieves the same
  // observable exit status for a standalone CLI invocation without an
  // abrupt process.exit() call.
  process.exitCode = result.exitCode;
}
