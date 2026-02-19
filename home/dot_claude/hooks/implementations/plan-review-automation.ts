#!/usr/bin/env -S bun run --silent

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { expandTilde } from "../lib/path-utils.ts";
import "../types/tool-schemas.ts";

type Severity = "P0" | "P1" | "P2";
type Verdict = "pass" | "needs-work" | "blocker";

interface Finding {
  severity: Severity;
  title: string;
  detail: string;
  suggestion: string;
}

interface ReviewerResult {
  reviewer: string;
  score: number;
  summary: string;
  findings: Finding[];
}

interface ReviewReport {
  planPath: string;
  reviewedAt: string;
  model: string;
  verdict: Verdict;
  reviewers: ReviewerResult[];
}

interface CacheState {
  planHash: string;
  reviewedAt: string;
}

interface ReviewerSpec {
  name: string;
  focus: string;
}

interface AutoReviewMarker {
  verdict: string;
  hash: string;
}

const SYSTEM_PROMPT = `You are an automated plan reviewer.

You MUST return ONLY a JSON object with this exact shape:
{
  "score": 1-5,
  "summary": "string",
  "findings": [
    {
      "severity": "P0|P1|P2",
      "title": "string",
      "detail": "string",
      "suggestion": "string"
    }
  ]
}

Rules:
- No markdown output.
- Score 5 means excellent, 1 means unsafe.
- If no meaningful issue exists, return empty findings array.
- Focus on concrete, actionable findings only.`;

const REVIEWERS: ReviewerSpec[] = [
  {
    name: "logic-validator",
    focus:
      "Check logical consistency, missing verification steps, incorrect assumptions, and contradiction between goals and tasks.",
  },
  {
    name: "architecture-boundary-analyzer",
    focus:
      "Check architecture boundaries, dependency direction, coupling risks, and contract design issues in the plan.",
  },
  {
    name: "release-safety-evaluator",
    focus:
      "Check release safety: test strategy, rollback readiness, rollout controls, and operational risks.",
  },
];

const TARGET_TOOL_NAMES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const REVIEW_MARKER_REGEX = /<!--\s*auto-review:[^>]*-->/g;
const REVIEW_STATUS_REGEX = /^- Review Status:\s*(pending|pass|needs-work|blocker)\s*$/m;

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
    if (!isPlanPath(absoluteTargetPath)) {
      return context.success({});
    }

    if (!existsSync(absoluteTargetPath)) {
      return context.success({});
    }

    const planContent = readFileSync(absoluteTargetPath, "utf-8");
    const planHash = computePlanHash(planContent);
    const existingMarker = extractLatestReviewMarker(planContent);

    const outputDir = resolve(baseDir, ".tmp");
    mkdirSync(outputDir, { recursive: true });
    const cachePath = resolve(outputDir, "plan-review.cache.json");
    const markdownPath = resolve(outputDir, "plan-review.md");
    const jsonPath = resolve(outputDir, "plan-review.json");

    const previousCache = readCache(cachePath);
    const canSkipByCache =
      previousCache?.planHash === planHash &&
      existingMarker?.hash === planHash &&
      existingMarker.verdict.length > 0;
    if (canSkipByCache) {
      return context.success({});
    }

    const model = process.env.PLAN_REVIEW_MODEL || "haiku";

    try {
      const reviewerResults = await Promise.all(
        REVIEWERS.map((reviewer) =>
          runReviewer(reviewer, planContent, absoluteTargetPath, model),
        ),
      );

      const reviewedAt = new Date().toISOString();
      const report: ReviewReport = {
        planPath: absoluteTargetPath,
        reviewedAt,
        model,
        verdict: decideVerdict(reviewerResults),
        reviewers: reviewerResults,
      };

      const withReviewStatus = upsertReviewStatus(planContent, report.verdict);
      const nextPlanHash = computePlanHash(withReviewStatus);
      const marker = buildReviewMarker(report, nextPlanHash);
      const updatedPlan = upsertReviewMarker(withReviewStatus, marker);
      if (updatedPlan !== planContent) {
        writeFileSync(absoluteTargetPath, updatedPlan, "utf-8");
      }

      writeFileSync(markdownPath, buildReviewMarkdown(report), "utf-8");
      writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
      writeFileSync(
        cachePath,
        JSON.stringify({ planHash: nextPlanHash, reviewedAt } satisfies CacheState, null, 2),
        "utf-8",
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[plan-review-automation] failed: ${reason}`);
    }

    return context.success({});
  },
});

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

function isPlanPath(path: string): boolean {
  return path.endsWith("/plan.md");
}

function extractTargetPath(toolName: string, toolInput: unknown): string | null {
  if (!isRecord(toolInput)) {
    return null;
  }

  if (
    (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") &&
    typeof toolInput.file_path === "string"
  ) {
    return toolInput.file_path;
  }

  if (toolName === "NotebookEdit" && typeof toolInput.notebook_path === "string") {
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
      typeof parsed.reviewedAt === "string"
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function runReviewer(
  reviewer: ReviewerSpec,
  planContent: string,
  planPath: string,
  model: string,
): Promise<ReviewerResult> {
  const userPrompt = createReviewerPrompt(reviewer, planContent, planPath);
  const response = await queryReviewer(userPrompt, model);
  return parseReviewerResult(reviewer.name, response);
}

function createReviewerPrompt(
  reviewer: ReviewerSpec,
  planContent: string,
  planPath: string,
): string {
  return [
    `Reviewer: ${reviewer.name}`,
    `Focus: ${reviewer.focus}`,
    `Plan Path: ${planPath}`,
    "",
    "Review this implementation plan:",
    "<plan>",
    planContent,
    "</plan>",
  ].join("\n");
}

async function queryReviewer(prompt: string, model: string): Promise<string> {
  const conversation = query({
    prompt,
    options: {
      model,
      maxTurns: 1,
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
    } else if (
      message.type === "result" &&
      message.subtype === "success" &&
      message.result
    ) {
      responseText = message.result;
    }
  }

  return responseText;
}

function parseReviewerResult(reviewer: string, response: string): ReviewerResult {
  const fallback: ReviewerResult = {
    reviewer,
    score: 2,
    summary:
      "Reviewer response could not be parsed. Treat this as needs-work and run manual review.",
    findings: [
      {
        severity: "P1",
        title: "Review parse failure",
        detail:
          "Automated reviewer did not return valid JSON. Validation quality is unknown.",
        suggestion:
          "Run manual /self-review and /validate-plan before approving the plan.",
      },
    ],
  };

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const score = normalizeScore(parsed.score);
    const summary =
      typeof parsed.summary === "string" && parsed.summary.length > 0
        ? parsed.summary
        : "No summary provided.";
    const findings = normalizeFindings(parsed.findings);

    return {
      reviewer,
      score,
      summary,
      findings,
    };
  } catch {
    return fallback;
  }
}

function normalizeScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 3;
  }
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded;
}

function normalizeFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const findings: Finding[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const severity = normalizeSeverity(item.severity);
    if (!severity) {
      continue;
    }
    const title = typeof item.title === "string" ? item.title : "";
    const detail = typeof item.detail === "string" ? item.detail : "";
    const suggestion =
      typeof item.suggestion === "string" ? item.suggestion : "";
    if (title.length === 0 || detail.length === 0) {
      continue;
    }
    findings.push({ severity, title, detail, suggestion });
  }
  return findings;
}

function normalizeSeverity(value: unknown): Severity | null {
  if (value === "P0" || value === "P1" || value === "P2") {
    return value;
  }
  return null;
}

function decideVerdict(results: ReviewerResult[]): Verdict {
  const severities = results.flatMap((result) =>
    result.findings.map((finding) => finding.severity),
  );
  if (severities.includes("P0")) {
    return "blocker";
  }
  if (severities.includes("P1")) {
    return "needs-work";
  }
  return "pass";
}

function buildReviewMarker(report: ReviewReport, planHash: string): string {
  const reviewers = report.reviewers.map((reviewer) => reviewer.reviewer).join(",");
  return `<!-- auto-review: verdict=${report.verdict}; hash=${planHash}; at=${report.reviewedAt}; reviewers=${reviewers} -->`;
}

function upsertReviewMarker(planContent: string, marker: string): string {
  const withoutMarker = stripReviewMarkers(planContent).trimEnd();
  return `${withoutMarker}\n\n${marker}\n`;
}

function upsertReviewStatus(planContent: string, verdict: Verdict): string {
  const statusLine = `- Review Status: ${verdict}`;
  const withoutMarker = stripReviewMarkers(planContent);
  if (REVIEW_STATUS_REGEX.test(withoutMarker)) {
    return withoutMarker.replace(REVIEW_STATUS_REGEX, statusLine);
  }

  const lines = withoutMarker.split("\n");
  const approvalIndex = lines.findIndex((line) => line.trim() === "## Approval");
  if (approvalIndex === -1) {
    return withoutMarker;
  }

  let insertIndex = approvalIndex + 1;
  for (let i = approvalIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== "string") {
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      break;
    }
    if (trimmed.startsWith("- Plan Status:")) {
      insertIndex = i + 1;
      break;
    }
  }

  lines.splice(insertIndex, 0, statusLine);
  return lines.join("\n");
}

function buildReviewMarkdown(report: ReviewReport): string {
  const lines: string[] = [];
  lines.push("# Automated Plan Review");
  lines.push("");
  lines.push(`- Plan: \`${report.planPath}\``);
  lines.push(`- Reviewed At: ${report.reviewedAt}`);
  lines.push(`- Model: ${report.model}`);
  lines.push(`- Verdict: **${report.verdict}**`);
  lines.push("");

  for (const reviewer of report.reviewers) {
    lines.push(`## ${reviewer.reviewer}`);
    lines.push(`- Score: ${reviewer.score}/5`);
    lines.push(`- Summary: ${reviewer.summary}`);
    lines.push("");

    if (reviewer.findings.length === 0) {
      lines.push("- Findings: none");
      lines.push("");
      continue;
    }

    lines.push("### Findings");
    for (const finding of reviewer.findings) {
      lines.push(`- [${finding.severity}] ${finding.title}`);
      lines.push(`  - Detail: ${finding.detail}`);
      if (finding.suggestion.length > 0) {
        lines.push(`  - Suggestion: ${finding.suggestion}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export {
  buildReviewMarkdown,
  buildReviewMarker,
  computePlanHash,
  decideVerdict,
  extractTargetPath,
  extractLatestReviewMarker,
  isPlanPath,
  parseReviewerResult,
  stripReviewMarkers,
  upsertReviewMarker,
  upsertReviewStatus,
};

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
