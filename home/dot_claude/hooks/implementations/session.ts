#!/usr/bin/env -S bun run --silent

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getHomeDir } from "../lib/path-utils.ts";
import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";
import { matcherCoversGuardedTools } from "../lib/guarded-tools.ts";
import {
  getDistillHealthNotice,
  getUnreadDigestPreview,
} from "../lib/insight-digest.ts";
import { getProjectRoot } from "../lib/project-root.ts";
import { shellSingleQuote } from "../lib/shell-quote.ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

// Resolved per call so a HOME swap (tests) is honored.
function getGlobalSettingsPath(): string {
  return resolve(getHomeDir(), ".claude", "settings.json");
}

function checkSharedTaskList(): string | null {
  const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  if (taskListId) {
    return `⚠️ CLAUDE_CODE_TASK_LIST_ID is set: ${taskListId}\n   This session shares a task list from another session. Tasks may be overwritten unintentionally.\n   To detach: unset CLAUDE_CODE_TASK_LIST_ID`;
  }
  return null;
}

/**
 * Whether the workflow looks armed, as the startup summary reports it.
 *
 * Deliberately a local copy of `isWorkflowActive` in lib/workflow-gate.ts
 * rather than an import: importing it would make the observer depend on the
 * module it exists to observe (spec K5). The copy is kept honest by a drift
 * test (session.test.ts) that runs both against one fixture table.
 *
 * One deliberate degradation: the guard also returns true when
 * `workflow-state.json` says `mode === "document-workflow"`, and this does not
 * read that file. Measured: no such file exists in this repository or in any
 * project under ~/workspace. The degradation is conservative -- it can report
 * inactive while the guard enforces, never the reverse.
 */
export function isWorkflowArmedForTesting(
  wfPaths: ReturnType<typeof resolveWorkflowPaths>,
): boolean {
  return existsSync(wfPaths.plan) || existsSync(wfPaths.research);
}

/** Pull the guard's PreToolUse matcher out of a parsed settings object. */
export function extractGuardMatcher(settings: unknown): string | null {
  const entries = (settings as { hooks?: { PreToolUse?: unknown[] } })?.hooks
    ?.PreToolUse;
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    const e = entry as { matcher?: unknown; hooks?: { command?: unknown }[] };
    const references =
      Array.isArray(e.hooks) &&
      e.hooks.some(
        (h) =>
          typeof h?.command === "string" &&
          h.command.includes("document-workflow-guard.ts"),
      );
    if (references && typeof e.matcher === "string") return e.matcher;
  }
  return null;
}

/**
 * Point 1 of the startup summary (decision 5): report what the guard's
 * PreToolUse matcher covers.
 *
 * Audit scope is deliberately narrow (decision 4): only
 * `~/.claude/settings.json` is read. Claude Code also merges project-level
 * `.claude/settings.json` and `settings.local.json`, but reimplementing that
 * full merge here would assert a guarantee ("the matcher is armed") that this
 * single-file read cannot back up. The file that was audited is named in the
 * message so the guarantee's boundary is visible, not implied.
 *
 * Wrapped in its own try/catch so a malformed or unreadable settings file
 * cannot blank out the other four startup-summary points.
 */
function auditGuardWiring(): string {
  try {
    if (!existsSync(getGlobalSettingsPath())) {
      return `wiring (${getGlobalSettingsPath()}): file not found; could not audit the guard's PreToolUse matcher.`;
    }
    const parsed = JSON.parse(readFileSync(getGlobalSettingsPath(), "utf-8"));
    const matcher = extractGuardMatcher(parsed);
    if (matcher === null) {
      return `wiring (${getGlobalSettingsPath()}): no PreToolUse entry references document-workflow-guard.ts.`;
    }
    const coverage = matcherCoversGuardedTools(matcher);
    return coverage.covered
      ? `wiring (${getGlobalSettingsPath()}): matcher "${matcher}" covers all guarded tools.`
      : `wiring (${getGlobalSettingsPath()}): matcher "${matcher}" is missing ${coverage.missing.join(", ")}.`;
  } catch (error) {
    // Deliberately not String(error): settings.json can carry tokens in an
    // `env` block, and unlike Bun, Node sometimes embeds a slice of the
    // offending input in a JSON.parse SyntaxError message.
    return `wiring (${getGlobalSettingsPath()}): could not audit it (${
      error instanceof Error ? error.name : "unknown"
    }).`;
  }
}

/**
 * Session management hooks
 * Handles SessionStart events using centralized logging
 */
const hook = defineHook({
  trigger: { SessionStart: true },
  run: (context) => {
    try {
      // Log session start using centralized logger
      logEvent("SessionStart", context.input.session_id);

      // Resolve the workflow dir the same way the guard does (K1/K3),
      // rather than trusting a pre-set value unconditionally: a pin that
      // escapes .tmp/sessions is rejected here exactly as it is by the guard,
      // so the two cannot silently disagree about which directory is armed.
      // The root is getProjectRoot(). In production that is the
      // CLAUDE_PROJECT_DIR Claude Code passes (the dir the session started
      // in), which a Bash `cd` or a move into a worktree does not change.
      // input.cwd is not used.
      const cwd = getProjectRoot();
      const sessionId = context.input.session_id;
      const resolution = resolveWorkflowDir({ cwd, sessionId });
      const userPin = process.env.DOCUMENT_WORKFLOW_DIR;

      // Export session info to CLAUDE_ENV_FILE for skills to consume
      //
      // The workflow dir and the session id are deliberately not exported
      // (spec K4). An exported value outlives /clear in the Bash env and
      // pointed `workflow-cli` and model-written paths at the previous
      // session's dir (#197). Bash gets them from `workflow-cli dir` and from
      // CLAUDE_CODE_SESSION_ID, which Claude Code itself keeps current.
      const envFile = process.env.CLAUDE_ENV_FILE;
      if (envFile) {
        const transcriptPath = context.input.transcript_path;
        const projectHash = context.input.cwd
          .replace(/\//g, "-")
          .replace(/^-/, "");
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_DIR=${shellSingleQuote(cwd)}\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_TRANSCRIPT_PATH=${shellSingleQuote(transcriptPath)}\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_HASH=${shellSingleQuote(projectHash)}\n`,
        );

        const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
        if (taskListId) {
          appendFileSync(
            envFile,
            `export CLAUDE_TASK_LIST_ID=${shellSingleQuote(taskListId)}\n`,
          );
        }

        // This block is deliberately NOT wrapped in its own try/catch, unlike
        // the settings read in auditGuardWiring(). A write failure here
        // (e.g. CLAUDE_ENV_FILE naming a directory that does not exist) must
        // reach the outer catch below so the startup summary reports the
        // failure (K5a) instead of the hook silently no-op'ing through
        // context.success({}). session.test.ts's "reports the failure
        // through systemMessage when the run actually throws" depends on
        // this propagation; isolating this block the way the settings read
        // is isolated would make that regression guard vacuous.
      }

      const taskListWarning = checkSharedTaskList();
      const messages = [
        "🚀 Claude Code session started. Ready for development!",
        auditGuardWiring(),
      ];

      if (resolution.source === "unresolvable") {
        // K2b: unresolvable has more than one cause, and the message must
        // name the check that failed, not guess at one of them.
        messages.push(
          resolution.reason === "invalid-session-id"
            ? "[session] the session id is malformed, so no workflow directory could be derived; the workflow gate is not enforcing."
            : `[session] could not verify that the derived workflow directory is a strict descendant of ${cwd}/.tmp/sessions; the workflow gate is not enforcing.`,
        );
      } else {
        const sourceLabel =
          resolution.source === "env" ? " (user-specified)" : "";
        messages.push(
          `Document Workflow directory: ${resolution.relative}/${sourceLabel}`,
        );
        messages.push(
          `resolved: ${resolution.dir} (source: ${resolution.source})`,
        );
        const wfPaths = resolveWorkflowPaths(resolution.dir);
        messages.push(
          `workflow gate: ${isWorkflowArmedForTesting(wfPaths) ? "armed" : "inactive"}`,
        );
        if (resolution.source === "env-rejected") {
          messages.push(
            `[session] DOCUMENT_WORKFLOW_DIR="${userPin}" was rejected (not a verified descendant of ${cwd}/.tmp/sessions) and the derived directory ${resolution.relative} is used instead.`,
          );
        }
      }

      messages.push(
        `warn-only mode: ${process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1" ? "on" : "off"}`,
      );

      if (context.input.cwd !== cwd) {
        messages.push(
          `cwd mismatch: context.input.cwd=${context.input.cwd} but the project root is ${cwd}.`,
        );
      }

      if (taskListWarning) {
        messages.push(taskListWarning);
      }
      const digestPreview = getUnreadDigestPreview();
      if (digestPreview) {
        messages.push(digestPreview);
      }
      const distillHealth = getDistillHealthNotice();
      if (distillHealth) {
        messages.push(distillHealth);
      }

      // SessionStart では cc-hooks-ts の success() が messageForUser を破棄する
      // (additionalClaudeContext しか読まない)。加えて素の stdout は hook_success
      // attachment として Claude のモデル入力に注入されるため、ユーザー向け通知には
      // 使えない。systemMessage は UI に表示され、モデル入力には入らない唯一のチャネル
      // （Claude Code 2.1.234 の binary 実測。再検証手順は
      //  docs/plans/hook-target-diagnostics-followups.md の「課題 A」節）。
      // なお context.json の event は trigger 宣言に対して型検査され、ランタイムの
      // hook_event_name とは結び付かない。複数イベント trigger に変える場合は注意。
      return context.json({
        event: "SessionStart",
        output: { systemMessage: messages.join("\n") },
      });
    } catch (error) {
      // K5a: an escaping exception must be reported through systemMessage,
      // not silently swallowed into context.success({}) -- that would arm
      // nothing while looking identical to a healthy startup.
      console.error(`Session start error: ${error}`);
      return context.json({
        event: "SessionStart",
        output: {
          systemMessage: `⚠️ Session start hook failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
