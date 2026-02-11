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
const READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Search",
  "LS",
  "WebSearch",
  "TaskList",
  "TaskGet",
  "TaskOutput",
];

/**
 * Safe Bash command patterns (whitelist)
 */
const SAFE_BASH_PATTERNS = [
  // Information retrieval
  /^(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whereis|basename|dirname|realpath)\b/,
  // Git read-only operations (with optional -C <path> prefix)
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|branch|remote|show|describe|tag|rev-parse|config\s+--get)\b/,
  // Git write operations (common safe dev workflow, with optional -C <path> prefix)
  /^git\s+(-C\s+\S+\s+)?(add|commit|stash|checkout|switch|fetch|pull|cherry-pick|rebase|merge)\b/,
  // Package information
  /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated|view|info|why|explain)\b/,
  // Development tools (no side effects)
  /^(npm|pnpm|yarn|bun)\s+(test|lint|format|typecheck|check|type-check)\b/,
  // Package manager build/dev/serve scripts (common safe dev workflow)
  /^(npm|pnpm|yarn|bun)\s+(build|dev|start|serve|preview)\b/,
  // Package manager run <script> (user-defined scripts in package.json)
  /^(npm|pnpm|yarn|bun)\s+run\s+\S+/,
  // Package installation (safe in dev context)
  /^(npm|pnpm|yarn|bun)\s+(install|add|remove|ci)\b/,
  // Test runners (node --test with optional preceding flags like --experimental-strip-types)
  /^(vitest|jest|mocha|ava|tap)\b/,
  /^node\s+(-\S+\s+)*--test\b/,
  // Linters and formatters (check mode)
  /^(eslint|prettier|oxlint|biome)\s+.*--check\b/,
  /^(eslint|prettier|oxlint|biome)\s+--check\b/,
  /^tsc\s+--noEmit\b/,
  // Safe directory/file creation
  /^mkdir\s/,
  /^touch\s/,
  // Environment inspection (read-only)
  /^env\b/,
  /^printenv\b/,
  // Port/process inspection (read-only)
  /^lsof\b/,
  /^(ss|netstat)\b/,
  // Data processing (read-only, no side effects)
  /^jq\b/,
  // System information (read-only)
  /^(fc-list|uname|hostnamectl|locale)\b/,
  // Chezmoi read-only operations
  /^chezmoi\s+(cat-config|data|doctor|diff|dump|dump-config|managed|state|status|verify|source-path|target-path|execute-template)\b/,
  // Claude CLI (read-only)
  /^claude\s+(--version|doctor|--help)\b/,
  // Dev tool execution (trusted tools only, not arbitrary packages)
  /^(npx|pnpx|bunx)\s+(vitest|jest|prettier|eslint|oxlint|tsc|tsgo|knip|stylelint|biome)\b/,
  // Git worktree management (custom script)
  /^git-worktree-(create|cleanup)\b/,
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
export {
  staticRuleEngine,
  READ_ONLY_TOOLS,
  SAFE_BASH_PATTERNS,
  DANGEROUS_PATTERNS,
};

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
