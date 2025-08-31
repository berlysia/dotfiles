#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";

/**
 * User prompt submission logger
 * Logs UserPromptSubmit events using centralized logging
 */
const hook = defineHook({
  trigger: { UserPromptSubmit: true },
  run: (context) => {
    try {
      // Log user prompt submission using centralized logger
      logEvent("UserPromptSubmit", context.input.session_id);

      return context.success({});

    } catch (error) {
      console.error(`User prompt logger error: ${error}`);
      return context.success({});
    }
  }
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}