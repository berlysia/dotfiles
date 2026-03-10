#!/usr/bin/env -S bun run --silent

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { defineHook } from "cc-hooks-ts";
import { logReflection } from "../lib/centralized-logging.ts";
import type {
  QualityLogEntry,
  ReflectionEntry,
} from "../types/logging-types.ts";
import "../types/tool-schemas.ts";

const LOG_DIR = join(process.env.HOME || "", ".claude", "logs");
const REFLECTION_NUDGE_THRESHOLD = 5;

const SYSTEM_PROMPT = `You analyze test/typecheck failures from an AI coding agent session to identify preventable patterns.

RULES:
- Respond with ONLY a JSON object, no other text
- Each reflection should be 2-3 sentences max
- Complete within 3 turns
- Do NOT use any tools

For each error, determine:
1. What code pattern caused the failure
2. Whether a linter rule could catch it BEFORE tests/typecheck run
3. If preventable, suggest a rule type and description

RESPONSE FORMAT:
{
  "reflections": [
    {
      "error_summary": "brief description of the error",
      "root_cause": "what code pattern caused it",
      "preventable_by_lint": true/false,
      "suggested_rule": {
        "type": "custom-rule|oxlint-config|oxfmt-config|eslint-plugin",
        "description": "what the rule should check",
        "pattern_hint": "regex or code pattern hint"
      }
    }
  ]
}

If preventable_by_lint is false, omit suggested_rule.
If no errors are preventable, return {"reflections": []} with each having preventable_by_lint: false.`;

function readQualityLogs(sessionId: string): QualityLogEntry[] {
  const entries: QualityLogEntry[] = [];
  const qualityFile = join(LOG_DIR, "quality.jsonl");

  try {
    const content = readFileSync(qualityFile, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as QualityLogEntry;
        if (
          entry.session_id === sessionId &&
          entry.source === "completion-gate"
        ) {
          entries.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file doesn't exist yet
  }

  return entries;
}

function countReflections(): number {
  let count = 0;

  try {
    const files = readdirSync(LOG_DIR).filter(
      (f) => f === "reflections.jsonl" || f.startsWith("reflections.jsonl."),
    );
    for (const file of files) {
      try {
        const content = readFileSync(join(LOG_DIR, file), "utf-8");
        count += content.split("\n").filter(Boolean).length;
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // log dir doesn't exist
  }

  return count;
}

async function reflectWithLLM(
  errors: QualityLogEntry[],
): Promise<ReflectionEntry[]> {
  const errorSummary = errors
    .map((e) => `[${e.lint_tool}] ${e.error_output}`)
    .join("\n---\n");

  const userPrompt = `Analyze these ${errors.length} test/typecheck failures from an AI agent session:\n\n${errorSummary}`;

  try {
    const conversation = query({
      prompt: userPrompt,
      options: {
        model: "haiku",
        maxTurns: 10,
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });

    let responseText = "";
    for await (const message of conversation) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText += block.text;
          }
        }
      } else if (message.type === "result") {
        if (message.subtype === "success" && message.result) {
          responseText = message.result;
        }
      }
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const result = JSON.parse(jsonMatch[0]) as {
      reflections: ReflectionEntry[];
    };
    return result.reflections || [];
  } catch (error) {
    console.error(`[stop-reflection] LLM error: ${error}`);
    return [];
  }
}

const hook = defineHook({
  trigger: { Stop: true },
  run: async (context) => {
    try {
      const { session_id } = context.input;

      const completionGateErrors = readQualityLogs(session_id);
      if (completionGateErrors.length === 0) {
        return context.success({});
      }

      const reflections = await reflectWithLLM(completionGateErrors);

      if (reflections.length > 0) {
        logReflection(completionGateErrors.length, reflections, session_id);
      }

      const totalReflections = countReflections();
      if (totalReflections >= REFLECTION_NUDGE_THRESHOLD) {
        return context.success({
          messageForUser:
            `[stop-reflection] ${reflections.length} failure pattern(s) analyzed.\n` +
            `${totalReflections} reflections accumulated. Run /analyze-mistakes to discover rule candidates.`,
        });
      }

      return context.success({});
    } catch (error) {
      console.error(`[stop-reflection] Error: ${error}`);
      return context.success({});
    }
  },
});

export default hook;

export {
  readQualityLogs,
  countReflections,
  SYSTEM_PROMPT,
  REFLECTION_NUDGE_THRESHOLD,
};

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
