#!/usr/bin/env -S bun run --silent

import { isAbsolute } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { buildDependencyNotice } from "../lib/dependency-notice.ts";

const hook = defineHook({
  trigger: { SubagentStart: true },
  run: (context) => {
    const cwd = context.input.cwd;
    if (!isAbsolute(cwd)) return context.success({});

    const notice = buildDependencyNotice(cwd, undefined, {
      audience: "subagent",
    });
    if (notice === null) return context.success({});

    return context.json({
      event: "SubagentStart",
      output: {
        hookSpecificOutput: {
          hookEventName: "SubagentStart",
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
