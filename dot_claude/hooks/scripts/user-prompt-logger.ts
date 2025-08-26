#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * User prompt submission logger
 * Logs UserPromptSubmit events for analytics
 */
export default defineHook({
  trigger: { UserPromptSubmit: true },
  run: (context) => {
    try {
      // Log user prompt submission
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "UserPromptSubmit",
        session_id: context.input.session_id,
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      const logFile = join(homedir(), ".config", "claude-companion", "logs", "hooks.jsonl");
      const logLine = JSON.stringify(logEntry) + "\n";
      
      // Ensure directory exists
      const logDir = join(homedir(), ".config", "claude-companion", "logs");
      require("node:fs").mkdirSync(logDir, { recursive: true });
      
      appendFileSync(logFile, logLine);

      return context.success({});

    } catch (error) {
      console.error(`User prompt logger error: ${error}`);
      return context.success({});
    }
  }
});