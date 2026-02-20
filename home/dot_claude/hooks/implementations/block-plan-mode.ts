#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";

/**
 * Block EnterPlanMode and redirect to Document Workflow.
 * Plan Mode is superseded by Document Workflow which provides
 * better traceability, review automation, and multi-session support.
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name } = context.input;

    if (tool_name !== "EnterPlanMode") {
      return context.success({});
    }

    const workflowDir =
      process.env.DOCUMENT_WORKFLOW_DIR || ".tmp/sessions/<session-id>/";

    return context.json(
      createDenyResponse(
        `EnterPlanMode is disabled. Use Document Workflow instead.\n\n` +
          `Document Workflow procedure:\n` +
          `1. Research: Read relevant code and write findings to \`${workflowDir}research.md\`\n` +
          `2. Plan: Write implementation plan to \`${workflowDir}plan.md\`\n` +
          `3. Iterate: Update plan until \`Plan Status: complete\`\n` +
          `4. Auto-review: plan-review-automation runs automatically on plan.md edits\n` +
          `5. Approval: Human sets \`Approval Status: approved\`\n` +
          `6. Implement: Proceed only after plan complete + review pass + human approval\n\n` +
          `This workflow provides better traceability and review automation than Plan Mode.`,
      ),
    );
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
