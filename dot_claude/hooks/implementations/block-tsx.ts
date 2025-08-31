#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";

/**
 * Block tsx/ts-node usage in favor of bun/deno
 * Converted from block-tsx-tsnode.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process Bash commands
    if (tool_name !== "Bash") {
      return context.success({});
    }

    // Type assertion for tool_input with null check
    const input = tool_input as { command?: string } | null | undefined;
    const command = input?.command || "";

    try {
      // First, check for find -exec and xargs patterns
      // These are special cases that need immediate blocking
      const findExecPattern = /find\s+.*\s+-exec\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const xargsPattern = /\|\s*xargs\s+(?:-[In]\s+\S+\s+)?(?:npx\s+)?(?:tsx|ts-node)\b/;
      const parallelPattern = /parallel\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const timeoutPattern = /timeout\s+\S+\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const timePattern = /\btime\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      
      if (findExecPattern.test(command)) {
        return context.blockingError(
          `Using tsx/ts-node with 'find -exec' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• find . -type f -name "*.ts" -exec bun {} \\;\n` +
          `• find . -type f -name "*.ts" -exec node {} \\;\n\n` +
          `Command: ${command}`
        );
      }
      
      if (xargsPattern.test(command)) {
        return context.blockingError(
          `Using tsx/ts-node with 'xargs' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• ls *.ts | xargs -I {} bun {}\n` +
          `• ls *.ts | xargs -I {} node {}\n\n` +
          `Command: ${command}`
        );
      }
      
      if (parallelPattern.test(command)) {
        return context.blockingError(
          `Using tsx/ts-node with 'parallel' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• parallel bun ::: *.ts\n` +
          `• parallel node ::: *.ts\n\n` +
          `Command: ${command}`
        );
      }
      
      if (timeoutPattern.test(command)) {
        return context.blockingError(
          `Using tsx/ts-node with 'timeout' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• timeout 10s bun script.ts\n` +
          `• timeout 10s node script.js\n\n` +
          `Command: ${command}`
        );
      }
      
      if (timePattern.test(command)) {
        return context.blockingError(
          `Using tsx/ts-node with 'time' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• time bun script.ts\n` +
          `• time node script.js\n\n` +
          `Command: ${command}`
        );
      }

      // Special handling for commands that execute other commands as arguments
      // These commands can pass tsx/ts-node as arguments, which should be blocked
      const commandExecutors = [
        /^(?:sh|bash|zsh|fish)\s+(-c|--command)\s+["']?/,
        /^npm\s+(?:run|exec)\s+["']?/,
        /^yarn\s+(?:run|exec)\s+["']?/,
        /^pnpm\s+(?:run|exec)\s+["']?/,
        /^bun\s+(?:run|exec)\s+["']?/,
        /^npx\s+--\s+/,
        /^exec\s+/,
        /^eval\s+["']?/
      ];

      // Check if command is executed through a command executor
      let commandToCheck = command;
      for (const executor of commandExecutors) {
        const match = command.match(executor);
        if (match) {
          // Extract the actual command being executed
          const remaining = command.substring(match[0].length);
          // Remove quotes if present
          commandToCheck = remaining.replace(/^["']|["']$/g, '');
          break;
        }
      }


      // Check for tsx/ts-node usage patterns
      const blockingPatterns = [
        {
          // Block direct tsx command execution (except .tsx files)
          pattern: /(?:^|[;&|]\s*)tsx(?:\s+|$)(?!.*\.tsx(?:\s|$))/,
          reason: "Use TypeScript-compatible runtime instead of 'tsx' for TypeScript execution",
          suggestion: "Replace 'tsx' with 'node --test' for testing or 'bun run' for execution"
        },
        {
          // Block direct ts-node command execution
          pattern: /(?:^|[;&|]\s*)ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'ts-node' for TypeScript execution",
          suggestion: "Replace 'ts-node' with 'node' for execution or 'bun run' for TypeScript files"
        },
        {
          // Block npx tsx
          pattern: /\bnpx\s+tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx tsx' for TypeScript execution",
          suggestion: "Replace 'npx tsx' with 'node --test' for testing or 'bun run' for execution"
        },
        {
          // Block npx ts-node
          pattern: /\bnpx\s+ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx ts-node' for TypeScript execution",
          suggestion: "Replace 'npx ts-node' with 'node' for execution or 'bun run' for TypeScript files"
        },
        {
          pattern: /\bnpm\s+(?:install|i|add)\s+.*\btsx\b/,
          reason: "Installing 'tsx' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove tsx installation. Use a TypeScript-compatible runtime (node, deno, bun) with built-in TypeScript support"
        },
        {
          pattern: /\bnpm\s+(?:install|i|add)\s+.*\bts-node\b/,
          reason: "Installing 'ts-node' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove ts-node installation. Use a TypeScript-compatible runtime (node, deno, bun) with native TypeScript support"
        },
        {
          pattern: /\bpnpm\s+(?:install|i|add)\s+.*\btsx\b/,
          reason: "Installing 'tsx' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove tsx installation. Use a TypeScript-compatible runtime (node, deno, bun) with built-in TypeScript support"
        },
        {
          pattern: /\bpnpm\s+(?:install|i|add)\s+.*\bts-node\b/,
          reason: "Installing 'ts-node' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove ts-node installation. Use a TypeScript-compatible runtime (node, deno, bun) with native TypeScript support"
        },
        {
          pattern: /\byarn\s+add\s+.*\btsx\b/,
          reason: "Installing 'tsx' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove tsx installation. Use a TypeScript-compatible runtime (node, deno, bun) with built-in TypeScript support"
        },
        {
          pattern: /\byarn\s+add\s+.*\bts-node\b/,
          reason: "Installing 'ts-node' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove ts-node installation. Use a TypeScript-compatible runtime (node, deno, bun) with native TypeScript support"
        },
        {
          // Block: bun add tsx, bun install tsx
          pattern: /\bbun\s+(?:install|i|add)\s+.*\btsx\b/,
          reason: "Installing 'tsx' is discouraged. Bun already supports TypeScript natively",
          suggestion: "Remove tsx installation. Bun can run TypeScript files directly with 'bun run file.ts'"
        },
        {
          // Block: bun add ts-node
          pattern: /\bbun\s+(?:install|i|add)\s+.*\bts-node\b/,
          reason: "Installing 'ts-node' is discouraged. Bun already supports TypeScript natively",
          suggestion: "Remove ts-node installation. Bun can run TypeScript files directly with 'bun run file.ts'"
        },
      ];

      // Check patterns against both original command and extracted command
      for (const { pattern, reason, suggestion } of blockingPatterns) {
        if (pattern.test(commandToCheck) || pattern.test(command)) {
          return context.blockingError(
            `${reason}\n\nSuggestion: ${suggestion}\n\nCommand: ${command}`
          );
        }
      }

      // Additional check: Block if tsx/ts-node appears as a command (not as extension or in string)
      // This catches edge cases like: echo tsx | bash
      const commandWordPattern = /\b(tsx|ts-node)\b(?!\.[a-z]+)/;
      if (commandWordPattern.test(commandToCheck)) {
        // But allow if it's clearly a file extension
        const fileExtensionPattern = /\.(tsx|ts)\b/;
        const stringPattern = /["'].*\b(tsx|ts-node)\b.*["']/;
        
        if (!fileExtensionPattern.test(commandToCheck) && !stringPattern.test(command)) {
          // Check if tsx/ts-node appears in a command position
          const commandPositionPattern = /(?:^|[;&|]\s*|\s+)(?:tsx|ts-node)(?:\s|$)/;
          if (commandPositionPattern.test(commandToCheck)) {
            return context.blockingError(
              `TypeScript execution tools (tsx/ts-node) are not allowed\n\n` +
              `Use TypeScript-compatible runtimes instead:\n` +
              `• bun run <file.ts> - for Bun runtime\n` +
              `• node --test <file.ts> - for Node.js testing\n` +
              `• deno run <file.ts> - for Deno runtime\n\n` +
              `Command: ${command}`
            );
          }
        }
      }

      // Allow if no problematic patterns found
      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in tsx/ts-node check: ${error}`);
    }
  }
});

// Run the hook if this file is executed directly
if (import.meta.main) {
  // Read input from stdin
  const decoder = new TextDecoder();
  const input = JSON.parse(decoder.decode(await Bun.stdin.bytes()));
  
  // Create context
  const context = {
    input,
    success: (result = {}) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    },
    blockingError: (message) => {
      console.log(JSON.stringify({ error: message }));
      process.exit(1);
    },
    fail: (result) => {
      console.log(JSON.stringify(result));
      process.exit(1);
    }
  };
  
  // Run the hook
  hook.run(context);
}

export default hook;