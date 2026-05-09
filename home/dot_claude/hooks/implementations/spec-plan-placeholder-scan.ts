#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { getWorkflowDir } from "../lib/workflow-paths.ts";
import { isWorkflowDocumentEdit } from "../lib/workflow-tool-input.ts";
import "../types/tool-schemas.ts";

/**
 * Placeholder pattern table. Each detection emits "line N: <name>" only —
 * the matched body is NOT included in output to prevent spec/plan content
 * leakage to hooks.jsonl (spec.md R8).
 */
const PLACEHOLDER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "TBD", pattern: /\bTBD\b/ },
  { name: "TODO", pattern: /\bTODO\b/ },
  { name: "後で実装", pattern: /後で実装/ },
  { name: "fill-in-details", pattern: /fill in details/i },
  { name: "適切に", pattern: /適切に/ },
  { name: "問題なく", pattern: /問題なく/ },
  { name: "正しく", pattern: /正しく/ },
  { name: "シンプルに", pattern: /シンプルに/ },
  { name: "安全に", pattern: /安全に/ },
  { name: "妥当な", pattern: /妥当な/ },
];

const IGNORE_OPEN = "<!-- placeholder-scan: ignore -->";
const IGNORE_CLOSE = "<!-- /placeholder-scan: ignore -->";

const hook = defineHook({
  trigger: { PostToolUse: true },
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
    if (
      editInfo.targetType !== "spec" &&
      editInfo.targetType !== "plan" &&
      editInfo.targetType !== "plan-numbered"
    ) {
      return context.success({});
    }

    if (!editInfo.targetPath) return context.success({});
    const safe = realpathInsideWorkflowDir(editInfo.targetPath, wfDir);
    if (!safe || !existsSync(safe)) return context.success({});

    let body: string;
    try {
      body = readFileSync(safe, "utf-8");
    } catch {
      return context.success({});
    }

    const lines = body.split("\n");
    const findings: string[] = [];
    let inIgnore = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes(IGNORE_OPEN)) {
        inIgnore = true;
        continue;
      }
      if (line.includes(IGNORE_CLOSE)) {
        inIgnore = false;
        continue;
      }
      if (inIgnore) continue;
      for (const { name, pattern } of PLACEHOLDER_PATTERNS) {
        if (pattern.test(line)) {
          findings.push(`line ${i + 1}: ${name}`);
        }
      }
    }
    if (findings.length === 0) return context.success({});

    const additionalContext = [
      "[placeholder-scan] No Placeholders 禁則違反候補:",
      ...findings,
      "(line numbers + matched-token only; body content is intentionally not echoed)",
    ].join("\n");

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

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
