#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";

import { defineHook } from "cc-hooks-ts";
import {
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { isExemptReadOnlyCommand } from "../lib/read-only-command.ts";
import { logDecision } from "../lib/centralized-logging.ts";
import {
  CONTROL_STRUCTURE_KEYWORDS,
  checkDangerousCommand,
  checkHomeDestruction,
  getCommandFromToolInput,
  getFilePathFromToolInput,
  NO_PAREN_TOOL_NAMES,
} from "../lib/command-parsing.ts";
import {
  createAllowResponse,
  createAskResponse,
  createBoundaryDenyResponse,
  createDenyResponse,
} from "../lib/context-helpers.ts";
import { analyzePatternMatches } from "../lib/decision-maker.ts";
import { isDangerousWritePath } from "../lib/dangerous-write-paths.ts";
import {
  getHomeDir,
  type MatchContext,
  resolveTargetPath,
} from "../lib/path-utils.ts";
import { ruleNamesFor } from "../lib/permission-rule-names.ts";
import {
  createMatchContext,
  createSettingsRoots,
  type SettingsRoots,
} from "../lib/project-root.ts";
import {
  type RuleList,
  checkIndividualCommandDenyWithPattern as patternMatcherCheckDeny,
  checkPattern as patternMatcherCheckPattern,
  isSafeBuiltinCommand,
  matchAnchoredBashAllow,
  ruleContext,
  type SourcedRule,
} from "../lib/pattern-matcher.ts";
import { listSettingsSources } from "../lib/settings-sources.ts";
import { scanSafeList } from "../lib/safe-command-list.ts";
import type {
  LoadedSettings,
  PermissionDecision,
  SettingsFile,
} from "../types/project-types.ts";
import "../types/tool-schemas.ts";

/**
 * Auto-approve commands based on permissions.allow/deny lists
 * Converted from auto-approve-commands.ts using cc-hooks-ts
 */
const hook = defineHook({
  // Use broad PreToolUse trigger to include unknown/MCP tools as well
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;

    // Exit early if no tool name
    if (!tool_name) {
      return context.success({});
    }

    // Get permission lists
    const roots = createSettingsRoots({
      cwd: context.input.cwd,
      transcriptPath: context.input.transcript_path,
    });
    const { allowList, denyList } = getPermissionLists(tool_name, roots);
    const matchContext = createMatchContext(context.input.cwd);

    try {
      // Process based on tool type
      if (tool_name === "Bash") {
        // Use improved structured processing
        const bashResult = await processBashTool(
          tool_input,
          denyList,
          allowList,
          context.input.cwd,
          matchContext,
          roots,
        );
        const decision = analyzeBashCommands(
          bashResult.commands,
          bashResult.hasAskRequired,
          bashResult.hasPassRequired,
        );

        // Log the decision using centralized logger
        logDecision(
          tool_name,
          decision.decision,
          decision.reason,
          context.input.session_id,
          tool_input,
        );

        if (decision.decision === "deny") {
          return context.json(createBoundaryDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        } else if (decision.decision === "allow") {
          return context.json(createAllowResponse(decision.reason));
        } else if (decision.decision === "pass") {
          // Pass through to Claude Code - no hook intervention
          return context.success({});
        }

        // Fallback: pass by default
        return context.success({});
      } else {
        // Handle other tools with special logic for certain tools
        const smartPassTools = [
          "ExitPlanMode",
          "WebFetch",
          "WebSearch",
          "Glob",
          "Search",
          "Grep",
        ];

        if (smartPassTools.includes(tool_name)) {
          // For these tools, check explicit patterns first, then pass if no matches
          const otherResult = await processOtherTool(
            tool_name,
            tool_input,
            denyList,
            allowList,
            matchContext,
          );

          // If there are explicit deny or allow matches, respect them
          if (
            otherResult.denyMatches.length > 0 ||
            otherResult.allowMatches.length > 0
          ) {
            const decision = analyzePatternMatches(
              otherResult.allowMatches,
              otherResult.denyMatches,
            );

            logDecision(
              tool_name,
              decision.decision,
              decision.reason,
              context.input.session_id,
              tool_input,
            );

            if (decision.decision === "deny") {
              return context.json(createBoundaryDenyResponse(decision.reason));
            } else if (decision.decision === "allow") {
              return context.json(createAllowResponse(decision.reason));
            }
          }

          // No explicit patterns matched, pass to Claude Code
          logDecision(
            tool_name,
            "pass",
            `Tool '${tool_name}' has no explicit patterns, delegating to Claude Code`,
            context.input.session_id,
            tool_input,
          );
          return context.success({});
        }

        // Handle other tools normally
        const otherResult = await processOtherTool(
          tool_name,
          tool_input,
          denyList,
          allowList,
          matchContext,
        );
        const decision = analyzePatternMatches(
          otherResult.allowMatches,
          otherResult.denyMatches,
        );

        // Log the decision using centralized logger
        logDecision(
          tool_name,
          decision.decision,
          decision.reason,
          context.input.session_id,
          tool_input,
        );

        if (decision.decision === "deny") {
          return context.json(createBoundaryDenyResponse(decision.reason));
        } else if (decision.decision === "ask") {
          return context.json(createAskResponse(decision.reason));
        } else if (decision.decision === "allow") {
          return context.json(createAllowResponse(decision.reason));
        }

        // Pass by default (let Claude Code decide) - log the decision
        logDecision(
          tool_name,
          "pass",
          `Tool '${tool_name}' has no matching patterns, delegating to Claude Code`,
          context.input.session_id,
          tool_input,
        );
        return context.success({});
      }
    } catch (error) {
      return context.json(
        createDenyResponse(`Error in auto-approve: ${error}`),
      );
    }
  },
});

// Helper functions (adapted from original implementation)

/**
 * Structured result type for bash command processing using Tagged Union pattern
 * This provides better type safety and eliminates string parsing
 */
type BashCommandResult =
  | { type: "allow"; command: string; pattern: string }
  | { type: "deny"; command: string; reason: string; pattern?: string }
  | { type: "pass"; command: string }
  | { type: "skip"; command: string; reason: string }
  | { type: "ask"; command: string; reason: string };

/**
 * Improved BashToolResult with structured command results
 */
interface BashToolResult {
  commands: BashCommandResult[];
  hasAskRequired: boolean;
  hasPassRequired: boolean;
}

interface OtherToolResult {
  denyMatches: string[];
  allowMatches: string[];
}

function getPermissionLists(
  tool_name: string,
  roots: SettingsRoots,
): {
  allowList: SourcedRule[];
  denyList: SourcedRule[];
} {
  if (process.env.CLAUDE_TEST_MODE === "1") {
    // Test mode
    try {
      const allowJson = JSON.parse(process.env.CLAUDE_TEST_ALLOW || "[]");
      const denyJson = JSON.parse(process.env.CLAUDE_TEST_DENY || "[]");

      const allowList = Array.isArray(allowJson)
        ? allowJson.filter((pattern: string) =>
            ruleNamesFor(tool_name).some(
              (name) => pattern === name || pattern.startsWith(`${name}(`),
            ),
          )
        : [];
      const denyList = Array.isArray(denyJson)
        ? denyJson.filter((pattern: string) =>
            ruleNamesFor(tool_name).some(
              (name) => pattern === name || pattern.startsWith(`${name}(`),
            ),
          )
        : [];

      // No settings file is behind these rules, so they anchor like rules
      // passed on the command line: where the session started.
      const fromEnv = (rule: string): SourcedRule => ({
        rule,
        settingsRoot: roots.project,
      });
      return {
        allowList: allowList.map(fromEnv),
        denyList: denyList.map(fromEnv),
      };
    } catch {
      return { allowList: [], denyList: [] };
    }
  } else {
    // Normal mode - get from settings files
    const workspaceRoot = getWorkspaceRoot();
    const settingsFiles = getSettingsFiles(workspaceRoot, roots);
    const allowList = extractPermissionList("allow", settingsFiles);
    const denyList = extractPermissionList("deny", settingsFiles);

    return { allowList, denyList };
  }
}

function currentUserName(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function getWorkspaceRoot(): string | undefined {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim();
  } catch {
    return process.cwd();
  }
}

function getSettingsFiles(
  workspaceRoot: string | undefined,
  roots: SettingsRoots,
): LoadedSettings[] {
  const loaded: LoadedSettings[] = [];
  for (const source of listSettingsSources(roots, workspaceRoot)) {
    if (!existsSync(source.path)) continue;
    try {
      loaded.push({
        settings: JSON.parse(
          readFileSync(source.path, "utf-8"),
        ) as SettingsFile,
        settingsRoot: source.settingsRoot,
      });
    } catch {
      // Ignore parse errors
    }
  }
  return loaded;
}

function extractPermissionList(
  type: "allow" | "deny",
  loaded: LoadedSettings[],
): SourcedRule[] {
  const rules: SourcedRule[] = [];

  for (const { settings, settingsRoot } of loaded) {
    const list = settings.permissions?.[type];
    if (Array.isArray(list)) {
      for (const rule of list) rules.push({ rule, settingsRoot });
    }
  }

  return rules;
}

/**
 * Improved bash tool processing with structured return types
 * Uses Tagged Union pattern for better type safety
 */
type BashStages = {
  classifyBashDeny: typeof classifyBashDeny;
  matchBashAllow: typeof matchBashAllow;
};

// Exported so tests can replace the stages and exercise the exception paths;
// the defaults are the real stages.
export async function processBashTool(
  tool_input: unknown,
  denyList: SourcedRule[],
  allowList: SourcedRule[],
  cwd: string | undefined,
  ctx: MatchContext,
  roots: SettingsRoots,
  stages: BashStages = { classifyBashDeny, matchBashAllow },
): Promise<BashToolResult> {
  const bashCommand = getCommandFromToolInput("Bash", tool_input) || "";

  // The allow basis is the split of the raw command only (F3a K1). The deny
  // side reads prepareDenyInput's maskedText and fragments, where data-only
  // heredoc bodies are emptied (F3b). Called before the home guard, where the
  // parser was called before, so a throw rejects to the hook's catch as before.
  // Taken before any parser call. A command the parser stopped analysing is
  // denied whatever its fragments say (today it is blocked by the 20 s
  // timeout); coarse fragments alone would let some writes through.
  const giveUpMark = parserGiveUpMark();
  const deniedForGiveUp = (): BashToolResult | null => {
    const reason = parserGiveUpReasonSince(giveUpMark);
    if (reason === null) return null;
    // The decision reason quotes `command`; a full over-limit command would
    // push the reason itself out of what the reader sees.
    const shown =
      bashCommand.length > 200
        ? `${bashCommand.slice(0, 200)}… (${bashCommand.length} characters)`
        : bashCommand;
    return {
      commands: [{ type: "deny", command: shown, reason }],
      hasAskRequired: false,
      hasPassRequired: false,
    };
  };
  const { maskedText, individualCommands, parsingMethod } =
    await prepareDenyInput(bashCommand);
  // Before the whole-text home check: both outcomes are a deny, and this one
  // skips reading a text the parser already refused.
  const gaveUpOnInput = deniedForGiveUp();
  if (gaveUpOnInput !== null) return gaveUpOnInput;

  // Judged on the whole command before splitting, because splitting loses the
  // `cd` context. `home` comes from this process, never from the command, so a
  // `HOME=...` assignment in an earlier Bash call cannot redirect the check.
  const homeResult = checkHomeDestruction(maskedText, {
    home: getHomeDir(),
    cwd: cwd || process.cwd(),
    user: currentUserName(),
  });
  if (homeResult.isDangerous) {
    return {
      commands: [
        { type: "deny", command: bashCommand, reason: homeResult.reason },
      ],
      hasAskRequired: false,
      hasPassRequired: false,
    };
  }

  // Judged once on the whole text (not the trimmed fragments); fragments only
  // inherit the result.
  const readOnlyExempt = isExemptReadOnlyCommand(maskedText, {
    parsingMethod,
  });
  // The only basis for allow: a split of the whole text (spec K1). The parser's
  // fragments may miss text the shell runs, so they feed the deny stage only.
  const simpleCommands = scanSafeList(bashCommand);

  // Each distinct text is judged once (trimmed, first occurrence wins, parser
  // fragments before scanned commands), so reasons count commands as before.
  const denyTargets = [
    ...new Set(
      [...individualCommands, ...(simpleCommands ?? [])]
        .map((fragment) => fragment.trim())
        .filter(Boolean),
    ),
  ];

  const commands: BashCommandResult[] = [];
  for (const target of denyTargets) {
    const result = await stages.classifyBashDeny(
      target,
      denyList,
      { readOnlyExempt },
      ctx,
    );
    const gaveUpOnFragment = deniedForGiveUp();
    if (gaveUpOnFragment !== null) return gaveUpOnFragment;
    if (result.type === "clear") continue;
    commands.push(result);
    if (result.type === "ask") {
      return { commands, hasAskRequired: true, hasPassRequired: false };
    }
  }
  if (commands.some((c) => c.type === "deny")) {
    return { commands, hasAskRequired: false, hasPassRequired: false };
  }

  try {
    if (simpleCommands === null) {
      commands.push({ type: "pass", command: bashCommand });
    } else {
      for (const simple of simpleCommands) {
        commands.push(
          await stages.matchBashAllow(simple, allowList, ctx, roots),
        );
      }
    }
  } catch (error) {
    // Never allow on a failure in the allow stage; the hook stays silent.
    // Only the error kind is logged: a message may quote the command.
    console.error(
      `[auto-approve] allow stage failed: ${error instanceof Error ? error.name : typeof error}`,
    );
    commands.push({ type: "pass", command: bashCommand });
  }

  const gaveUpLate = deniedForGiveUp();
  if (gaveUpLate !== null) return gaveUpLate;

  return {
    commands,
    hasAskRequired: false,
    hasPassRequired: commands.some((c) => c.type === "pass"),
  };
}

type DenyStageResult =
  | Extract<BashCommandResult, { type: "skip" | "ask" | "deny" }>
  | { type: "clear" };

async function classifyBashDeny(
  cmd: string,
  denyList: SourcedRule[],
  opts: { readOnlyExempt: boolean },
  ctx: MatchContext,
): Promise<DenyStageResult> {
  // Skip evaluation for control structure keywords - they are transparent
  if (CONTROL_STRUCTURE_KEYWORDS.includes(cmd)) {
    return {
      type: "skip",
      command: cmd,
      reason: `Control structure keyword '${cmd}'`,
    };
  }

  // Check for dangerous commands first
  // Skipped only when the whole command is a single read-only invocation whose
  // arguments are plain text (lib/read-only-command.ts).
  if (!opts.readOnlyExempt) {
    const dangerResult = checkDangerousCommand(cmd);
    if (dangerResult.isDangerous) {
      return dangerResult.requiresManualReview
        ? { type: "ask", command: cmd, reason: dangerResult.reason }
        : { type: "deny", command: cmd, reason: dangerResult.reason };
    }
  }

  // Check deny patterns
  if (denyList.length > 0) {
    const denyResult = await patternMatcherCheckDeny(cmd, denyList, ctx);
    if (denyResult.matches && denyResult.matchedPattern) {
      return {
        type: "deny",
        command: cmd,
        reason: `Individual command blocked: ${cmd}`,
        pattern: denyResult.matchedPattern,
      };
    }
  }

  return { type: "clear" };
}

// Layer 1: Static safe patterns (always allow regardless of allowList)
// These are read-only commands with no side effects
const SAFE_BASH_PATTERNS_LAYER1 = [
  // Information retrieval
  /^(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whereis|basename|dirname|realpath)\s/,
  /^(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whereis|basename|dirname|realpath)$/,
  // Git read-only operations
  /^git\s+(status|log|diff|branch|remote|show|describe|tag|rev-parse)(\s|$)/,
  /^git\s+config\s+--get\s/,
  // Package information
  /^(npm|pnpm|yarn|bun)\s+(ls|list|outdated|view|info|why|explain)(\s|$)/,
];

/** One simple command from scanSafeList; anchored rules only, no re-parse. */
async function matchBashAllow(
  cmd: string,
  allowList: SourcedRule[],
  ctx: MatchContext,
  roots: SettingsRoots,
): Promise<Extract<BashCommandResult, { type: "allow" | "pass" }>> {
  const sed = await inferSedInPlaceAllow(cmd, ctx, roots);
  if (sed) return sed;
  for (const pattern of SAFE_BASH_PATTERNS_LAYER1) {
    if (pattern.test(cmd)) {
      return {
        type: "allow",
        command: cmd,
        pattern: "Static safe pattern (Layer 1)",
      };
    }
  }
  if (allowList.length > 0) {
    // Only `sleep` reaches here in practice: scanSafeList returns null for a
    // `find` head, so isSafeBuiltinCommand's find branch is unused on this path.
    if (isSafeBuiltinCommand(cmd)) {
      return { type: "allow", command: cmd, pattern: "Built-in safe command" };
    }
    const matched = matchAnchoredBashAllow(
      cmd,
      allowList.map(({ rule }) => rule),
    );
    if (matched) return { type: "allow", command: cmd, pattern: matched };
  }
  return { type: "pass", command: cmd };
}

async function inferSedInPlaceAllow(
  cmd: string,
  ctx: MatchContext,
  roots: SettingsRoots,
): Promise<Extract<BashCommandResult, { type: "allow" }> | null> {
  // parseSedInPlace splits words without a full shell reading and misreads a
  // space after a backslash, so it never infers a command containing one.
  if (cmd.includes("\\")) return null;
  // sed -i コマンドの権限推論チェック
  // Edit/MultiEditが許可されているディレクトリ内のファイルへのsed -iを自動承認
  if (cmd.includes("sed") && cmd.includes("-i")) {
    const { parseSedInPlace } = await import("../lib/sed-parser.ts");
    const sedResult = parseSedInPlace(cmd);

    // sed -i コマンドで、グロブを含まず、パースに成功した場合のみ推論を試みる
    if (
      sedResult.isSedInPlace &&
      !sedResult.containsGlob &&
      !sedResult.parseError &&
      sedResult.targetFiles.length > 0
    ) {
      // Edit/MultiEditパターンを取得（Bashツールの許可リストとは別）
      const editPermissions = getPermissionLists("Edit", roots);
      const multiEditPermissions = getPermissionLists("MultiEdit", roots);
      const editAllowList = [
        ...editPermissions.allowList,
        ...multiEditPermissions.allowList,
      ];

      const { checkFilePermissions } =
        await import("../lib/file-permission-inference.ts");
      const permResult = checkFilePermissions(
        sedResult.targetFiles,
        editAllowList,
        ctx,
      );

      if (permResult.allFilesPermitted) {
        // 全ファイルがEdit許可パターンにマッチする場合、自動承認
        return {
          type: "allow",
          command: cmd,
          pattern: `sed -i inferred from Edit permissions (files: ${sedResult.targetFiles.join(", ")})`,
        };
      }
    }
  }

  return null;
}

async function processOtherTool(
  tool_name: string,
  tool_input: unknown,
  denyList: SourcedRule[],
  allowList: SourcedRule[],
  ctx: MatchContext,
): Promise<OtherToolResult> {
  const denyMatches: string[] = [];
  const allowMatches: string[] = [];

  // Check deny patterns first
  for (const sourced of denyList) {
    if (
      sourced.rule.trim() &&
      (await checkPattern(sourced, tool_name, tool_input, ctx, "deny"))
    ) {
      denyMatches.push(sourced.rule);
    }
  }

  // Check allow patterns
  for (const sourced of allowList) {
    if (
      sourced.rule.trim() &&
      (await checkPattern(sourced, tool_name, tool_input, ctx, "allow")) &&
      !isBorrowedEditRuleOnDangerousPath(
        sourced.rule,
        tool_name,
        tool_input,
        ctx,
      )
    ) {
      allowMatches.push(sourced.rule);
    }
  }

  return {
    denyMatches,
    allowMatches,
  };
}

/**
 * Write, MultiEdit and NotebookEdit borrow Edit rules, but an allow here skips
 * the PermissionRequest layer and its dangerous path check. Leave such a call
 * unanswered so that layer still sees it. Both the raw value (what that layer
 * inspects) and the resolved path (catches a relative `.env`) are checked.
 */
function isBorrowedEditRuleOnDangerousPath(
  pattern: string,
  tool_name: string,
  tool_input: unknown,
  ctx: MatchContext,
): boolean {
  // Edit never reached the second layer's check (it was already allowed here),
  // so its outcome stays as it was; only tools that newly borrow Edit rules are held back.
  if (tool_name === "Edit") return false;
  if (pattern !== "Edit" && !pattern.startsWith("Edit(")) return false;
  const raw = getFilePathFromToolInput(tool_name, tool_input) || "";
  if (!raw) return false;
  return (
    isDangerousWritePath(raw) ||
    isDangerousWritePath(resolveTargetPath(raw, ctx))
  );
}

// Pattern matching functions now use shared library imports

async function checkPattern(
  sourced: SourcedRule,
  tool_name: string,
  tool_input: unknown,
  ctx: MatchContext,
  list: RuleList,
): Promise<boolean> {
  const pattern = sourced.rule;
  // Check for invalid Bash(**) pattern and log warning
  if (pattern === "Bash(**)" && tool_name === "Bash") {
    console.warn(
      `Invalid pattern 'Bash(**)' detected. Bash tool uses command prefixes like 'Bash(npm *)' not file patterns.`,
    );
    return false;
  }

  if (
    NO_PAREN_TOOL_NAMES.includes(tool_name) ||
    tool_name.startsWith("mcp__")
  ) {
    // For tools without parentheses, match the pattern directly or with wildcard
    // Support both "ToolName" and "ToolName(**)" patterns
    return pattern === tool_name || pattern === `${tool_name}(**)`;
  }

  // Use shared pattern checking from pattern-matcher.ts
  return await patternMatcherCheckPattern(
    pattern,
    tool_name,
    tool_input,
    ruleContext(ctx, sourced),
    list,
  );
}

/**
 * Analyze structured bash command results using Tagged Union pattern
 * Provides better type safety than string parsing approach
 */
function analyzeBashCommands(
  commands: BashCommandResult[],
  hasAskRequired: boolean,
  _hasPassRequired: boolean,
): { decision: PermissionDecision; reason: string } {
  // Ask takes precedence
  if (hasAskRequired) {
    const askCommand = commands.find((cmd) => cmd.type === "ask");
    return {
      decision: "ask",
      reason: askCommand?.reason
        ? `Command '${askCommand.command}': ${askCommand.reason}`
        : "Manual review required for dangerous command",
    };
  }

  // Check for denied commands
  const deniedCommands = commands.filter((cmd) => cmd.type === "deny");
  if (deniedCommands.length > 0) {
    // Create detailed breakdown of which commands were denied and why
    const denyDetails = deniedCommands
      .map((cmd) => {
        if (cmd.pattern) {
          return `"${cmd.command}" → blocked by ${cmd.pattern}`;
        } else {
          return `"${cmd.command}" → ${cmd.reason}`;
        }
      })
      .join(", ");

    return {
      decision: "deny",
      reason: `Blocked by security rules (${deniedCommands.length} commands): ${denyDetails}`,
    };
  }

  // Check if all non-skipped commands are explicitly allowed
  const nonSkippedCommands = commands.filter((cmd) => cmd.type !== "skip");
  const allowedCommands = commands.filter((cmd) => cmd.type === "allow");
  const passCommands = commands.filter((cmd) => cmd.type === "pass");

  if (nonSkippedCommands.length === 0) {
    // Only control structure keywords are present
    const skippedCommands = commands.filter((cmd) => cmd.type === "skip");
    const skippedDetails = skippedCommands
      .map((cmd) => `"${cmd.command}"`)
      .join(", ");
    return {
      decision: "ask",
      reason: `Only control structure keywords present (${skippedCommands.length} keywords): ${skippedDetails}, no allow patterns defined`,
    };
  }

  if (allowedCommands.length > 0 && passCommands.length === 0) {
    // Create detailed breakdown of which commands matched which patterns
    const matchDetails = allowedCommands
      .map((cmd) => `"${cmd.command}" → ${cmd.pattern}`)
      .join(", ");
    return {
      decision: "allow",
      reason: `All commands matched allow patterns (${allowedCommands.length} commands): ${matchDetails}`,
    };
  }

  // Pass commands through to Claude Code (no hook intervention)
  if (passCommands.length > 0) {
    // Create detailed breakdown of which commands are passed through
    const passDetails = passCommands
      .map((cmd) => `"${cmd.command}"`)
      .join(", ");
    return {
      decision: "pass",
      reason: `Commands passed through to Claude Code for evaluation (${passCommands.length} commands): ${passDetails}`,
    };
  }

  // Fallback ask case - provide details about what commands need review
  const allCommands = nonSkippedCommands
    .map((cmd) => `"${cmd.command}"`)
    .join(", ");
  return {
    decision: "ask",
    reason: `Manual review required for commands (${nonSkippedCommands.length} commands): ${allCommands} - no permission patterns configured`,
  };
}

// analyzePatternMatches function now imported from decision-maker.ts to eliminate duplication

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
