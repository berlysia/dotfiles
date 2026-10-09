#!/usr/bin/env -S bun run --silent

import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import {
  MAX_COMMAND_CHARS,
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
import { getCommandFromToolInput } from "../lib/command-parsing.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { isExemptReadOnlyCommand } from "../lib/read-only-command.ts";
import {
  createAskResponse,
  createBoundaryDenyResponse,
  createDenyResponse,
  createMatchedTextDenyResponse,
  formatAskReason,
  shortenForReason,
} from "../lib/context-helpers.ts";
import {
  buildReadOnlyPatterns,
  classifyDeletion,
  cpThenNodeModules,
  describeDeletionMatch,
  isNonModifyingShape,
  mayAllowAsReadOnly,
  redirectToNodeModules,
  standaloneSymlinkRemovalOperands,
} from "../lib/node-modules-policy.ts";
import { prefixThenOnLine, type TextMatcher } from "../lib/linear-match.ts";
import {
  isEditInput,
  isMultiEditInput,
  isNotebookEditInput,
  isWriteInput,
} from "../types/project-types.ts";
// Import module augmentation for MultiEdit type
import "../types/tool-schemas.ts";

/**
 * Control access to node_modules directories with 3-stage analysis
 * - ALLOW: Read-only operations (ls, cat, cd, etc.)
 * - ASK: Unknown operations requiring approval
 * - DENY: Destructive operations (rm, mv, write redirects, etc.)
 * Converted from deny-node-modules-write.ts using cc-hooks-ts
 */
const hook = defineHook({
  trigger: { PreToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input } = context.input;

    // Process destructive file tools and bash commands
    // Note: Read tool is excluded to allow node_modules content inspection
    const fileAccessTools = [
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Bash",
    ];
    if (!fileAccessTools.includes(tool_name)) {
      return context.success({});
    }

    try {
      // Special handling for Bash commands with 3-stage analysis
      if (tool_name === "Bash") {
        const cmd = getCommandFromToolInput("Bash", tool_input) || "";
        // Removing a symlink named node_modules never touches its target, so a
        // standalone, unambiguous rm/unlink of existing symlinks is exempt.
        const linkOperands =
          cmd.length > MAX_COMMAND_CHARS
            ? null
            : standaloneSymlinkRemovalOperands(cmd);
        if (linkOperands !== null && linkOperands.every(isSymlinkPath)) {
          return context.success({});
        }
        const bashResult = await analyzeBashCommand(cmd);

        switch (bashResult.decision) {
          case "deny":
            // Only a deny that quotes a `Matched:` line gets the matched-text
            // guidance; the parser give-up deny carries none.
            return context.json(
              bashResult.matched
                ? createMatchedTextDenyResponse(bashResult.reason)
                : createBoundaryDenyResponse(bashResult.reason),
            );
          case "ask":
            return context.json(createAskResponse(bashResult.reason));
          case "allow":
            return context.success({});
        }
      }

      // For other tools, extract file path and validate
      const filePath = await extractFilePath(tool_name, tool_input);
      if (!filePath) {
        return context.success({});
      }

      // Check if path is in node_modules
      const validation = validateNodeModulesAccess(filePath);
      if (!validation.isAllowed) {
        return context.json(
          createBoundaryDenyResponse(
            `${tool_name} access denied: ${validation.reason}\nPath: ${validation.resolvedPath}`,
          ),
        );
      }

      return context.success({});
    } catch (error) {
      return context.json(
        createDenyResponse(`Error in node_modules access check: ${error}`),
      );
    }
  },
});

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false; // ENOENT / ENOTDIR / EACCES / ELOOP: no exemption, the regular deny applies
  }
}

interface NodeModulesValidationResult {
  isAllowed: boolean;
  resolvedPath: string;
  reason?: string;
}

type Decision = "deny" | "allow" | "ask";

interface AnalysisResult {
  decision: Decision;
  reason: string;
  operation?: string;
  matched?: string | undefined;
}

interface BashAnalysisResult {
  decision: Decision;
  reason: string;
  operation?: string;
  matched?: string | undefined;
}

async function extractFilePath(
  tool_name: string,
  tool_input: unknown,
): Promise<string | null> {
  if (isWriteInput(tool_name, tool_input)) {
    return (
      (tool_input as import("cc-hooks-ts").ToolSchema["Write"]["input"])
        .file_path || null
    );
  }
  if (isEditInput(tool_name, tool_input)) {
    return (
      (tool_input as import("cc-hooks-ts").ToolSchema["Edit"]["input"])
        .file_path || null
    );
  }
  if (isMultiEditInput(tool_name, tool_input)) {
    return (
      (tool_input as import("cc-hooks-ts").ToolSchema["MultiEdit"]["input"])
        .file_path || null
    );
  }
  if (isNotebookEditInput(tool_name, tool_input)) {
    return (
      (tool_input as import("cc-hooks-ts").ToolSchema["NotebookEdit"]["input"])
        .notebook_path || null
    );
  }
  if (tool_name === "Bash") {
    const cmd = getCommandFromToolInput("Bash", tool_input) || "";
    return await extractPathFromBashCommand(cmd);
  }
  return null;
}

function validateNodeModulesAccess(
  filePath: string,
): NodeModulesValidationResult {
  // Resolve to absolute path
  const resolvedPath = resolve(filePath);

  // Check if path contains node_modules
  if (resolvedPath.includes("/node_modules/")) {
    return {
      isAllowed: false,
      resolvedPath,
      reason:
        "Direct modification of node_modules files is not allowed. Use package manager commands instead.",
    };
  }

  // Check if path is directly named node_modules
  if (
    resolvedPath.endsWith("/node_modules") ||
    resolvedPath.includes("/node_modules")
  ) {
    return {
      isAllowed: false,
      resolvedPath,
      reason:
        "Direct modification of node_modules directory is not allowed. Use package manager commands instead.",
    };
  }

  // Allow all other paths
  return {
    isAllowed: true,
    resolvedPath,
  };
}

async function analyzeBashCommand(
  command: string,
): Promise<BashAnalysisResult> {
  // Deny-side reads go through prepareDenyInput: data-only heredoc bodies are
  // emptied in both the whole text and the fragments (spec K1).
  const giveUpMark = parserGiveUpMark();
  const { maskedText, individualCommands, parsingMethod } =
    await prepareDenyInput(command);
  // A command the parser stopped analysing is denied whether or not its text
  // mentions node_modules: the fragments below are incomplete for it.
  const giveUpReason = parserGiveUpReasonSince(giveUpMark);
  if (giveUpReason !== null) {
    return { decision: "deny", reason: giveUpReason, operation: "unknown" };
  }
  const commands = individualCommands;
  // Judged once on the whole command; fragments only inherit the result.
  const readOnlyExempt = isExemptReadOnlyCommand(maskedText, { parsingMethod });

  let hasUnknown = false;
  let unknownCmd = "";

  // Check each command individually
  for (const cmd of commands) {
    const result = analyzeIndividualCommand(cmd, {
      fallback: parsingMethod === "fallback",
      readOnlyExempt,
    });

    // If any command should be denied, deny the entire compound command
    if (result.decision === "deny") {
      const matchedLine = result.matched ? `\nMatched: ${result.matched}.` : "";
      return {
        decision: "deny",
        reason: `Destructive operation detected: ${result.matched ? shortenForReason(cmd) : cmd}\n${result.reason}${matchedLine}`,
        operation: result.operation || "unknown",
        matched: result.matched,
      };
    }

    // Track unknown commands
    if (result.decision === "ask") {
      hasUnknown = true;
      unknownCmd = cmd;
    }
  }

  // If no denies but has unknown, ask
  if (hasUnknown) {
    return {
      decision: "ask",
      reason: formatAskReason(
        "Unknown node_modules operation requires approval",
        "Command",
        [unknownCmd],
      ),
      operation: "unknown",
    };
  }

  // All commands are allowed
  return {
    decision: "allow",
    reason: "Read-only operations permitted",
  };
}

function deletionReason(
  cmd: string,
  verdict: "deny-delete" | "deny-find",
): string {
  const base =
    verdict === "deny-find"
      ? "find operation not allowed on node_modules"
      : "delete operation not allowed on node_modules";
  const targetsLink =
    verdict === "deny-delete" &&
    cmd
      .toLowerCase()
      .split(/\s+/)
      .some((w) => w.endsWith("node_modules"));
  return targetsLink
    ? `${base}. If you created this node_modules symlink yourself, remove it with a standalone \`unlink <absolute path>\` command. This boundary allows that one command, for that case only, as an exception to the note below.`
    : base;
}

/**
 * Destructive operations - clear deny. Exported for the differential test
 * (linear-match-equivalence.test.ts). Do not add a regex of the form
 * `X\s+.*Y` / `X.*Y` here; use prefixThenOnLine (see Issue #219).
 * `trigger` is shown as `Matched:`; review it when `pattern` changes. The
 * prefix `\s+` also matches a line break, so it never says "same line".
 */
export const DESTRUCTIVE_NODE_MODULES_PATTERNS: ReadonlyArray<{
  readonly pattern: TextMatcher;
  readonly operation: string;
  readonly trigger: string;
}> = [
  {
    pattern: prefixThenOnLine(/(?:^|\s)mv\s+/, /node_modules/),
    operation: "move",
    trigger: 'the word "mv" followed by node_modules',
  },
  {
    pattern: cpThenNodeModules(),
    operation: "copy-to",
    trigger: 'the word "cp" followed later by node_modules',
  },
  {
    pattern: redirectToNodeModules(),
    operation: "overwrite",
    trigger:
      'the character ">" followed by node_modules in the same or the next word, quoted text included',
  },
  {
    pattern: prefixThenOnLine(/(?:^|\s)(chmod|chown)\s+/, /node_modules/),
    operation: "permission",
    trigger: 'the word "chmod" or "chown" followed by node_modules',
  },
  {
    pattern: prefixThenOnLine(/(?:^|\s)mkdir\s+/, /node_modules/),
    operation: "create",
    trigger: 'the word "mkdir" followed by node_modules',
  },
  {
    pattern: prefixThenOnLine(/(?:^|\s)touch\s+/, /node_modules/),
    operation: "create",
    trigger: 'the word "touch" followed by node_modules',
  },
];

function analyzeIndividualCommand(
  cmd: string,
  opts: { fallback: boolean; readOnlyExempt: boolean },
): AnalysisResult {
  // If no node_modules reference, always allow
  if (!cmd.toLowerCase().includes("node_modules")) {
    return { decision: "allow", reason: "No node_modules reference" };
  }

  // Read-only operations - clear allow
  const readOnlyPatterns = [
    ...buildReadOnlyPatterns(),
    { pattern: /(?:^|\s)(pwd|dirname|basename)/, operation: "path-info" },
  ];

  const verdict = classifyDeletion(cmd, {
    readOnlyExempt: opts.readOnlyExempt,
  });
  if (verdict === "deny-delete" || verdict === "deny-find") {
    return {
      decision: "deny",
      reason: deletionReason(cmd, verdict),
      operation: "delete",
      matched: describeDeletionMatch(cmd, verdict),
    };
  }

  // Check for destructive operations first
  for (const {
    pattern,
    operation,
    trigger,
  } of DESTRUCTIVE_NODE_MODULES_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        decision: "deny",
        reason: `${operation} operation not allowed on node_modules`,
        operation,
        matched: trigger,
      };
    }
  }

  if (verdict === "ask-find") {
    return {
      decision: "ask",
      reason: "find with -exec on node_modules requires approval",
      operation: "unknown",
    };
  }
  if (!mayAllowAsReadOnly(cmd, { fallback: opts.fallback })) {
    return {
      decision: "ask",
      reason:
        "Compound command fragment under fallback parsing requires approval",
      operation: "unknown",
    };
  }

  // Printing file lines or running an installed tool does not make
  // node_modules a target. No decision is given, so the regular permission
  // path still judges the command.
  if (isNonModifyingShape(cmd)) {
    return {
      decision: "allow",
      reason: "does not target node_modules",
      operation: "non-modifying",
    };
  }

  // Check for read-only operations
  for (const { pattern, operation } of readOnlyPatterns) {
    if (pattern.test(cmd)) {
      return {
        decision: "allow",
        reason: `${operation} operation is safe`,
        operation,
      };
    }
  }

  // Unknown operation - ask for approval
  return {
    decision: "ask",
    reason: "Unknown operation on node_modules requires approval",
    operation: "unknown",
  };
}

async function extractPathFromBashCommand(
  command: string,
): Promise<string | null> {
  // Use the new analysis system to determine if command affects node_modules
  const result = await analyzeBashCommand(command);

  // If the command involves node_modules in any way, return dummy path to trigger processing
  if (result.decision !== "allow" || command.includes("node_modules")) {
    return "node_modules";
  }

  return null;
}

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
