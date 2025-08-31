#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createAskResponse, createDenyResponse } from "../lib/context-helpers.ts";
import "../types/tool-schemas.ts";

/**
 * Auto-approve commands based on permissions.allow/deny lists
 * Converted from auto-approve-commands.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true } as const,
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Exit early if no tool name
    if (!tool_name) {
      return context.success({});
    }

    // Get permission lists
    const { allowList, denyList } = getPermissionLists(tool_name);

    try {
      // Process based on tool type
      if (tool_name === "Bash") {
        const bashResult = processBashTool(tool_input, denyList, allowList);

        // Handle early exit conditions (dangerous commands requiring manual review)
        if (bashResult.earlyExit) {
          const [exitType, exitReason] = bashResult.earlyExit.split("|", 2);
          if (exitType === "ask") {
            return context.json(createAskResponse(exitReason || "Manual review required"));
          }
        }

        const decision = analyzeBashCommands(bashResult.individualResults, bashResult.denyMatches);

        // Log the decision
        logDecision(tool_name, tool_input, decision.decision, decision.reason);

        if (decision.decision === "deny") {
          return context.json(createDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        }

        // Allow by default
        return context.success({});

      } else {
        // Handle other tools
        const otherResult = processOtherTool(tool_name, tool_input, denyList, allowList);
        const decision = analyzePatternMatches(otherResult.allowMatches, otherResult.denyMatches);

        // Log the decision
        logDecision(tool_name, tool_input, decision.decision, decision.reason);

        if (decision.decision === "deny") {
          return context.json(createDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        }

        // Allow by default
        return context.success({});
      }

    } catch (error) {
      return context.json(createDenyResponse(`Error in auto-approve: ${error}`));
    }
  }
});

// Helper functions (adapted from original implementation)

interface BashCommandResult {
  result?: string;
  denyMatch?: string;
  earlyExit?: string;
}

interface BashToolResult {
  individualResults: string[];
  denyMatches: string[];
  earlyExit?: string;
}

interface OtherToolResult {
  denyMatches: string[];
  allowMatches: string[];
}

function getPermissionLists(tool_name: string): { allowList: string[]; denyList: string[] } {
  if (process.env.CLAUDE_TEST_MODE === "1") {
    // Test mode
    try {
      const allowJson = JSON.parse(process.env.CLAUDE_TEST_ALLOW || "[]");
      const denyJson = JSON.parse(process.env.CLAUDE_TEST_DENY || "[]");

      const allowList = Array.isArray(allowJson)
        ? allowJson.filter((pattern: string) => pattern.startsWith(`${tool_name}(`))
        : [];
      const denyList = Array.isArray(denyJson)
        ? denyJson.filter((pattern: string) => pattern.startsWith(`${tool_name}(`))
        : [];

      return { allowList, denyList };
    } catch {
      return { allowList: [], denyList: [] };
    }
  } else {
    // Normal mode - get from settings files
    const workspaceRoot = getWorkspaceRoot();
    const settingsFiles = getSettingsFiles(workspaceRoot);
    const allowList = extractPermissionList("allow", settingsFiles);
    const denyList = extractPermissionList("deny", settingsFiles);

    return { allowList, denyList };
  }
}

function getWorkspaceRoot(): string | undefined {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return result.trim();
  } catch {
    return process.cwd();
  }
}

interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
}

function getSettingsFiles(workspaceRoot?: string): SettingsFile[] {
  const settingsFiles: SettingsFile[] = [];

  // Global settings
  const globalSettingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(globalSettingsPath)) {
    try {
      const content = readFileSync(globalSettingsPath, "utf-8");
      settingsFiles.push(JSON.parse(content) as SettingsFile);
    } catch {
      // Ignore parse errors
    }
  }

  // Workspace settings
  if (workspaceRoot) {
    const workspaceSettingsPath = join(workspaceRoot, ".claude", "settings.json");
    if (existsSync(workspaceSettingsPath)) {
      try {
        const content = readFileSync(workspaceSettingsPath, "utf-8");
        settingsFiles.push(JSON.parse(content) as SettingsFile);
      } catch {
        // Ignore parse errors
      }
    }
  }

  return settingsFiles;
}

function extractPermissionList(type: "allow" | "deny", settingsFiles: SettingsFile[]): string[] {
  const patterns: string[] = [];

  for (const file of settingsFiles) {
    const list = file.permissions?.[type];
    if (Array.isArray(list)) {
      patterns.push(...list);
    }
  }

  return patterns;
}

function processBashTool(tool_input: any, denyList: string[], allowList: string[]): BashToolResult {
  const bashCommand = tool_input.command || "";
  const extractedCommands = extractCommandsFromCompound(bashCommand);

  const individualResults: string[] = [];
  const denyMatches: string[] = [];

  for (const cmd of extractedCommands) {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) continue;

    const result = processBashCommand(trimmedCmd, denyList, allowList);

    if (result.earlyExit) {
      return {
        individualResults,
        denyMatches,
        earlyExit: result.earlyExit,
      };
    }

    if (result.result) {
      individualResults.push(result.result);
    }

    if (result.denyMatch) {
      denyMatches.push(result.denyMatch);
    }
  }

  return {
    individualResults,
    denyMatches,
  };
}

function processBashCommand(cmd: string, denyList: string[], allowList: string[]): BashCommandResult {
  // Check for dangerous commands first
  const dangerResult = checkDangerousCommand(cmd);
  if (dangerResult.isDangerous) {
    if (dangerResult.requiresManualReview) {
      return {
        earlyExit: `ask|${dangerResult.reason}`,
      };
    } else {
      return {
        result: `DENY: '${cmd}' (blocked: ${dangerResult.reason})`,
        denyMatch: dangerResult.reason,
      };
    }
  }

  // Check deny patterns
  if (denyList.length > 0) {
    const denyResult = checkIndividualCommandDenyWithPattern(cmd, denyList);
    if (denyResult.matches && denyResult.matchedPattern) {
      return {
        result: `DENY: '${cmd}' (matched: ${denyResult.matchedPattern})`,
        denyMatch: `Individual command blocked: ${cmd}`,
      };
    }
  }

  // Check allow patterns
  if (allowList.length > 0) {
    const allowResult = checkIndividualCommandWithMatchedPattern(cmd, allowList);
    if (allowResult.matches && allowResult.matchedPattern) {
      return {
        result: `ALLOW: '${cmd}' (matched: ${allowResult.matchedPattern})`,
      };
    } else {
      return {
        result: `NO_MATCH: '${cmd}' (no allow pattern matched)`,
      };
    }
  } else {
    return {
      result: `NO_MATCH: '${cmd}' (no allow patterns defined)`,
    };
  }
}

function processOtherTool(tool_name: string, tool_input: any, denyList: string[], allowList: string[]): OtherToolResult {
  const denyMatches: string[] = [];
  const allowMatches: string[] = [];

  // Check deny patterns first
  for (const pattern of denyList) {
    if (pattern.trim() && checkPattern(pattern, tool_name, tool_input)) {
      denyMatches.push(pattern);
    }
  }

  // Check allow patterns
  for (const pattern of allowList) {
    if (pattern.trim() && checkPattern(pattern, tool_name, tool_input)) {
      allowMatches.push(pattern);
    }
  }

  return {
    denyMatches,
    allowMatches,
  };
}

// Simplified pattern matching functions (core logic from original implementation)
function extractCommandsFromCompound(command: string): string[] {
  // Simple split on ; && || for now - can be enhanced
  return command.split(/[;&|]{1,2}/).map(cmd => cmd.trim()).filter(Boolean);
}

function checkDangerousCommand(cmd: string): { isDangerous: boolean; requiresManualReview: boolean; reason: string } {
  const dangerousPatterns = [
    { pattern: /rm\s+-rf\s+\//, reason: "Dangerous system deletion", requiresReview: false },
    { pattern: /sudo\s+rm/, reason: "Sudo deletion command", requiresReview: false },
    { pattern: /dd\s+.*\/dev\//, reason: "Disk operation", requiresReview: false },
    { pattern: /mkfs/, reason: "Filesystem creation", requiresReview: false },
    { pattern: /curl.*\|\s*sh/, reason: "Piped shell execution", requiresReview: true },
    { pattern: /wget.*\|\s*sh/, reason: "Piped shell execution", requiresReview: true },
  ];

  for (const { pattern, reason, requiresReview } of dangerousPatterns) {
    if (pattern.test(cmd)) {
      return { isDangerous: true, requiresManualReview: requiresReview, reason };
    }
  }

  return { isDangerous: false, requiresManualReview: false, reason: "" };
}

function checkIndividualCommandWithMatchedPattern(cmd: string, patterns: string[]): { matches: boolean; matchedPattern?: string } {
  for (const pattern of patterns) {
    if (checkCommandPattern(pattern, cmd)) {
      return { matches: true, matchedPattern: pattern };
    }
  }
  return { matches: false };
}

function checkIndividualCommandDenyWithPattern(cmd: string, patterns: string[]): { matches: boolean; matchedPattern?: string } {
  for (const pattern of patterns) {
    if (checkCommandPattern(pattern, cmd)) {
      return { matches: true, matchedPattern: pattern };
    }
  }
  return { matches: false };
}

function checkCommandPattern(pattern: string, cmd: string): boolean {
  // Extract command from Bash(command:*) format
  const match = pattern.match(/^Bash\(([^)]+)\)$/);
  if (!match) return false;

  const cmdPattern = match[1];
  if (!cmdPattern) return false;

  // Simple wildcard matching - can be enhanced
  if (cmdPattern.endsWith(":*")) {
    const prefix = cmdPattern.slice(0, -2);
    return cmd.startsWith(prefix);
  }

  return cmd === cmdPattern;
}

function checkPattern(pattern: string, tool_name: string, tool_input: any): boolean {
  // Check if pattern matches the tool name
  if (!pattern.startsWith(`${tool_name}(`)) {
    return false;
  }

  // Extract the pattern content from Tool(pattern) format
  const match = pattern.match(new RegExp(`^${tool_name}\\(([^)]+)\\)$`));
  if (!match) return false;

  const pathPattern = match[1];
  if (!pathPattern) return false;

  // Get the file path from tool input based on tool type
  let filePath: string | undefined;
  if (tool_name === "Write" || tool_name === "Edit" || tool_name === "MultiEdit") {
    filePath = tool_input.file_path;
  } else if (tool_name === "Read") {
    filePath = tool_input.file_path;
  } else if (tool_name === "NotebookEdit" || tool_name === "NotebookRead") {
    filePath = tool_input.notebook_path;
  }

  if (!filePath) return false;

  // Handle different pattern types
  if (pathPattern === "**") {
    // Match all paths
    return true;
  } else if (pathPattern.startsWith("!")) {
    // Negation pattern - this is an allow pattern, not a deny
    const negatedPattern = pathPattern.slice(1);
    return !matchesPathPattern(filePath, negatedPattern);
  } else {
    // Regular pattern matching
    return matchesPathPattern(filePath, pathPattern);
  }
}

function analyzeBashCommands(individualResults: string[], denyMatches: string[]): { decision: string; reason: string } {
  if (denyMatches.length > 0) {
    return {
      decision: "deny",
      reason: `Blocked by security rules: ${denyMatches.join(", ")}`
    };
  }

  const allowCount = individualResults.filter(r => r.startsWith("ALLOW:")).length;
  const noMatchCount = individualResults.filter(r => r.startsWith("NO_MATCH:")).length;

  if (allowCount > 0 && noMatchCount === 0) {
    return {
      decision: "allow",
      reason: `All commands matched allow patterns (${allowCount} commands)`
    };
  }

  if (noMatchCount > 0) {
    return {
      decision: "ask",
      reason: `Some commands did not match allow patterns (${noMatchCount} commands)`
    };
  }

  return {
    decision: "ask",
    reason: "No permission patterns configured"
  };
}

function analyzePatternMatches(allowMatches: string[], denyMatches: string[]): { decision: string; reason: string } {
  if (denyMatches.length > 0) {
    return {
      decision: "deny",
      reason: `Matched deny patterns: ${denyMatches.join(", ")}`
    };
  }

  if (allowMatches.length > 0) {
    return {
      decision: "allow",
      reason: `Matched allow patterns: ${allowMatches.join(", ")}`
    };
  }

  return {
    decision: "ask",
    reason: "No matching patterns found"
  };
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  // Convert relative paths to absolute for consistent matching
  let absoluteFilePath = filePath;
  if (!filePath.startsWith("/")) {
    // For relative paths, use the current working directory
    absoluteFilePath = join(process.cwd(), filePath);
  }

  // Handle tilde expansion
  let absolutePattern = pattern;
  if (pattern.startsWith("~/")) {
    absolutePattern = join(homedir(), pattern.slice(2));
  }

  // Handle wildcard patterns
  if (absolutePattern.endsWith("/**")) {
    let prefix = absolutePattern.slice(0, -3);
    // Handle relative patterns like ./**
    if (prefix === ".") {
      prefix = process.cwd();
    } else if (prefix.startsWith("./")) {
      prefix = join(process.cwd(), prefix.slice(2));
    }
    return absoluteFilePath.startsWith(prefix);
  } else if (absolutePattern.endsWith("/*")) {
    const prefix = absolutePattern.slice(0, -2);
    const dirPath = absoluteFilePath.substring(0, absoluteFilePath.lastIndexOf("/"));
    return dirPath === prefix;
  } else if (absolutePattern.includes("*")) {
    // Convert glob pattern to regex
    const regexPattern = absolutePattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(absoluteFilePath);
  } else {
    // Exact match
    return absoluteFilePath === absolutePattern;
  }
}

function logDecision(tool_name: string, tool_input: any, decision: string, reason: string): void {
  const logFile = join(homedir(), ".claude", "auto_approve_commands.log");
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${tool_name}: ${decision} - ${reason}\n`;

  try {
    // Simple append to log file
    const fs = require("node:fs");
    fs.appendFileSync(logFile, logEntry);
  } catch {
    // Ignore logging errors
  }
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
