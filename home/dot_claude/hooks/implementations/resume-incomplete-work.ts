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
import "../types/tool-schemas.ts";

const MAX_RETRIES = 2;
const COUNTER_FILENAME = ".resume-incomplete-retries";
const MIN_MESSAGE_LENGTH = 20;

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

      const { last_assistant_message } = context.input;
      const retryCount = getRetryCount();

      if (retryCount >= MAX_RETRIES) {
        console.error(
          `[resume-incomplete-work] Max retries (${MAX_RETRIES}) reached. Allowing stop.`,
        );
        return context.success({});
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
