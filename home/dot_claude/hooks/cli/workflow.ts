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
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { diagnoseGate, formatGateDiagnosis } from "../lib/workflow-gate.ts";
import { isStrictlyUnderProjectSubdir } from "../lib/workflow-fs.ts";
import {
  deriveDefaultWorkflowDir,
  getWorkflowDocumentType,
  isValidSessionId,
  resolveWorkflowPaths,
  type WorkflowDocumentType,
} from "../lib/workflow-paths.ts";
import {
  computeDesignHash,
  computeDocumentHash,
  countReviewerOutputsRounds,
  PLAN_NORMALIZERS,
  reviewersForDocumentType,
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

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
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
 */
function resolveTargetWfDir(
  flags: Record<string, string>,
  deps: RunWorkflowCliDeps,
): { wfDir: string; warning: string | null } {
  let wfDir = deps.wfDir;
  const flagValue = flags["wf-dir"];
  if (flagValue) {
    const candidate = resolve(deps.cwd, flagValue);
    if (isStrictlyUnderProjectSubdir(deps.cwd, SESSIONS_SUBDIR, candidate)) {
      wfDir = candidate;
    } else {
      return {
        wfDir: deps.wfDir,
        warning: `--wf-dir "${flagValue}" is not a strict descendant of ${SESSIONS_SUBDIR}; ignoring and using the resolved default (${deps.wfDir})`,
      };
    }
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
  const { wfDir, warning } = resolveTargetWfDir(flags, deps);
  const wfPaths = resolveWorkflowPaths(wfDir);
  const twoLayer = existsSync(wfPaths.spec);
  const targetArg = positional[0];
  const target = targetArg
    ? resolve(wfDir, targetArg)
    : twoLayer
      ? wfPaths.spec
      : wfPaths.plan;
  const docLabel = twoLayer ? "spec.md" : "plan.md";
  const diagnosis = diagnoseGate(wfDir, target);
  const lines = [formatGateDiagnosis(diagnosis, target, docLabel)];

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

function cmdRound(
  args: string[],
  deps: RunWorkflowCliDeps,
): RunWorkflowCliResult {
  const { positional, flags } = parseArgs(args);
  const docName = positional[0];
  if (!docName) {
    return err("round requires a document name (plan-N.md or spec.md)");
  }
  const { wfDir, warning } = resolveTargetWfDir(flags, deps);
  const docPath = resolve(wfDir, docName);
  if (!existsSync(docPath)) {
    return err(`document not found: ${docPath}`);
  }
  const oldContent = readFileSync(docPath, "utf-8");
  const documentType = getWorkflowDocumentType(docPath) ?? "plan";
  const currentRound = countReviewerOutputsRounds(oldContent);
  const nextRound = currentRound + 1;
  const mandatoryReviewers = reviewersForDocumentType(documentType);

  const skeletonLines = [`## Reviewer Outputs (Round ${nextRound})`, ""];
  for (const reviewer of mandatoryReviewers) {
    skeletonLines.push(`### ${reviewer.slug}`, "- verdict: ", "- 主指摘: ", "");
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

  return ok(
    `inserted "## Reviewer Outputs (Round ${nextRound})" into ${docName}\n`,
    warning,
  );
}

// ---------------------------------------------------------------------------
// stamp
// ---------------------------------------------------------------------------

function bareSlug(subagentType: string): string {
  const parts = subagentType.split(":");
  return parts[parts.length - 1] ?? subagentType;
}

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
  parentSpecHash: string | null;
  at: string;
  reviewers: string;
}): string {
  const parts = [
    `verdict=${fields.verdict}`,
    `hash=${fields.hash}`,
    `design-hash=${fields.designHash}`,
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

  const { wfDir, warning } = resolveTargetWfDir(flags, deps);
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

  const mandatorySlugs = reviewersForDocumentType(documentType).map(
    (r) => r.slug as string,
  );
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

  const { wfDir, warning } = resolveTargetWfDir(flags, deps);
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
