#!/usr/bin/env -S bun run --silent

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { logQuality } from "../lib/centralized-logging.ts";
import "../types/tool-schemas.ts";

const REPLACEMENT_CHAR = "�";

const FILE_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit"]);

function getFilePath(
  tool_name: string,
  tool_input: Record<string, unknown>,
): string | null {
  if (!FILE_TOOL_NAMES.has(tool_name)) return null;
  return (
    (tool_input.file_path as string) || (tool_input.path as string) || null
  );
}

function findCorruptedLines(content: string): number[] {
  const lines: number[] = [];
  const contentLines = content.split("\n");
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.includes(REPLACEMENT_CHAR)) {
      lines.push(i + 1);
    }
  }
  return lines;
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: (context) => {
    const { tool_name, tool_input, session_id } = context.input;

    try {
      const filePath = getFilePath(
        tool_name,
        tool_input as Record<string, unknown>,
      );
      if (!filePath) return context.success({});

      const resolved = resolve(filePath);
      if (!existsSync(resolved)) return context.success({});

      const content = readFileSync(resolved, "utf-8");
      if (!content.includes(REPLACEMENT_CHAR)) return context.success({});

      const corruptedLines = findCorruptedLines(content);
      const lineList = corruptedLines.slice(0, 10).join(", ");
      const truncated =
        corruptedLines.length > 10
          ? ` (and ${corruptedLines.length - 10} more)`
          : "";

      const message = `Unicode replacement character (U+FFFD) detected in ${filePath} at line(s): ${lineList}${truncated}. This indicates a Unicode decoding failure — the original text was corrupted. Fix these characters with the correct text.`;

      logQuality(
        "quality-loop",
        "unicode-corruption-guard",
        message,
        session_id,
        filePath,
      );

      return context.json({
        event: "PostToolUse",
        output: {
          hookSpecificOutput: {
            hookEventName: "PostToolUse" as const,
            additionalContext: message,
          },
        },
      });
    } catch {
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
