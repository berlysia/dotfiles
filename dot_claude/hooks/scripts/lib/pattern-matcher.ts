/**
 * Pattern matching functions for hook scripts
 * TypeScript conversion of pattern-matcher.sh
 */

import type { ToolInput } from "../types/hooks-types.js";

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
        if (!words[i].startsWith("-")) {
          const remaining = words.slice(i).join(" ");
          return { found: true, command: remaining };
        }
      }
    }
  }
  
  // Handle find -exec command
  else if (command.includes("-exec ")) {
    const execMatch = command.match(/-exec\s+(.+?)\s+[\\;+]/);
    if (execMatch) {
      return { found: true, command: execMatch[1].trim() };
    }
  }
  
  return { found: false };
}

/**
 * Extract all individual commands from compound command strings
 */
export function extractCommandsFromCompound(commandString: string): string[] {
  const commands: string[] = [];
  
  // Replace operators with unique delimiters
  let tempCommand = commandString
    .replace(/&&/g, "█AND█")
    .replace(/\|\|/g, "█OR█")
    .replace(/;/g, "█SEMI█")
    .replace(/\|/g, "█PIPE█");
  
  // Split on the unique delimiters
  const parts = tempCommand.split("█");
  
  for (const part of parts) {
    // Skip operator parts
    if (["AND", "OR", "SEMI", "PIPE"].includes(part)) {
      continue;
    }
    
    // Clean up whitespace
    const cleanPart = part.trim();
    if (!cleanPart) continue;
    
    // Add the main command
    commands.push(cleanPart);
    
    // Extract and add child commands from wrapper commands
    const childResult = extractChildCommand(cleanPart);
    if (childResult.found && childResult.command) {
      commands.push(childResult.command);
    }
    
    // Extract commands from subshells $(...) and `...`
    const subshellMatches = cleanPart.match(/\$\([^)]+\)|`[^`]+`/g);
    if (subshellMatches) {
      for (const subshell of subshellMatches) {
        let innerCmd = "";
        
        // Remove $( ) wrapping
        const dollarMatch = subshell.match(/^\$\((.+)\)$/);
        if (dollarMatch) {
          innerCmd = dollarMatch[1];
        }
        
        // Remove ` ` wrapping
        const backtickMatch = subshell.match(/^`(.+)`$/);
        if (backtickMatch) {
          innerCmd = backtickMatch[1];
        }
        
        if (innerCmd.trim()) {
          commands.push(innerCmd.trim());
        }
      }
    }
  }
  
  return commands;
}

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
function matchGitignorePattern(filePath: string, pattern: string): boolean {
  // Handle directory patterns ending with /
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    return filePath.startsWith(`${dirPattern}/`) || filePath === dirPattern;
  }
  
  // Handle ** patterns first (match any number of directories)
  if (pattern === "**") {
    return true;
  }
  
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    if (prefix.startsWith("/")) {
      // Anchored pattern - match from beginning
      return filePath.startsWith(`${prefix}/`) || filePath === prefix;
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
      return filePath.includes(prefixPattern) && filePath.includes(suffixPattern);
    }
  }
  
  // Handle patterns starting with /
  if (pattern.startsWith("/")) {
    const anchoredPattern = pattern.slice(1);
    return filePath === anchoredPattern || filePath.startsWith(`${anchoredPattern}/`);
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
function checkIndividualCommandWithPattern(
  cmd: string,
  patterns: string[]
): { matches: boolean; pattern?: string } {
  // Check built-in safe commands first
  if (isSafeBuiltinCommand(cmd)) {
    return { matches: true, pattern: "Built-in safe command" };
  }
  
  for (const pattern of patterns) {
    if (!pattern.trim()) continue;
    
    // Create a mock tool input for individual command check
    const mockInput: ToolInput = { command: cmd };
    
    if (checkPattern(pattern, "Bash", mockInput)) {
      return { matches: true, pattern };
    }
  }
  
  return { matches: false };
}

/**
 * Check individual command matches allow patterns
 */
export function checkIndividualCommand(cmd: string, allowList: string[]): boolean {
  const result = checkIndividualCommandWithPattern(cmd, allowList);
  return result.matches;
}

/**
 * Check individual command and return matching pattern
 */
export function checkIndividualCommandWithMatchedPattern(
  cmd: string,
  allowList: string[]
): { matches: boolean; matchedPattern?: string } {
  const result = checkIndividualCommandWithPattern(cmd, allowList);
  return { matches: result.matches, matchedPattern: result.pattern };
}

/**
 * Check individual command matches deny patterns
 */
export function checkIndividualCommandDeny(cmd: string, denyList: string[]): boolean {
  const result = checkIndividualCommandWithPattern(cmd, denyList);
  return result.matches;
}

/**
 * Check individual command deny and return matching pattern
 */
export function checkIndividualCommandDenyWithPattern(
  cmd: string,
  denyList: string[]
): { matches: boolean; matchedPattern?: string } {
  const result = checkIndividualCommandWithPattern(cmd, denyList);
  return { matches: result.matches, matchedPattern: result.pattern };
}

/**
 * Check if a pattern matches the tool usage
 */
export function checkPattern(pattern: string, toolName: string, toolInput: ToolInput): boolean {
  // Handle Bash tool specifically
  if (pattern.startsWith("Bash(") && pattern.endsWith(")")) {
    if (toolName !== "Bash") {
      return false;
    }
    
    // Extract the command pattern from Bash(command:*)
    const cmdPattern = pattern.slice(5, -1); // Remove "Bash(" and ")"
    
    // Get the actual command
    const actualCommand = toolInput.command || "";
    
    // Check if command matches the pattern
    if (cmdPattern.includes(":")) {
      const cmdPrefix = cmdPattern.split(":")[0];
      
      // Handle compound commands (&&, ||, ;)
      const commands = extractCommandsFromCompound(actualCommand);
      
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
    
    // Get the file path from tool input
    const filePath = (toolInput.file_path || 
                     toolInput.path || 
                     (toolInput as any).pattern ||
                     "") as string;
    
    // GitIgnore-style pattern matching
    if (pathPattern === "**") {
      return true;
    } else if (pathPattern.startsWith("!")) {
      // Negation pattern - should not match
      const negPattern = pathPattern.slice(1);
      return !matchGitignorePattern(filePath, negPattern);
    } else {
      return matchGitignorePattern(filePath, pathPattern);
    }
  } else if (pattern === toolName) {
    return true;
  }
  
  return false;
}