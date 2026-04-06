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

interface ReviewerRule {
  subagentType: string;
  label: string;
  keywords: string[];
  priority: number;
}

const MAX_ADDITIONAL_REVIEWERS = 3;

const REVIEWER_CATALOG: ReviewerRule[] = [
  {
    subagentType: "compound-engineering:review:architecture-strategist",
    label: "Architecture pattern compliance",
    keywords: [
      "architecture",
      "module",
      "layer",
      "dependency",
      "boundary",
      "service",
      "component",
      "アーキテクチャ",
      "モジュール",
      "レイヤー",
      "依存",
      "境界",
      "サービス",
      "コンポーネント",
    ],
    priority: 1,
  },
  {
    subagentType: "compound-engineering:review:security-sentinel",
    label: "Security audit",
    keywords: [
      "security",
      "auth",
      "token",
      "credential",
      "injection",
      "xss",
      "csrf",
      "permission",
      "secret",
      "セキュリティ",
      "認証",
      "認可",
      "トークン",
      "権限",
      "脆弱性",
    ],
    priority: 1,
  },
  {
    subagentType: "compound-engineering:review:data-integrity-guardian",
    label: "Data model and migration safety",
    keywords: [
      "database",
      "migration",
      "schema",
      "table",
      "column",
      "index",
      "query",
      "sql",
      "データベース",
      "マイグレーション",
      "スキーマ",
      "テーブル",
      "カラム",
    ],
    priority: 2,
  },
  {
    subagentType: "compound-engineering:review:performance-oracle",
    label: "Performance and scalability",
    keywords: [
      "performance",
      "optimization",
      "cache",
      "latency",
      "scalability",
      "n+1",
      "bottleneck",
      "パフォーマンス",
      "最適化",
      "キャッシュ",
      "レイテンシ",
      "スケーラビリティ",
    ],
    priority: 2,
  },
  {
    subagentType: "resilience-analyzer",
    label: "Fault tolerance and resilience",
    keywords: [
      "resilience",
      "retry",
      "circuit breaker",
      "fault tolerance",
      "timeout",
      "fallback",
      "recovery",
      "リトライ",
      "タイムアウト",
      "フォールバック",
      "障害耐性",
      "復旧",
    ],
    priority: 3,
  },
  {
    subagentType: "test-quality-evaluator",
    label: "Test quality and coverage",
    keywords: [
      "test coverage",
      "regression",
      "tdd",
      "test strategy",
      "test plan",
      "テストカバレッジ",
      "リグレッション",
      "テスト戦略",
    ],
    priority: 3,
  },
  {
    subagentType: "deployment-readiness-evaluator",
    label: "Deployment safety",
    keywords: [
      "deploy",
      "release",
      "ci/cd",
      "rollback",
      "infrastructure",
      "pipeline",
      "デプロイ",
      "リリース",
      "ロールバック",
      "パイプライン",
    ],
    priority: 3,
  },
  {
    subagentType: "compound-engineering:review:code-simplicity-reviewer",
    label: "YAGNI and simplification",
    keywords: [
      "refactor",
      "simplify",
      "cleanup",
      "abstraction",
      "complexity",
      "technical debt",
      "リファクタリング",
      "簡素化",
      "抽象化",
      "技術的負債",
    ],
    priority: 3,
  },
];

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
      planContent,
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
  planContent: string,
): string {
  const additionalReviewers = selectReviewers(planContent);
  const allReviewerNames = ["logic-validator"];

  const lines = [
    "[plan-review-automation] plan.md was updated. Run sub-agent reviews before approval.",
    "",
    `Plan: ${planPath}`,
  ];
  if (researchPath) {
    lines.push(`Research: ${researchPath}`);
  }

  if (additionalReviewers.length > 0) {
    lines.push(
      "",
      "Recommended sub-agents (use Agent tool, run ALL in parallel):",
      "1. subagent_type: logic-validator — Check logical consistency, assumptions, and contradictions",
    );
    for (let i = 0; i < additionalReviewers.length; i++) {
      const r = additionalReviewers[i]!;
      const shortName = r.subagentType.split(":").pop()!;
      allReviewerNames.push(shortName);
      lines.push(`${i + 2}. subagent_type: ${r.subagentType} — ${r.label}`);
    }
  } else {
    lines.push(
      "",
      "Recommended sub-agent (use Agent tool):",
      "1. subagent_type: logic-validator — Check logical consistency, assumptions, and contradictions",
    );
  }

  const reviewersValue = allReviewerNames.join("+");
  lines.push(
    "",
    "After reviews, update plan.md:",
    "- Set `- Review Status: pass|needs-work|blocker` in ## Approval section",
    `- Append \`<!-- auto-review: verdict=...; hash=...; at=...; reviewers=${reviewersValue} -->\` marker`,
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

function normalizeForHash(content: string): string {
  return content
    .replace(REVIEW_MARKER_REGEX, "")
    .replace(/^(- Approval Status:)\s*.*$/m, "$1")
    .replace(/^(\s*- )\[x\]/gm, "$1[ ]")
    .trimEnd();
}

function computePlanHash(planContent: string): string {
  return hashText(normalizeForHash(planContent));
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

function stripApprovalSection(content: string): string {
  const approvalIndex = content.indexOf("## Approval");
  if (approvalIndex === -1) {
    return content;
  }
  return content.slice(0, approvalIndex);
}

function selectReviewers(planContent: string): ReviewerRule[] {
  const body = stripApprovalSection(stripReviewMarkers(planContent));
  const lowerBody = body.toLowerCase();

  const matched = REVIEWER_CATALOG.filter((rule) =>
    rule.keywords.some((kw) => lowerBody.includes(kw.toLowerCase())),
  );

  matched.sort((a, b) => a.priority - b.priority);
  return matched.slice(0, MAX_ADDITIONAL_REVIEWERS);
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
  buildRecommendation,
  computePlanHash,
  extractTargetPath,
  extractLatestReviewMarker,
  isPlanFile,
  normalizeForHash,
  REVIEWER_CATALOG,
  selectReviewers,
  stripReviewMarkers,
};

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
