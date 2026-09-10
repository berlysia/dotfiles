#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  applyNormalizers,
  computeDesignHash,
  computeDocumentHash,
  type Normalizer,
  PLAN_NORMALIZERS,
  SPEC_NORMALIZERS,
} from "../lib/document-hash.ts";
import { expandTilde } from "../lib/path-utils.ts";
import {
  getWorkflowDocumentType,
  isPlanFile,
  isWorkflowDocument,
  resolveWorkflowPaths,
  type WorkflowDocumentType,
} from "../lib/workflow-paths.ts";
import {
  type AutoReviewMarker,
  parseLatestAutoReviewMarker,
} from "../lib/workflow-marker.ts";
import {
  ALWAYS_ON_REVIEWERS,
  buildRecommendation,
  buildSummaryReminder,
  type CacheState,
  canSkip,
  countReviewerOutputsRounds,
  isReviewCompletePendingApproval,
  PLAN_REVIEWERS,
  readDocCache,
  REVIEWER_CATALOG,
  reviewersForDocumentType,
  selectReviewers,
  SPEC_REVIEWERS,
  stripReviewMarkers,
  writeDocCache,
} from "../lib/workflow-review-core.ts";
import "../types/tool-schemas.ts";

const TARGET_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);
const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input, cwd } = context.input;
    if (!TARGET_TOOL_NAMES.has(tool_name)) {
      return context.success({});
    }

    const baseDir = getWorkingDirectory(cwd);
    const targetPath = extractTargetPath(tool_name, tool_input);
    if (!targetPath) {
      return context.success({});
    }

    const absoluteTargetPath = normalizePath(baseDir, targetPath);
    const documentType = getWorkflowDocumentType(absoluteTargetPath);
    if (!documentType) {
      return context.success({});
    }

    if (!existsSync(absoluteTargetPath)) {
      return context.success({});
    }

    const planContent = readFileSync(absoluteTargetPath, "utf-8");
    const normalizers = normalizersForDocumentType(documentType);
    const planHash = computeDocumentHash(planContent, normalizers);
    const existingMarker = extractLatestReviewMarker(planContent);

    // Co-locate cache with the plan file itself, keyed per document (spec K1)
    const planDir = dirname(absoluteTargetPath);
    const docName = basename(absoluteTargetPath);

    // Skip if already reviewed for this content hash
    const cache = readDocCache(planDir, docName);
    if (canSkip(cache, planHash, existingMarker)) {
      if (
        isReviewCompletePendingApproval(
          planContent,
          planHash,
          existingMarker,
        ) &&
        cache?.summaryRemindedHash !== planHash
      ) {
        writeDocCache(planDir, docName, {
          planHash: cache?.planHash ?? planHash,
          recommendedAt: cache?.recommendedAt ?? new Date().toISOString(),
          summaryRemindedHash: planHash,
        } satisfies CacheState);

        return context.json({
          event: "PostToolUse",
          output: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildSummaryReminder(absoluteTargetPath),
            },
          },
        });
      }
      return context.success({});
    }

    // Prescribed-fix carry-forward (K7 c): not skippable by full-content hash,
    // but the prior verdict was pass and the section-scoped design-hash is
    // unchanged from the most recent needs-work baseline → the edit was a
    // prescribed wording fix that did not move design sections. Do not
    // re-recommend reviews (the prior pass verdict carries forward).
    if (
      existingMarker?.verdict === "pass" &&
      canCarryForwardVerdict({
        currentDesignHash: computeDesignHash(planContent),
        baselineDesignHash: findNeedsWorkBaselineDesignHash(planContent),
      })
    ) {
      return context.success({});
    }

    // Check if sibling research.md / spec.md exist
    const { research: researchPath, spec: specPath } =
      resolveWorkflowPaths(planDir);
    const hasResearch = existsSync(researchPath);
    const hasSpec = existsSync(specPath);

    // For plan-numbered documents in two-layer mode, compute parent-spec-hash
    // so the recommendation can include the value in the marker template.
    let parentSpecHash: string | null = null;
    if (documentType === "plan-numbered" && hasSpec) {
      try {
        const specContent = readFileSync(specPath, "utf-8");
        parentSpecHash = computeDocumentHash(specContent, SPEC_NORMALIZERS);
      } catch {
        parentSpecHash = null;
      }
    }

    const additionalContext = buildRecommendation(
      absoluteTargetPath,
      hasResearch ? researchPath : null,
      planContent,
      {
        documentType,
        specPath: hasSpec ? specPath : null,
        parentSpecHash,
        fullTextEmittedForRound: cache?.fullTextEmittedForRound,
      },
    );

    // Record that we recommended review for this hash (prevents repeated
    // prompts) and the round count this recommendation covers (K6
    // pointer-ization: the next same-round edit gets a pointer, not a
    // full re-injection).
    writeDocCache(planDir, docName, {
      planHash,
      recommendedAt: new Date().toISOString(),
      fullTextEmittedForRound: countReviewerOutputsRounds(planContent),
    } satisfies CacheState);

    return context.json({
      event: "PostToolUse",
      output: {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext,
        },
      },
    });
  },
});

function getWorkingDirectory(cwd: string | undefined): string {
  if (process.env.CLAUDE_TEST_CWD) {
    return process.env.CLAUDE_TEST_CWD;
  }
  if (typeof cwd === "string" && cwd.length > 0) {
    return cwd;
  }
  return process.cwd();
}

function normalizePath(cwd: string, path: string): string {
  return resolve(cwd, expandTilde(path));
}

function extractTargetPath(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  if (
    (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
    typeof toolInput.file_path === "string"
  ) {
    return toolInput.file_path;
  }

  if (
    toolName === "NotebookEdit" &&
    typeof toolInput.notebook_path === "string"
  ) {
    return toolInput.notebook_path;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** @deprecated Backward-compatible alias for `computeDocumentHash(content, SPEC_NORMALIZERS)`. */
function computePlanHash(planContent: string): string {
  return computeDocumentHash(planContent, SPEC_NORMALIZERS);
}

/** @deprecated Backward-compatible alias for `applyNormalizers(content, SPEC_NORMALIZERS)`. */
function normalizeForHash(content: string): string {
  return applyNormalizers(content, SPEC_NORMALIZERS);
}

/**
 * Pick the normalizer set appropriate for the document type.
 */
function normalizersForDocumentType(
  type: WorkflowDocumentType,
): ReadonlyArray<Normalizer> {
  return type === "plan-numbered" ? PLAN_NORMALIZERS : SPEC_NORMALIZERS;
}

// Shared with the guard via workflow-marker (spec K4/N7). Re-exported under the
// original name so call sites and tests are unchanged; the returned shape now
// also carries `parentSpecHash`, which this hook does not read.
const extractLatestReviewMarker: (content: string) => AutoReviewMarker | null =
  parseLatestAutoReviewMarker;

/**
 * K7 (c) carry-forward gate. Returns true only when both the current and the
 * baseline design-hash are present and equal. Either being `null` (no design
 * sections, or the baseline needs-work marker lacked the field) forces a full
 * re-review — same conservative policy as a missing parent-spec-hash.
 *
 * Note: K7 conditions (a) wording-precision class and (b) reviewer verbatim
 * are NOT machine-decided here; they are upheld by the workflow.md
 * "prescribed-fix carry-forward" protocol. This hook only machine-verifies (c).
 */
export function canCarryForwardVerdict(input: {
  currentDesignHash: string | null;
  baselineDesignHash: string | null;
}): boolean {
  if (input.currentDesignHash === null || input.baselineDesignHash === null) {
    return false;
  }
  return input.currentDesignHash === input.baselineDesignHash;
}

/**
 * Scan all auto-review markers and return the `design-hash` recorded in the
 * most recent `verdict=needs-work` marker. Returns `null` when no needs-work
 * marker exists or it lacks a non-empty design-hash field (conservative;
 * routes `canCarryForwardVerdict` into its fail-safe branch).
 */
function findNeedsWorkBaselineDesignHash(content: string): string | null {
  const matches = content.match(REVIEW_MARKER_REGEX);
  if (!matches) {
    return null;
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const marker = matches[i];
    if (!marker) {
      continue;
    }
    let verdict = "";
    let designHash: string | null = null;
    for (const part of marker.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)=([^;]+)/g)) {
      const key = part[1]?.trim();
      const value = part[2]?.trim();
      if (!key || !value) {
        continue;
      }
      if (key === "verdict") {
        verdict = value;
      } else if (key === "design-hash") {
        designHash = value;
      }
    }
    if (verdict === "needs-work") {
      return designHash && designHash.length > 0 ? designHash : null;
    }
  }
  return null;
}

export {
  ALWAYS_ON_REVIEWERS,
  SPEC_REVIEWERS,
  PLAN_REVIEWERS,
  SPEC_NORMALIZERS,
  PLAN_NORMALIZERS,
  buildRecommendation,
  buildSummaryReminder,
  computeDocumentHash,
  computePlanHash,
  extractTargetPath,
  extractLatestReviewMarker,
  isReviewCompletePendingApproval,
  isPlanFile,
  isWorkflowDocument,
  getWorkflowDocumentType,
  normalizeForHash,
  normalizersForDocumentType,
  reviewersForDocumentType,
  REVIEWER_CATALOG,
  selectReviewers,
  stripReviewMarkers,
};

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
