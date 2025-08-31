#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { logCommand, logTool } from "../lib/centralized-logging.ts";
import { isBashToolInput, isFileToolInput } from "../types/project-types.ts";
import "../types/tool-schemas.ts";

/**
 * Command logger for tracking tool usage
 * Converted from original command-logger.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input, session_id } = context.input;

    try {
      // Log Bash commands using centralized logger
      if (isBashToolInput(tool_name, tool_input)) {
        const command = tool_input.command || "";
        const description = tool_input.description || "";
        
        // Use centralized logging
        logCommand(command, session_id, description);
      }

      // Log tool usage for Edit/Write tools
      if (isFileToolInput(tool_name, tool_input)) {
        const filePath = tool_input.file_path || "";
        logTool(tool_name, session_id, filePath, "Auto-format triggered");
      }

      return context.success({});

    } catch (error) {
      // Don't block on logging errors, but log the error
      console.error(`Command logger error: ${error}`);
      return context.success({});
    }
  }
});


export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
