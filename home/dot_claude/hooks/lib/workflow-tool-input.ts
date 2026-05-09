import { resolve } from "node:path";
import { expandTilde } from "./path-utils.ts";
import {
  isLessonsLearnedPath,
  isPlanNumberedPath,
  isSpecPath,
} from "./workflow-paths.ts";

export type WorkflowEditTargetType =
  | "spec"
  | "plan-numbered"
  | "plan"
  | "lessons-learned";

export interface WorkflowEditInfo {
  isEdit: boolean;
  targetType: WorkflowEditTargetType | null;
  targetPath: string | null;
}

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PLAN_FILENAME = "plan.md";

/**
 * Inspect a tool invocation and decide whether it edits a Document Workflow
 * artifact (spec.md / plan.md / plan-N.md / lessons-learned.md). Returns the
 * resolved absolute path and target type for downstream hooks (P9 / P10 / P12).
 *
 * For non-edit tools (Bash, Read, etc.) and edits to unrelated files, returns
 * isEdit=false / targetType=null. Hooks can early-return on this signal.
 */
export function isWorkflowDocumentEdit(
  toolName: string,
  toolInput: unknown,
  wfDir: string,
): WorkflowEditInfo {
  if (!EDIT_TOOLS.has(toolName)) {
    return { isEdit: false, targetType: null, targetPath: null };
  }
  if (typeof toolInput !== "object" || toolInput === null) {
    return { isEdit: false, targetType: null, targetPath: null };
  }
  const input = toolInput as Record<string, unknown>;
  const rawPath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : null;
  if (rawPath === null) {
    return { isEdit: false, targetType: null, targetPath: null };
  }
  const abs = resolve(wfDir, expandTilde(rawPath));
  if (isSpecPath(abs, wfDir)) {
    return { isEdit: true, targetType: "spec", targetPath: abs };
  }
  if (isPlanNumberedPath(abs, wfDir)) {
    return { isEdit: true, targetType: "plan-numbered", targetPath: abs };
  }
  if (abs === resolve(wfDir, PLAN_FILENAME)) {
    return { isEdit: true, targetType: "plan", targetPath: abs };
  }
  if (isLessonsLearnedPath(abs, wfDir)) {
    return { isEdit: true, targetType: "lessons-learned", targetPath: abs };
  }
  return { isEdit: false, targetType: null, targetPath: null };
}
