#!/usr/bin/env -S bun run --silent

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { expandTilde } from "../lib/path-utils.ts";
import { isPlanFile, resolveWorkflowPaths } from "../lib/workflow-paths.ts";
import "../types/tool-schemas.ts";

interface CacheState {
  planHash: string;
  recommendedAt: string;
}

interface AutoReviewMarker {
  verdict: string;
  hash: string;
}

const TARGET_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);
const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    const { tool_name, tool_input, cwd } = context.input;
    if (!TARGET_TOOL_NAMES.has(tool_name)) {
      return context.success({});
    }

    const baseDir = getWorkingDirectory(cwd);
    const targetPath = extractTargetPath(tool_name, tool_input);
    if (!targetPath) {
      return context.success({});
    }

    const absoluteTargetPath = normalizePath(baseDir, targetPath);
    if (!isPlanFile(absoluteTargetPath)) {
      return context.success({});
    }

    if (!existsSync(absoluteTargetPath)) {
      return context.success({});
    }

    const planContent = readFileSync(absoluteTargetPath, "utf-8");
    const planHash = computePlanHash(planContent);
    const existingMarker = extractLatestReviewMarker(planContent);

    // Co-locate cache with the plan file itself
    const planDir = dirname(absoluteTargetPath);
    mkdirSync(planDir, { recursive: true });
    const { reviewCache: cachePath } = resolveWorkflowPaths(planDir);

    // Skip if already reviewed for this content hash
    const canSkip =
      (existingMarker?.hash === planHash &&
        existingMarker.verdict.length > 0) ||
      readCache(cachePath)?.planHash === planHash;
    if (canSkip) {
      return context.success({});
    }

    // Record that we recommended review for this hash (prevents repeated prompts)
    writeFileSync(
      cachePath,
      JSON.stringify(
        {
          planHash,
          recommendedAt: new Date().toISOString(),
        } satisfies CacheState,
        null,
        2,
      ),
      "utf-8",
    );

    // Check if sibling research.md exists
    const { research: researchPath } = resolveWorkflowPaths(planDir);
    const hasResearch = existsSync(researchPath);

    const additionalContext = buildRecommendation(
      absoluteTargetPath,
      hasResearch ? researchPath : null,
    );

    return context.json({
      event: "PostToolUse",
      output: {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext,
        },
      },
    });
  },
});

function buildRecommendation(
  planPath: string,
  researchPath: string | null,
): string {
  const lines = [
    "[plan-review-automation] plan.md was updated. Run sub-agent reviews before approval.",
    "",
    `Plan: ${planPath}`,
  ];
  if (researchPath) {
    lines.push(`Research: ${researchPath}`);
  }
  lines.push(
    "",
    "Recommended sub-agent (use Task tool):",
    "1. subagent_type: logic-validator — Check logical consistency, assumptions, and contradictions",
    "",
    "After reviews, update plan.md:",
    "- Set `- Review Status: pass|needs-work|blocker` in ## Approval section",
    "- Append `<!-- auto-review: verdict=...; hash=...; at=...; reviewers=... -->` marker",
  );
  return lines.join("\n");
}

function getWorkingDirectory(cwd: string | undefined): string {
  if (process.env.CLAUDE_TEST_CWD) {
    return process.env.CLAUDE_TEST_CWD;
  }
  if (typeof cwd === "string" && cwd.length > 0) {
    return cwd;
  }
  return process.cwd();
}

function normalizePath(cwd: string, path: string): string {
  return resolve(cwd, expandTilde(path));
}

function extractTargetPath(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  if (
    (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
    typeof toolInput.file_path === "string"
  ) {
    return toolInput.file_path;
  }

  if (
    toolName === "NotebookEdit" &&
    typeof toolInput.notebook_path === "string"
  ) {
    return toolInput.notebook_path;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function stripReviewMarkers(content: string): string {
  return content.replace(REVIEW_MARKER_REGEX, "").trimEnd();
}

function computePlanHash(planContent: string): string {
  return hashText(stripReviewMarkers(planContent));
}

function extractLatestReviewMarker(content: string): AutoReviewMarker | null {
  const matches = content.match(REVIEW_MARKER_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }

  const latest = matches[matches.length - 1];
  if (!latest) {
    return null;
  }

  let verdict = "";
  let hash = "";
  for (const part of latest.matchAll(/(\w+)=([^;]+)/g)) {
    const key = part[1]?.trim();
    const value = part[2]?.trim();
    if (!key || !value) {
      continue;
    }
    if (key === "verdict") {
      verdict = value;
    }
    if (key === "hash") {
      hash = value;
    }
  }

  if (verdict.length === 0 || hash.length === 0) {
    return null;
  }

  return { verdict, hash };
}

function readCache(path: string): CacheState | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheState;
    if (
      typeof parsed.planHash === "string" &&
      typeof parsed.recommendedAt === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export {
  computePlanHash,
  extractTargetPath,
  extractLatestReviewMarker,
  isPlanFile,
  stripReviewMarkers,
};

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
