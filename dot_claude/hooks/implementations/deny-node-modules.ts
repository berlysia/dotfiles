#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { resolve } from "node:path";
import { createAskResponse, createDenyResponse } from "../lib/context-helpers.ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { extractCommandsFromCompound } from "../lib/bash-parser.ts";
import { isWriteInput, isEditInput, isMultiEditInput, isNotebookEditInput } from "../types/project-types.ts";

/**
 * Control access to node_modules directories with 3-stage analysis
 * - ALLOW: Read-only operations (ls, cat, cd, etc.)
 * - ASK: Unknown operations requiring approval
 * - DENY: Destructive operations (rm, mv, write redirects, etc.)
 * Converted from deny-node-modules-write.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;

    // Process destructive file tools and bash commands
    // Note: Read tool is excluded to allow node_modules content inspection
    const fileAccessTools = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];
    if (!fileAccessTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      // Special handling for Bash commands with 3-stage analysis
      if (tool_name === "Bash") {
        const cmd = getCommandFromToolInput("Bash", tool_input) || "";
        const bashResult = await analyzeBashCommand(cmd);
        
        switch (bashResult.decision) {
          case 'deny':
            return context.json(createDenyResponse(bashResult.reason));
          case 'ask':
            return context.json(createAskResponse(bashResult.reason));
          case 'allow':
            return context.success({});
        }
      }
      
      // For other tools, extract file path and validate
      const filePath = await extractFilePath(tool_name, tool_input);
      if (!filePath) {
        return context.success({});
      }

      // Check if path is in node_modules
      const validation = validateNodeModulesAccess(filePath);
      if (!validation.isAllowed) {
        return context.json(createDenyResponse(
          `${tool_name} access denied: ${validation.reason}\nPath: ${validation.resolvedPath}`
        ));
      }

      return context.success({});

    } catch (error) {
      return context.json(createDenyResponse(`Error in node_modules access check: ${error}`));
    }
  }
});

interface NodeModulesValidationResult {
  isAllowed: boolean;
  resolvedPath: string;
  reason?: string;
}

type Decision = 'deny' | 'allow' | 'ask';

interface AnalysisResult {
  decision: Decision;
  reason: string;
  operation?: string;
}

interface BashAnalysisResult {
  decision: Decision;
  reason: string;
  operation?: string;
}

async function extractFilePath(tool_name: string, tool_input: unknown): Promise<string | null> {
  if (isWriteInput(tool_name, tool_input)) {
    return tool_input.file_path || null;
  }
  if (isEditInput(tool_name, tool_input)) {
    return tool_input.file_path || null;
  }
  if (isMultiEditInput(tool_name, tool_input)) {
    return tool_input.file_path || null;
  }
  if (isNotebookEditInput(tool_name, tool_input)) {
    return tool_input.notebook_path || null;
  }
  if (tool_name === "Bash") {
    const cmd = getCommandFromToolInput("Bash", tool_input) || "";
    return await extractPathFromBashCommand(cmd);
  }
  return null;
}

function validateNodeModulesAccess(filePath: string): NodeModulesValidationResult {
  // Resolve to absolute path
  const resolvedPath = resolve(filePath);
  
  // Check if path contains node_modules
  if (resolvedPath.includes("/node_modules/")) {
    return {
      isAllowed: false,
      resolvedPath,
      reason: "Direct modification of node_modules files is not allowed. Use package manager commands instead."
    };
  }

  // Check if path is directly named node_modules
  if (resolvedPath.endsWith("/node_modules") || resolvedPath.includes("/node_modules")) {
    return {
      isAllowed: false,
      resolvedPath,
      reason: "Direct modification of node_modules directory is not allowed. Use package manager commands instead."
    };
  }

  // Allow all other paths
  return {
    isAllowed: true,
    resolvedPath
  };
}


async function analyzeBashCommand(command: string): Promise<BashAnalysisResult> {
  // Split compound commands and analyze each individually using bash-parser
  const commands = await extractCommandsFromCompound(command);
  
  let hasUnknown = false;
  let unknownCmd = '';
  
  // Check each command individually
  for (const cmd of commands) {
    const result = analyzeIndividualCommand(cmd);
    
    // If any command should be denied, deny the entire compound command
    if (result.decision === 'deny') {
      return {
        decision: 'deny',
        reason: `Destructive operation detected: ${cmd}`,
        operation: result.operation || 'unknown'
      };
    }
    
    // Track unknown commands
    if (result.decision === 'ask') {
      hasUnknown = true;
      unknownCmd = cmd;
    }
  }
  
  // If no denies but has unknown, ask
  if (hasUnknown) {
    return {
      decision: 'ask',
      reason: `Unknown node_modules operation requires approval: ${unknownCmd}`,
      operation: 'unknown'
    };
  }
  
  // All commands are allowed
  return { 
    decision: 'allow',
    reason: 'Read-only operations permitted'
  };
}

function analyzeIndividualCommand(cmd: string): AnalysisResult {
  // If no node_modules reference, always allow
  if (!cmd.includes('node_modules')) {
    return { decision: 'allow', reason: 'No node_modules reference' };
  }
  
  // Destructive operations - clear deny
  const destructivePatterns = [
    { pattern: /(?:^|\s)(rm|rmdir)\s+.*node_modules/, operation: 'delete' },
    { pattern: /(?:^|\s)mv\s+.*node_modules/, operation: 'move' },
    { pattern: /(?:^|\s)cp\s+.*\s+.*node_modules/, operation: 'copy-to' },
    { pattern: />+\s*[^\s]*node_modules/, operation: 'overwrite' },
    { pattern: /(?:^|\s)(chmod|chown)\s+.*node_modules/, operation: 'permission' },
    { pattern: /(?:^|\s)mkdir\s+.*node_modules/, operation: 'create' },
    { pattern: /(?:^|\s)touch\s+.*node_modules/, operation: 'create' }
  ];
  
  // Read-only operations - clear allow
  const readOnlyPatterns = [
    { pattern: /(?:^|\s)(ls|ll|la)\s+.*node_modules/, operation: 'list' },
    { pattern: /(?:^|\s)(cat|head|tail|less|more)\s+.*node_modules/, operation: 'read' },
    { pattern: /(?:^|\s)(grep|find|locate)\s+.*node_modules/, operation: 'search' },
    { pattern: /(?:^|\s)cd\s+.*node_modules/, operation: 'navigate' },
    { pattern: /(?:^|\s)(pwd|dirname|basename)/, operation: 'path-info' },
    { pattern: /(?:^|\s)(file|stat|du|wc)\s+.*node_modules/, operation: 'info' }
  ];
  
  // Check for destructive operations first
  for (const { pattern, operation } of destructivePatterns) {
    if (pattern.test(cmd)) {
      return { 
        decision: 'deny', 
        reason: `${operation} operation not allowed on node_modules`,
        operation 
      };
    }
  }
  
  // Check for read-only operations
  for (const { pattern, operation } of readOnlyPatterns) {
    if (pattern.test(cmd)) {
      return { 
        decision: 'allow', 
        reason: `${operation} operation is safe`,
        operation 
      };
    }
  }
  
  // Unknown operation - ask for approval
  return { 
    decision: 'ask', 
    reason: 'Unknown operation on node_modules requires approval',
    operation: 'unknown'
  };
}

async function extractPathFromBashCommand(command: string): Promise<string | null> {
  // Use the new analysis system to determine if command affects node_modules
  const result = await analyzeBashCommand(command);
  
  // If the command involves node_modules in any way, return dummy path to trigger processing
  if (result.decision !== 'allow' || command.includes('node_modules')) {
    return "node_modules";
  }
  
  return null;
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
