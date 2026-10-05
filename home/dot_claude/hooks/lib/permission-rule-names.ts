/**
 * Rule names that apply to a tool call. Claude Code checks file permissions
 * against Edit(...) rules for every tool that edits files and never consults
 * Write(...) / NotebookEdit(...) rules, so those tools also borrow Edit rules.
 *
 * file-access-guard's PERMISSION_CATEGORY holds the same Write -> Edit mapping
 * (plus a Read side that is not applied here, because Glob reports its
 * `pattern` instead of its `path`). Change one, review the other.
 */
const TOOLS_BORROWING_EDIT_RULES = new Set([
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

export function ruleNamesFor(toolName: string): string[] {
  return TOOLS_BORROWING_EDIT_RULES.has(toolName)
    ? [toolName, "Edit"]
    : [toolName];
}
