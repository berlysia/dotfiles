#!/usr/bin/env -S bun run --silent

import { isAbsolute } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { buildDependencyNotice } from "../lib/dependency-notice.ts";
import "../types/tool-schemas.ts";

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    if (context.input.tool_name !== "EnterWorktree") {
      return context.success({});
    }

    const toolResponse: unknown = context.input.tool_response;
    const worktreePath = (
      toolResponse as { worktreePath?: unknown } | null | undefined
    )?.worktreePath;
    if (
      typeof worktreePath !== "string" ||
      worktreePath.length === 0 ||
      !isAbsolute(worktreePath)
    ) {
      return context.success({});
    }

    const notice = buildDependencyNotice(worktreePath);
    if (notice === null) return context.success({});

    return context.json({
      event: "PostToolUse",
      output: {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: notice,
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
