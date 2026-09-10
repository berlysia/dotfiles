#!/usr/bin/env -S bun run --silent

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import { resolveWorkflowDir } from "../lib/workflow-resolve.ts";
import "../types/tool-schemas.ts";

const MAX_RETRIES = 2;
const COUNTER_FILENAME = ".resume-incomplete-retries";
const MIN_MESSAGE_LENGTH = 20;

// K7: a turn-ending line that declares an action ("...を走らせます。",
// "Let me run the tests.") without doing it. Matched against the LAST
// non-empty line only — matching anywhere in the message would flag mid-task
// sentences and URLs/code containing these words (spec K7 security 11).
const ANNOUNCE_ENDING_JA_REGEX =
  /(走らせ|実行し|反映し|直し|進め|着手し|書き|開始し|回し|起動し|更新し)ます[。.!]?$/;
const ANNOUNCE_ENDING_EN_REGEX = /^(I('ll| will)|Let me) .*\.$/;
// Presence of a wait-word anywhere in the last line means the model already
// named what it's waiting on for a human — not an unqualified announcement.
const WAIT_WORD_REGEX = /(承認|approve|待ち|判断を)/i;
const TRAILING_QUESTION_REGEX = /[?？]\s*$/;

function lastNonEmptyLine(message: string): string | null {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * True when the message ends on a bare declaration of intent: the last
 * non-empty line matches a declaration ending and carries no wait-word and
 * no trailing question mark.
 */
function isAnnounceOnly(message: string): boolean {
  const last = lastNonEmptyLine(message);
  if (!last) return false;
  const declares =
    ANNOUNCE_ENDING_JA_REGEX.test(last) || ANNOUNCE_ENDING_EN_REGEX.test(last);
  if (!declares) return false;
  if (WAIT_WORD_REGEX.test(last) || TRAILING_QUESTION_REGEX.test(last)) {
    return false;
  }
  return true;
}

function getCounterPath(): string {
  return join(process.cwd(), ".tmp", COUNTER_FILENAME);
}

function getRetryCount(): number {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) {
      const content = readFileSync(counterPath, "utf-8").trim();
      const count = Number.parseInt(content, 10);
      return Number.isNaN(count) ? 0 : count;
    }
  } catch {
    // ignore read errors
  }
  return 0;
}

function incrementRetryCount(): number {
  const counterPath = getCounterPath();
  const newCount = getRetryCount() + 1;
  try {
    const dir = dirname(counterPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(counterPath, String(newCount), "utf-8");
  } catch {
    // ignore write errors
  }
  return newCount;
}

function resetRetryCount(): void {
  const counterPath = getCounterPath();
  try {
    if (existsSync(counterPath)) unlinkSync(counterPath);
  } catch {
    // ignore unlink errors
  }
}

/**
 * True when this session's workflow dir exists and holds research.md — the
 * announce-then-stop branch only fires mid-Document-Workflow (spec K7); a
 * session with no active workflow has nothing this check should react to.
 */
function workflowHasResearch(sessionId: string): boolean {
  const cwd = process.env.CLAUDE_TEST_CWD || process.cwd();
  const resolution = resolveWorkflowDir({ cwd, sessionId });
  if (resolution.source === "unresolvable") {
    return false;
  }
  return existsSync(resolveWorkflowPaths(resolution.dir).research);
}

const hook = defineHook({
  trigger: { Stop: true, UserPromptSubmit: true },
  run: (context) => {
    try {
      // 新しいユーザー入力 = 新しいターン。カウンタを reset しないと
      // 一度 MAX に到達した時点で永続無効化される（mtime が数週間前のまま
      // MAX 値で固着し全プロジェクトでフックが死んでいた事例あり）。
      if (context.input.hook_event_name === "UserPromptSubmit") {
        resetRetryCount();
        return context.success({});
      }

      const { last_assistant_message, stop_hook_active } = context.input;
      const retryCount = getRetryCount();

      if (retryCount >= MAX_RETRIES) {
        console.error(
          `[resume-incomplete-work] Max retries (${MAX_RETRIES}) reached. Allowing stop.`,
        );
        return context.success({});
      }

      // K7 announce-then-stop: inserted ahead of the short-message allow path
      // below, since a long declarative message ("...を走らせます。") passes
      // that path today even though it ends the turn without acting or naming
      // what it is waiting on. stop_hook_active always allows (this hook is
      // itself re-invoked on the resulting Stop; do not re-block it).
      if (
        !stop_hook_active &&
        isAnnounceOnly(last_assistant_message ?? "") &&
        workflowHasResearch(context.input.session_id)
      ) {
        const count = incrementRetryCount();
        const remaining = MAX_RETRIES - count;
        const lastLine = lastNonEmptyLine(last_assistant_message ?? "") ?? "";
        return context.json({
          event: "Stop",
          output: {
            decision: "block" as const,
            reason: `This turn ended on a declaration of intent ("${lastLine.slice(0, 80)}") with no wait-word. Either execute the declared action within this turn, or state explicitly what a human needs to decide before you continue. (attempt ${count}/${MAX_RETRIES}, ${remaining} remaining)`,
          },
        });
      }

      const message = last_assistant_message?.trim() ?? "";

      // モデルが substantive なテキストを返して end_turn したなら
      // 「ターンを終える意思」は表明済み。長さ判定一本で trust する。
      // 旧実装は「完了文言」regex (しました/してください/ご確認ください 等)
      // で再判定していたが、これらは mid-task 文に頻出するため heuristic
      // としての信頼性が低く、実質的に noise だった。
      if (message.length >= MIN_MESSAGE_LENGTH) {
        return context.success({});
      }

      // 空 or 極短文だけが「沈黙落ち」の真のシグナル
      // (典型: tool_use 直後にテキストなしで end_turn)
      const count = incrementRetryCount();
      const remaining = MAX_RETRIES - count;

      const reason =
        message.length === 0
          ? "You stopped without any message. The task may be incomplete. Review the original request and either continue working or explain what was completed and what remains."
          : `You stopped with a very brief message ("${message.slice(0, 60)}"). The task may be incomplete. Review the original request and either continue working or provide a clear completion summary. (attempt ${count}/${MAX_RETRIES}, ${remaining} remaining)`;

      return context.json({
        event: "Stop",
        output: {
          decision: "block" as const,
          reason,
        },
      });
    } catch (error) {
      console.error(`[resume-incomplete-work] Error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
