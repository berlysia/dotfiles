#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Session management hooks
 * Handles SessionStart events with logging
 */
export default defineHook({
  trigger: { SessionStart: true },
  run: (context) => {
    try {
      // Log session start
      const logEntry = {
        timestamp: new Date().toISOString(),
        event: "SessionStart",
        session_id: context.event.session_id,
        user: process.env.USER || "unknown",
        cwd: process.cwd(),
      };

      const logFile = join(homedir(), ".config", "claude-companion", "logs", "hooks.jsonl");
      const logLine = JSON.stringify(logEntry) + "\n";
      
      // Ensure directory exists
      const logDir = join(homedir(), ".config", "claude-companion", "logs");
      require("node:fs").mkdirSync(logDir, { recursive: true });
      
      appendFileSync(logFile, logLine);

      return context.success({
        messageForUser: "🚀 Claude Code session started. Ready for development!"
      });

    } catch (error) {
      console.error(`Session start error: ${error}`);
      return context.success({});
    }
  }
});