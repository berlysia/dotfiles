/**
 * Pattern matching functions for hook scripts
 * TypeScript conversion of pattern-matcher.sh
 */

import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { ToolInput } from "../types/project-types.ts";
import { isBashToolInput } from "../types/project-types.ts";
import { getFilePathFromToolInput } from "./command-parsing.ts";
import {
  type MatchContext,
  type MatchKind,
  resolvePathPattern,
  resolveTargetPath,
} from "./path-utils.ts";
import { ruleNamesFor } from "./permission-rule-names.ts";
import { hasParentSegment, isUnderRoot } from "./path-containment.ts";
import { collectTempRoots } from "./temp-roots.ts";

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
function _extractChildCommand(command: string): ChildCommandResult {
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
        const word = words[i];
        if (word && typeof word === "string" && !word.startsWith("-")) {
          const remaining = words.slice(i).join(" ");
          return { found: true, command: remaining };
        }
      }
    }
  }

  // Handle find -exec command
  else if (command.includes("-exec ")) {
    const execMatch = command.match(/-exec\s+(.+?)\s+[\\;+]/);
    if (execMatch?.[1]) {
      return { found: true, command: execMatch[1].trim() };
    }
  }

  return { found: false };
}

// Function removed - use extractCommandsStructured from bash-parser.ts instead

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

  if (startPath.startsWith("/")) {
    if (hasParentSegment(startPath)) {
      return false;
    }
    const tempRoots = [...collectTempRoots("", realpathSync), "/var/tmp"];
    if (tempRoots.some((root) => isUnderRoot(startPath, root))) {
      return true;
    }
  }

  // Allow specific safe absolute paths
  const safeAbsolutePaths = [
    new RegExp(`^/home/${process.env.USER || "\\w+"}`),
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
export function isSafeBuiltinCommand(cmd: string): boolean {
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
 * Match one path segment against a pattern whose only wildcard is `*` (zero or
 * more characters, never crossing a segment). A DP table keeps the cost at
 * O(text * pattern); a RegExp built from user patterns could backtrack badly.
 */
function matchSegment(text: string, pattern: string): boolean {
  // reachable[j]: pattern[0..j) matches the text prefix consumed so far
  let reachable: boolean[] = new Array<boolean>(pattern.length + 1).fill(false);
  reachable[0] = true;
  for (let j = 0; j < pattern.length; j++) {
    reachable[j + 1] = reachable[j] === true && pattern[j] === "*";
  }
  for (let i = 0; i < text.length; i++) {
    const next: boolean[] = new Array<boolean>(pattern.length + 1).fill(false);
    for (let j = 0; j < pattern.length; j++) {
      const token = pattern[j];
      if (token === "*") {
        // `*` consumes nothing (next[j]) or one more character (reachable[j+1])
        next[j + 1] = next[j] === true || reachable[j + 1] === true;
      } else {
        next[j + 1] = reachable[j] === true && token === text[i];
      }
    }
    reachable = next;
  }
  return reachable[pattern.length] === true;
}

/**
 * Match an absolute path against an absolute pattern containing `*` / `**`.
 * `**` as a whole segment spans zero or more segments; `*` stays in a segment.
 * The path is normalized first so `//`, `/./` and `..` cannot dodge a deny
 * pattern or widen an allow pattern.
 */
function matchAbsoluteGlob(filePath: string, pattern: string): boolean {
  if (!filePath.startsWith("/")) return false;
  const pathSegments = posix
    .normalize(filePath)
    .split("/")
    .filter((s) => s !== "");
  const patternSegments = pattern.split("/").filter((s) => s !== "");

  // table[j]: pattern[0..j) matches the path prefix consumed so far
  let table: boolean[] = new Array<boolean>(patternSegments.length + 1).fill(
    false,
  );
  table[0] = true;
  for (let j = 0; j < patternSegments.length; j++) {
    table[j + 1] = table[j] === true && patternSegments[j] === "**";
  }
  for (const segment of pathSegments) {
    const next: boolean[] = new Array<boolean>(patternSegments.length + 1).fill(
      false,
    );
    for (let j = 0; j < patternSegments.length; j++) {
      const token = patternSegments[j] as string;
      if (token === "**") {
        next[j + 1] = next[j] === true || table[j + 1] === true;
      } else {
        next[j + 1] = table[j] === true && matchSegment(segment, token);
      }
    }
    table = next;
  }
  return table[patternSegments.length] === true;
}

/**
 * Match a tool-supplied path against the text inside a `Tool(...)` permission
 * rule. Both sides are resolved first (resolvePathPattern, resolveTargetPath)
 * and compared segment by segment under a literal base, so `..`, `//` and
 * look-alike directory names cannot widen an allow or dodge a deny.
 */
export function matchGitignorePattern(
  filePath: string,
  pattern: string,
  ctx: MatchContext,
  kind: MatchKind,
): boolean {
  // An empty path would resolve to cwd itself; no caller means that.
  if (filePath === "") return false;
  const target = resolveTargetPath(filePath, ctx);
  return resolvePathPattern(pattern, ctx, kind).some(({ base, glob }) => {
    if (!isUnderRoot(target, base)) return false;
    const rest = base === "/" ? target : target.slice(base.length);
    return matchAbsoluteGlob(rest === "" ? "/" : rest, `/${glob}`);
  });
}

/**
 * Check if individual command matches any pattern
 */
async function checkIndividualCommandWithPattern(
  cmd: string,
  patterns: string[],
  ctx: MatchContext,
): Promise<{ matches: boolean; pattern?: string }> {
  for (const pattern of patterns) {
    if (!pattern.trim()) continue;

    // Create a mock tool input for individual command check
    const mockInput: ToolInput = { command: cmd };

    if (await checkPattern(pattern, "Bash", mockInput, ctx, "deny")) {
      return { matches: true, pattern };
    }
  }

  return { matches: false };
}

/**
 * Check individual command matches deny patterns
 */
/**
 * Check individual command deny and return matching pattern
 */
export async function checkIndividualCommandDenyWithPattern(
  cmd: string,
  denyList: string[],
  ctx: MatchContext,
): Promise<{ matches: boolean; matchedPattern?: string }> {
  // Skip built-in safe commands - they should never be denied
  // This prevents the logic error where isSafeBuiltinCommand=true causes denial
  if (isSafeBuiltinCommand(cmd)) {
    return { matches: false };
  }

  const result = await checkIndividualCommandWithPattern(cmd, denyList, ctx);
  return {
    matches: result.matches,
    ...(result.pattern && { matchedPattern: result.pattern }),
  };
}

/**
 * Check if a pattern matches the tool usage
 */
export type RuleList = "allow" | "deny";

export async function checkPattern(
  pattern: string,
  toolName: string,
  toolInput: unknown,
  ctx: MatchContext,
  list: RuleList,
): Promise<boolean> {
  // Handle Bash tool specifically
  if (pattern.startsWith("Bash(") && pattern.endsWith(")")) {
    if (toolName !== "Bash") {
      return false;
    }

    // Reject ** and an empty prefix for Bash tool - not valid Bash patterns.
    // Bash tool uses command prefixes like "npm *" not file patterns like "**"
    const parsed = parseBashPattern(pattern);
    if (parsed === null) return false;

    // Get the actual command using type guard
    const actualCommand = isBashToolInput(toolName, toolInput)
      ? toolInput.command || ""
      : "";

    // Check if command matches the pattern
    if (parsed.kind === "prefix") {
      const cmdPrefix = parsed.value;

      // Handle compound commands (&&, ||, ;) - now async
      const { extractCommandsStructured } =
        await import("../lib/bash-parser.ts");
      const { individualCommands } = await extractCommandsStructured(
        actualCommand || "",
      );
      const commands = individualCommands;

      for (let cmd of commands) {
        // Trim whitespace and remove leading & characters
        cmd = cmd.trim().replace(/^&+/, "");

        // Check if command starts with the prefix
        if (cmd.startsWith(cmdPrefix)) {
          return true;
        }

        // Also check if the prefix appears as a word within the command
        // This catches cases like "timeout 15 pnpm test" matching "pnpm *"
        // Used for deny-side and other-tool matching only. auto-approve's Bash
        // allow uses matchAnchoredBashAllow instead.
        if (cmd.includes(` ${cmdPrefix} `) || cmd.endsWith(` ${cmdPrefix}`)) {
          return true;
        }
      }
    } else if (actualCommand === parsed.value) {
      return true;
    }

    return false;
  }

  // Handle Skill tool specifically
  // Skill tool uses { skill: "skillName" } format, not file paths
  if (pattern.startsWith("Skill(") && pattern.endsWith(")")) {
    if (toolName !== "Skill") {
      return false;
    }

    // Extract the skill name pattern from Skill(skillName)
    const skillPattern = pattern.slice(6, -1); // Remove "Skill(" and ")"

    // Get the actual skill name from tool input
    const actualSkill =
      typeof toolInput === "object" && toolInput !== null
        ? ((toolInput as { skill?: string }).skill ?? "")
        : "";

    return actualSkill === skillPattern;
  }

  // File path rules. Write, MultiEdit and NotebookEdit also answer to Edit(...) rules.
  const ruleNames = ruleNamesFor(toolName);
  const ruleName = ruleNames.find((name) => pattern.startsWith(`${name}(`));
  if (ruleName !== undefined) {
    const pathPattern = pattern.slice(ruleName.length + 1, -1);
    const rawFilePath = getFilePathFromToolInput(toolName, toolInput) || "";
    // A tool call without a path cannot match a path rule; smartPassTools handle it.
    if (!rawFilePath) return false;
    return matchGitignorePattern(
      rawFilePath,
      pathPattern,
      ctx,
      list === "allow" ? "grant" : "restrict",
    );
  }
  return ruleNames.includes(pattern);
}

export type BashPattern = { kind: "prefix" | "exact"; value: string };

/**
 * The two Bash(...) forms this module reads: `Bash(p *)` (prefix) and `Bash(p)`
 * (exact). Null for anything else, including `Bash(**)` and an empty prefix.
 * A bare `Bash` is not a Bash(...) pattern; checkPattern still matches it for
 * deny through its `pattern === toolName` branch.
 */
export function parseBashPattern(pattern: string): BashPattern | null {
  if (!pattern.startsWith("Bash(") || !pattern.endsWith(")")) return null;
  const body = pattern.slice(5, -1);
  if (body === "**") return null;
  if (body.endsWith(" *")) {
    const value = body.slice(0, -2);
    return value ? { kind: "prefix", value } : null;
  }
  return { kind: "exact", value: body };
}

/**
 * Allow-side matching for one simple command from scanSafeList: anchored at the
 * start and never re-parsed. Returns the matching pattern or null. Unlike
 * checkPattern, a prefix that only appears as a later word does not match.
 */
export function matchAnchoredBashAllow(
  simpleCommand: string,
  allowList: string[],
): string | null {
  for (const pattern of allowList) {
    // Not trimmed, like checkPattern's entry check: `Bash(p *) ` with a
    // trailing space is not a Bash(...) pattern on either side.
    const parsed = parseBashPattern(pattern);
    if (parsed === null) continue;
    const matches =
      parsed.kind === "prefix"
        ? simpleCommand === parsed.value ||
          simpleCommand.startsWith(`${parsed.value} `)
        : simpleCommand === parsed.value;
    if (matches) return pattern;
  }
  return null;
}
