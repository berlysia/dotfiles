#!/usr/bin/env -S bun run --silent

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function looksLikeCompletion(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) return false;

  const lastLines = trimmed
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-3)
    .join("\n")
    .toLowerCase();

  const completionSignals = [
    /完了/,
    /以上/,
    /finished/,
    /done/,
    /complete[ds]?\b/,
    /まとめ/,
    /次のステップ/,
    /next\s*step/,
    /お知らせください/,
    /let me know/,
    /質問.*あれば/,
    /if you have.*question/,
    /ご確認ください/,
    /please review/,
    /しました/,
    /済み/,
    /残作業/,
    /remaining/,
    /承認/,
    /approve/,
    /Approval Status/,
    /Executive Summary/,
    /Next Action/,
    /してください/,
  ];

  return completionSignals.some((pattern) => pattern.test(lastLines));
}

const hook = defineHook({
  trigger: { Stop: true },
  run: (context) => {
    try {
      const { last_assistant_message } = context.input;
      const retryCount = getRetryCount();

      if (retryCount >= MAX_RETRIES) {
        console.error(
          `[resume-incomplete-work] Max retries (${MAX_RETRIES}) reached. Allowing stop.`,
        );
        return context.success({});
      }

      const message = last_assistant_message?.trim() ?? "";

      if (
        message.length >= MIN_MESSAGE_LENGTH &&
        looksLikeCompletion(message)
      ) {
        return context.success({});
      }

      const count = incrementRetryCount();
      const remaining = MAX_RETRIES - count;

      const reason =
        message.length === 0
          ? "You stopped without any message. The task may be incomplete. Review the original request and either continue working or explain what was completed and what remains."
          : `You stopped with a very brief or non-conclusive message. The task may be incomplete. Review the original request and either continue working or provide a clear completion summary. (attempt ${count}/${MAX_RETRIES}, ${remaining} remaining)`;

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
