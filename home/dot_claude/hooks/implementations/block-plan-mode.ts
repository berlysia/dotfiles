#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { sanitizeForDisplay } from "../lib/sanitize-display.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

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

    const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
    const resolution = resolveWorkflowDir({
      cwd,
      sessionId: context.input.session_id,
    });
    // The deny text is the main path by which Claude is told where to create the
    // workflow documents, so a dir it cannot resolve must not be papered over
    // with a plausible-looking literal. Naming the shape is honest; naming a
    // path that does not exist is not.
    const resolved =
      resolution.source === "unresolvable"
        ? null
        : sanitizeForDisplay(resolution.relative);

    const researchLine = resolved
      ? `1. Research: Read relevant code and write findings to \`${resolved}/research.md\``
      : "1. Research: Read relevant code and write findings to `research.md` in the session workflow directory (the guard could not resolve its path)";
    const planLine = resolved
      ? `2. Plan: Write implementation plan to \`${resolved}/plan.md\``
      : "2. Plan: Write implementation plan to `plan.md` in the same directory";

    return context.json(
      createDenyResponse(
        `EnterPlanMode is disabled. Use Document Workflow instead.\n\n` +
          `Document Workflow procedure:\n` +
          `${researchLine}\n` +
          `${planLine}\n` +
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
