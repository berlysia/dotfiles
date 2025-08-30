#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import "../types/tool-schemas.ts";

/**
 * Command logger for tracking tool usage
 * Converted from original command-logger.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input, session_id } = context.input;

    try {
      // Initialize logging
      const logDir = join(homedir(), ".claude");
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // Only log Bash commands for now (can be extended)
      if (tool_name === "Bash") {
        logBashCommand(tool_input, session_id);
      }

      // Log auto-format events for Edit/Write tools
      if (["Edit", "MultiEdit", "Write"].includes(tool_name)) {
        logAutoFormatEvent(tool_name, tool_input, session_id);
      }

      return context.success({});

    } catch (error) {
      // Don't block on logging errors, but log the error
      console.error(`Command logger error: ${error}`);
      return context.success({});
    }
  }
});

interface LogEntry {
  timestamp: string;
  user: string;
  cwd: string;
  session_id?: string;
  tool_name: string;
  command?: string;
  description?: string;
  exit_code?: number;
  file_path?: string;
}

function logBashCommand(tool_input: any, sessionId?: string): void {
  const command = tool_input.command || "";
  const description = tool_input.description || "";

  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    tool_name: "Bash",
    command: command.replace(/\n/g, "\\n"), // Escape newlines
    description,
    ...(sessionId && { session_id: sessionId }),
  };

  // Write to command history log (compatible with existing format)
  const commandHistoryLog = join(homedir(), ".claude", "command_history.log");
  const logLine = `[${new Date().toLocaleString()}] ${logEntry.user} [${logEntry.cwd}]: ${logEntry.command}\n`;

  try {
    appendFileSync(commandHistoryLog, logLine);
  } catch (error) {
    console.error(`Failed to write command history: ${error}`);
  }

  // Write structured log entry
  writeStructuredLog(logEntry);
}

function logAutoFormatEvent(tool_name: string, tool_input: any, sessionId?: string): void {
  const filePath = tool_input.file_path || "";

  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    tool_name: tool_name,
    file_path: filePath,
    description: "Auto-format triggered",
    ...(sessionId && { session_id: sessionId }),
  };

  writeStructuredLog(logEntry);
}

function writeStructuredLog(logEntry: LogEntry): void {
  const structuredLogFile = join(homedir(), ".claude", "tool_usage.jsonl");
  const logLine = JSON.stringify(logEntry) + "\n";

  try {
    appendFileSync(structuredLogFile, logLine);
  } catch (error) {
    console.error(`Failed to write structured log: ${error}`);
  }
}