/**
 * Logging functions for hook scripts
 * TypeScript conversion of logging.sh
 */

import { appendFileSync } from "node:fs";
import type { ToolInput, CommandLogEntry } from "../types/hooks-types.js";

/**
 * Log pattern analysis results
 */
export function logPatternAnalysis(
  logFile: string,
  toolName: string,
  toolInput: ToolInput,
  decision: string,
  decisionReason: string,
  individualResults: string[] = [],
  denyMatches: string[] = [],
  allowMatches: string[] = []
): void {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  let logContent = `[${timestamp}] PATTERN ANALYSIS\n`;
  logContent += `Tool: ${toolName}\n`;
  
  if (toolName === "Bash") {
    const bashCommand = toolInput.command || "";
    logContent += `Command: ${bashCommand}\n`;
    
    // Show individual command analysis
    logContent += "Individual command analysis:\n";
    if (individualResults.length > 0) {
      for (const result of individualResults) {
        logContent += `  ${result}\n`;
      }
    } else {
      logContent += "  No commands extracted\n";
    }
  } else {
    logContent += `Input: ${JSON.stringify(toolInput)}\n`;
  }
  
  logContent += `Decision: ${decision}\n`;
  logContent += `Reason: ${decisionReason}\n`;
  
  if (denyMatches.length > 0) {
    logContent += "Deny matches:\n";
    for (const match of denyMatches) {
      logContent += `  - ${match}\n`;
    }
  }
  
  if (allowMatches.length > 0) {
    logContent += "Allow matches:\n";
    for (const match of allowMatches) {
      logContent += `  - ${match}\n`;
    }
  }
  
  logContent += "---\n";
  
  try {
    appendFileSync(logFile, logContent);
  } catch (error) {
    console.warn(`Warning: Failed to write to log file ${logFile}: ${error}`);
  }
}

/**
 * Create a command log entry
 */
export function createLogEntry(
  command: string,
  decision: string,
  reason: string,
  toolName: string
): CommandLogEntry {
  return {
    timestamp: new Date().toISOString(),
    command,
    decision: decision as "allow" | "deny" | "ask",
    reason,
    toolName,
  };
}

/**
 * Log a command decision to a structured log file
 */
export function logCommandDecision(
  logFile: string,
  entry: CommandLogEntry
): void {
  const logLine = JSON.stringify(entry) + "\n";
  
  try {
    appendFileSync(logFile, logLine);
  } catch (error) {
    console.warn(`Warning: Failed to write to structured log file ${logFile}: ${error}`);
  }
}