#!/usr/bin/env -S bun run --silent

/**
 * Gate diagnosis shared by the guard's deny message and the `workflow-cli status`
 * command (spec K4). This module NEVER makes an allow/deny decision — it only
 * describes, per condition, whether the strict judgment form is satisfied and,
 * when it is not, echoes the nearest lenient status line so the model can see
 * that (e.g.) its `Review Status` line is missing the leading hyphen. That
 * hyphen-less-line-stuck failure (research P5) is invisible in the current fixed
 * deny text; naming the failing condition and the found line is the fix.
 *
 * The strict regexes and hash function used here are the exact ones the guard
 * judges with, so the diagnosis can never disagree with the gate.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { computeDocumentHash, SPEC_NORMALIZERS } from "./document-hash.ts";
import { sanitizeForDisplay } from "./sanitize-display.ts";
import { listsTarget } from "./workflow-files.ts";
import { resolveWorkflowPaths } from "./workflow-paths.ts";
import {
  LENIENT_STATUS_LINE,
  parseLatestAutoReviewMarker,
  STRICT_APPROVAL_STATUS,
  STRICT_PLAN_STATUS,
  STRICT_REVIEW_STATUS,
} from "./workflow-marker.ts";

export interface GateCondition {
  ok: boolean;
  /** The nearest matching line as written (lenient), for display only. */
  foundLine?: string | undefined;
  /** The exact strict form the guard requires. */
  expected: string;
}

export interface DocumentDiagnosis {
  path: string;
  exists: boolean;
  conditions: {
    planStatus: GateCondition;
    reviewStatus: GateCondition;
    approvalStatus: GateCondition;
    markerVerdict: GateCondition;
    hashMatch: GateCondition;
  };
}

export interface GateDiagnosis {
  active: boolean;
  twoLayer: boolean;
  /** Single-layer: plan.md. Two-layer: spec.md (the first gate to clear). */
  primary: DocumentDiagnosis;
  /** Present in two-layer mode once spec.md passes: the plan-N.md requirement. */
  note?: string | undefined;
  nextAction: string;
}

function findStatusLine(
  content: string,
  field: "Plan" | "Review" | "Approval",
): string | undefined {
  const lines = content.match(LENIENT_STATUS_LINE) ?? [];
  const hit = lines.find((line) => line.includes(`${field} Status:`));
  return hit ? sanitizeForDisplay(hit.trim()) : undefined;
}

export function evaluateDocument(path: string): DocumentDiagnosis {
  const exists = existsSync(path);
  const empty: GateCondition = { ok: false, expected: "" };
  if (!exists) {
    return {
      path,
      exists: false,
      conditions: {
        planStatus: { ...empty, expected: "- Plan Status: complete" },
        reviewStatus: { ...empty, expected: "- Review Status: pass" },
        approvalStatus: { ...empty, expected: "- Approval Status: approved" },
        markerVerdict: {
          ...empty,
          expected: "<!-- auto-review: verdict=pass; ... -->",
        },
        hashMatch: { ...empty, expected: "marker hash == computed hash" },
      },
    };
  }

  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    content = "";
  }

  const marker = parseLatestAutoReviewMarker(content);
  const computedHash = computeDocumentHash(content, SPEC_NORMALIZERS);

  return {
    path,
    exists: true,
    conditions: {
      planStatus: {
        ok: STRICT_PLAN_STATUS.test(content),
        foundLine: findStatusLine(content, "Plan"),
        expected: "- Plan Status: complete",
      },
      reviewStatus: {
        ok: STRICT_REVIEW_STATUS.test(content),
        foundLine: findStatusLine(content, "Review"),
        expected: "- Review Status: pass",
      },
      approvalStatus: {
        ok: STRICT_APPROVAL_STATUS.test(content),
        foundLine: findStatusLine(content, "Approval"),
        expected: "- Approval Status: approved",
      },
      markerVerdict: {
        ok: marker?.verdict === "pass",
        foundLine: marker ? `verdict=${marker.verdict}` : undefined,
        expected: "verdict=pass in the latest auto-review marker",
      },
      hashMatch: {
        ok: marker?.hash === computedHash,
        foundLine: marker?.hash
          ? `marker hash=${marker.hash.slice(0, 12)}… vs computed ${computedHash.slice(0, 12)}…`
          : undefined,
        expected: "marker hash == computed document hash",
      },
    },
  };
}

/**
 * Diagnose why the gate is closed for `targetPath` under `wfDir`. Describes the
 * first document that must clear (plan.md single-layer, spec.md two-layer) and,
 * in two-layer mode once the spec passes, the owning plan-N.md requirement.
 */
export function diagnoseGate(wfDir: string, targetPath: string): GateDiagnosis {
  const wfPaths = resolveWorkflowPaths(wfDir);
  const active = existsSync(wfPaths.research) || existsSync(wfPaths.plan);
  const twoLayer = existsSync(wfPaths.spec);
  const primaryPath = twoLayer ? wfPaths.spec : wfPaths.plan;
  const primary = evaluateDocument(primaryPath);

  const firstFailure = Object.values(primary.conditions).find((c) => !c.ok);
  const specOk = twoLayer && !firstFailure;

  let note: string | undefined;
  if (specOk) {
    note = `spec.md is approved. The plan-N.md whose ## Files section lists \`${sanitizeForDisplay(targetPath)}\` must also be complete + Review Status: pass + Approval Status: approved, with an auto-review marker whose parent-spec-hash equals the current spec.md hash.`;
  }

  let nextAction: string;
  if (firstFailure) {
    if (firstFailure === primary.conditions.approvalStatus) {
      nextAction =
        "A human sets `- Approval Status: approved` (approval is human-only). Run `workflow-cli status` to see the full checklist.";
    } else if (
      firstFailure === primary.conditions.markerVerdict ||
      firstFailure === primary.conditions.reviewStatus
    ) {
      nextAction =
        "Run the reviewers, then `workflow-cli round <doc>` and `workflow-cli stamp <doc> --verdict pass --reviewers ...` to write the strict Review Status line and marker.";
    } else {
      nextAction =
        "Set the missing status line to its exact strict form (see `expected`), or run `workflow-cli status` for the checklist.";
    }
  } else if (specOk) {
    nextAction =
      "Approve the owning plan-N.md (see note), or `workflow-cli status` for details.";
  } else {
    nextAction = "The gate conditions are satisfied.";
  }

  return { active, twoLayer, primary, note, nextAction };
}

const PLAN_NUMBERED_FILENAME_REGEX = /^plan-[0-9]+\.md$/;

/**
 * Enumerate plan-N.md files (N is one or more digits) directly within wfDir,
 * for the gate decision and `isImplementationPhase`. Strict regex match
 * excludes plan-draft.md, plan-1.md.bak, plan-2-draft.md.
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
 * A document is "approved" when all five gate conditions `evaluateDocument`
 * computes are satisfied. Reusing it (rather than re-deriving the same five
 * checks a second time) keeps this predicate from silently disagreeing with
 * the deny-message diagnosis it shares a module with.
 */
export function isDocumentApproved(d: DocumentDiagnosis): boolean {
  return (
    d.exists &&
    d.conditions.planStatus.ok &&
    d.conditions.reviewStatus.ok &&
    d.conditions.approvalStatus.ok &&
    d.conditions.markerVerdict.ok &&
    d.conditions.hashMatch.ok
  );
}

/**
 * Detect whether the workflow has crossed into implementation phase:
 * - Single-layer: plan.md fully approved (matching hash, verdict=pass).
 * - Two-layer: spec.md fully approved AND at least one plan-N.md fully
 *   approved with `parent-spec-hash` equal to the current spec.md hash.
 *
 * Moved here from `document-workflow-guard.ts` (spec K1, plan-2 T4) so
 * `workflow-bash-sync.ts`'s tripwire can gate on the same definition the
 * guard's off-plan relaxation uses, without the two hooks drifting apart.
 */
export function isImplementationPhase(
  wfDir: string,
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
  twoLayer: boolean,
): boolean {
  if (!twoLayer) {
    return isDocumentApproved(evaluateDocument(wfPaths.plan));
  }

  if (!isDocumentApproved(evaluateDocument(wfPaths.spec))) {
    return false;
  }
  let specContent: string;
  try {
    specContent = readFileSync(wfPaths.spec, "utf-8");
  } catch {
    return false;
  }
  const specHash = computeDocumentHash(specContent, SPEC_NORMALIZERS);

  for (const planPath of findPlanNumberedFiles(wfDir)) {
    if (!isDocumentApproved(evaluateDocument(planPath))) {
      continue;
    }
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      continue;
    }
    const marker = parseLatestAutoReviewMarker(planContent);
    if (!marker || marker.parentSpecHash !== specHash) {
      continue;
    }
    return true;
  }
  return false;
}

export interface WorkflowState {
  mode?: string;
  approved?: boolean;
}

export function readWorkflowState(statePath: string): WorkflowState | null {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as WorkflowState;
  } catch {
    return null;
  }
}

/**
 * A workflow is active once workflow-state.json says so or plan.md /
 * research.md exists. session.ts keeps a local copy for its startup summary
 * (spec K5 of the overhaul); session.test.ts checks the two for drift.
 */
export function isWorkflowActive(
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
  state: WorkflowState | null,
): boolean {
  if (state?.mode === "document-workflow") {
    return true;
  }
  return existsSync(wfPaths.plan) || existsSync(wfPaths.research);
}

export type TargetEvaluation =
  | { kind: "inactive" }
  | { kind: "allow"; owner: string }
  | {
      kind: "no-plan-owner";
      implementationPhase: boolean;
      diagnosis: GateDiagnosis;
    }
  | { kind: "deny"; diagnosis: GateDiagnosis };

export interface TargetQuery {
  wfDir: string;
  /** Absolute path of the file being written. */
  target: string;
  /** The session's project root; `## Files` entries resolve against the target's checkout. */
  projectRoot: string;
  /** The target as the caller shows it in a diagnosis (raw tool input); defaults to `target`. */
  label?: string;
}

/**
 * The gate's decision for one write target, shared by the guard and
 * `workflow-cli status <path>` so the two cannot disagree on a gated
 * target (#209-2). The guard's shortcuts for workflow documents and paths
 * outside the project run before this (classifyExemption, T3).
 * - allow: single-layer plan.md approved, or the plan-N.md listing the
 *   target approved with parent-spec-hash equal to the current spec.md hash.
 * - no-plan-owner: two-layer, spec.md approved, no plan-N.md lists the
 *   target. The guard relaxes it to warn + off-plan log during
 *   implementation phase.
 * - deny: anything else (no research.md, a document not approved, hash
 *   drift, parent-spec-hash missing or stale).
 */
export function evaluateTarget(query: TargetQuery): TargetEvaluation {
  const wfPaths = resolveWorkflowPaths(query.wfDir);
  if (!isWorkflowActive(wfPaths, readWorkflowState(wfPaths.state))) {
    return { kind: "inactive" };
  }
  const deny = (): TargetEvaluation => ({
    kind: "deny",
    diagnosis: diagnoseGate(query.wfDir, query.label ?? query.target),
  });
  if (!existsSync(wfPaths.research)) {
    return deny();
  }
  if (!existsSync(wfPaths.spec)) {
    return isDocumentApproved(evaluateDocument(wfPaths.plan))
      ? { kind: "allow", owner: wfPaths.plan }
      : deny();
  }

  if (!isDocumentApproved(evaluateDocument(wfPaths.spec))) {
    return deny();
  }
  let specHash: string;
  try {
    specHash = computeDocumentHash(
      readFileSync(wfPaths.spec, "utf-8"),
      SPEC_NORMALIZERS,
    );
  } catch {
    return deny();
  }

  for (const planPath of findPlanNumberedFiles(query.wfDir)) {
    let planContent: string;
    try {
      planContent = readFileSync(planPath, "utf-8");
    } catch {
      continue;
    }
    if (!listsTarget(planContent, query.target, query.projectRoot)) {
      continue;
    }
    if (!isDocumentApproved(evaluateDocument(planPath))) {
      return deny();
    }
    // A missing parent-spec-hash is a conservative deny: the plan cannot
    // prove which spec it was approved against.
    const marker = parseLatestAutoReviewMarker(planContent);
    if (
      !marker ||
      marker.parentSpecHash === null ||
      marker.parentSpecHash !== specHash
    ) {
      return deny();
    }
    return { kind: "allow", owner: planPath };
  }

  return {
    kind: "no-plan-owner",
    implementationPhase: isImplementationPhase(query.wfDir, wfPaths, true),
    diagnosis: diagnoseGate(query.wfDir, query.label ?? query.target),
  };
}

export type Exemption = "workflow-document" | "outside-project";

/**
 * Targets the guard lets through before asking the gate: markdown under the
 * workflow dir is a workflow document, never implementation (it is
 * session-scoped scratch under .tmp/), and paths outside the project are not
 * this workflow's business. `target` is absolute and lexical, compared with
 * the lexical projectRoot / wfDir the hooks resolve.
 *
 * The predicate is stated as a property of the directory rather than as a
 * list of filenames because naming the artifacts individually (plan.md /
 * spec.md / research.md / lessons-learned.md -- including P12's out-of-lifecycle
 * writes per spec K7 / DI4 -- and plan-N.md) sent every other note the
 * workflow legitimately produces (handoff memos such as NEXT-SESSION.md, plan
 * drafts, split research notes) into the implementation gate, where an
 * unapproved plan denied them.
 *
 * Non-markdown inside the directory stays gated on purpose:
 * `plan-review.cache.json` and `off-plan-writes.log` are hook-managed state, and
 * a tool-driven write to them could forge a cached verdict or rewrite the audit
 * trail the off-plan relaxation depends on.
 */
export function classifyExemption(
  target: string,
  projectRoot: string,
  wfDir: string,
): Exemption | null {
  if (target.startsWith(`${wfDir}/`) && target.endsWith(".md")) {
    return "workflow-document";
  }
  if (!target.startsWith(`${projectRoot}/`) && target !== projectRoot) {
    return "outside-project";
  }
  return null;
}

/** One line (or the full diagnosis) for `workflow-cli status <path>`. */
export function formatTargetEvaluation(
  evaluation: TargetEvaluation,
  targetLabel: string,
  docLabel: string,
): string {
  switch (evaluation.kind) {
    case "inactive":
      return `Document workflow: inactive (no research.md or plan.md in the workflow dir); \`${targetLabel}\` is not gated.`;
    case "allow":
      return `Document workflow gate: \`${targetLabel}\` is allowed by \`${basename(evaluation.owner)}\`.`;
    case "no-plan-owner":
      if (evaluation.implementationPhase) {
        return `Document workflow gate: no plan-N.md lists \`${targetLabel}\`; a write is allowed with a warning and recorded in off-plan-writes.log (implementation phase).`;
      }
      return formatGateDiagnosis(evaluation.diagnosis, targetLabel, docLabel);
    case "deny":
      return formatGateDiagnosis(evaluation.diagnosis, targetLabel, docLabel);
  }
}

/** Render a diagnosis as the multi-line text used in a deny reason / `status`. */
export function formatGateDiagnosis(
  d: GateDiagnosis,
  targetLabel: string,
  docLabel?: string,
): string {
  const lines: string[] = [];
  lines.push(
    `Document workflow gate${d.twoLayer ? " (two-layer)" : ""}: \`${targetLabel}\` is blocked. Conditions on \`${docLabel ?? d.primary.path}\`:`,
  );
  const order: [string, GateCondition][] = [
    ["Plan Status", d.primary.conditions.planStatus],
    ["Review Status", d.primary.conditions.reviewStatus],
    ["Approval Status", d.primary.conditions.approvalStatus],
    ["marker verdict", d.primary.conditions.markerVerdict],
    ["hash match", d.primary.conditions.hashMatch],
  ];
  for (const [name, cond] of order) {
    const mark = cond.ok ? "✓" : "✗";
    const detail = cond.ok
      ? ""
      : cond.foundLine
        ? ` (found: ${cond.foundLine}; expected: ${cond.expected})`
        : ` (missing; expected: ${cond.expected})`;
    lines.push(`  ${mark} ${name}${detail}`);
  }
  if (d.note) {
    lines.push(`  note: ${d.note}`);
  }
  lines.push(`Next: ${d.nextAction}`);
  return lines.join("\n");
}
