/**
 * Pattern matching functions for hook scripts
 * TypeScript conversion of pattern-matcher.sh
 */

import type { ToolInput } from "../types/project-types.ts";
import { isBashToolInput } from "../types/project-types.ts";
import { getFilePathFromToolInput } from "./command-parsing.ts";
import {
  normalizePathForMatching,
  normalizePattern,
  type NormalizedPath,
  type NormalizedPattern,
} from "./path-utils.ts";

/**
 * Result of child command extraction
 */
interface ChildCommandResult {
  found: boolean;
  command?: string;
}

/**
 * Extract wrapper command's child command
 */
function extractChildCommand(command: string): ChildCommandResult {
  const words = command.split(/\s+/);

  // Handle timeout command
  if (command.startsWith("timeout ")) {
    if (words.length > 2) {
      const remaining = words.slice(2).join(" ");
      return { found: true, command: remaining };
    }
  }

  // Handle time command
  else if (command.startsWith("time ")) {
    if (words.length > 1) {
      const remaining = words.slice(1).join(" ");
      return { found: true, command: remaining };
    }
  }

  // Handle npx/pnpx/bunx commands
  else if (/^(npx|pnpx|bunx)\s/.test(command)) {
    if (words.length > 1) {
      const remaining = words.slice(1).join(" ");
      return { found: true, command: remaining };
    }
  }

  // Handle xargs command
  else if (command.startsWith("xargs ")) {
    if (words.length > 1) {
      // Find the first word that doesn't start with -
      for (let i = 1; i < words.length; i++) {
        const word = words[i];
        if (word && typeof word === "string" && !word.startsWith("-")) {
          const remaining = words.slice(i).join(" ");
          return { found: true, command: remaining };
        }
      }
    }
  }

  // Handle find -exec command
  else if (command.includes("-exec ")) {
    const execMatch = command.match(/-exec\s+(.+?)\s+[\\;+]/);
    if (execMatch && execMatch[1]) {
      return { found: true, command: execMatch[1].trim() };
    }
  }

  return { found: false };
}

// Function removed - use extractCommandsStructured from bash-parser.ts instead

/**
 * Check if a find command is safe to auto-approve
 */
function isSafeFindCommand(cmd: string): boolean {
  // Dangerous patterns to reject
  const dangerousPatterns = [
    /-exec\s+rm/,
    /-exec\s+rmdir/,
    /-exec\s+mv/,
    /-delete/,
    /-execdir/,
    /\/etc\//,
    /\/proc\//,
    /\/sys\//,
    /\/dev\//,
    /\/var\/log/,
    /\/usr\/bin/,
    /\/usr\/sbin/,
    /\/bin\//,
    /\/sbin\//,
  ];

  // Check for dangerous patterns
  for (const pattern of dangerousPatterns) {
    if (pattern.test(cmd)) {
      return false;
    }
  }

  // Special case: cp to /dev/ is dangerous
  if (/-exec\s+cp/.test(cmd) && /\/dev\//.test(cmd)) {
    return false;
  }

  // Extract start path
  const pathMatch = cmd.match(/find\s+([^\s]+)/);
  const startPath = pathMatch ? pathMatch[1] : "";

  // If no path specified or starts with ., allow it
  if (!startPath || startPath === "." || startPath.startsWith("./")) {
    return true;
  }

  // Allow relative paths that don't go up directories excessively
  if (!startPath.startsWith("/") && !startPath.includes("../../../")) {
    return true;
  }

  // Allow specific safe absolute paths
  const safeAbsolutePaths = [
    new RegExp(`^/home/${process.env.USER || "\\w+"}`),
    /^\/tmp/,
    /^\/var\/tmp/,
  ];

  for (const safePattern of safeAbsolutePaths) {
    if (safePattern.test(startPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a command is safe to auto-approve (built-in safe commands)
 */
function isSafeBuiltinCommand(cmd: string): boolean {
  const cmdName = cmd.split(/\s+/)[0];

  switch (cmdName) {
    case "sleep":
      // Sleep is generally safe
      return true;
    case "find":
      // Check if find command is safe
      return isSafeFindCommand(cmd);
    default:
      return false;
  }
}

/**
 * GitIgnore-style pattern matching
 */
/**
 * Match a normalized file path against a normalized pattern (type-safe overload)
 *
 * This overload requires branded types to ensure type safety and prevent
 * accidental mixing of file paths and patterns.
 */
export function matchGitignorePattern(
  filePath: NormalizedPath,
  pattern: NormalizedPattern,
): boolean;

/**
 * Match a file path against a pattern (backward compatibility overload)
 *
 * This overload accepts plain strings for backward compatibility during migration.
 * New code should use the branded type overload.
 *
 * @deprecated Prefer using the overload with NormalizedPath and NormalizedPattern
 */
export function matchGitignorePattern(
  filePath: string,
  pattern: string,
): boolean;

export function matchGitignorePattern(
  filePath: string | NormalizedPath,
  pattern: string | NormalizedPattern,
): boolean {
  // Handle directory patterns ending with /
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    return filePath.startsWith(`${dirPattern}/`) || filePath === dirPattern;
  }

  // Handle ** patterns first (match any number of directories)
  if (pattern === "**") {
    // Security check: Reject parent directory traversal
    // Absolute paths are safe as long as they don't contain directory traversal
    if (filePath.startsWith("../") || filePath.includes("/../")) {
      return false;
    }
    return true;
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (prefix.startsWith("/")) {
      // Anchored pattern - match from beginning
      return filePath.startsWith(`${prefix}/`) || filePath === prefix;
    } else if (prefix === "." || prefix === "") {
      // Special case for ./** - matches paths within current directory
      // Security check: Reject parent directory traversal
      if (filePath.startsWith("../") || filePath.includes("/../")) {
        return false;
      }
      // For ./** pattern, only match relative paths (converted from cwd-relative absolute paths)
      // Absolute paths outside cwd should not match ./**
      if (pattern.startsWith("./**") && filePath.startsWith("/")) {
        return false;
      }
      return true;
    } else {
      // Not anchored - can match anywhere
      return filePath.includes(`${prefix}/`) || filePath.includes(prefix);
    }
  }

  if (pattern.includes("/**/")) {
    const [prefix, suffix] = pattern.split("/**/");
    const prefixPattern = prefix || "";
    const suffixPattern = suffix || "";

    // Simple check for middle ** patterns
    if (prefixPattern && suffixPattern) {
      return (
        filePath.includes(prefixPattern) && filePath.includes(suffixPattern)
      );
    }
  }

  // Handle patterns starting with /
  if (pattern.startsWith("/")) {
    const anchoredPattern = pattern.slice(1);
    return (
      filePath === anchoredPattern || filePath.startsWith(`${anchoredPattern}/`)
    );
  } else {
    // Not anchored - can match anywhere in path
    if (pattern.includes(".")) {
      // For patterns like *.js, match the filename
      const basename = filePath.split("/").pop() || "";
      return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(basename);
    } else {
      // For patterns without extension, check each directory level
      const pathParts = filePath.split("/");
      for (const part of pathParts) {
        if (new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(part)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Check if individual command matches any pattern
 */
async function checkIndividualCommandWithPattern(
  cmd: string,
  patterns: string[],
): Promise<{ matches: boolean; pattern?: string }> {
  // Check built-in safe commands first
  if (isSafeBuiltinCommand(cmd)) {
    return { matches: true, pattern: "Built-in safe command" };
  }

  for (const pattern of patterns) {
    if (!pattern.trim()) continue;

    // Create a mock tool input for individual command check
    const mockInput: ToolInput = { command: cmd };

    if (await checkPattern(pattern, "Bash", mockInput)) {
      return { matches: true, pattern };
    }
  }

  return { matches: false };
}

/**
 * Check individual command matches allow patterns
 */
export async function checkIndividualCommand(
  cmd: string,
  allowList: string[],
): Promise<boolean> {
  const result = await checkIndividualCommandWithPattern(cmd, allowList);
  return result.matches;
}

/**
 * Check individual command and return matching pattern
 */
export async function checkIndividualCommandWithMatchedPattern(
  cmd: string,
  allowList: string[],
): Promise<{ matches: boolean; matchedPattern?: string }> {
  const result = await checkIndividualCommandWithPattern(cmd, allowList);
  return {
    matches: result.matches,
    ...(result.pattern && { matchedPattern: result.pattern }),
  };
}

/**
 * Check individual command matches deny patterns
 */
export async function checkIndividualCommandDeny(
  cmd: string,
  denyList: string[],
): Promise<boolean> {
  // Skip built-in safe commands - they should never be denied
  if (isSafeBuiltinCommand(cmd)) {
    return false;
  }

  const result = await checkIndividualCommandWithPattern(cmd, denyList);
  return result.matches;
}

/**
 * Check individual command deny and return matching pattern
 */
export async function checkIndividualCommandDenyWithPattern(
  cmd: string,
  denyList: string[],
): Promise<{ matches: boolean; matchedPattern?: string }> {
  // Skip built-in safe commands - they should never be denied
  // This prevents the logic error where isSafeBuiltinCommand=true causes denial
  if (isSafeBuiltinCommand(cmd)) {
    return { matches: false };
  }

  const result = await checkIndividualCommandWithPattern(cmd, denyList);
  return {
    matches: result.matches,
    ...(result.pattern && { matchedPattern: result.pattern }),
  };
}

/**
 * Check if a pattern matches the tool usage
 */
export async function checkPattern(
  pattern: string,
  toolName: string,
  toolInput: unknown,
): Promise<boolean> {
  // Handle Bash tool specifically
  if (pattern.startsWith("Bash(") && pattern.endsWith(")")) {
    if (toolName !== "Bash") {
      return false;
    }

    // Extract the command pattern from Bash(command:*)
    const cmdPattern = pattern.slice(5, -1); // Remove "Bash(" and ")"

    // Reject ** pattern for Bash tool - it's not a valid Bash pattern
    // Bash tool uses command prefixes like "npm:*" not file patterns like "**"
    if (cmdPattern === "**") {
      return false;
    }

    // Get the actual command using type guard
    const actualCommand = isBashToolInput(toolName, toolInput)
      ? toolInput.command || ""
      : "";

    // Check if command matches the pattern
    if (cmdPattern.includes(":")) {
      const cmdPrefix = cmdPattern.split(":")[0];
      if (!cmdPrefix) return false;

      // Handle compound commands (&&, ||, ;) - now async
      const { extractCommandsStructured } = await import(
        "../lib/bash-parser.ts"
      );
      const { individualCommands } = await extractCommandsStructured(
        actualCommand || "",
      );
      const commands = individualCommands;

      for (let cmd of commands) {
        // Trim whitespace and remove leading & characters
        cmd = cmd.trim().replace(/^&+/, "");

        // Check if command starts with the prefix
        if (cmd.startsWith(cmdPrefix)) {
          return true;
        }

        // Also check if the prefix appears as a word within the command
        // This catches cases like "timeout 15 pnpm test" matching "pnpm:*"
        if (cmd.includes(` ${cmdPrefix} `) || cmd.endsWith(` ${cmdPrefix}`)) {
          return true;
        }
      }
    } else if (actualCommand === cmdPattern) {
      return true;
    }

    return false;
  }

  // Handle other tools with file path patterns
  if (pattern.startsWith(`${toolName}(`)) {
    // Extract the path pattern
    const pathPattern = pattern.slice(toolName.length + 1, -1); // Remove "ToolName(" and ")"

    // Get the file path from tool input using helper
    const rawFilePath = getFilePathFromToolInput(toolName, toolInput) || "";

    // If no path is provided and the pattern expects a path, don't match
    // This allows tools without paths to be handled by smartPassTools logic
    if (!rawFilePath) {
      return false;
    }

    // Normalize path and pattern using utility functions
    const filePath = normalizePathForMatching(rawFilePath, pathPattern);
    const normalizedPattern = normalizePattern(pathPattern);

    // GitIgnore-style pattern matching
    if (pathPattern === "**") {
      // Use matchGitignorePattern to ensure security checks are applied
      return matchGitignorePattern(filePath, normalizePattern("**"));
    } else if (pathPattern.startsWith("!")) {
      // Negation pattern - should not match
      const negPattern = pathPattern.slice(1);
      const normalizedNegPattern = normalizePattern(negPattern);
      return !matchGitignorePattern(filePath, normalizedNegPattern);
    } else {
      return matchGitignorePattern(filePath, normalizedPattern);
    }
  } else if (pattern === toolName) {
    return true;
  }

  return false;
}
