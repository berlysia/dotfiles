#!/usr/bin/env tsx

/**
 * Auto-approve commands based on permissions.allow/deny lists
 * TypeScript conversion of auto-approve-commands.sh
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  readHookInput,
  extractToolInfo,
  getWorkspaceRoot,
  getSettingsFiles,
  extractPermissionList,
} from "./lib/hook-common.js";
import {
  extractCommandsFromCompound,
  checkIndividualCommandWithMatchedPattern,
  checkIndividualCommandDenyWithPattern,
  checkPattern,
} from "./lib/pattern-matcher.js";
import { checkDangerousCommand } from "./lib/dangerous-commands.js";
import {
  analyzeBashCommandResults,
  analyzePatternMatches,
  outputDecision,
} from "./lib/decision-maker.js";
import { logPatternAnalysis } from "./lib/logging.js";
import type {
  HookInput,
  ToolInput,
  CommandAnalysisResult,
} from "./types/hooks-types.js";

// Log file for auto-approved commands
const LOG_FILE = join(homedir(), ".claude", "auto_approve_commands.log");

/**
 * Result of processing individual bash command
 */
interface BashCommandResult {
  result?: string;
  denyMatch?: string;
  earlyExit?: string;
}

/**
 * Process individual Bash command
 */
function processBashCommand(
  cmd: string,
  denyList: string[],
  allowList: string[]
): BashCommandResult {
  // Check for dangerous commands first
  const dangerResult = checkDangerousCommand(cmd);
  if (dangerResult.isDangerous) {
    // Special handling for commands that need manual review
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

/**
 * Result of processing bash tool
 */
interface BashToolResult {
  individualResults: string[];
  denyMatches: string[];
  earlyExit?: string;
}

/**
 * Process Bash tool commands
 */
function processBashTool(
  toolInput: ToolInput,
  denyList: string[],
  allowList: string[]
): BashToolResult {
  const bashCommand = toolInput.command || "";
  const extractedCommands = extractCommandsFromCompound(bashCommand);

  const individualResults: string[] = [];
  const denyMatches: string[] = [];

  // Process each individual command
  for (const cmd of extractedCommands) {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) continue;

    const result = processBashCommand(trimmedCmd, denyList, allowList);

    // Check for early exit conditions
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

/**
 * Result of processing other tools
 */
interface OtherToolResult {
  denyMatches: string[];
  allowMatches: string[];
}

/**
 * Process non-Bash tools
 */
function processOtherTool(
  toolName: string,
  toolInput: ToolInput,
  denyList: string[],
  allowList: string[]
): OtherToolResult {
  const denyMatches: string[] = [];
  const allowMatches: string[] = [];

  // Check deny patterns first
  for (const pattern of denyList) {
    if (pattern.trim() && checkPattern(pattern, toolName, toolInput)) {
      denyMatches.push(pattern);
    }
  }

  // Check allow patterns
  for (const pattern of allowList) {
    if (pattern.trim() && checkPattern(pattern, toolName, toolInput)) {
      allowMatches.push(pattern);
    }
  }

  return {
    denyMatches,
    allowMatches,
  };
}

/**
 * Get permission lists based on environment
 */
function getPermissionLists(toolName: string): {
  allowList: string[];
  denyList: string[];
} {
  if (process.env.CLAUDE_TEST_MODE === "1") {
    // Test mode
    try {
      const allowJson = JSON.parse(process.env.CLAUDE_TEST_ALLOW || "[]");
      const denyJson = JSON.parse(process.env.CLAUDE_TEST_DENY || "[]");

      const allowList = Array.isArray(allowJson) 
        ? allowJson.filter((pattern: string) => pattern.startsWith(`${toolName}(`))
        : [];
      const denyList = Array.isArray(denyJson)
        ? denyJson.filter((pattern: string) => pattern.startsWith(`${toolName}(`))
        : [];

      return { allowList, denyList };
    } catch {
      return { allowList: [], denyList: [] };
    }
  } else {
    // Normal mode
    const workspaceRoot = getWorkspaceRoot();
    const settingsFiles = getSettingsFiles(workspaceRoot);
    const allowList = extractPermissionList("allow", settingsFiles);
    const denyList = extractPermissionList("deny", settingsFiles);

    return { allowList, denyList };
  }
}

/**
 * Main execution function
 */
function main(): void {
  try {
    // Read and validate input
    const hookInput = readHookInput();
    const { toolName, toolInput } = extractToolInfo(hookInput);

    // Exit if no tool name
    if (!toolName) {
      process.exit(0);
    }

    // Get permission lists
    const { allowList, denyList } = getPermissionLists(toolName);

    // Exit if no lists defined
    if (allowList.length === 0 && denyList.length === 0) {
      process.exit(0);
    }

    // Process based on tool type
    let decision = "";
    let decisionReason = "";
    const individualResults: string[] = [];
    const denyMatches: string[] = [];
    const allowMatches: string[] = [];

    if (toolName === "Bash") {
      const bashResult = processBashTool(toolInput, denyList, allowList);

      // Handle early exit conditions
      if (bashResult.earlyExit) {
        const [exitType, exitReason] = bashResult.earlyExit.split("|", 2);
        outputDecision(exitType as "ask" | "allow" | "deny", exitReason);
        process.exit(0);
      }

      individualResults.push(...bashResult.individualResults);
      denyMatches.push(...bashResult.denyMatches);

      const analysisResult = analyzeBashCommandResults(
        bashResult.individualResults,
        bashResult.denyMatches
      );

      decision = analysisResult.decision;
      decisionReason = analysisResult.reason;
    } else {
      const otherResult = processOtherTool(toolName, toolInput, denyList, allowList);
      
      denyMatches.push(...otherResult.denyMatches);
      allowMatches.push(...otherResult.allowMatches);

      const analysisResult = analyzePatternMatches(
        otherResult.allowMatches,
        otherResult.denyMatches
      );

      decision = analysisResult.decision;
      decisionReason = analysisResult.reason;
    }

    // Log the analysis
    logPatternAnalysis(
      LOG_FILE,
      toolName,
      toolInput,
      decision,
      decisionReason,
      individualResults,
      denyMatches,
      allowMatches
    );

    // Output the decision
    outputDecision(decision as "allow" | "deny" | "ask", decisionReason);

  } catch (error) {
    console.error(`Error in auto-approve-commands: ${error}`);
    process.exit(1);
  }
}

// Run main if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}