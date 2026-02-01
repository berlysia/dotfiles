#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";

const VALIDATION_MARKER = "<!-- validated -->";

/**
 * Get the most recently modified plan file
 */
function getLatestPlanFile(): string | null {
  const cwd = process.cwd();
  const planDirs = [
    join(cwd, ".claude", "plans"),
    join(process.env.HOME || "", ".claude", "plans"),
  ];

  let latestFile: string | null = null;
  let latestMtime = 0;

  for (const dir of planDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const filePath = join(dir, file);
        const stats = statSync(filePath);
        if (stats.mtimeMs > latestMtime) {
          latestMtime = stats.mtimeMs;
          latestFile = filePath;
        }
      }
    } catch {
      // Ignore errors reading directory
    }
  }

  return latestFile;
}

/**
 * Check if the plan file has the validation marker
 */
function isValidated(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.includes(VALIDATION_MARKER);
  } catch {
    return false;
  }
}

/**
 * Guard ExitPlanMode to require plan validation first.
 * Checks for validation marker in the latest plan file.
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name } = context.input;

    // Only process ExitPlanMode
    if (tool_name !== "ExitPlanMode") {
      return context.success({});
    }

    const latestPlan = getLatestPlanFile();

    // If no plan file found, allow (might be a simple case)
    if (!latestPlan) {
      return context.success({});
    }

    // Check for validation marker
    if (isValidated(latestPlan)) {
      return context.success({});
    }

    // Plan exists but not validated - deny and instruct
    return context.json(
      createDenyResponse(
        `Plan validation required before exiting Plan Mode.\n\n` +
          `Please execute /validate-plan first to verify the plan's logical consistency.\n\n` +
          `Plan file: ${latestPlan}\n\n` +
          `After validation completes, the plan will be marked as validated and you can retry ExitPlanMode.\n\n` +
          `If this is a simple plan that doesn't require validation, you can skip by adding the marker manually:\n` +
          `Edit the plan file and add "${VALIDATION_MARKER}" at the end.`
      )
    );
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
