#!/usr/bin/env -S bun run --silent

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { defineHook } from "cc-hooks-ts";
import { logEvent } from "../lib/centralized-logging.ts";
import {
  countProse,
  findEnglishRequest,
  isEnglishProse,
} from "../lib/english-reply.ts";

const TRANSCRIPT_WINDOW_BYTES = 1024 * 1024;

const REASON =
  "直前の返答が英語でした。利用者は英語を指定していません。同じ内容を日本語で返答し直してください。コード・識別子・パス・引用は原文のままにします。";

/** Last 1 MiB of the transcript; "" when it cannot be read. */
function readTranscriptTail(path: string | undefined): string {
  if (!path) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_WINDOW_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const hook = defineHook({
  trigger: { Stop: true },
  run: (context) => {
    try {
      const { last_assistant_message, stop_hook_active, transcript_path } =
        context.input;

      // stop_hook_active is shared by every Stop hook, so this also stays
      // quiet on a re-entry caused by another hook. Accepted: it keeps this
      // hook from needing a counter file of its own.
      if (stop_hook_active) return context.success({});

      const message = last_assistant_message ?? "";
      if (!isEnglishProse(message)) return context.success({});

      // An unreadable transcript counts as "did not ask": a wrong block costs
      // one rewrite, a miss costs the user an English reply.
      if (findEnglishRequest(readTranscriptTail(transcript_path))) {
        return context.success({});
      }

      const { kana, latin } = countProse(message);
      const ratio = (kana / (kana + latin)).toFixed(3);
      logEvent(
        "Stop",
        context.input.session_id,
        `english-reply-gate: blocked (kana=${kana} latin=${latin} ratio=${ratio})`,
      );

      return context.json({
        event: "Stop",
        output: { decision: "block" as const, reason: REASON },
      });
    } catch (error) {
      console.error(`[english-reply-gate] Error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
