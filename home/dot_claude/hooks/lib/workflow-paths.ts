import { resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";

const DEFAULT_WORKFLOW_DIR = ".tmp";
const PLAN_FILENAME = "plan.md";
const RESEARCH_FILENAME = "research.md";
const STATE_FILENAME = "workflow-state.json";
const REVIEW_CACHE_FILENAME = "plan-review.cache.json";
const REVIEW_MARKDOWN_FILENAME = "plan-review.md";
const REVIEW_JSON_FILENAME = "plan-review.json";

/**
 * Resolve the workflow directory for the current session.
 * Uses DOCUMENT_WORKFLOW_DIR env var if set, otherwise falls back to `.tmp/`.
 */
export function getWorkflowDir(cwd: string): string {
  const envDir = process.env.DOCUMENT_WORKFLOW_DIR;
  if (envDir && envDir.length > 0) {
    return resolve(cwd, expandTilde(envDir));
  }
  return resolve(cwd, DEFAULT_WORKFLOW_DIR);
}

export function getPlanPath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), PLAN_FILENAME);
}

export function getResearchPath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), RESEARCH_FILENAME);
}

export function getStatePath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), STATE_FILENAME);
}

export function getReviewCachePath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), REVIEW_CACHE_FILENAME);
}

export function getReviewMarkdownPath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), REVIEW_MARKDOWN_FILENAME);
}

export function getReviewJsonPath(cwd: string): string {
  return resolve(getWorkflowDir(cwd), REVIEW_JSON_FILENAME);
}

/**
 * Check if a given path is a workflow document (plan.md or research.md)
 * within the current session's workflow directory.
 */
export function isWorkflowDocumentPath(cwd: string, path: string): boolean {
  const normalized = resolve(cwd, expandTilde(path));
  return normalized === getPlanPath(cwd) || normalized === getResearchPath(cwd);
}

/**
 * Check if a given absolute path is a plan.md within any workflow directory.
 * Matches both legacy (.tmp/plan.md) and session-based (.tmp/sessions/<id>/plan.md).
 */
export function isPlanFile(absolutePath: string): boolean {
  return absolutePath.endsWith(`/${PLAN_FILENAME}`);
}

/**
 * Get the relative workflow dir path (for display/logging purposes).
 */
export function getWorkflowDirRelative(): string {
  const envDir = process.env.DOCUMENT_WORKFLOW_DIR;
  if (envDir && envDir.length > 0) {
    return envDir;
  }
  return DEFAULT_WORKFLOW_DIR;
}
