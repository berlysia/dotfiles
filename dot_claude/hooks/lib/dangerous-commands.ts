/**
 * Dangerous command detection functions
 * TypeScript conversion of dangerous-commands.sh
 */

import type { DangerousCommandResult } from "../types/project-types.ts";

/**
 * Check for dangerous git push commands
 */
function checkDangerousGitPush(cmd: string): string | null {
  if (/^git\s+push/.test(cmd)) {
    const forceFlags = [/-f(\s|$)/, /--force(\s|$)/, /--force-with-lease(\s|$)/];
    
    for (const flag of forceFlags) {
      if (flag.test(cmd)) {
        return `Force push blocked: ${cmd}`;
      }
    }
  }
  
  return null;
}

/**
 * Check for git commit verification bypass
 */
function checkGitCommitBypass(cmd: string): boolean {
  if (!/^git\s+commit/.test(cmd)) {
    return false;
  }
  
  // Check for various bypass flags
  const bypassPatterns = [
    /\s--no-verify(\s|$)/,
    /\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/, // -n flag in combination
    /\s-c\s+commit\.gpgsign=false(\s|$)/,
    /\s--config\s+commit\.gpgsign=false(\s|$)/,
  ];
  
  return bypassPatterns.some(pattern => pattern.test(cmd));
}

/**
 * Check for git config write operations
 */
function checkGitConfigWrite(cmd: string): boolean {
  if (!/^git\s+config/.test(cmd)) {
    return false;
  }
  
  // Allow read-only operations
  const readOnlyFlags = [
    /\s--get(\s|$)/,
    /\s--get-all(\s|$)/,
    /\s--list(\s|$)/,
    /\s--get-regexp(\s|$)/,
  ];
  
  const isReadOnly = readOnlyFlags.some(flag => flag.test(cmd));
  
  // If it's a git config command but not read-only, it's potentially dangerous
  return !isReadOnly;
}

/**
 * Check for environment variable overrides for git
 */
function checkGitEnvOverride(cmd: string): boolean {
  const envVarPattern = /^(GIT_|EMAIL=|USER=|AUTHOR=|COMMITTER=)/;
  const hasGitCommand = /git\s/.test(cmd);
  
  return envVarPattern.test(cmd) && hasGitCommand;
}

/**
 * Check for dangerous rm commands
 */
function checkDangerousRm(cmd: string): string | null {
  if (!/^rm\s/.test(cmd)) {
    return null;
  }
  
  // Check for force flags
  const forcePatterns = [
    /\s-[rfRi]*f[rfRi]*(\s|$)/,
    /\s--force(\s|$)/,
  ];
  
  for (const pattern of forcePatterns) {
    if (pattern.test(cmd)) {
      return `Force rm blocked: ${cmd}`;
    }
  }
  
  return null;
}

/**
 * Check for operations on .git directory
 */
function checkGitDirectoryOperation(cmd: string): string | null {
  if (!/^(rm|mv|rmdir)\s/.test(cmd)) {
    return null;
  }
  
  // Check if command targets .git directory or its contents
  const gitDirPatterns = [
    // .git directory itself
    /(^|\s|["']|\/)\.git(\/|\s|["']|$|\*)/,
    // .git subdirectories
    /(^|\s|["']|\/)\.git\/(objects|refs|hooks|info|logs|HEAD|config|index)(\/|\s|["']|$|\*)/,
  ];
  
  for (const pattern of gitDirPatterns) {
    if (pattern.test(cmd)) {
      return `Git directory protected: ${cmd}`;
    }
  }
  
  return null;
}

/**
 * Main function to check all dangerous commands
 */
export function checkDangerousCommand(cmd: string): DangerousCommandResult {
  // Check for dangerous git push
  const pushResult = checkDangerousGitPush(cmd);
  if (pushResult) {
    return {
      isDangerous: true,
      reason: "Force push detected",
    };
  }
  
  // Check for git commit bypass
  if (checkGitCommitBypass(cmd)) {
    return {
      isDangerous: true,
      reason: "Git commit with verification bypass detected. Manual review required.",
      requiresManualReview: true,
    };
  }
  
  // Check for git config write
  if (checkGitConfigWrite(cmd)) {
    return {
      isDangerous: true,
      reason: "Git config write operation detected. Manual review required.",
      requiresManualReview: true,
    };
  }
  
  // Check for git environment override
  if (checkGitEnvOverride(cmd)) {
    return {
      isDangerous: true,
      reason: "Git command with environment variable override detected. Manual review required.",
      requiresManualReview: true,
    };
  }
  
  // Check for dangerous rm
  const rmResult = checkDangerousRm(cmd);
  if (rmResult) {
    return {
      isDangerous: true,
      reason: "Force rm detected",
    };
  }
  
  // Check for git directory operations
  const gitDirResult = checkGitDirectoryOperation(cmd);
  if (gitDirResult) {
    return {
      isDangerous: true,
      reason: ".git directory protection",
    };
  }
  
  return {
    isDangerous: false,
  };
}

/**
 * Compatibility wrapper for shell script interface
 * Returns boolean and sets reason via reference parameter pattern
 */
export function checkDangerousCommandLegacy(cmd: string): {
  isDangerous: boolean;
  reason: string;
} {
  const result = checkDangerousCommand(cmd);
  return {
    isDangerous: result.isDangerous,
    reason: result.reason || "",
  };
}