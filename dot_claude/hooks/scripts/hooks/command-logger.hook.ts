#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// Custom tool definitions
declare module "cc-hooks-ts" {
  interface ToolSchema {
    Bash: {
      input: {
        command: string;
        description?: string;
        run_in_background?: boolean;
        timeout?: number;
      };
      response: {
        stdout: string;
        stderr: string;
        exit_code: number;
      };
    };
  }
}

/**
 * Command logger for tracking tool usage
 * Converted from original command-logger.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { toolName, toolInput, session_id } = context.event;

    try {
      // Initialize logging
      const logDir = join(homedir(), ".claude");
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      // Only log Bash commands for now (can be extended)
      if (toolName === "Bash") {
        logBashCommand(toolInput, session_id);
      }

      // Log auto-format events for Edit/Write tools
      if (["Edit", "MultiEdit", "Write"].includes(toolName)) {
        logAutoFormatEvent(toolName, toolInput, session_id);
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

function logBashCommand(toolInput: any, sessionId?: string): void {
  const command = toolInput.command || "";
  const description = toolInput.description || "";
  
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    session_id: sessionId,
    tool_name: "Bash",
    command: command.replace(/\n/g, "\\n"), // Escape newlines
    description,
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

function logAutoFormatEvent(toolName: string, toolInput: any, sessionId?: string): void {
  const filePath = toolInput.file_path || "";
  
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    user: process.env.USER || "unknown",
    cwd: process.cwd(),
    session_id: sessionId,
    tool_name: toolName,
    file_path: filePath,
    description: "Auto-format triggered",
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