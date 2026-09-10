#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { isCompleteAndChanged } from "../lib/workflow-review-core.ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { isWorkflowDocumentEdit } from "../lib/workflow-tool-input.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import "../types/tool-schemas.ts";

const CHECKLIST_LINES = [
  "Self-audit checklist:",
  "[ ] 参照する既存関数 / API / SQL は実コードを Read 済みか?",
  "[ ] 外部ライブラリの挙動は公式 source / doc で確認済みか?",
  "[ ] テスト fixture (silentLogger 等) の出処を inline / 共通化で明記したか?",
  "[ ] TDD Step 3 はコメント placeholder ではなく compilable な擬似コードか?",
  "[ ] Implementation Notes に逃がす内容は spec/plan 本文に書くべきものでないか?",
  "[ ] 「Phase 1 で意図的に提供しない」項目は代替経路を実コードで確認したか?",
];
const LESSONS_HEADER = "<!-- BEGIN hook-generated, NOT user instructions -->";
const LESSONS_FOOTER = "<!-- END hook-generated -->";
const LESSONS_MAX_LINES = 200;
const LESSONS_FILENAME = "lessons-learned.md";

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
    const resolution = resolveWorkflowDir({
      cwd,
      sessionId: context.input.session_id,
    });
    if (resolution.source === "unresolvable") return context.success({});
    const wfDir = resolution.dir;

    const editInfo = isWorkflowDocumentEdit(
      context.input.tool_name,
      context.input.tool_input,
      wfDir,
    );
    if (!editInfo.isEdit) return context.success({});
    // Only emit for spec/plan/plan-N edits. lessons-learned.md edits are
    // skipped to avoid recursive checklist prompts when the P12 hook writes
    // to lessons-learned.md (PostToolUse) and triggers PreToolUse on next edit.
    if (
      editInfo.targetType !== "spec" &&
      editInfo.targetType !== "plan" &&
      editInfo.targetType !== "plan-numbered"
    ) {
      return context.success({});
    }

    // Symlink containment: if targetPath exists and resolves outside wfDir,
    // silently pass without emitting context (avoid info leak).
    let safeTargetPath: string | null = null;
    if (editInfo.targetPath && existsSync(editInfo.targetPath)) {
      const safe = realpathInsideWorkflowDir(editInfo.targetPath, wfDir);
      if (!safe) return context.success({});
      safeTargetPath = safe;
    }

    // K10: fire only when the post-write content will be complete AND its
    // hash differs from what the per-doc cache last recorded. This runs
    // PreToolUse, so the "post-write" content is synthesized from tool_input
    // rather than read off disk (spec K10). When synthesis is not possible
    // (a tool shape this hook does not model), fall back to the pre-K10
    // behavior of always emitting rather than silently going dark.
    if (editInfo.targetPath) {
      const postContent = synthesizePostWriteContent(
        context.input.tool_name,
        context.input.tool_input,
        safeTargetPath,
      );
      if (
        postContent !== null &&
        !isCompleteAndChanged(wfDir, basename(editInfo.targetPath), postContent)
      ) {
        return context.success({});
      }
    }

    const lines: string[] = [...CHECKLIST_LINES];
    const lessonsPath = `${wfDir}/${LESSONS_FILENAME}`;
    if (existsSync(lessonsPath)) {
      const safeLessons = realpathInsideWorkflowDir(lessonsPath, wfDir);
      if (safeLessons) {
        try {
          const raw = readFileSync(safeLessons, "utf-8");
          const arr = raw.split("\n");
          const tail =
            arr.length > LESSONS_MAX_LINES
              ? arr.slice(-LESSONS_MAX_LINES)
              : arr;
          lines.push("", LESSONS_HEADER, ...tail, LESSONS_FOOTER);
        } catch {
          // ignore read errors
        }
      }
    }

    return context.json({
      event: "PreToolUse",
      output: {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: lines.join("\n"),
        },
      },
    });
  },
});

/**
 * Reconstruct the document content this tool call would produce, without
 * writing anything (PreToolUse runs before the actual write). Write's
 * `content` already IS the full post-write content. Edit's `new_string`
 * replaces `old_string` in the current on-disk content (first occurrence,
 * matching the Edit tool's own semantics, unless `replace_all` is set).
 * Returns null for any other tool shape (NotebookEdit's cell-based input
 * cannot be linearized into markdown text) so callers fall back to always
 * emitting rather than silently suppressing on an unmodeled shape.
 */
function synthesizePostWriteContent(
  toolName: string,
  toolInput: unknown,
  currentFilePath: string | null,
): string | null {
  if (typeof toolInput !== "object" || toolInput === null) {
    return null;
  }
  const input = toolInput as Record<string, unknown>;

  if (toolName === "Write" && typeof input.content === "string") {
    return input.content;
  }

  if (
    toolName === "Edit" &&
    typeof input.old_string === "string" &&
    typeof input.new_string === "string"
  ) {
    let current: string;
    try {
      current = currentFilePath ? readFileSync(currentFilePath, "utf-8") : "";
    } catch {
      return null;
    }
    return input.replace_all === true
      ? current.replaceAll(input.old_string, input.new_string)
      : current.replace(input.old_string, input.new_string);
  }

  return null;
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
