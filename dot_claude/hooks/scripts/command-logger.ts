#!/usr/bin/env bun

/*
 * Claude Code Command Logger
 * Records command execution with precise timing using Pre/Post hook matching
 * Compliant with Claude Code hooks specification
 * Output: One line per command with execution time
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { readdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { readHookInput, readStopHookInput, getWorkspaceRoot } from "./lib/hook-common.js";
import type { HookInput, StopHookInput, LogEntry, PendingCommand } from "./types/hooks-types.js";

// Configuration
const WORKSPACE_ROOT = getWorkspaceRoot(process.cwd());
const LOG_DIR = join(WORKSPACE_ROOT, ".claude", "log");
const COMMAND_LOG = join(LOG_DIR, "command_execution.log");
const TIMING_DIR = join(LOG_DIR, "cmd_timing");

// Ensure directories exist
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TIMING_DIR, { recursive: true });

// Main execution
const hookType = process.argv[2] || "unknown";
const timestamp = new Date().toISOString();
const timestampNs = Date.now() * 1000000 + (performance.now() % 1) * 1000000;

/**
 * Extract command information from tool input data
 */
function extractCommandInfo(toolInputData: any): {
  command: string;
  description: string;
} {
  try {
    return {
      command: toolInputData?.command || "",
      description: toolInputData?.description || ""
    };
  } catch {
    return { command: "", description: "" };
  }
}

/**
 * Generate stable command ID with session isolation
 */
function generateCommandId(toolInputData: any, sessionId: string): string {
  try {
    // Sort keys for consistent hashing
    const sortedParams = Object.keys(toolInputData || {})
      .sort()
      .reduce((result, key) => {
        result[key] = toolInputData[key];
        return result;
      }, {} as Record<string, any>);

    const paramsString = JSON.stringify(sortedParams);
    const paramsHash = Buffer.from(paramsString)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 8);

    const sessionHash = Buffer.from(sessionId)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 8);

    return `cmd_${paramsHash}_${sessionHash}`;
  } catch {
    return `cmd_unknown_${sessionId}`;
  }
}

/**
 * Get or generate session ID
 */
function getSessionId(input: HookInput): string {
  // Use official session_id from Claude Code hooks if available
  if (input.session_id) {
    return Buffer.from(input.session_id)
      .toString("base64")
      .replace(/[^a-zA-Z0-9]/g, "")
      .substring(0, 8);
  }

  // Fallback to environment variable or process-based ID
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  const processId = `${process.ppid || 0}_${process.pid}`;
  const sessionId = Buffer.from(processId)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 8);

  process.env.CLAUDE_SESSION_ID = sessionId;
  return sessionId;
}

/**
 * Generate command statistics
 */
function generateStatistics(): void {
  const statsFile = join(LOG_DIR, "command_stats.txt");
  const statsScript = join(dirname(import.meta.url.replace('file://', '')), "generate_stats.sh");

  if (!existsSync(COMMAND_LOG)) {
    return;
  }

  try {
    // Use external script for statistics generation if available
    if (existsSync(statsScript)) {
      const output = execSync(`"${statsScript}" "${COMMAND_LOG}"`, {
        encoding: "utf8"
      });
      writeFileSync(statsFile, output);
      console.log(`📊 Command statistics updated: ${statsFile}`);
    } else {
      // Fallback simple statistics
      const commandCount = readFileSync(COMMAND_LOG, "utf8").split("\n").length - 1;
      const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";
      
      const stats = [
        `# Command Statistics (Generated: ${timestamp})`,
        `Total commands: ${commandCount}`,
        `Session: ${sessionId}`,
        ""
      ].join("\n");

      writeFileSync(statsFile, stats);
      console.log(`📊 Basic statistics generated: ${statsFile}`);
    }
  } catch (error) {
    console.error("Failed to generate statistics:", error);
  }
}

/**
 * Handle PreToolUse hook - store command info for timing
 */
function handlePreToolUse(input: HookInput, commandId: string, timestampNs: number): void {
  const { command, description } = extractCommandInfo(input.tool_input);
  
  const pendingFile = join(TIMING_DIR, `.pending_${commandId}_${timestampNs}`);
  const pendingData: PendingCommand = {
    command_id: commandId,
    command,
    description,
    timestamp_ns: timestampNs
  };

  try {
    writeFileSync(pendingFile, JSON.stringify(pendingData, null, 2));
  } catch (error) {
    console.error("Failed to write pending command file:", error);
  }
}

/**
 * Handle PostToolUse hook - calculate execution time and log
 */
async function handlePostToolUse(input: HookInput, commandId: string, timestampNs: number): Promise<void> {
  const timeoutSeconds = 300; // 5 minutes timeout
  const cutoffTimeNs = timestampNs - (timeoutSeconds * 1000000000);

  try {
    // Find pending files for this command
    const files = await readdir(TIMING_DIR);
    const pendingFiles = files
      .filter(file => file.startsWith(`.pending_${commandId}_`))
      .map(file => join(TIMING_DIR, file))
      .sort()
      .reverse(); // Most recent first

    for (const pendingFile of pendingFiles) {
      try {
        if (!existsSync(pendingFile)) continue;

        const pendingData: PendingCommand = JSON.parse(readFileSync(pendingFile, "utf8"));
        
        // Check if within timeout range
        if (pendingData.timestamp_ns > cutoffTimeNs) {
          // Calculate execution time
          const totalDurationMs = Math.round((timestampNs - pendingData.timestamp_ns) / 1000000);

          // Create log entry
          const logEntry: LogEntry = {
            timestamp,
            command_id: commandId,
            duration_ms: totalDurationMs,
            command: pendingData.command,
            description: pendingData.description
          };

          const logLine = `${timestamp}|${commandId}|${totalDurationMs}ms|${pendingData.command}|${pendingData.description}`;
          
          // Append to command execution log
          writeFileSync(COMMAND_LOG, logLine + "\n", { flag: "a" });

          // Clean up pending file
          rmSync(pendingFile, { force: true });
          break;
        }
      } catch (error) {
        console.error(`Error processing pending file ${pendingFile}:`, error);
      }
    }

    // Periodic cleanup of stale files (every 100th command)
    const commandCount = existsSync(COMMAND_LOG) 
      ? readFileSync(COMMAND_LOG, "utf8").split("\n").length - 1
      : 0;
      
    if (commandCount % 100 === 0 && commandCount > 0) {
      await cleanupStaleFiles(60 * 60 * 1000); // 60 minutes
    }
  } catch (error) {
    console.error("Error handling PostToolUse:", error);
  }
}

/**
 * Handle Stop hook - cleanup and generate statistics
 */
async function handleStop(timestampNs: number): Promise<void> {
  const stopLogFile = join(LOG_DIR, "stop_hook.log");
  const stopMessage = `🛑 Stop hook executed at ${timestamp}`;
  
  console.log(stopMessage);
  writeFileSync(stopLogFile, stopMessage + "\n", { flag: "a" });

  try {
    const timeoutSeconds = 300; // 5 minutes
    await cleanupStaleFiles(timeoutSeconds * 1000);
    
    console.log("📊 Generating command statistics...");
    generateStatistics();
  } catch (error) {
    console.error("Error in stop hook cleanup:", error);
  }
}

/**
 * Clean up stale pending files
 */
async function cleanupStaleFiles(timeoutMs: number): Promise<void> {
  try {
    const files = await readdir(TIMING_DIR);
    const pendingFiles = files
      .filter(file => file.startsWith(".pending_"))
      .map(file => join(TIMING_DIR, file));

    let cleanupCount = 0;
    const cutoffTime = Date.now() - timeoutMs;

    for (const file of pendingFiles) {
      try {
        const stats = await stat(file);
        if (stats.mtime.getTime() < cutoffTime) {
          rmSync(file, { force: true });
          cleanupCount++;
        }
      } catch (error) {
        // File might have been deleted already, ignore
      }
    }

    if (cleanupCount > 0) {
      const cleanupMessage = `Cleaned up ${cleanupCount} timed-out pending files`;
      const cleanupLog = join(LOG_DIR, "cleanup.log");
      
      writeFileSync(cleanupLog, `${timestamp}: ${cleanupMessage}\n`, { flag: "a" });
      console.log(cleanupMessage);
    }
  } catch (error) {
    console.error("Error during cleanup:", error);
  }
}

// Main execution
try {
  switch (hookType) {
    case "PreToolUse":
    case "PostToolUse": {
      const input = readHookInput();
      
      // Only process Bash tool commands
      if (input.tool_name !== "Bash") {
        console.log(JSON.stringify(input));
        process.exit(0);
      }

      const sessionId = getSessionId(input);
      const commandId = generateCommandId(input.tool_input, sessionId);

      if (hookType === "PreToolUse") {
        handlePreToolUse(input, commandId, timestampNs);
      } else {
        await handlePostToolUse(input, commandId, timestampNs);
      }
      
      // Pass through input unchanged (required by Claude Code hooks specification)
      console.log(JSON.stringify(input));
      break;
    }
      
    case "Stop": {
      const stopInput = readStopHookInput();
      await handleStop(timestampNs);
      
      // Pass through input unchanged (required by Claude Code hooks specification)
      console.log(JSON.stringify(stopInput));
      break;
    }

    default:
      console.error(`Unknown hook type: ${hookType}`);
      process.exit(1);
  }
} catch (error) {
  console.error("Command logger error:", error);
  process.exit(1);
}