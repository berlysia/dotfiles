#!/usr/bin/env -S bun run --silent

/**
 * PermissionRequest Auto-Approve Hook
 * Static rule-based evaluation for automatic permission approval
 *
 * Layer 2a: Static rule-based evaluation (this hook)
 * Layer 2b: LLM evaluation via type: "prompt" hook (in settings.json)
 * Fallback: User confirmation (Layer 3)
 */

import { defineHook } from "cc-hooks-ts";
import { logDecision } from "../lib/centralized-logging.ts";
import { createPermissionRequestAllowResponse } from "../lib/permission-request-helpers.ts";
import type { PermissionRequestInput } from "../lib/structured-llm-evaluator.ts";

/**
 * Static decision result
 */
type StaticDecision = "allow" | "deny" | "uncertain";

/**
 * Read-only tools that are always safe to allow
 */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "Search", "LS", "WebSearch"];

/**
 * Safe Bash command patterns (whitelist)
 */
const SAFE_BASH_PATTERNS = [
  // Information retrieval
  /^(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whereis|basename|dirname|realpath)\b/,
  // Git read-only operations
  /^git\s+(status|log|diff|branch|remote|show|describe|tag|rev-parse|config\s+--get)\b/,
  // Package information
  /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated|view|info|why|explain)\b/,
  // Development tools (no side effects)
  /^(npm|pnpm|yarn|bun)\s+(test|lint|format|typecheck|check|type-check)\b/,
  // Test runners
  /^(vitest|jest|mocha|ava|tap|node\s+--test)\b/,
  // Linters and formatters (check mode)
  /^(eslint|prettier|oxlint|biome)\s+.*--check\b/,
  /^(eslint|prettier|oxlint|biome)\s+--check\b/,
  /^tsc\s+--noEmit\b/,
];

/**
 * Dangerous patterns that should never be auto-approved
 */
const DANGEROUS_PATTERNS = [
  // Destructive file operations
  /rm\s+(-[rf]+\s+)*\//,
  /rm\s+-rf\b/,
  // Disk operations
  /\bdd\s+.*if=/,
  /\bmkfs\b/,
  /\bformat\s+[A-Z]:/i, // Windows format command
  // Remote code execution
  /curl.*\|\s*(sh|bash|zsh)/,
  /wget.*\|\s*(sh|bash|zsh)/,
  /\beval\b/,
  // System modifications
  /\bsudo\b/,
  /chmod\s+777\b/,
  // Sensitive file access
  /\/etc\/(passwd|shadow|sudoers)/,
  /~\/\.ssh\//,
  /\.env\b/,
  /credentials/i,
];

/**
 * Layer 2a: Static rule-based evaluation
 * No injection risk - purely pattern matching
 */
function staticRuleEngine(input: PermissionRequestInput): StaticDecision {
  const toolName = input.tool_name;
  const toolInput = input.tool_input;

  // 1. Read-only tools are always safe
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return "allow";
  }

  // 2. Bash command evaluation
  if (toolName === "Bash" && toolInput && "command" in toolInput) {
    const cmd = String(toolInput.command).trim();

    // Check dangerous patterns first
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return "deny";
      }
    }

    // Check safe patterns
    for (const pattern of SAFE_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return "allow";
      }
    }
  }

  // 3. File operations within project scope
  if (
    ["Edit", "Write", "MultiEdit"].includes(toolName) &&
    toolInput &&
    "file_path" in toolInput
  ) {
    const filePath = String(toolInput.file_path);
    const cwd = input.cwd || process.cwd();

    // Check for dangerous paths
    const dangerousPaths = [
      "/etc/",
      "/usr/",
      "/bin/",
      "/sbin/",
      "/.ssh/",
      "/.gnupg/",
      "/.aws/",
      "/credentials",
      "/.env",
    ];

    for (const dangerous of dangerousPaths) {
      if (filePath.includes(dangerous)) {
        return "deny";
      }
    }

    // Allow if within project directory
    if (filePath.startsWith(cwd) || filePath.startsWith("./")) {
      return "allow";
    }
  }

  // Cannot determine - need further evaluation
  return "uncertain";
}

const hook = defineHook({
  trigger: {
    PermissionRequest: true,
  },
  run: async (context) => {
    const input = context.input as unknown as PermissionRequestInput;
    const { tool_name, tool_input, session_id } = input;

    // Layer 2a: Static rule evaluation
    const staticResult = staticRuleEngine(input);

    if (staticResult === "allow") {
      // Log the decision
      logDecision(
        tool_name,
        "allow",
        `Auto-approved by static rule (Layer 2a)`,
        session_id,
        tool_input,
      );

      return context.json({
        event: "PermissionRequest",
        output: createPermissionRequestAllowResponse(),
      });
    }

    if (staticResult === "deny") {
      // Log but don't deny - let user decide
      // (PermissionRequest deny would block, we want user confirmation)
      logDecision(
        tool_name,
        "ask",
        `Static rule flagged as potentially dangerous (Layer 2a)`,
        session_id,
        tool_input,
      );

      // Pass through to prompt hook (Layer 2b) or user confirmation (Layer 3)
      return context.success({});
    }

    // Static rule returned "uncertain" - pass to prompt hook (Layer 2b)
    logDecision(
      tool_name,
      "ask",
      `Static rule uncertain, deferring to prompt hook (Layer 2b)`,
      session_id,
      tool_input,
    );

    return context.success({});
  },
});

export default hook;

// Export for testing
export { staticRuleEngine, SAFE_BASH_PATTERNS, DANGEROUS_PATTERNS };

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
