#!/usr/bin/env -S bun run --silent

/**
 * Single source of truth for parsing the `<!-- auto-review: ... -->` marker and
 * for the workflow status-line regexes.
 *
 * Before this module, `document-workflow-guard.ts` and `plan-review-automation.ts`
 * each held a private copy of the marker scanner (one retaining `parent-spec-hash`,
 * the other `design-hash`). Consolidating removes that duplication (spec K4, N7).
 *
 * The STRICT status regexes are the *judgment* form used by the guard to gate
 * implementation. They require the leading `- ` and reject trailing annotations.
 * The LENIENT form is *display only* (used by workflow-gate diagnostics to echo
 * the nearest matching line back to the model); it must never drive a gate
 * decision. Keeping both here, with the judgment form unchanged, is what lets
 * the diagnostic be forgiving without moving any document hash (spec K4).
 */

// Judgment form (unchanged from document-workflow-guard.ts:16-18).
export const STRICT_PLAN_STATUS = /^- Plan Status:\s*complete\s*$/m;
export const STRICT_REVIEW_STATUS = /^- Review Status:\s*pass\s*$/m;
export const STRICT_APPROVAL_STATUS = /^- Approval Status:\s*approved\s*$/m;

// Display form (diagnostics only): tolerates a missing hyphen and trailing text.
export const LENIENT_STATUS_LINE =
  /^\s*-?\s*(Plan|Review|Approval) Status:.*$/gm;

const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;

export interface AutoReviewMarker {
  verdict: string;
  hash: string;
  designHash: string | null;
  parentSpecHash: string | null;
}

/**
 * Return the last `<!-- auto-review: ... -->` marker's fields, or null when no
 * marker is present or the marker lacks a verdict/hash. Markers are append-only
 * (the guard trusts the last one), so scanning-then-taking-last is correct.
 *
 * The union of `designHash` and `parentSpecHash` is returned so both the guard
 * (which reads `parentSpecHash`) and plan-review-automation (which reads
 * `designHash`) consume one parser. Hyphen-aware key matching keeps
 * `design-hash` / `parent-spec-hash` from substring-colliding with `hash`.
 */
export function parseLatestAutoReviewMarker(
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
  let designHash: string | null = null;
  let parentSpecHash: string | null = null;
  for (const part of latest.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)=([^;]+)/g)) {
    const key = part[1]?.trim();
    // A field with no trailing `;` (i.e. the last field before `-->`) would
    // otherwise capture the marker close in its value; strip it so the last
    // field parses the same as any interior field.
    const value = part[2]?.replace(/\s*-->\s*$/, "").trim();
    if (!key || !value) {
      continue;
    }
    if (key === "verdict") {
      verdict = value;
    } else if (key === "hash") {
      hash = value;
    } else if (key === "design-hash") {
      designHash = value;
    } else if (key === "parent-spec-hash") {
      parentSpecHash = value;
    }
  }

  if (verdict.length === 0 || hash.length === 0) {
    return null;
  }

  return { verdict, hash, designHash, parentSpecHash };
}
