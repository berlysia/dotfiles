#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  createAskResponse,
  createDenyResponse,
  createAllowResponse,
} from "../lib/context-helpers.ts";
import { logDecision } from "../lib/centralized-logging.ts";
import {
  isBashToolInput,
  type PermissionDecision,
} from "../types/project-types.ts";
import {
  checkDangerousCommand,
  checkCommandPattern,
  getFilePathFromToolInput,
  getCommandFromToolInput,
  NO_PAREN_TOOL_NAMES,
  CONTROL_STRUCTURE_KEYWORDS,
} from "../lib/command-parsing.ts";
import { extractCommandsStructured } from "../lib/bash-parser.ts";
import {
  checkIndividualCommandWithMatchedPattern as patternMatcherCheckAllow,
  checkIndividualCommandDenyWithPattern as patternMatcherCheckDeny,
  checkPattern as patternMatcherCheckPattern,
  matchGitignorePattern,
} from "../lib/pattern-matcher.ts";
import { analyzePatternMatches } from "../lib/decision-maker.ts";
import { normalizePath, normalizePattern } from "../lib/path-utils.ts";
import "../types/tool-schemas.ts";

/**
 * Auto-approve commands based on permissions.allow/deny lists
 * Converted from auto-approve-commands.ts using cc-hooks-ts
 */
const hook = defineHook({
  // Use broad PreToolUse trigger to include unknown/MCP tools as well
  trigger: { PreToolUse: true },
  run: async (context) => {
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
        // Use improved structured processing
        const bashResult = await processBashTool(
          tool_input,
          denyList,
          allowList,
        );
        const decision = analyzeBashCommands(
          bashResult.commands,
          bashResult.hasAskRequired,
          bashResult.hasPassRequired,
        );

        // Log the decision using centralized logger
        const command = isBashToolInput(tool_name, tool_input)
          ? tool_input.command
          : undefined;
        logDecision(
          tool_name,
          decision.decision,
          decision.reason,
          context.input.session_id,
          command,
          tool_input,
        );

        if (decision.decision === "deny") {
          return context.json(createDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        } else if (decision.decision === "allow") {
          return context.json(createAllowResponse(decision.reason));
        } else if (decision.decision === "pass") {
          // Pass through to Claude Code - no hook intervention
          return context.success({});
        }

        // Fallback: pass by default
        return context.success({});
      } else {
        // Handle other tools with special logic for certain tools
        const smartPassTools = ["ExitPlanMode", "WebFetch", "WebSearch", "Glob", "Search", "Grep"];
        
        if (smartPassTools.includes(tool_name)) {
          // For these tools, check explicit patterns first, then pass if no matches
          const otherResult = await processOtherTool(
            tool_name,
            tool_input,
            denyList,
            allowList,
          );
          
          // If there are explicit deny or allow matches, respect them
          if (otherResult.denyMatches.length > 0 || otherResult.allowMatches.length > 0) {
            const decision = analyzePatternMatches(
              otherResult.allowMatches,
              otherResult.denyMatches,
            );
            
            logDecision(
              tool_name,
              decision.decision,
              decision.reason,
              context.input.session_id,
              undefined,
              tool_input,
            );
            
            if (decision.decision === "deny") {
              return context.json(createDenyResponse(decision.reason));
            } else if (decision.decision === "allow") {
              return context.json(createAllowResponse(decision.reason));
            }
          }
          
          // No explicit patterns matched, pass to Claude Code
          logDecision(
            tool_name,
            "pass",
            `Tool '${tool_name}' has no explicit patterns, delegating to Claude Code`,
            context.input.session_id,
            undefined,
            tool_input,
          );
          return context.success({});
        }

        // Handle other tools normally
        const otherResult = await processOtherTool(
          tool_name,
          tool_input,
          denyList,
          allowList,
        );
        const decision = analyzePatternMatches(
          otherResult.allowMatches,
          otherResult.denyMatches,
        );

        // Log the decision using centralized logger
        logDecision(
          tool_name,
          decision.decision,
          decision.reason,
          context.input.session_id,
          undefined,
          tool_input,
        );

        if (decision.decision === "deny") {
          return context.json(createDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        } else if (decision.decision === "allow") {
          return context.json(createAllowResponse(decision.reason));
        }

        // Pass by default (let Claude Code decide) - log the decision
        logDecision(
          tool_name,
          "pass",
          `Tool '${tool_name}' has no matching patterns, delegating to Claude Code`,
          context.input.session_id,
          undefined,
          tool_input,
        );
        return context.success({});
      }
    } catch (error) {
      return context.json(
        createDenyResponse(`Error in auto-approve: ${error}`),
      );
    }
  },
});

// Helper functions (adapted from original implementation)

/**
 * Structured result type for bash command processing using Tagged Union pattern
 * This provides better type safety and eliminates string parsing
 */
type BashCommandResult =
  | { type: "allow"; command: string; pattern: string }
  | { type: "deny"; command: string; reason: string; pattern?: string }
  | { type: "pass"; command: string }
  | { type: "skip"; command: string; reason: string }
  | { type: "ask"; command: string; reason: string };

/**
 * Improved BashToolResult with structured command results
 */
interface BashToolResult {
  commands: BashCommandResult[];
  hasAskRequired: boolean;
  hasPassRequired: boolean;
}

interface OtherToolResult {
  denyMatches: string[];
  allowMatches: string[];
}

function getPermissionLists(tool_name: string): {
  allowList: string[];
  denyList: string[];
} {
  if (process.env.CLAUDE_TEST_MODE === "1") {
    // Test mode
    try {
      const allowJson = JSON.parse(process.env.CLAUDE_TEST_ALLOW || "[]");
      const denyJson = JSON.parse(process.env.CLAUDE_TEST_DENY || "[]");

      const allowList = Array.isArray(allowJson)
        ? allowJson.filter(
            (pattern: string) =>
              pattern === tool_name || pattern.startsWith(`${tool_name}(`),
          )
        : [];
      const denyList = Array.isArray(denyJson)
        ? denyJson.filter(
            (pattern: string) =>
              pattern === tool_name || pattern.startsWith(`${tool_name}(`),
          )
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
      stdio: ["ignore", "pipe", "ignore"],
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
    const workspaceSettingsPath = join(
      workspaceRoot,
      ".claude",
      "settings.json",
    );
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

function extractPermissionList(
  type: "allow" | "deny",
  settingsFiles: SettingsFile[],
): string[] {
  const patterns: string[] = [];

  for (const file of settingsFiles) {
    const list = file.permissions?.[type];
    if (Array.isArray(list)) {
      patterns.push(...list);
    }
  }

  return patterns;
}

/**
 * Improved bash tool processing with structured return types
 * Uses Tagged Union pattern for better type safety
 */
async function processBashTool(
  tool_input: unknown,
  denyList: string[],
  allowList: string[],
): Promise<BashToolResult> {
  const bashCommand = getCommandFromToolInput("Bash", tool_input) || "";
  const { individualCommands } = await extractCommandsStructured(bashCommand);
  const extractedCommands = individualCommands;

  const commands: BashCommandResult[] = [];
  let hasAskRequired = false;
  let hasPassRequired = false;

  for (const cmd of extractedCommands) {
    const trimmedCmd = cmd.trim();
    if (!trimmedCmd) continue;

    const result = await processBashCommand(trimmedCmd, denyList, allowList);
    commands.push(result);

    // Check if ask is required (early exit condition)
    if (result.type === "ask") {
      hasAskRequired = true;
      break; // Early exit when ask is needed
    }

    // Track if any command requires pass-through
    if (result.type === "pass") {
      hasPassRequired = true;
    }
  }

  return {
    commands,
    hasAskRequired,
    hasPassRequired,
  };
}

/**
 * Improved bash command processing with structured return types
 * Uses Tagged Union pattern for better type safety and eliminates string parsing
 */
async function processBashCommand(
  cmd: string,
  denyList: string[],
  allowList: string[],
): Promise<BashCommandResult> {
  const trimmedCmd = cmd.trim();

  // Skip evaluation for control structure keywords - they are transparent
  if (CONTROL_STRUCTURE_KEYWORDS.includes(trimmedCmd)) {
    return {
      type: "skip",
      command: trimmedCmd,
      reason: `Control structure keyword '${trimmedCmd}'`,
    };
  }

  // Check for dangerous commands first
  const dangerResult = checkDangerousCommand(cmd);
  if (dangerResult.isDangerous) {
    if (dangerResult.requiresManualReview) {
      return {
        type: "ask",
        command: cmd,
        reason: dangerResult.reason,
      };
    } else {
      return {
        type: "deny",
        command: cmd,
        reason: dangerResult.reason,
      };
    }
  }

  // Check deny patterns
  if (denyList.length > 0) {
    const denyResult = await patternMatcherCheckDeny(cmd, denyList);
    if (denyResult.matches && denyResult.matchedPattern) {
      return {
        type: "deny",
        command: cmd,
        reason: `Individual command blocked: ${cmd}`,
        pattern: denyResult.matchedPattern,
      };
    }
  }

  // Check allow patterns
  if (allowList.length > 0) {
    const allowResult = await patternMatcherCheckAllow(cmd, allowList);
    if (allowResult.matches && allowResult.matchedPattern) {
      return {
        type: "allow",
        command: cmd,
        pattern: allowResult.matchedPattern,
      };
    } else {
      return {
        type: "pass",
        command: cmd,
      };
    }
  } else {
    return {
      type: "pass",
      command: cmd,
    };
  }
}

async function processOtherTool(
  tool_name: string,
  tool_input: unknown,
  denyList: string[],
  allowList: string[],
): Promise<OtherToolResult> {
  const denyMatches: string[] = [];
  const allowMatches: string[] = [];

  // Check deny patterns first
  for (const pattern of denyList) {
    if (
      pattern.trim() &&
      (await checkPattern(pattern, tool_name, tool_input))
    ) {
      denyMatches.push(pattern);
    }
  }

  // Check allow patterns
  for (const pattern of allowList) {
    if (
      pattern.trim() &&
      (await checkPattern(pattern, tool_name, tool_input))
    ) {
      allowMatches.push(pattern);
    }
  }

  return {
    denyMatches,
    allowMatches,
  };
}

// Pattern matching functions now use shared library imports

async function checkPattern(
  pattern: string,
  tool_name: string,
  tool_input: unknown,
): Promise<boolean> {
  // Check for invalid Bash(**) pattern and log warning
  if (pattern === "Bash(**)" && tool_name === "Bash") {
    console.warn(
      `Invalid pattern 'Bash(**)' detected. Bash tool uses command prefixes like 'Bash(npm:*)' not file patterns.`,
    );
    return false;
  }

  if (
    NO_PAREN_TOOL_NAMES.includes(tool_name) ||
    tool_name.startsWith("mcp__")
  ) {
    // For tools without parentheses, match the pattern directly or with wildcard
    // Support both "ToolName" and "ToolName(**)" patterns
    return pattern === tool_name || pattern === `${tool_name}(**)`;
  }

  // Use shared pattern checking from pattern-matcher.ts
  return await patternMatcherCheckPattern(pattern, tool_name, tool_input);
}

/**
 * Analyze structured bash command results using Tagged Union pattern
 * Provides better type safety than string parsing approach
 */
function analyzeBashCommands(
  commands: BashCommandResult[],
  hasAskRequired: boolean,
  hasPassRequired: boolean,
): { decision: PermissionDecision; reason: string } {
  // Ask takes precedence
  if (hasAskRequired) {
    const askCommand = commands.find((cmd) => cmd.type === "ask");
    return {
      decision: "ask",
      reason: askCommand?.reason
        ? `Command '${askCommand.command}': ${askCommand.reason}`
        : "Manual review required for dangerous command",
    };
  }

  // Check for denied commands
  const deniedCommands = commands.filter((cmd) => cmd.type === "deny");
  if (deniedCommands.length > 0) {
    // Create detailed breakdown of which commands were denied and why
    const denyDetails = deniedCommands.map(cmd => {
      if (cmd.pattern) {
        return `"${cmd.command}" → blocked by ${cmd.pattern}`;
      } else {
        return `"${cmd.command}" → ${cmd.reason}`;
      }
    }).join(", ");
    
    return {
      decision: "deny",
      reason: `Blocked by security rules (${deniedCommands.length} commands): ${denyDetails}`,
    };
  }

  // Check if all non-skipped commands are explicitly allowed
  const nonSkippedCommands = commands.filter((cmd) => cmd.type !== "skip");
  const allowedCommands = commands.filter((cmd) => cmd.type === "allow");
  const passCommands = commands.filter((cmd) => cmd.type === "pass");

  if (nonSkippedCommands.length === 0) {
    // Only control structure keywords are present
    const skippedCommands = commands.filter(cmd => cmd.type === 'skip');
    const skippedDetails = skippedCommands.map(cmd => `"${cmd.command}"`).join(", ");
    return {
      decision: "ask",
      reason: `Only control structure keywords present (${skippedCommands.length} keywords): ${skippedDetails}, no allow patterns defined`,
    };
  }

  if (allowedCommands.length > 0 && passCommands.length === 0) {
    // Create detailed breakdown of which commands matched which patterns
    const matchDetails = allowedCommands.map(cmd => `"${cmd.command}" → ${cmd.pattern}`).join(", ");
    return {
      decision: "allow",
      reason: `All commands matched allow patterns (${allowedCommands.length} commands): ${matchDetails}`,
    };
  }

  // Pass commands through to Claude Code (no hook intervention)
  if (passCommands.length > 0) {
    // Create detailed breakdown of which commands are passed through
    const passDetails = passCommands.map(cmd => `"${cmd.command}"`).join(", ");
    return {
      decision: "pass",
      reason: `Commands passed through to Claude Code for evaluation (${passCommands.length} commands): ${passDetails}`,
    };
  }

  // Fallback ask case - provide details about what commands need review
  const allCommands = nonSkippedCommands.map(cmd => `"${cmd.command}"`).join(", ");
  return {
    decision: "ask",
    reason: `Manual review required for commands (${nonSkippedCommands.length} commands): ${allCommands} - no permission patterns configured`,
  };
}

// analyzePatternMatches function now imported from decision-maker.ts to eliminate duplication

// matchesPathPattern functionality consolidated into pattern-matcher.ts matchGitignorePattern
// This wrapper handles path normalization and delegates to shared implementation
function matchesPathPattern(filePath: string, pattern: string): boolean {
  // Normalize file path and pattern using utility functions from path-utils.ts
  const normalizedPath = normalizePath(filePath, { makeAbsolute: true });
  const normalizedPatternStr = normalizePattern(pattern);

  // Use shared gitignore-style pattern matching from pattern-matcher.ts
  return matchGitignorePattern(normalizedPath, normalizedPatternStr);
}

// matchGitignorePattern is now imported from pattern-matcher.ts to eliminate duplication

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
