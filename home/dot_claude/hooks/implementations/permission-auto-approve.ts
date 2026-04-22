#!/usr/bin/env -S bun run --silent

/**
 * PermissionRequest Auto-Approve Hook
 * Static rule-based evaluation for automatic permission approval
 *
 * Layer 2a: Static rule-based evaluation (this hook)
 * Layer 2b: LLM evaluation via type: "prompt" hook (in settings.json)
 * Fallback: User confirmation (Layer 3)
 */

import path from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logDecision } from "../lib/centralized-logging.ts";
import { createPermissionRequestAllowResponse } from "../lib/permission-request-helpers.ts";
import type { PermissionRequestInput } from "../lib/structured-llm-evaluator.ts";

/**
 * Static decision with source attribution.
 * `source` is required on every variant so decision logs can reason about the
 * provenance of each allow/deny/uncertain outcome without string guessing.
 */
export type StaticDecision =
  | { behavior: "allow"; source: "pattern-match" | "project-scope-safe" }
  | { behavior: "deny"; source: "dangerous-pattern" }
  | { behavior: "uncertain"; source: "no-match" };

/**
 * Boundary check result for the project-scope allowance path.
 * `reason` values let tests pinpoint which guard rejected a command.
 */
export type BoundaryCheckResult =
  | { safe: true; source: "project-scope-safe" }
  | {
      safe: false;
      reason:
        | "prefilter-miss"
        | "shell-composition"
        | "outside-cwd"
        | "not-allowlisted"
        | "unresolvable";
    };

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
  "WebFetch",
  "ToolSearch",
  "Agent",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
];

/**
 * Skills that are safe to auto-approve.
 * Codex delegation, read-only research, and non-destructive workflow skills.
 */
const SAFE_SKILLS = [
  "codex:rescue",
  "codex:setup",
  "codex:codex-result-handling",
  "codex:codex-cli-runtime",
  "codex:gpt-5-4-prompting",
  "recall",
  "approach-check",
  "session-memo",
  "logic-validation",
  "verify-doc",
  "scope-guard",
  "decompose",
  "clarify",
  "task-enrich",
  "task-handoff",
  "proposal-list",
  "adr-session",
];

/**
 * Safe Bash command patterns (whitelist)
 */
const SAFE_BASH_PATTERNS = [
  // Information retrieval
  /^(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whereis|basename|dirname|realpath)\b/,
  // Read-only comparison / delay (no side effects)
  /^(diff|cmp|sleep)\b/,
  // Git read-only operations (with optional -C <path> prefix)
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|branch|remote|show|describe|tag|rev-parse|config\s+--get|ls-files|shortlog|blame)\b/,
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
  // pnpm --filter <pkg> with safe subcommands (workspace development workflow)
  /^pnpm\s+--filter\s+\S+\s+(test|build|dev|start|serve|preview|lint|format|typecheck|check|type-check)\b/,
  /^pnpm\s+--filter\s+\S+\s+run\s+\S+/,
  /^pnpm\s+--filter\s+\S+\s+(ls|list|outdated|info|why)\b/,
  /^pnpm\s+--filter\s+\S+\s+(install|add|remove)\b/,
  // Test runners (node --test with optional preceding flags like --experimental-strip-types)
  /^(vitest|jest|mocha|ava|tap)\b/,
  /^node\s+(-\S+\s+)*--test\b/,
  // Linters and formatters (check mode)
  /^(eslint|prettier|oxlint|oxfmt|biome)\s+.*--check\b/,
  /^(eslint|prettier|oxlint|oxfmt|biome)\s+--check\b/,
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
  // Hash calculation (read-only)
  /^(md5sum|sha1sum|sha256sum|sha512sum|shasum|cksum)\b/,
  // Package query (read-only)
  /^apt-cache\b/,
  /^dpkg\s+(-l|-L|-s|--list|--listfiles|--status)\b/,
  // Chezmoi operations (manages user's own dotfiles)
  /^chezmoi\s+(cat-config|data|doctor|diff|dump|dump-config|managed|unmanaged|state|status|verify|source-path|target-path|execute-template|apply|update|add|init)\b/,
  // Claude CLI (read-only)
  /^claude\s+(--version|doctor|--help)\b/,
  // Package manager direct tool invocation (pnpm <tool>, not via `run`)
  /^pnpm\s+(biome|oxfmt|oxlint|eslint|prettier|knip|tsc|tsgo|vitest)\b/,
  // Dev tool execution (trusted tools only, not arbitrary packages)
  /^(npx|pnpx|bunx)\s+(--no\s+)?(vitest|jest|prettier|eslint|oxlint|oxfmt|tsc|tsgo|knip|stylelint|biome)\b/,
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
 * Narrow prefilter for the project-scope-safe path. Only commands that LOOK
 * like the three over-rejected shapes (rm -rf, chmod +x, or <path>.sh) are
 * eligible for further inspection.
 */
const PREFILTER_REGEX = /^(rm\s+-rf|chmod\s+\+x|\S+\.sh(\s|$))/;

/**
 * Shell-safe character whitelist. Any character outside this set (including
 * `;`, `&`, `|`, `$`, backticks, redirection, globs, braces, `=`, etc.) is
 * rejected so that composition and environment-variable prefixes cannot slip
 * into the scope-safe path and expand into arbitrary binary execution.
 *
 * `+` is intentionally allowed because `chmod +x` relies on it and `+` has
 * no POSIX shell metacharacter meaning on its own. The plan omitted `+` in
 * the initial spec; this deviation is documented here so future readers do
 * not reintroduce the regression.
 */
const SHELL_WHITELIST_REGEX = /^[A-Za-z0-9_./+\s-]+$/;

/**
 * Directories under cwd that are allowed as `rm -rf` targets. Deliberately
 * omits `node_modules/` since deleting it breaks lockfile coherence and is
 * expensive to rebuild.
 */
const RM_RF_ALLOWED_DIRS = [".tmp/", ".cache/", "dist/", "build/"];

/**
 * Directories under cwd that are allowed as `chmod +x` targets.
 */
const CHMOD_X_ALLOWED_DIRS = [".tmp/", "scripts/"];

/**
 * Normalize a command by stripping known-safe prefixes.
 * This allows the underlying command to be evaluated by SAFE_BASH_PATTERNS.
 *
 * Stripped prefixes:
 * - `cd <path> && ` : directory change before actual command
 * - `ENV_VAR=value ` : environment variable prefix(es)
 */
function normalizeCommand(cmd: string): string {
  let normalized = cmd;

  // Strip `cd <path> && ` prefix (cd itself is harmless; evaluate the next command)
  normalized = normalized.replace(/^cd\s+\S+\s*&&\s*/, "").trim();

  // Strip leading ENV_VAR=value prefix(es) (e.g., BASELINE_YEAR=2023 FOO=bar node --test ...)
  normalized = normalized.replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/, "").trim();

  return normalized;
}

/**
 * Evaluate whether a Bash command is safe under the project-scope rule set.
 *
 * The check is intentionally conservative: it requires a narrow shape match,
 * a strict character whitelist, and a cwd containment check before granting
 * the allow. We do not consult realpath on purpose — following symlinks would
 * introduce disk I/O and an attack surface this personal-dotfiles threat model
 * does not need to cover.
 */
export function isProjectScopeSafe(
  command: string,
  cwd: string,
): BoundaryCheckResult {
  if (!PREFILTER_REGEX.test(command)) {
    return { safe: false, reason: "prefilter-miss" };
  }

  if (!SHELL_WHITELIST_REGEX.test(command)) {
    return { safe: false, reason: "shell-composition" };
  }

  let target: string | null = null;
  let allowlist: readonly string[] = [];

  const rmMatch = command.match(/^rm\s+-rf\s+(\S+)\s*$/);
  const chmodMatch = command.match(/^chmod\s+\+x\s+(\S+)\s*$/);
  const scriptMatch = command.match(/^(\S+\.sh)(?:\s|$)/);

  if (rmMatch) {
    target = rmMatch[1] ?? null;
    allowlist = RM_RF_ALLOWED_DIRS;
  } else if (chmodMatch) {
    target = chmodMatch[1] ?? null;
    allowlist = CHMOD_X_ALLOWED_DIRS;
  } else if (scriptMatch) {
    target = scriptMatch[1] ?? null;
    // Script invocations only need cwd containment; no subdirectory allowlist.
    allowlist = [];
  }

  if (target === null || target === "") {
    return { safe: false, reason: "unresolvable" };
  }

  const absolute = path.resolve(cwd, target);
  const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (absolute !== cwd && !absolute.startsWith(cwdPrefix)) {
    return { safe: false, reason: "outside-cwd" };
  }

  if (allowlist.length > 0) {
    const relative = absolute === cwd ? "" : absolute.slice(cwdPrefix.length);
    const allowed = allowlist.some((dir) => {
      // Normalize `dist/` to accept both `dist` (bare directory) and
      // `dist/anything` (nested path). path.resolve strips trailing slashes
      // from the target, so we need to compare bare forms explicitly.
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const bare = prefix.slice(0, -1);
      return relative === bare || relative.startsWith(prefix);
    });
    if (!allowed) {
      return { safe: false, reason: "not-allowlisted" };
    }
  }

  return { safe: true, source: "project-scope-safe" };
}

/**
 * Layer 2a: Static rule-based evaluation
 * No injection risk - purely pattern matching
 */
function staticRuleEngine(input: PermissionRequestInput): StaticDecision {
  const toolName = input.tool_name;
  const toolInput = input.tool_input;

  // 1. Read-only tools are always safe
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return { behavior: "allow", source: "pattern-match" };
  }

  // 2. Bash command evaluation
  if (toolName === "Bash" && toolInput && "command" in toolInput) {
    const cmd = String(toolInput.command).trim();
    const cwd = input.cwd || process.cwd();

    // 2a. Project scope safe check runs BEFORE dangerous patterns so that the
    // narrow over-rejection cases (rm -rf .tmp/..., chmod +x scripts/..., etc.)
    // are not caught by the generic `rm -rf` deny.
    const scopeCheck = isProjectScopeSafe(cmd, cwd);
    if (scopeCheck.safe) {
      return { behavior: "allow", source: "project-scope-safe" };
    }

    // 2b. Dangerous patterns (evaluated against original command)
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return { behavior: "deny", source: "dangerous-pattern" };
      }
    }

    // 2c. Safe patterns against original command
    for (const pattern of SAFE_BASH_PATTERNS) {
      if (pattern.test(cmd)) {
        return { behavior: "allow", source: "pattern-match" };
      }
    }

    // 2d. Safe patterns against normalized command (strips cd prefix, ENV prefix)
    const normalizedCmd = normalizeCommand(cmd);
    if (normalizedCmd !== cmd) {
      for (const pattern of SAFE_BASH_PATTERNS) {
        if (pattern.test(normalizedCmd)) {
          return { behavior: "allow", source: "pattern-match" };
        }
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
        return { behavior: "deny", source: "dangerous-pattern" };
      }
    }

    if (filePath.startsWith(cwd) || filePath.startsWith("./")) {
      return { behavior: "allow", source: "pattern-match" };
    }
  }

  // 4. Skill invocations: per-skill allow, rest → uncertain (Layer 2b will ask)
  if (toolName === "Skill" && toolInput && "skill" in toolInput) {
    const skill = String(toolInput.skill);
    if (SAFE_SKILLS.includes(skill)) {
      return { behavior: "allow", source: "pattern-match" };
    }
    return { behavior: "uncertain", source: "no-match" };
  }

  return { behavior: "uncertain", source: "no-match" };
}

const hook = defineHook({
  trigger: {
    PermissionRequest: true,
  },
  run: async (context) => {
    const input = context.input as unknown as PermissionRequestInput;
    const { tool_name, tool_input, session_id } = input;

    const staticResult = staticRuleEngine(input);

    if (staticResult.behavior === "allow") {
      logDecision(
        tool_name,
        "allow",
        `Auto-approved by static rule (Layer 2a, source=${staticResult.source})`,
        session_id,
        tool_input,
      );

      return context.json({
        event: "PermissionRequest",
        output: createPermissionRequestAllowResponse(),
      });
    }

    if (staticResult.behavior === "deny") {
      // Log but don't deny - let Layer 2b (LLM) attempt to re-evaluate.
      // Final deny only comes from LLM (Layer 2b) so that over-zealous static
      // deny patterns can still be overridden by contextual LLM judgment.
      logDecision(
        tool_name,
        "ask",
        `Static rule flagged as potentially dangerous (Layer 2a, source=${staticResult.source})`,
        session_id,
        tool_input,
      );

      return context.success({});
    }

    logDecision(
      tool_name,
      "ask",
      `Static rule uncertain, deferring to prompt hook (Layer 2a, source=${staticResult.source})`,
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
  normalizeCommand,
  READ_ONLY_TOOLS,
  SAFE_BASH_PATTERNS,
  DANGEROUS_PATTERNS,
  PREFILTER_REGEX,
  SHELL_WHITELIST_REGEX,
  RM_RF_ALLOWED_DIRS,
  CHMOD_X_ALLOWED_DIRS,
  SAFE_SKILLS,
};

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
