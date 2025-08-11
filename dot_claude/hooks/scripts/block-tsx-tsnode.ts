#!/usr/bin/env bun

/*
 * Hook script to block tsx and ts-node usage in various forms.
 * Blocks installation, npx usage, loader usage, and direct execution.
 * TypeScript version with enhanced type safety and pattern matching.
 */

import { readHookInput } from "./lib/hook-common.js";
import type { HookInput } from "./types/hooks-types.js";

interface BashToolInput {
  command?: string;
  [key: string]: unknown;
}

/**
 * Extract and clean package names from installation command
 */
function extractPackageNames(packagesString: string): string[] {
  return packagesString
    .split(/\s+/)
    .filter(pkg => pkg && !pkg.startsWith('-')) // Skip flags
    .map(pkg => {
      // Remove version specifier if present (e.g., tsx@latest)
      const atIndex = pkg.indexOf('@');
      return atIndex > 0 ? pkg.substring(0, atIndex) : pkg;
    });
}

/**
 * Check if a bash command should be blocked
 */
function checkBashCommand(command: string): void {
  // Pattern 1: Package installation (npm/yarn/pnpm/bun)
  const installPattern = /^[\s]*(npm|yarn|pnpm|bun)[\s]+(install|add|i)[\s]+(.+)$/;
  const installMatch = command.match(installPattern);
  
  if (installMatch) {
    const packagesString = installMatch[3];
    const packageNames = extractPackageNames(packagesString);
    
    // Check if tsx or ts-node is being installed as a standalone package
    for (const pkgName of packageNames) {
      if (pkgName === "tsx" || pkgName === "ts-node") {
        console.error(`Installation of ${pkgName} is prohibited. Use the existing TypeScript toolchain in the project.`);
        process.exit(2);
      }
    }
  }

  // Pattern 2: Node.js loader usage
  const loaderPattern = /(--loader|--require|--experimental-loader)[\s]+(tsx|ts-node)(\/[^\s]*)?([\s]|$)/;
  if (loaderPattern.test(command)) {
    console.error("Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project.");
    process.exit(2);
  }

  // Pattern 3: npx usage
  const npxPattern = /^[\s]*npx[\s]+(tsx|ts-node)[\s]+/;
  if (npxPattern.test(command)) {
    console.error("Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project.");
    process.exit(2);
  }

  // Pattern 4: Direct execution
  const directExecPattern = /^[\s]*(tsx|ts-node)[\s]+[^-].*\.ts[\s]*$/;
  if (directExecPattern.test(command)) {
    console.error("Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project.");
    process.exit(2);
  }
}

// Main execution
try {
  const input = readHookInput();

  // Only process Bash commands
  if (input.tool_name !== "Bash") {
    process.exit(0);
  }

  const toolInput = input.tool_input as BashToolInput;
  const command = toolInput.command;

  if (!command) {
    process.exit(0);
  }

  // Check if the command should be blocked
  checkBashCommand(command);

  // Allow the command to proceed
  process.exit(0);
} catch (error) {
  console.error("Error in block-tsx-tsnode:", error);
  process.exit(1);
}