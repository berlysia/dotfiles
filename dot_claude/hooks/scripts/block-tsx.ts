#!/usr/bin/env bun

import { defineHook } from "cc-hooks-ts";

/**
 * Block tsx/ts-node usage in favor of bun/deno
 * Converted from block-tsx-tsnode.ts using cc-hooks-ts
 */
export default defineHook({
  trigger: { PreToolUse: true },
  run: (context) => {
    const { tool_name, tool_input } = context.input;

    // Only process Bash commands
    if (tool_name !== "Bash") {
      return context.success({});
    }

    // Type assertion for tool_input
    const input = tool_input as { command?: string };
    const command = input.command || "";

    try {
      // Check for tsx/ts-node usage patterns
      const blockingPatterns = [
        {
          pattern: /\btsx\s+(?!--version|--help)/,
          reason: "Use TypeScript-compatible runtime instead of 'tsx' for TypeScript execution",
          suggestion: "Replace 'tsx script.ts' with a TypeScript-compatible runtime (e.g., 'node script.ts', 'deno run script.ts', 'bun script.ts')"
        },
        {
          pattern: /\bts-node\s+(?!--version|--help)/,
          reason: "Use TypeScript-compatible runtime instead of 'ts-node' for TypeScript execution",
          suggestion: "Replace 'ts-node script.ts' with a TypeScript-compatible runtime (e.g., 'node script.ts', 'deno run script.ts', 'bun script.ts')"
        },
        {
          pattern: /\bnpx\s+tsx\s+(?!--version|--help)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx tsx' for TypeScript execution",
          suggestion: "Replace 'npx tsx script.ts' with a TypeScript-compatible runtime (e.g., 'node script.ts', 'deno run script.ts', 'bun script.ts')"
        },
        {
          pattern: /\bnpx\s+ts-node\s+(?!--version|--help)/,
          reason: "Use TypeScript-compatible runtime instead of 'npx ts-node' for TypeScript execution",
          suggestion: "Replace 'npx ts-node script.ts' with a TypeScript-compatible runtime (e.g., 'node script.ts', 'deno run script.ts', 'bun script.ts')"
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
      ];

      // Check each pattern
      for (const { pattern, reason, suggestion } of blockingPatterns) {
        if (pattern.test(command)) {
          return context.blockingError(
            `${reason}\n\nSuggestion: ${suggestion}\n\nCommand: ${command}`
          );
        }
      }

      // Allow if no problematic patterns found
      return context.success({});

    } catch (error) {
      return context.blockingError(`Error in tsx/ts-node check: ${error}`);
    }
  }
});