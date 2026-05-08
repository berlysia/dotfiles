import { resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";

const PLAN_FILENAME = "plan.md";
const SPEC_FILENAME = "spec.md";
const RESEARCH_FILENAME = "research.md";
const STATE_FILENAME = "workflow-state.json";
const REVIEW_CACHE_FILENAME = "plan-review.cache.json";
const REVIEW_MARKDOWN_FILENAME = "plan-review.md";
const REVIEW_JSON_FILENAME = "plan-review.json";

const PLAN_NUMBERED_REGEX = /^plan-[0-9]+\.md$/;

export type WorkflowDocumentType = "spec" | "plan" | "plan-numbered";

/**
 * Resolve the workflow directory for the current session.
 * Returns null when DOCUMENT_WORKFLOW_DIR is not set.
 */
export function getWorkflowDir(cwd: string): string | null {
  const envDir = process.env.DOCUMENT_WORKFLOW_DIR;
  if (envDir && envDir.length > 0) {
    return resolve(cwd, expandTilde(envDir));
  }
  return null;
}

export function getPlanPath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, PLAN_FILENAME) : null;
}

export function getSpecPath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, SPEC_FILENAME) : null;
}

export function getResearchPath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, RESEARCH_FILENAME) : null;
}

export function getStatePath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, STATE_FILENAME) : null;
}

export function getReviewCachePath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, REVIEW_CACHE_FILENAME) : null;
}

export function getReviewMarkdownPath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, REVIEW_MARKDOWN_FILENAME) : null;
}

export function getReviewJsonPath(cwd: string): string | null {
  const dir = getWorkflowDir(cwd);
  return dir ? resolve(dir, REVIEW_JSON_FILENAME) : null;
}

/**
 * Check if a given path is a workflow document (plan.md or research.md)
 * within the current session's workflow directory.
 */
export function isWorkflowDocumentPath(cwd: string, path: string): boolean {
  const planPath = getPlanPath(cwd);
  const researchPath = getResearchPath(cwd);
  if (!planPath || !researchPath) {
    return false;
  }
  const normalized = resolve(cwd, expandTilde(path));
  return normalized === planPath || normalized === researchPath;
}

/**
 * Check if a given absolute path is a plan.md within any workflow directory.
 * Matches both legacy (.tmp/plan.md) and session-based (.tmp/sessions/<id>/plan.md).
 */
export function isPlanFile(absolutePath: string): boolean {
  return absolutePath.endsWith(`/${PLAN_FILENAME}`);
}

/**
 * Detect the type of a workflow document by filename.
 * - "spec": spec.md (design layer in two-layer mode)
 * - "plan": plan.md (single-layer mode, contains lightweight spec)
 * - "plan-numbered": plan-N.md where N is one or more digits (execution layer in two-layer mode)
 * Returns null for unrelated files. Strict regex match prevents false-allow on
 * `plan-draft.md` / `plan-1.md.bak` / `plan-2-draft.md` etc.
 */
export function getWorkflowDocumentType(
  absolutePath: string,
): WorkflowDocumentType | null {
  const filename = absolutePath.split("/").pop() ?? "";
  if (filename === SPEC_FILENAME) {
    return "spec";
  }
  if (filename === PLAN_FILENAME) {
    return "plan";
  }
  if (PLAN_NUMBERED_REGEX.test(filename)) {
    return "plan-numbered";
  }
  return null;
}

/**
 * Check if a given absolute path is any workflow document (spec.md / plan.md / plan-N.md).
 */
export function isWorkflowDocument(absolutePath: string): boolean {
  return getWorkflowDocumentType(absolutePath) !== null;
}

/**
 * Resolve all workflow artifact paths from a known workflow directory.
 * Enables co-location: once any artifact's directory is known,
 * all sibling artifacts can be found without env var resolution.
 */
export function resolveWorkflowPaths(workflowDir: string): {
  plan: string;
  spec: string;
  research: string;
  state: string;
  reviewCache: string;
  reviewMarkdown: string;
  reviewJson: string;
} {
  return {
    plan: resolve(workflowDir, PLAN_FILENAME),
    spec: resolve(workflowDir, SPEC_FILENAME),
    research: resolve(workflowDir, RESEARCH_FILENAME),
    state: resolve(workflowDir, STATE_FILENAME),
    reviewCache: resolve(workflowDir, REVIEW_CACHE_FILENAME),
    reviewMarkdown: resolve(workflowDir, REVIEW_MARKDOWN_FILENAME),
    reviewJson: resolve(workflowDir, REVIEW_JSON_FILENAME),
  };
}

/**
 * Get the relative workflow dir path (for display/logging purposes).
 * Returns null when DOCUMENT_WORKFLOW_DIR is not set.
 */
export function getWorkflowDirRelative(): string | null {
  const envDir = process.env.DOCUMENT_WORKFLOW_DIR;
  if (envDir && envDir.length > 0) {
    return envDir;
  }
  return null;
}
