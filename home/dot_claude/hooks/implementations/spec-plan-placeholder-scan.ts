#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  isCompleteAndChanged,
  scanPlaceholders,
} from "../lib/workflow-review-core.ts";
import { realpathInsideWorkflowDir } from "../lib/workflow-fs.ts";
import { isWorkflowDocumentEdit } from "../lib/workflow-tool-input.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import "../types/tool-schemas.ts";

const hook = defineHook({
  trigger: { PostToolUse: true },
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

    // K10: only scan a document that is both complete and newly changed
    // (per-doc cache hash differs) — not on every keystroke of a still-draft
    // document (spec K10, decision-quality 2 / performance 10).
    if (!isCompleteAndChanged(wfDir, basename(safe), body)) {
      return context.success({});
    }

    const findings = scanPlaceholders(body).map(
      ({ line, name }) => `line ${line}: ${name}`,
    );
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
