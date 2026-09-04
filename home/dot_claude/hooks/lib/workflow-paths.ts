import { resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";

const PLAN_FILENAME = "plan.md";
const SPEC_FILENAME = "spec.md";
const RESEARCH_FILENAME = "research.md";
const STATE_FILENAME = "workflow-state.json";
const REVIEW_CACHE_FILENAME = "plan-review.cache.json";
const REVIEW_MARKDOWN_FILENAME = "plan-review.md";
const REVIEW_JSON_FILENAME = "plan-review.json";
const LESSONS_LEARNED_FILENAME = "lessons-learned.md";

const PLAN_NUMBERED_REGEX = /^plan-[0-9]+\.md$/;

export type WorkflowDocumentType = "spec" | "plan" | "plan-numbered";

/**
 * Resolve the workflow directory for the current session.
 * Returns null when DOCUMENT_WORKFLOW_DIR is not set.
 *
 * Superseded by `resolveWorkflowDir` in `lib/workflow-resolve.ts`. Kept only so
 * that the two-phase chezmoi apply stays safe: removing a lib export while the
 * deployed hooks still import it opens the window spec K15 describes. Deletion
 * is tracked as K8 item 6.
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

/**
 * Path to the design-layer document in two-layer mode.
 *
 * Consumers reach spec.md through `resolveWorkflowPaths().spec`; this accessor
 * exists to keep the per-document family complete alongside getPlanPath and
 * getResearchPath.
 *
 * @public
 */
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
 *
 * Superseded by `resolveWorkflowDir` in `lib/workflow-resolve.ts`. Kept only so
 * that the two-phase chezmoi apply stays safe: removing a lib export while the
 * deployed hooks still import it opens the window spec K15 describes. Deletion
 * is tracked as K8 item 6.
 */
export function getWorkflowDirRelative(): string | null {
  const envDir = process.env.DOCUMENT_WORKFLOW_DIR;
  if (envDir && envDir.length > 0) {
    return envDir;
  }
  return null;
}

/**
 * Pure path predicates for spec / plan-N / lessons-learned within a workflow dir.
 * Used by P9/P10/P12 hooks (added in plan-1) to share path detection logic.
 * Reuses existing constants (SPEC_FILENAME, PLAN_NUMBERED_REGEX) for SSoT consistency.
 */
export function isSpecPath(absPath: string, wfDir: string): boolean {
  return absPath === resolve(wfDir, SPEC_FILENAME);
}

export function isPlanNumberedPath(absPath: string, wfDir: string): boolean {
  const prefix = `${wfDir}/`;
  if (!absPath.startsWith(prefix)) return false;
  const filename = absPath.slice(prefix.length);
  return PLAN_NUMBERED_REGEX.test(filename);
}

export function isLessonsLearnedPath(absPath: string, wfDir: string): boolean {
  return absPath === resolve(wfDir, LESSONS_LEARNED_FILENAME);
}

const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{8,}$/;

/** The project-relative directory that holds one directory per session. */
export const SESSIONS_ROOT = ".tmp/sessions";

/**
 * Session ids reach hooks as `string` with no non-empty guarantee, and the
 * derived dir is built by slicing them. An allowlist is required rather than a
 * denylist: `""` slices to `""` and `"."` collapses to the sessions root, so
 * both would make every session share one directory.
 *
 * This prevents the degenerate collision, not every collision: two ids sharing
 * their first eight characters still map to one dir. That property is
 * inherited from `session.ts:33-35` and is accepted by spec K13, which
 * declines to bind approval to a session.
 */
export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_REGEX.test(sessionId);
}

/**
 * The default workflow dir, relative to the project root.
 *
 * This is the single definition of the expression that `session.ts` previously
 * held on its own; both it and the guard now derive from here so the startup
 * summary and the enforcement path cannot drift apart silently.
 *
 * Callers must check `isValidSessionId` first. `resolveWorkflowDir` does; call
 * that instead unless you have already validated.
 */
export function deriveDefaultWorkflowDir(sessionId: string): string {
  return `${SESSIONS_ROOT}/${sessionId.slice(0, 8)}`;
}
