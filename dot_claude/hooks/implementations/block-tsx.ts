#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import { createDenyResponse } from "../lib/context-helpers.ts";
import { isBashToolInput } from "../types/project-types.ts";

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

    // Safely read command using type guard
    if (!isBashToolInput(tool_name, tool_input)) {
      return context.success({});
    }
    const command = tool_input.command || "";

    try {
      // First, check for find -exec and xargs patterns
      // These are special cases that need immediate blocking
      const findExecPattern = /find\s+.*\s+-exec\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const xargsPattern = /\|\s*xargs\s+(?:-[In]\s+\S+\s+)?(?:npx\s+)?(?:tsx|ts-node)\b/;
      const parallelPattern = /parallel\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const timeoutPattern = /timeout\s+\S+\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      const timePattern = /\btime\s+(?:npx\s+)?(?:tsx|ts-node)\b/;
      
      if (findExecPattern.test(command)) {
        return context.json(createDenyResponse(
          `Using tsx/ts-node with 'find -exec' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• find . -type f -name "*.ts" -exec node {} \\;\n` +
          `• find . -type f -name "*.ts" -exec bun {} \\;\n\n` +
          `Command: ${command}`
        ));
      }
      
      if (xargsPattern.test(command)) {
        return context.json(createDenyResponse(
          `Using tsx/ts-node with 'xargs' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• ls *.ts | xargs -I {} node {}\n` +
          `• ls *.ts | xargs -I {} bun {}\n\n` +
          `Command: ${command}`
        ));
      }
      
      if (parallelPattern.test(command)) {
        return context.json(createDenyResponse(
          `Using tsx/ts-node with 'parallel' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• parallel node ::: *.ts\n` +
          `• parallel bun ::: *.ts\n\n` +
          `Command: ${command}`
        ));
      }
      
      if (timeoutPattern.test(command)) {
        return context.json(createDenyResponse(
          `Using tsx/ts-node with 'timeout' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• timeout 10s node script.js\n` +
          `• timeout 10s bun script.ts\n\n` +
          `Command: ${command}`
        ));
      }
      
      if (timePattern.test(command)) {
        return context.json(createDenyResponse(
          `Using tsx/ts-node with 'time' is not allowed\n\n` +
          `Suggestion: Use a TypeScript-compatible runtime instead:\n` +
          `• time node script.js\n` +
          `• time bun script.ts\n\n` +
          `Command: ${command}`
        ));
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
          suggestion: "Replace 'tsx' with 'node --test' for testing or 'node' for execution"
        },
        {
          // Block direct ts-node command execution
          pattern: /(?:^|[;&|]\s*)ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'ts-node' for TypeScript execution",
          suggestion: "Replace 'ts-node' with 'node' for execution or 'bun' for TypeScript files"
        },
        {
          // Block npx tsx
          pattern: /\bnpx\s+tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx tsx' for TypeScript execution",
          suggestion: "Replace 'npx tsx' with 'node --test' for testing or 'node' for execution"
        },
        {
          // Block npx ts-node
          pattern: /\bnpx\s+ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx ts-node' for TypeScript execution",
          suggestion: "Replace 'npx ts-node' with 'node' for execution or 'bun' for TypeScript files"
        },
        {
          // Block yarn dlx tsx
          pattern: /\byarn\s+dlx\s+tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'yarn dlx tsx' for TypeScript execution",
          suggestion: "Replace 'yarn dlx tsx' with 'node --test' for testing or 'node' for execution"
        },
        {
          // Block yarn dlx ts-node
          pattern: /\byarn\s+dlx\s+ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'yarn dlx ts-node' for TypeScript execution",
          suggestion: "Replace 'yarn dlx ts-node' with 'node' for execution or 'bun' for TypeScript files"
        },
        {
          // Block pnpx tsx
          pattern: /\bpnpx\s+tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'pnpx tsx' for TypeScript execution",
          suggestion: "Replace 'pnpx tsx' with 'node --test' for testing or 'node' for execution"
        },
        {
          // Block pnpx ts-node
          pattern: /\bpnpx\s+ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'pnpx ts-node' for TypeScript execution",
          suggestion: "Replace 'pnpx ts-node' with 'node' for execution or 'bun' for TypeScript files"
        },
        {
          // Block bunx tsx
          pattern: /\bbunx\s+tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'bunx tsx' for TypeScript execution",
          suggestion: "Replace 'bunx tsx' with 'node --test' for testing or 'bun run' for execution"
        },
        {
          // Block bunx ts-node
          pattern: /\bbunx\s+ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'bunx ts-node' for TypeScript execution",
          suggestion: "Replace 'bunx ts-node' with 'node' for execution or 'bun' for TypeScript files"
        },
        {
          // Block deno run npm:tsx
          pattern: /\bdeno\s+run\s+npm:tsx(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'deno run npm:tsx' for TypeScript execution",
          suggestion: "Replace 'deno run npm:tsx' with 'deno run' for direct TypeScript execution"
        },
        {
          // Block deno run npm:ts-node
          pattern: /\bdeno\s+run\s+npm:ts-node(?:\s+|$)/,
          reason: "Use TypeScript-compatible runtime instead of 'deno run npm:ts-node' for TypeScript execution",
          suggestion: "Replace 'deno run npm:ts-node' with 'deno run' for direct TypeScript execution"
        },
        {
          pattern: /\bnpm\s+(?:install|i|add)\s+.*\btsx\b/,
          reason: "Installing 'tsx' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove tsx installation. Use a TypeScript-compatible runtime (node, bun, deno) with built-in TypeScript support"
        },
        {
          pattern: /\bnpm\s+(?:install|i|add)\s+.*\bts-node\b/,
          reason: "Installing 'ts-node' is discouraged. Use TypeScript-compatible runtime for TypeScript execution",
          suggestion: "Remove ts-node installation. Use a TypeScript-compatible runtime (node, bun, deno) with native TypeScript support"
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
          return context.json(createDenyResponse(
            `${reason}\n\nSuggestion: ${suggestion}\n\nCommand: ${command}`
          ));
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
            return context.json(createDenyResponse(
              `TypeScript execution tools (tsx/ts-node) are not allowed\n\n` +
              `Use TypeScript-compatible runtimes instead:\n` +
              `• node --test <file.ts> - for Node.js testing\n` +
              `• node <file.js> - for Node.js execution\n` +
              `• bun run <file.ts> - for Bun runtime\n` +
              `• deno run <file.ts> - for Deno runtime\n\n` +
              `Command: ${command}`
            ));
          }
        }
      }

      // Allow if no problematic patterns found
      return context.success({});

    } catch (error) {
      return context.json(createDenyResponse(`Error in tsx/ts-node check: ${error}`));
    }
  }
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
