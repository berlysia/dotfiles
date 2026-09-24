/**
 * Command parsing utilities for auto-approve hook
 * Shared between implementation and tests
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolSchema } from "cc-hooks-ts";

// Meta commands that can execute other commands
const _META_COMMANDS = {
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
    // === Destructive file operations ===
    {
      // Match rm with recursive and force flags, variable substitution (immediate deny - unpredictable)
      pattern:
        /rm\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\s+[{$]/,
      reason: "rm -rf with variable substitution is too dangerous",
      requiresReview: false,
    },
    {
      // Match rm with recursive and force flags, targeting system directories (immediate deny)
      pattern:
        /rm\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\s+\//,
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

    // === Destructive git operations ===
    {
      pattern: /git\s+push\s+.*--force\b/,
      reason: "Force push can overwrite remote history",
      requiresReview: true,
    },
    {
      pattern: /git\s+push\s+.*-f\b/,
      reason: "Force push (-f) can overwrite remote history",
      requiresReview: true,
    },
    {
      pattern: /git\s+push\s+--force\b/,
      reason: "Force push can overwrite remote history",
      requiresReview: true,
    },
    {
      pattern: /git\s+push\s+-f\b/,
      reason: "Force push (-f) can overwrite remote history",
      requiresReview: true,
    },
    {
      pattern: /git\s+reset\s+--hard\b/,
      reason: "Hard reset discards uncommitted changes permanently",
      requiresReview: true,
    },
    {
      pattern: /git\s+clean\s+.*-[fd]/,
      reason: "Git clean removes untracked files/directories permanently",
      requiresReview: true,
    },
    {
      pattern: /git\s+branch\s+.*-D\b/,
      reason: "Force delete branch (-D) ignores unmerged status",
      requiresReview: true,
    },
    {
      pattern: /git\s+.*--no-verify/,
      reason: "Git command with --no-verify bypasses hooks and safety checks",
      requiresReview: true,
    },
    {
      pattern: /git\s+.*--no-gpg-sign/,
      reason:
        "Git command with --no-gpg-sign bypasses GPG signature verification",
      requiresReview: true,
    },

    // === Destructive GitHub CLI operations ===
    {
      pattern: /gh\s+pr\s+merge\b/,
      reason: "Merging PR affects shared repository state",
      requiresReview: true,
    },
    {
      pattern: /gh\s+pr\s+close\b/,
      reason: "Closing PR affects shared repository state",
      requiresReview: true,
    },
    {
      pattern: /gh\s+issue\s+close\b/,
      reason: "Closing issue affects shared repository state",
      requiresReview: true,
    },
    {
      pattern: /gh\s+issue\s+delete\b/,
      reason: "Deleting issue is irreversible",
      requiresReview: true,
    },
    {
      pattern: /gh\s+repo\s+delete\b/,
      reason: "Deleting repository is irreversible",
      requiresReview: false,
    },
    {
      pattern: /gh\s+repo\s+archive\b/,
      reason: "Archiving repository affects all collaborators",
      requiresReview: true,
    },
    {
      pattern: /gh\s+release\s+delete\b/,
      reason: "Deleting release is irreversible",
      requiresReview: true,
    },

    // === Destructive package manager operations ===
    {
      pattern: /npm\s+publish\b/,
      reason: "Publishing package to registry is public and hard to undo",
      requiresReview: true,
    },
    {
      pattern: /npm\s+unpublish\b/,
      reason: "Unpublishing can break dependent packages",
      requiresReview: false,
    },
    {
      pattern: /npm\s+deprecate\b/,
      reason: "Deprecating package affects all users",
      requiresReview: true,
    },
    {
      pattern: /pnpm\s+publish\b/,
      reason: "Publishing package to registry is public and hard to undo",
      requiresReview: true,
    },
    {
      pattern: /bun\s+publish\b/,
      reason: "Publishing package to registry is public and hard to undo",
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
  // Extract command from Bash(command *) format
  const match = pattern.match(/^Bash\(([^)]+)\)$/);
  if (!match) return false;

  const cmdPattern = match[1];
  if (!cmdPattern) return false;

  // Simple wildcard matching - can be enhanced
  if (cmdPattern.endsWith(" *")) {
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
  } else if (tool_name === "Grep" || tool_name === "Search") {
    // Grep and Search require explicit path parameter for security
    return "path" in tool_input && typeof tool_input.path === "string"
      ? tool_input.path
      : undefined;
  } else if (tool_name === "Glob") {
    // Glob uses pattern parameter as the path for pattern matching
    return "pattern" in tool_input && typeof tool_input.pattern === "string"
      ? tool_input.pattern
      : undefined;
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
  // Glob removed - it uses pattern parameter and should support path patterns like Glob(./**)
  "ExitPlanMode",
  "WebSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
];

/**
 * Control structure keywords that should be processed transparently
 */
export const CONTROL_STRUCTURE_KEYWORDS = CONTROL_KEYWORDS;

// =============================================================================
// Home directory guard
// =============================================================================
//
// Judges a Bash command by the paths it would remove or move, not by how the
// command text is spelled. The 2026-09-24 incident slipped past the regex
// patterns above because `rm -rf "$HOME"` quotes its variable; resolving
// `~` / `$HOME` / `cd` before comparing closes that whole class of spellings.

export interface HomeGuardOptions {
  /** Real home directory of the hook process. Never taken from the command. */
  home: string;
  /** Working directory the command starts in. */
  cwd: string;
  /** Current user name, so that `~<user>` expands to `home`. */
  user?: string | undefined;
}

export interface HomeGuardResult {
  isDangerous: boolean;
  reason: string;
}

interface ShellToken {
  value: string;
  /** Contains a variable or command substitution that could not be resolved. */
  unresolved: boolean;
  leadingTilde: boolean;
  hasGlob: boolean;
}

interface CommandSegment {
  text: string;
  pipelineId: number;
}

type ResolvedTarget =
  | { kind: "path"; path: string; isGlobDir: boolean }
  | { kind: "unresolved"; display: string }
  | { kind: "unknown-cwd"; value: string; hasGlob: boolean }
  | { kind: "other" };

type TargetClass = "delete" | "move";

const SAFE: HomeGuardResult = { isDangerous: false, reason: "" };

const WRAPPER_COMMANDS = new Set([
  "sudo",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "timeout",
  "time",
  "builtin",
]);

const FIND_DESTRUCTIVE_EXEC = new Set([
  "rm",
  "mv",
  "shred",
  "truncate",
  "unlink",
]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const INDIRECT_SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

function splitSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let pipelineId = 0;
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;

  const flush = (nextPipeline: boolean) => {
    if (current.trim()) segments.push({ text: current.trim(), pipelineId });
    current = "";
    if (nextPipeline) pipelineId++;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && next !== undefined) {
        current += next;
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      current += ch + next;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      parenDepth++;
      current += "$(";
      i++;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      current += ch;
      continue;
    }
    if (parenDepth > 0) {
      current += ch;
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      flush(true);
      i++;
      continue;
    }
    if (ch === "|") {
      flush(false);
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "\n") {
      flush(true);
      continue;
    }
    current += ch;
  }
  flush(false);
  return segments;
}

function tokenize(
  text: string,
  vars: Map<string, string>,
  home: string,
): ShellToken[] {
  const tokens: ShellToken[] = [];
  let token: ShellToken | null = null;
  const start = (): ShellToken => {
    token ??= {
      value: "",
      unresolved: false,
      leadingTilde: false,
      hasGlob: false,
    };
    return token;
  };
  const push = () => {
    if (token) tokens.push(token);
    token = null;
  };

  // Returns the index of the last consumed character.
  const expand = (i: number, t: ShellToken): number => {
    const next = text[i + 1];
    if (next === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      t.unresolved = true;
      t.value += text.slice(i, j);
      return j - 1;
    }
    let name = "";
    let end = i;
    if (next === "{") {
      const close = text.indexOf("}", i + 2);
      if (close < 0) {
        t.unresolved = true;
        t.value += text.slice(i);
        return text.length - 1;
      }
      name = text.slice(i + 2, close);
      end = close;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
      if (!match) {
        t.unresolved = true;
        t.value += "$";
        return i;
      }
      name = match[0];
      end = i + name.length;
    }
    if (name === "HOME") {
      t.value += home;
    } else if (vars.has(name)) {
      t.value += vars.get(name);
    } else {
      t.unresolved = true;
      t.value += `$${name}`;
    }
    return end;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    const t = start();
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      t.value += text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        const c = text[j] as string;
        if (c === "\\" && j + 1 < text.length) {
          t.value += text[j + 1];
          j++;
        } else if (c === "$") {
          j = expand(j, t);
        } else if (c === "`") {
          t.unresolved = true;
          t.value += c;
        } else {
          t.value += c;
        }
      }
      i = j;
    } else if (ch === "\\") {
      if (i + 1 < text.length) t.value += text[i + 1];
      i++;
    } else if (ch === "$") {
      i = expand(i, t);
    } else if (ch === "`") {
      t.unresolved = true;
      t.value += ch;
    } else {
      if (ch === "~" && t.value === "") t.leadingTilde = true;
      if (ch === "*" || ch === "?" || ch === "[") t.hasGlob = true;
      t.value += ch;
    }
  }
  push();
  return tokens;
}

function baseName(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

/** Drops leading `NAME=value` assignments and wrapper commands like `sudo`. */
function stripWrappers(tokens: ShellToken[]): ShellToken[] {
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i] as ShellToken;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.value)) {
      i++;
      continue;
    }
    const name = baseName(tok.value);
    if (!WRAPPER_COMMANDS.has(name)) break;
    i++;
    // Skip the wrapper's own options and arguments (e.g. `timeout 5`, `nice -n 10`).
    while (i < tokens.length) {
      const opt = (tokens[i] as ShellToken).value;
      if (opt.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
        i++;
      } else if (name === "timeout" && /^\d/.test(opt)) {
        i++;
      } else if (name === "nice" && /^-?\d+$/.test(opt)) {
        i++;
      } else {
        break;
      }
    }
  }
  return tokens.slice(i);
}

function resolveTarget(
  tok: ShellToken,
  cwd: string | null,
  opts: HomeGuardOptions,
): ResolvedTarget {
  if (tok.unresolved) return { kind: "unresolved", display: tok.value };
  let value = tok.value;
  if (tok.leadingTilde) {
    const match = /^~([^/]*)(\/.*)?$/.exec(value);
    const user = match?.[1] ?? "";
    if (user !== "" && user !== opts.user) return { kind: "other" };
    value = opts.home + (match?.[2] ?? "");
  }
  let globDir = false;
  if (tok.hasGlob) {
    const firstGlob = value.search(/[*?[]/);
    const slash = value.lastIndexOf("/", firstGlob);
    value = slash < 0 ? "." : value.slice(0, slash) || "/";
    globDir = true;
  }
  if (!isAbsolute(value)) {
    if (cwd === null) return { kind: "unknown-cwd", value, hasGlob: globDir };
    return { kind: "path", path: resolve(cwd, value), isGlobDir: globDir };
  }
  return { kind: "path", path: resolve(value), isGlobDir: globDir };
}

function isHomeOrAncestor(path: string, home: string): boolean {
  if (path === home) return true;
  const prefix = path.endsWith("/") ? path : `${path}/`;
  return home.startsWith(prefix);
}

function judgeTarget(
  target: ResolvedTarget,
  cls: TargetClass,
  home: string,
): string | null {
  switch (target.kind) {
    case "unresolved":
      return cls === "delete"
        ? `cannot resolve \`${target.display}\` for a recursive delete`
        : null;
    case "unknown-cwd": {
      const v = target.value.replace(/\/+$/, "");
      const selfLike =
        v === "." || v === ".." || v.startsWith("../") || target.hasGlob;
      return selfLike ? `\`${target.value}\` after an unresolvable cd` : null;
    }
    case "other":
      return null;
    case "path": {
      if (isHomeOrAncestor(target.path, home)) {
        return target.isGlobDir
          ? `glob over ${target.path}`
          : `target ${target.path}`;
      }
      if (!target.isGlobDir && dirname(target.path) === home) {
        return `target ${target.path} (direct child of home)`;
      }
      return null;
    }
  }
}

function nonFlagArgs(args: ShellToken[]): ShellToken[] {
  const out: ShellToken[] = [];
  let endOfOptions = false;
  for (const tok of args) {
    if (!endOfOptions && tok.value === "--") {
      endOfOptions = true;
    } else if (!endOfOptions && tok.value.startsWith("-") && !tok.unresolved) {
      continue;
    } else {
      out.push(tok);
    }
  }
  return out;
}

function isRecursiveRm(args: ShellToken[]): boolean {
  return args.some(
    (t) =>
      t.value === "--recursive" ||
      (/^-[A-Za-z]+$/.test(t.value) && /[rR]/.test(t.value)),
  );
}

/** Returns the paths a destructive verb acts on, or null if the verb is harmless. */
function destructiveTargets(
  name: string,
  args: ShellToken[],
  cwd: string | null,
  opts: HomeGuardOptions,
): { targets: ShellToken[]; cls: TargetClass; base: string | null } | null {
  switch (name) {
    case "rm":
      return isRecursiveRm(args)
        ? { targets: nonFlagArgs(args), cls: "delete", base: cwd }
        : null;
    case "find": {
      const paths: ShellToken[] = [];
      let i = 0;
      for (; i < args.length; i++) {
        const v = (args[i] as ShellToken).value;
        if (v.startsWith("-") || v === "(" || v === "!") break;
        paths.push(args[i] as ShellToken);
      }
      const expr = args.slice(i);
      const destructive = expr.some((t, idx) => {
        if (t.value === "-delete") return true;
        if (!FIND_EXEC_FLAGS.has(t.value)) return false;
        const cmd = expr[idx + 1];
        return (
          cmd !== undefined && FIND_DESTRUCTIVE_EXEC.has(baseName(cmd.value))
        );
      });
      if (!destructive) return null;
      const targets = paths.length > 0 ? paths : [literalToken(".")];
      return { targets, cls: "delete", base: cwd };
    }
    case "rsync": {
      const positional = nonFlagArgs(args);
      const deletesDest = args.some((t) => t.value.startsWith("--delete"));
      const removesSource = args.some(
        (t) => t.value === "--remove-source-files",
      );
      const targets: ShellToken[] = [];
      if (deletesDest && positional.length > 0) {
        targets.push(positional[positional.length - 1] as ShellToken);
      }
      if (removesSource) targets.push(...positional.slice(0, -1));
      return targets.length > 0 ? { targets, cls: "delete", base: cwd } : null;
    }
    case "tar":
      return tarTargets(args, cwd, opts);
    case "mv": {
      const positional = nonFlagArgs(args);
      return positional.length > 1
        ? { targets: positional.slice(0, -1), cls: "move", base: cwd }
        : null;
    }
    default:
      return null;
  }
}

function literalToken(value: string): ShellToken {
  return {
    value,
    unresolved: false,
    leadingTilde: value.startsWith("~"),
    hasGlob: false,
  };
}

function tarTargets(
  args: ShellToken[],
  cwd: string | null,
  opts: HomeGuardOptions,
): { targets: ShellToken[]; cls: TargetClass; base: string | null } | null {
  if (!args.some((t) => t.value === "--remove-files")) return null;
  const targets: ShellToken[] = [];
  let base = cwd;
  for (let i = 0; i < args.length; i++) {
    const tok = args[i] as ShellToken;
    const v = tok.value;
    if (v.startsWith("--file=")) continue;
    if (v.startsWith("--directory=")) {
      base = resolveBase(
        literalToken(v.slice("--directory=".length)),
        base,
        opts,
      );
      continue;
    }
    if (v === "--file" || v === "--directory" || v === "-C") {
      const next = args[i + 1];
      if (next && v !== "--file") base = resolveBase(next, base, opts);
      i++;
      continue;
    }
    if (v.startsWith("--")) continue;
    // Short option cluster: `-czf` anywhere, or old-style `czf` as the first argument.
    const cluster = v.startsWith("-") ? v.slice(1) : i === 0 ? v : null;
    if (cluster !== null && /^[A-Za-z]+$/.test(cluster)) {
      // `f` and `C` take the following argument (the archive name / the base dir).
      for (const flag of cluster) {
        if (flag === "f") i++;
        if (flag === "C") {
          const next = args[i + 1];
          if (next) base = resolveBase(next, base, opts);
          i++;
        }
      }
      continue;
    }
    targets.push(tok);
  }
  return { targets, cls: "delete", base };
}

function resolveBase(
  tok: ShellToken,
  cwd: string | null,
  opts: HomeGuardOptions,
): string | null {
  const resolved = resolveTarget(tok, cwd, opts);
  return resolved.kind === "path" && !resolved.isGlobDir ? resolved.path : null;
}

function mentionsHome(text: string, opts: HomeGuardOptions): boolean {
  return (
    /(^|[\s'"=:])~(\/|[\s'"]|$)/.test(text) ||
    text.includes("$HOME") ||
    text.includes("${HOME}") ||
    text.includes(opts.home)
  );
}

function isIndirectHomeDelete(text: string, opts: HomeGuardOptions): boolean {
  const hasRm = /(^|[\s'"/;&|(])rm(\s|$)/.test(text);
  const hasRecursive =
    /(\s)(-[A-Za-z]*[rR][A-Za-z]*|--recursive)(\s|$|['"])/.test(text);
  return hasRm && hasRecursive && mentionsHome(text, opts);
}

function nextCwd(
  args: ShellToken[],
  cwd: string | null,
  opts: HomeGuardOptions,
): string | null {
  const target = args.find((t) => !t.value.startsWith("-") || t.value === "-");
  if (!target) return opts.home;
  if (target.value === "-") return null;
  const resolved = resolveTarget(target, cwd, opts);
  return resolved.kind === "path" ? resolved.path : null;
}

function danger(detail: string): HomeGuardResult {
  return {
    isDangerous: true,
    reason: `Blocked recursive delete/move of the home directory or its direct children (${detail}). If this is really intended, a human must run it manually outside Claude.`,
  };
}

export function checkHomeDestruction(
  command: string,
  opts: HomeGuardOptions,
): HomeGuardResult {
  const home = resolve(opts.home);
  const options = { ...opts, home };
  const vars = new Map<string, string>();
  const segments = splitSegments(command);
  let cwd: string | null = opts.cwd;

  for (const segment of segments) {
    const tokens = tokenize(segment.text, vars, home);
    const assignments = tokens.filter((t) =>
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value),
    );
    for (const a of assignments) {
      const eq = a.value.indexOf("=");
      if (!a.unresolved) vars.set(a.value.slice(0, eq), a.value.slice(eq + 1));
    }

    const words = stripWrappers(tokens);
    const head = words[0];
    if (!head) continue;
    const name = baseName(head.value);
    const args = words.slice(1);

    if (name === "cd" || name === "pushd") {
      cwd = nextCwd(args, cwd, options);
      continue;
    }

    if (
      (INDIRECT_SHELLS.has(name) && args.some((t) => t.value === "-c")) ||
      name === "eval"
    ) {
      if (isIndirectHomeDelete(segment.text, options)) {
        return danger(`indirect execution via ${name}`);
      }
      continue;
    }
    if (name === "xargs") {
      const pipeline = segments
        .filter((s) => s.pipelineId === segment.pipelineId)
        .map((s) => s.text)
        .join(" | ");
      if (isIndirectHomeDelete(pipeline, options)) {
        return danger("indirect execution via xargs");
      }
      continue;
    }

    const found = destructiveTargets(name, args, cwd, options);
    if (!found) continue;
    for (const tok of found.targets) {
      const verdict = judgeTarget(
        resolveTarget(tok, found.base, options),
        found.cls,
        home,
      );
      if (verdict) return danger(`${name}: ${verdict}`);
    }
  }
  return SAFE;
}
