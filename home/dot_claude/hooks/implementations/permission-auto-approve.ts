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
import { isDangerousWritePath } from "../lib/dangerous-write-paths.ts";
import { hasParentSegment } from "../lib/path-containment.ts";
import { isStrictlyUnderProjectSubdir } from "../lib/workflow-fs.ts";
import { createPermissionRequestAllowResponse } from "../lib/permission-request-helpers.ts";
import type { PermissionRequestInput } from "../lib/structured-llm-evaluator.ts";
import { isValidSessionId } from "../lib/workflow-paths.ts";
import { scanSafeList } from "../lib/safe-command-list.ts";
import { prefixThenOnLine, type TextMatcher } from "../lib/linear-match.ts";

/**
 * Static decision with source attribution.
 * `source` is required on every variant so decision logs can reason about the
 * provenance of each allow/deny/uncertain outcome without string guessing.
 */
export type StaticDecision =
  | {
      behavior: "allow";
      source:
        | "pattern-match"
        | "project-scope-safe"
        | "session-scratchpad-safe";
    }
  | { behavior: "deny"; source: "dangerous-pattern" }
  | {
      behavior: "uncertain";
      // `scan-*` say why the Bash branch did not allow (spec K8); `scan-demoted`
      // marks inputs the pre-split rule would have allowed, so the decision log
      // can count how many allows moved to the later layers.
      source:
        | "no-match"
        | "scan-null"
        | "scan-mismatch"
        | "scan-error"
        | "scan-demoted";
    };

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
  // Git read-only operations (with optional -C <path> / -c key=value prefixes)
  /^git\s+(-[cC]\s+\S+\s+)*(status|log|diff|branch|remote|show|describe|tag|rev-parse|config\s+--get|ls-files|shortlog|blame)\b/,
  // Git local write operations (with optional -C <path> / -c key=value prefixes)
  /^git\s+(-[cC]\s+\S+\s+)*(add|commit|stash|checkout|switch|fetch|pull|cherry-pick|rebase|merge|rm)\b/,
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
  /^(eslint|prettier|oxlint|oxfmt|biome)\s.*--check\b/,
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
  // Git worktree management (custom script; create also installs dependencies, see docs/commands/git-worktree-create.md)
  /^git-worktree-(create|cleanup)\b/,
  // APM (skill package manager, local operations only)
  /^apm\s+(install|search|pack|deps|list|info|update|remove|uninstall|--help|--version)\b/,
];

/**
 * Dangerous patterns that should never be auto-approved. Exported for the
 * differential test (linear-match-equivalence.test.ts). Do not add a regex of
 * the form `X\s+.*Y` / `X.*Y` here; use prefixThenOnLine (see Issue #219).
 */
const DANGEROUS_PATTERNS: ReadonlyArray<TextMatcher> = [
  // Destructive file operations
  /rm\s+(-[rf]+\s+)*\//,
  /rm\s+-rf\b/,
  // Disk operations
  prefixThenOnLine(/\bdd\s+/, /if=/),
  /\bmkfs\b/,
  /\bformat\s+[A-Z]:/i, // Windows format command
  // Remote code execution
  prefixThenOnLine(/curl/, /\|\s*(sh|bash|zsh)/),
  prefixThenOnLine(/wget/, /\|\s*(sh|bash|zsh)/),
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
 * like the four over-rejected shapes (rm -rf, rm [-f], chmod +x, or <path>.sh)
 * are eligible for further inspection.
 */
const PREFILTER_REGEX = /^(rm\s+-rf|rm\s+(-f\s+)?\S|chmod\s+\+x|\S+\.sh(\s|$))/;

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
 *
 * Only space and tab count as blanks: `\s` would also accept a newline (and
 * `\r`, `\v`, `\f`, NBSP, U+3000), and the shape checks below read only the
 * first line, so `scripts/x.sh` + newline + any command would be allowed.
 */
const SHELL_WHITELIST_REGEX = /^[A-Za-z0-9_./+ \t-]+$/;

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
 * Used only to replay the pre-split rule for logging (`legacyStaticBashAllow`);
 * it never decides an allow.
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
  const rmSingleMatch = !rmMatch && command.match(/^rm\s+(-f\s+)?(\S+)\s*$/);
  const chmodMatch = command.match(/^chmod\s+\+x\s+(\S+)\s*$/);
  const scriptMatch = command.match(/^(\S+\.sh)(?:\s|$)/);

  if (rmMatch) {
    target = rmMatch[1] ?? null;
    allowlist = RM_RF_ALLOWED_DIRS;
  } else if (rmSingleMatch) {
    target = rmSingleMatch[2] ?? null;
    // Single-file rm only needs cwd containment, no subdirectory restriction
    allowlist = [];
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
 * Boundary check result for the session-scratchpad allowance path.
 * `reason` values let tests pinpoint which guard rejected a file target.
 */
export type ScratchpadCheckResult =
  | { safe: true; source: "session-scratchpad-safe" }
  | {
      safe: false;
      reason:
        | "invalid-session-id"
        | "path-traversal"
        | "not-scratchpad-shape"
        | "not-contained";
    };

/**
 * Matches the numeric uid segment Claude Code's own scratchpad convention
 * uses: `/tmp/claude-<uid>/<project-slug>/<session_id>/scratchpad/...`.
 */
const SCRATCHPAD_UID_SEGMENT_REGEX = /^claude-[0-9]+$/;

/**
 * Evaluate whether a Write/Edit/MultiEdit/NotebookEdit target resolves
 * strictly under THIS session's scratchpad directory. Claude Code's own
 * convention is that the scratchpad needs no permission prompt; this closes
 * the gap where the static rule engine had no pattern for it at all (109
 * observed "no patterns matched" asks in decisions.jsonl).
 *
 * Deliberately narrower than a general `/tmp/**` allow: only a path shaped
 * exactly as `/tmp/claude-<uid>/<slug>/<session_id>/scratchpad/...` for the
 * CURRENT session's `session_id` qualifies. `$TMPDIR`-based equivalents are
 * out of scope — supporting them would require resolving `$TMPDIR` from the
 * hook's own environment and trusting it matches the environment the
 * scratchpad path was minted in, which is not trivial, so this only matches
 * literal `/tmp`.
 *
 * Path traversal (`..`) is rejected outright on the raw (pre-resolve) path,
 * even when it would lexically net out to staying inside the scratchpad,
 * because a legitimate scratchpad write never needs `..` and there is no
 * reason to trust adversarial input enough to rely on `path.resolve`'s
 * lexical collapse alone.
 *
 * Symlink escape is closed by requiring the resolved (realpath'd) nearest
 * existing ancestor chain to stay under the scratchpad dir, reusing
 * `isStrictlyUnderProjectSubdir` — the same containment primitive P9/P10/P12
 * use for workflow directories (`lib/workflow-fs.ts`).
 */
export function isSessionScratchpadSafe(
  filePath: string,
  sessionId: string,
  cwd: string,
): ScratchpadCheckResult {
  if (!isValidSessionId(sessionId)) {
    return { safe: false, reason: "invalid-session-id" };
  }

  if (hasParentSegment(filePath)) {
    return { safe: false, reason: "path-traversal" };
  }

  const absolute = path.resolve(cwd, filePath);
  const segments = absolute.split("/").filter((segment) => segment.length > 0);

  // segments: ["tmp", "claude-<uid>", "<project-slug>", "<session_id>", "scratchpad", ...rest]
  if (
    segments.length < 5 ||
    segments[0] !== "tmp" ||
    !SCRATCHPAD_UID_SEGMENT_REGEX.test(segments[1] ?? "") ||
    segments[3] !== sessionId ||
    segments[4] !== "scratchpad"
  ) {
    return { safe: false, reason: "not-scratchpad-shape" };
  }

  const sessionDir = `/${segments.slice(0, 4).join("/")}`;
  if (!isStrictlyUnderProjectSubdir(sessionDir, "scratchpad", absolute)) {
    return { safe: false, reason: "not-contained" };
  }

  return { safe: true, source: "session-scratchpad-safe" };
}

/** `cd` with one argument, the shape the pre-split rule stripped (spec K8). */
const CD_SIMPLE_COMMAND_REGEX = /^cd [^ \t]+$/;

/** Inputs longer than this skip the old-rule replay, which is logging only. */
const LEGACY_REPLAY_MAX_LENGTH = 100_000;

/**
 * Characters the matched part may contain. The patterns split words on
 * blanks, so they read the same words as the shell only where nothing can
 * move a word boundary: quotes, `\`, `$`, globs (including zsh extendedglob
 * `^` `#`), and the redirections scanSafeList keeps inside a simple command
 * (`git -C 2>&1 status push` matched as `status`). An allowlist, so a
 * character nobody thought of counts as unsafe.
 */
const MATCHED_PART_SAFE_CHARS_REGEX = /^[A-Za-z0-9_./:=@+,~ \t-]*$/;

/**
 * SAFE_BASH_PATTERNS that must also end where the shell ends a word: on a
 * blank, or before a blank or the end. Their `\b` also breaks at `-` `.` `@`
 * `:`, so `npx vitest-evil` matched as `vitest`. The condition is part of the
 * regex (not checked after the match) so that alternations such as
 * `dump|dump-config` can still backtrack to the longer word.
 */
const SAFE_BASH_WORD_PATTERNS = SAFE_BASH_PATTERNS.map(
  (pattern) =>
    new RegExp(
      `(?:${pattern.source})(?:(?<=[ \\t])|(?=[ \\t]|$))`,
      pattern.flags,
    ),
);

function isStaticSafeSimpleCommand(simple: string): boolean {
  if (CD_SIMPLE_COMMAND_REGEX.test(simple)) return true;
  // Only the matched part decides: `git -c "a status" push` would otherwise
  // match as `status`. Quotes after the matched part (`git commit -m 'x'`)
  // are arguments the pattern does not read.
  return SAFE_BASH_WORD_PATTERNS.some((pattern) => {
    const match = pattern.exec(simple);
    return match !== null && MATCHED_PART_SAFE_CHARS_REGEX.test(match[0]);
  });
}

/**
 * The rule before the whole-text split: SAFE_BASH_PATTERNS on the whole text,
 * then on the text with `cd x &&` / `FOO=1` stripped. A pattern anchored only
 * at the start says nothing about the rest of the text, so this never decides
 * an allow; it only marks `scan-demoted` in the decision log. Remove it with
 * `normalizeCommand` once the demoted counts have been reviewed after F3b.
 */
function legacyStaticBashAllow(cmd: string): boolean {
  if (SAFE_BASH_PATTERNS.some((pattern) => pattern.test(cmd))) return true;
  const normalized = normalizeCommand(cmd);
  return (
    normalized !== cmd &&
    SAFE_BASH_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

function evaluateStaticBash(command: unknown, cwd: string): StaticDecision {
  const rawCommand = String(command);
  const cmd = rawCommand.trim();

  // 2a. Project scope safe check runs BEFORE dangerous patterns so that the
  // narrow over-rejection cases (rm -rf .tmp/..., chmod +x scripts/..., etc.)
  // are not caught by the generic `rm -rf` deny.
  if (isProjectScopeSafe(cmd, cwd).safe) {
    return { behavior: "allow", source: "project-scope-safe" };
  }

  // 2b. Dangerous patterns on the whole text (a superset, like the deny side
  // of auto-approve).
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { behavior: "deny", source: "dangerous-pattern" };
    }
  }

  // 2c. Allow only when the whole text splits into simple commands and each
  // one is a known-safe shape (spec K8). The scanner gets the raw text: it
  // trims trailing blanks itself and refuses other whitespace.
  const simpleCommands = scanSafeList(rawCommand);
  if (
    simpleCommands !== null &&
    simpleCommands.every(isStaticSafeSimpleCommand)
  ) {
    return { behavior: "allow", source: "pattern-match" };
  }
  if (cmd.length <= LEGACY_REPLAY_MAX_LENGTH && legacyStaticBashAllow(cmd)) {
    return { behavior: "uncertain", source: "scan-demoted" };
  }
  return {
    behavior: "uncertain",
    source: simpleCommands === null ? "scan-null" : "scan-mismatch",
  };
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
    try {
      return evaluateStaticBash(toolInput.command, input.cwd || process.cwd());
    } catch (error) {
      // Never allow on a failure. Only the error kind is logged: a message
      // may quote the command.
      console.error(
        `[permission-auto-approve] static Bash rule failed: ${error instanceof Error ? error.name : typeof error}`,
      );
      return { behavior: "uncertain", source: "scan-error" };
    }
  }

  // 3. File operations within project scope
  if (
    ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName) &&
    toolInput &&
    ("file_path" in toolInput || "notebook_path" in toolInput)
  ) {
    const filePath = String(
      "file_path" in toolInput ? toolInput.file_path : toolInput.notebook_path,
    );
    const cwd = input.cwd || process.cwd();

    if (isDangerousWritePath(filePath)) {
      return { behavior: "deny", source: "dangerous-pattern" };
    }

    // 3a. Session scratchpad: Claude Code's own convention is that this
    // needs no permission prompt (see isSessionScratchpadSafe doc comment).
    const scratchpadCheck = isSessionScratchpadSafe(
      filePath,
      input.session_id,
      cwd,
    );
    if (scratchpadCheck.safe) {
      return { behavior: "allow", source: "session-scratchpad-safe" };
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
