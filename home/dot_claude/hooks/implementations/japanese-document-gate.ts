#!/usr/bin/env -S bun run --silent

import { gate } from "../lib/japanese-document-gate/gate.ts";
import { gitDocumentCandidates } from "../lib/japanese-document-gate/discovery.ts";
import { object } from "../lib/japanese-document-gate/shared.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";

if (import.meta.main) {
  let input: unknown;
  try {
    const raw = await readStdinLimited(1024 * 1024, 2000);
    if (raw === null) throw new Error("フック入力を読めませんでした。");
    input = JSON.parse(raw);
    const output = gate(input, {
      candidates: (cwd) => {
        // Avoid invoking git on non-repositories without hiding other failures.
        try {
          return gitDocumentCandidates(cwd);
        } catch (error) {
          if (
            object(error) &&
            typeof error.stderr === "string" &&
            error.stderr.includes("not a git repository")
          )
            return [];
          console.error("[japanese-document-gate] git discovery failed", error);
          throw error;
        }
      },
    });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    else if (object(input) && input.hook_event_name === "Stop")
      process.stdout.write("{}\n");
  } catch (error) {
    console.error("[japanese-document-gate]", error);
    const reason =
      "日本語文書の検査状態を確認できませんでした。エラーを解消するか、未検証の草稿であることを報告してください。";
    process.stdout.write(
      `${JSON.stringify(
        object(input) && input.hook_event_name === "Stop"
          ? { decision: "block", reason }
          : { systemMessage: reason },
      )}\n`,
    );
  }
}
