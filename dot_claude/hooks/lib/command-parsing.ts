/**
 * Command parsing utilities for auto-approve hook
 * Shared between implementation and tests
 */
import type { ToolSchema } from "cc-hooks-ts";

// Meta commands that can execute other commands
const META_COMMANDS = {
  sh: [/-c\s+['"](.+?)['"]/, /(.+)/],
  bash: [/-c\s+['"](.+?)['"]/, /(.+)/],
  zsh: [/-c\s+['"](.+?)['"]/, /(.+)/],
  bun: [/-e\s+['"](.+?)['"]/, /(.+)/], // Handle bun -e "script" patterns
  node: [/-e\s+['"](.+?)['"]/, /(.+)/], // Handle node -e "script" patterns
  xargs: [/sh\s+-c\s+['"](.+?)['"]/, /-I\s+\S+\s+(.+)/, /(.+)/],
  timeout: [/\d+\s+(.+)/],
  time: [/(.+)/],
  env: [/(?:\w+=\w+\s+)*(.+)/],
  cat: [/(.+)/], // Handle cat commands in pipelines
  head: [/(-\d+\s+)?(.+)/], // Handle head -n file patterns
  tail: [/(-\d+\s+)?(.+)/], // Handle tail -n file patterns
};

// Control structure keywords that should be processed transparently
const CONTROL_KEYWORDS = [
  "for",
  "do",
  "done",
  "if",
  "then",
  "else",
  "fi",
  "while",
];

/**
 * Modern structured command extraction with clear separation of individual vs original commands
 */
export async function extractCommandsStructured(command: string) {
  const { extractCommandsStructured } = await import("./bash-parser.ts");
  return await extractCommandsStructured(command);
}

// Deprecated function removed - use extractCommandsStructured() instead

// Legacy helper functions removed - functionality moved to bash-parser.ts

/**
 * Check if a command is potentially dangerous and requires review
 */
export function checkDangerousCommand(cmd: string): {
  isDangerous: boolean;
  requiresManualReview: boolean;
  reason: string;
} {
  const dangerousPatterns = [
    {
      // Match rm with recursive and force flags, variable substitution (immediate deny - unpredictable)
      pattern: /rm\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\s+[{\$]/,
      reason: "rm -rf with variable substitution is too dangerous",
      requiresReview: false,
    },
    {
      // Match rm with recursive and force flags, targeting system directories (immediate deny)
      pattern: /rm\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\s+\//,
      reason: "Dangerous system deletion",
      requiresReview: false,
    },
    {
      pattern: /sudo\s+rm/,
      reason: "Sudo deletion command",
      requiresReview: false,
    },
    {
      pattern: /dd\s+.*\/dev\//,
      reason: "Disk operation",
      requiresReview: false,
    },
    { pattern: /mkfs/, reason: "Filesystem creation", requiresReview: false },
    {
      pattern: /(curl|wget).*\|\s*(sh|bash|zsh|fish|dash)/,
      reason: "Piped shell execution",
      requiresReview: true,
    },
    {
      pattern: /git\s+.*--no-verify/,
      reason: "Git command with --no-verify bypasses hooks and safety checks",
      requiresReview: true,
    },
  ];

  for (const { pattern, reason, requiresReview } of dangerousPatterns) {
    if (pattern.test(cmd)) {
      return {
        isDangerous: true,
        requiresManualReview: requiresReview,
        reason,
      };
    }
  }

  return { isDangerous: false, requiresManualReview: false, reason: "" };
}

/**
 * Check if a command matches a pattern (for Bash commands)
 */
export function checkCommandPattern(pattern: string, cmd: string): boolean {
  // Extract command from Bash(command:*) format
  const match = pattern.match(/^Bash\(([^)]+)\)$/);
  if (!match) return false;

  const cmdPattern = match[1];
  if (!cmdPattern) return false;

  // Simple wildcard matching - can be enhanced
  if (cmdPattern.endsWith(":*")) {
    const prefix = cmdPattern.slice(0, -2);
    return cmd.startsWith(prefix);
  }

  return cmd === cmdPattern;
}

/**
 * Get file path from tool input based on tool type
 */
// Overloads to support ToolSchema-based inference when tool is known
export function getFilePathFromToolInput<Name extends keyof ToolSchema>(
  tool_name: Name,
  tool_input: ToolSchema[Name]["input"],
): string | undefined;
export function getFilePathFromToolInput(
  tool_name: string,
  tool_input: unknown,
): string | undefined;
export function getFilePathFromToolInput(
  tool_name: string,
  tool_input: unknown,
): string | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;

  if (!isObj(tool_input)) return undefined;

  const filePath = ((): string | undefined => {
    if ("file_path" in tool_input && typeof tool_input.file_path === "string")
      return tool_input.file_path;
    if ("path" in tool_input && typeof tool_input.path === "string")
      return tool_input.path;
    if (
      "notebook_path" in tool_input &&
      typeof tool_input.notebook_path === "string"
    )
      return tool_input.notebook_path;
    return undefined;
  })();

  if (
    tool_name === "Write" ||
    tool_name === "Edit" ||
    tool_name === "MultiEdit"
  ) {
    return filePath;
  } else if (tool_name === "Read") {
    return filePath;
  } else if (tool_name === "NotebookEdit" || tool_name === "NotebookRead") {
    return filePath;
  } else if (tool_name === "Grep") {
    // Grep requires explicit path parameter for security
    return ("path" in tool_input && typeof tool_input.path === "string"
      ? tool_input.path
      : undefined);
  }
  return undefined;
}

// Overloads to get command from tool input (Bash only) with ToolSchema inference
export function getCommandFromToolInput<Name extends keyof ToolSchema>(
  tool_name: Name,
  tool_input: ToolSchema[Name]["input"],
): string | undefined;
export function getCommandFromToolInput(
  tool_name: string,
  tool_input: unknown,
): string | undefined;
export function getCommandFromToolInput(
  tool_name: string,
  tool_input: unknown,
): string | undefined {
  if (tool_name !== "Bash") return undefined;
  if (typeof tool_input !== "object" || tool_input === null) return undefined;
  const cmd = (tool_input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : undefined;
}

/**
 * Tools that don't use parentheses in pattern matching
 */
export const NO_PAREN_TOOL_NAMES = [
  "TodoRead",
  "TodoWrite",
  "Task",
  "BashOutput",
  "KillBash",
  "Glob",
  "ExitPlanMode",
  "WebSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
];

/**
 * Control structure keywords that should be processed transparently
 */
export const CONTROL_STRUCTURE_KEYWORDS = CONTROL_KEYWORDS;
