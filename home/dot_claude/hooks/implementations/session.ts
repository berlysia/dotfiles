#!/usr/bin/env -S bun run --silent

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";
import { matcherCoversGuardedTools } from "../lib/guarded-tools.ts";
import { getUnreadDigestPreview } from "../lib/insight-digest.ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";

const GLOBAL_SETTINGS_PATH = resolve(homedir(), ".claude", "settings.json");

// Characters that would break out of the double-quoted shell sink this
// module writes DOCUMENT_WORKFLOW_DIR through (`export X="${value}"`). See
// the write site below for why this list, not a general escaper, is correct
// here.
const UNSAFE_FOR_DOUBLE_QUOTED_EXPORT = /["`$\\\n]/;

function isSafeForDoubleQuotedExport(value: string): boolean {
  return !UNSAFE_FOR_DOUBLE_QUOTED_EXPORT.test(value);
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
 * Deliberately a local copy of the guard's `isWorkflowActive` rather than an
 * import: importing it would make the observer depend on the module it exists
 * to observe (spec K5), and moving it to `lib/` would add an export during the
 * phase that must not touch `lib/` (spec K15). The copy is kept honest by a
 * drift test that runs both against one fixture table.
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
    if (!existsSync(GLOBAL_SETTINGS_PATH)) {
      return `wiring (${GLOBAL_SETTINGS_PATH}): file not found; could not audit the guard's PreToolUse matcher.`;
    }
    const parsed = JSON.parse(readFileSync(GLOBAL_SETTINGS_PATH, "utf-8"));
    const matcher = extractGuardMatcher(parsed);
    if (matcher === null) {
      return `wiring (${GLOBAL_SETTINGS_PATH}): no PreToolUse entry references document-workflow-guard.ts.`;
    }
    const coverage = matcherCoversGuardedTools(matcher);
    return coverage.covered
      ? `wiring (${GLOBAL_SETTINGS_PATH}): matcher "${matcher}" covers all guarded tools.`
      : `wiring (${GLOBAL_SETTINGS_PATH}): matcher "${matcher}" is missing ${coverage.missing.join(", ")}.`;
  } catch (error) {
    // Deliberately not String(error): settings.json can carry tokens in an
    // `env` block, and unlike Bun, Node sometimes embeds a slice of the
    // offending input in a JSON.parse SyntaxError message.
    return `wiring (${GLOBAL_SETTINGS_PATH}): could not audit it (${
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

      // Resolve DOCUMENT_WORKFLOW_DIR the same way the guard does (K1/K3),
      // rather than trusting a pre-set value unconditionally: a pin that
      // escapes .tmp/sessions is rejected here exactly as it is by the guard,
      // so the two cannot silently disagree about which directory is armed.
      // decision 2: cwd comes from process.cwd(), never context.input.cwd --
      // this hook is not one of the five CLAUDE_TEST_CWD readers, and adding
      // it as a sixth would blur the seam K11b deliberately left alone.
      const cwd = process.cwd();
      const sessionId = context.input.session_id;
      const resolution = resolveWorkflowDir({ cwd, sessionId });
      const userPin = process.env.DOCUMENT_WORKFLOW_DIR;

      // Export session info to CLAUDE_ENV_FILE for skills to consume
      const envFile = process.env.CLAUDE_ENV_FILE;
      let workflowDirExportSkippedForUnsafeChars = false;
      if (envFile) {
        const transcriptPath = context.input.transcript_path;
        const projectHash = context.input.cwd
          .replace(/\//g, "-")
          .replace(/^-/, "");
        appendFileSync(envFile, `export CLAUDE_SESSION_ID="${sessionId}"\n`);
        appendFileSync(
          envFile,
          `export CLAUDE_TRANSCRIPT_PATH="${transcriptPath}"\n`,
        );
        appendFileSync(
          envFile,
          `export CLAUDE_PROJECT_HASH="${projectHash}"\n`,
        );

        const taskListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
        if (taskListId) {
          appendFileSync(
            envFile,
            `export CLAUDE_TASK_LIST_ID="${taskListId}"\n`,
          );
        }

        // decision 6: spec R8 / K8 item 7 leave the *general* unescaped-write
        // fix for these exports to later work; this is a narrower fail-safe
        // scoped to the containment path K11 newly opened.
        // `isStrictlyUnderProjectSubdir` accepts an as-yet-uncreated
        // descendant, so a value like `.tmp/sessions/x";touch /tmp/x;"` can
        // reach this point through containment. Rather than escape it
        // (sanitizeForDisplay is the wrong tool -- its own docstring says it
        // keeps `$` and is not for structural sinks), a value carrying a
        // character unsafe for this sink's double quotes is simply not
        // written, matching how an unresolvable dir is already handled below.
        // `resolution.relative === null` (the unresolvable case) is folded
        // into the same "do not write" rule for the same reason: writing the
        // literal string "null" as the exported value would keep this file's
        // single export line intact while pointing consumers at a directory
        // that does not exist.
        if (resolution.relative !== null) {
          if (isSafeForDoubleQuotedExport(resolution.relative)) {
            appendFileSync(
              envFile,
              `export DOCUMENT_WORKFLOW_DIR="${resolution.relative}"\n`,
            );
          } else {
            workflowDirExportSkippedForUnsafeChars = true;
          }
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
            ? "[session] the session id is malformed, so no workflow directory could be derived; DOCUMENT_WORKFLOW_DIR is not exported."
            : `[session] could not verify that the derived workflow directory is a strict descendant of ${cwd}/.tmp/sessions; DOCUMENT_WORKFLOW_DIR is not exported.`,
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
            `[session] DOCUMENT_WORKFLOW_DIR="${userPin}" was rejected (not a verified descendant of ${cwd}/.tmp/sessions) and the derived directory is used instead; \`cp -a\` handoffs and other consumers of $DOCUMENT_WORKFLOW_DIR will see ${resolution.relative}, not the pin.`,
          );
        }
      }

      if (workflowDirExportSkippedForUnsafeChars) {
        messages.push(
          "[session] DOCUMENT_WORKFLOW_DIR was not exported to CLAUDE_ENV_FILE: the resolved path contains a character unsafe for its double-quoted shell export.",
        );
      }

      messages.push(
        `warn-only mode: ${process.env.DOCUMENT_WORKFLOW_WARN_ONLY === "1" ? "on" : "off"}`,
      );

      if (context.input.cwd !== cwd) {
        messages.push(
          `cwd mismatch: context.input.cwd=${context.input.cwd} but process.cwd()=${cwd}.`,
        );
      }

      if (taskListWarning) {
        messages.push(taskListWarning);
      }
      const digestPreview = getUnreadDigestPreview();
      if (digestPreview) {
        messages.push(digestPreview);
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
