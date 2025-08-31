#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";

/**
 * Session management hooks
 * Handles SessionStart events using centralized logging
 */
const hook = defineHook({
  trigger: { SessionStart: true },
  run: (context) => {
    try {
      // Log session start using centralized logger
      logEvent("SessionStart", context.input.session_id);

      return context.success({
        messageForUser: "🚀 Claude Code session started. Ready for development!"
      });

    } catch (error) {
      console.error(`Session start error: ${error}`);
      return context.success({});
    }
  }
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}