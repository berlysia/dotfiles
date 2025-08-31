/**
 * Common functionality for Claude Code hook scripts
 * TypeScript conversion of hook-common.sh
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  HookInput,
  StopHookInput,
  ToolInput,
  SettingsFile,
  ProcessingContext,
} from "../types/hooks-types.ts";

/**
 * Read raw JSON input from stdin
 */
function readRawInput(): string {
  try {
    const input = readFileSync(0, "utf-8").trim();
    if (!input) {
      throw new Error("No input provided");
    }
    return input;
  } catch (error) {
    throw new Error(`Failed to read input: ${error}`);
  }
}

/**
 * Read and parse tool hook input from stdin (PreToolUse, PostToolUse)
 */
export function readHookInput(): HookInput {
  const input = readRawInput();

  try {
    const parsed = JSON.parse(input) as HookInput;
    
    // Validate required fields
    if (!parsed.tool_name) {
      throw new Error("Missing tool_name in input");
    }
    
    if (!parsed.tool_input) {
      throw new Error("Missing tool_input in input");
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON input: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Read and parse Stop/SubagentStop hook input from stdin
 */
export function readStopHookInput(): StopHookInput {
  const input = readRawInput();

  try {
    const parsed = JSON.parse(input) as StopHookInput;
    
    // Validate required fields
    if (!parsed.hook_event_name) {
      throw new Error("Missing hook_event_name in input");
    }
    
    if (!parsed.session_id) {
      throw new Error("Missing session_id in input");
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON input: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Extract tool information from hook input
 */
export function extractToolInfo(input: HookInput): { toolName: string; toolInput: ToolInput } {
  return {
    toolName: input.tool_name,
    toolInput: input.tool_input,
  };
}

/**
 * Get workspace root with fallback
 */
export function getWorkspaceRoot(): string | undefined;
export function getWorkspaceRoot(fallback: string): string;
export function getWorkspaceRoot(fallback?: string): string | undefined {
  try {
    const output = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Build settings file paths array
 */
export function getSettingsFiles(workspaceRoot?: string): string[] {
  const files: string[] = [];
  
  if (workspaceRoot) {
    files.push(join(workspaceRoot, ".claude", "settings.local.json"));
    files.push(join(workspaceRoot, ".claude", "settings.json"));
  }
  
  files.push(join(homedir(), ".claude", "settings.json"));
  
  return files;
}

/**
 * Load and parse a settings file safely
 */
function loadSettingsFile(filePath: string): SettingsFile | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as SettingsFile;
  } catch (error) {
    console.warn(`Warning: Failed to parse settings file ${filePath}: ${error}`);
    return undefined;
  }
}

/**
 * Extract allow/deny lists from settings files
 */
export function extractPermissionList(
  listType: "allow" | "deny",
  settingsFiles: string[]
): string[] {
  const result: string[] = [];

  for (const filePath of settingsFiles) {
    const settings = loadSettingsFile(filePath);
    if (!settings?.permissions) {
      continue;
    }

    const list = settings.permissions[listType];
    if (Array.isArray(list)) {
      result.push(...list);
    }
  }

  return result;
}

/**
 * Extract file paths from various tool inputs
 */
export function extractFilePaths(toolInput: ToolInput): string[] {
  const paths: string[] = [];

  // Check common file path fields
  if (toolInput.file_path && typeof toolInput.file_path === "string") {
    paths.push(toolInput.file_path);
  }

  if (toolInput.notebook_path && typeof toolInput.notebook_path === "string") {
    paths.push(toolInput.notebook_path);
  }

  if (toolInput.path && typeof toolInput.path === "string") {
    paths.push(toolInput.path);
  }

  if (toolInput.pattern && typeof toolInput.pattern === "string") {
    paths.push(toolInput.pattern);
  }

  // For MultiEdit tool: extract file_path from edits array
  if (toolInput.edits && Array.isArray(toolInput.edits)) {
    // If there's a file_path at the root level, use that
    if (toolInput.file_path && typeof toolInput.file_path === "string") {
      paths.push(toolInput.file_path);
    }
  }

  return paths;
}

/**
 * Build processing context for command analysis
 */
export function buildProcessingContext(
  workspaceRoot?: string,
  settingsFiles?: string[]
): ProcessingContext {
  const files = settingsFiles || getSettingsFiles(workspaceRoot);
  
  return {
    workspaceRoot,
    settingsFiles: files,
    allowPatterns: extractPermissionList("allow", files),
    denyPatterns: extractPermissionList("deny", files),
  };
}

/**
 * Utility function to safely execute shell commands
 */
export function safeExecSync(command: string): string | undefined {
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}