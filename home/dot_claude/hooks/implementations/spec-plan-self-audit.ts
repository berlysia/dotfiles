#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { getWorkflowDir } from "../lib/workflow-paths.ts";
import { isWorkflowDocumentEdit } from "../lib/workflow-tool-input.ts";
import "../types/tool-schemas.ts";

const CHECKLIST_LINES = [
  "Self-audit checklist (P9):",
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
    const wfDir = getWorkflowDir(cwd);
    if (!wfDir) return context.success({});

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
    if (editInfo.targetPath && existsSync(editInfo.targetPath)) {
      const safe = realpathInsideWorkflowDir(editInfo.targetPath, wfDir);
      if (!safe) return context.success({});
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

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
