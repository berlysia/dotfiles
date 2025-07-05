#!/usr/bin/env node
/**
 * Hook script to block tsx and ts-node usage in various forms.
 * Blocks installation, npx usage, loader usage, and direct execution.
 */


// PreToolUse Input type based on Claude Code documentation
interface PreToolUseInput {
  session_id: string;
  transcript_path: string;
  tool_name: string;
  tool_input: Record<string, any>;
}

// Specific tool input for Bash commands
// Based on Claude Code's Bash tool usage patterns
interface BashToolInput {
  command: string;       // The command to execute
  description?: string;  // Optional description of what the command does
  timeout?: number;      // Optional timeout in milliseconds
}

export interface BlockCheckResult {
  shouldBlock: boolean;
  reason: string | null;
}

export function checkBashCommand(command: string): BlockCheckResult {
  // Pattern 1: Package installation (npm/yarn/pnpm/bun)
  // Matches: npm install tsx, yarn add ts-node, etc.
  // But NOT: npm install tsx-loader, react-tsx-parser, etc.
  const installPattern = /^\s*(npm|yarn|pnpm|bun)\s+(install|add|i)\s+(.+)$/;
  const installMatch = command.match(installPattern);
  
  if (installMatch) {
    const packages = installMatch[3];
    // Split by spaces, but handle flags like -D, --save-dev
    const packageList: string[] = [];
    const parts = packages.split(/\s+/);
    
    for (const part of parts) {
      if (!part.startsWith('-')) {
        packageList.push(part);
      }
    }
    
    // Check if tsx or ts-node is being installed as a standalone package
    for (const pkg of packageList) {
      // Remove version specifier if present (e.g., tsx@latest)
      const pkgName = pkg.split('@')[0];
      if (pkgName === 'tsx' || pkgName === 'ts-node') {
        return {
          shouldBlock: true,
          reason: `Installation of ${pkgName} is prohibited. Use the existing TypeScript toolchain in the project.`
        };
      }
    }
  }
  
  // Pattern 2: Node.js loader usage
  // Matches: node --loader tsx, node --experimental-loader ts-node/esm, etc.
  const loaderPattern = /(--loader|--require|--experimental-loader)\s+(tsx|ts-node)/;
  if (loaderPattern.test(command)) {
    return {
      shouldBlock: true,
      reason: "Using tsx/ts-node as a loader is prohibited. Use the existing TypeScript toolchain in the project."
    };
  }
  
  // Pattern 3: npx usage
  // Matches: npx tsx script.ts, npx ts-node index.ts
  const npxPattern = /^\s*npx\s+(tsx|ts-node)\s+/;
  if (npxPattern.test(command)) {
    return {
      shouldBlock: true,
      reason: "Running tsx/ts-node via npx is prohibited. Use the existing TypeScript toolchain in the project."
    };
  }
  
  // Pattern 4: Direct execution
  // Matches: tsx script.ts, ts-node app.ts (but not .tsx files)
  // This pattern ensures we're looking at command execution, not file names
  const directPattern = /^\s*(tsx|ts-node)\s+[^-].*\.ts\b/;
  if (directPattern.test(command)) {
    return {
      shouldBlock: true,
      reason: "Direct execution of TypeScript files with tsx/ts-node is prohibited. Use the existing TypeScript toolchain in the project."
    };
  }
  
  return { shouldBlock: false, reason: null };
}

async function main(): Promise<void> {
  // Read all input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  
  const inputData = Buffer.concat(chunks).toString();
  
  try {
    const data: PreToolUseInput = JSON.parse(inputData);
    
    // Only process Bash commands
    if (data.tool_name !== 'Bash') {
      process.exit(0);
    }
    
    const toolInput = data.tool_input as BashToolInput;
    const command = toolInput.command || '';
    
    if (!command) {
      process.exit(0);
    }
    
    // Check if the command should be blocked
    const { shouldBlock, reason } = checkBashCommand(command);
    
    if (shouldBlock && reason) {
      // Exit code 2 blocks the tool call and shows the reason to Claude
      process.stderr.write(reason);
      process.exit(2);
    }
    
    // Allow the command to proceed
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Error: Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});