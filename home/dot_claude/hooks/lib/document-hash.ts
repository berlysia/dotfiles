import { createHash } from "node:crypto";

const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;
const INTENT_TRIAGE_MARKER_REGEX = /<!--\s*intent-triage:[^>]*-->/g;
const REVIEWER_OUTPUTS_HEADING = /^## Reviewer Outputs \(Round \d+\)$/;

export type Normalizer = (content: string) => string;

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Strip every `## Reviewer Outputs (Round N)` section (heading line plus its
 * body up to the next `## ` heading or EOF). The heading match is anchored to
 * the full line via `REVIEWER_OUTPUTS_HEADING`, so `## Reviewer Outputs`
 * without a `(Round N)` suffix is preserved (R3 boundary criterion (i)).
 * EOF termination is handled by line scanning because JS regex has no `\Z`.
 */
function stripReviewerOutputsSections(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (REVIEWER_OUTPUTS_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^## /.test(line) && !REVIEWER_OUTPUTS_HEADING.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      out.push(line);
    }
  }
  return out.join("\n");
}

function extractSectionBody(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l === `## ${heading}`);
  if (startIdx === -1) {
    return null;
  }
  const body: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? "")) {
      break;
    }
    body.push(lines[i] ?? "");
  }
  return body.join("\n").trimEnd();
}

/**
 * Canonical normalizers for spec.md / single-layer plan.md (and plan-N.md;
 * `PLAN_NORMALIZERS` is an alias). Strips bookkeeping that must not perturb
 * the "hash change == design change" invariant: auto-review markers (which
 * contain the hash itself), intent-triage markers, and `## Reviewer Outputs
 * (Round N)` sections. Then blanks the Approval Status value and resets
 * checkbox completion so status/progress flips do not change the hash.
 */
const SPEC_NORMALIZERS: ReadonlyArray<Normalizer> = [
  (c) => c.replace(REVIEW_MARKER_REGEX, ""),
  (c) => c.replace(INTENT_TRIAGE_MARKER_REGEX, ""),
  (c) => stripReviewerOutputsSections(c),
  (c) => c.replace(/^(- Approval Status:)\s*.*$/m, "$1"),
  (c) => c.replace(/^(\s*- )\[x\]/gm, "$1[ ]"),
  (c) => c.trimEnd(),
];

const PLAN_NORMALIZERS: ReadonlyArray<Normalizer> = SPEC_NORMALIZERS;

const DESIGN_SECTION_HEADINGS = ["Files", "Key Decisions", "Scope", "Tasks"];

function applyNormalizers(
  content: string,
  normalizers: ReadonlyArray<Normalizer>,
): string {
  return normalizers.reduce((acc, fn) => fn(acc), content);
}

/**
 * Compute the normalized full-content hash for a workflow document.
 * Pass `SPEC_NORMALIZERS` for spec.md / single-layer plan.md and
 * `PLAN_NORMALIZERS` for plan-N.md execution-layer documents.
 */
function computeDocumentHash(
  content: string,
  normalizers: ReadonlyArray<Normalizer> = SPEC_NORMALIZERS,
): string {
  return hashText(applyNormalizers(content, normalizers));
}

/**
 * Section-scoped design hash over only the design sections
 * ({Files, Key Decisions, Scope, Tasks}). Returns `null` when no design
 * section is present so an empty extraction is never a stable hash that
 * two structurally-empty documents could match on (fail-open guard, spec R5).
 */
function computeDesignHash(content: string): string | null {
  const parts: string[] = [];
  for (const heading of DESIGN_SECTION_HEADINGS) {
    const body = extractSectionBody(content, heading);
    if (body !== null) {
      parts.push(`## ${heading}\n${body}`);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  const normalized = parts
    .join("\n")
    .replace(/^(\s*- )\[x\]/gm, "$1[ ]")
    .trimEnd();
  return hashText(normalized);
}

export {
  SPEC_NORMALIZERS,
  PLAN_NORMALIZERS,
  applyNormalizers,
  computeDocumentHash,
  computeDesignHash,
  stripReviewerOutputsSections,
};
