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
  summaryRemindedHash?: string;
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
];

const PLAN_STATUS_COMPLETE_REGEX = /^- Plan Status:\s*complete\s*$/m;
const APPROVAL_STATUS_APPROVED_REGEX = /^- Approval Status:\s*approved\s*$/m;

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
    const cache = readCache(cachePath);
    const canSkip =
      (existingMarker?.hash === planHash &&
        existingMarker.verdict.length > 0) ||
      cache?.planHash === planHash;
    if (canSkip) {
      if (
        isReviewCompletePendingApproval(
          planContent,
          planHash,
          existingMarker,
        ) &&
        cache?.summaryRemindedHash !== planHash
      ) {
        writeFileSync(
          cachePath,
          JSON.stringify(
            {
              planHash: cache?.planHash ?? planHash,
              recommendedAt: cache?.recommendedAt ?? new Date().toISOString(),
              summaryRemindedHash: planHash,
            } satisfies CacheState,
            null,
            2,
          ),
          "utf-8",
        );

        return context.json({
          event: "PostToolUse",
          output: {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: buildSummaryReminder(absoluteTargetPath),
            },
          },
        });
      }
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
  const allReviewerNames = [
    "logic-validator",
    "scope-justification-reviewer",
    "decision-quality-reviewer",
    "greenfield-perspective-reviewer",
  ];

  const lines = [
    "[plan-review-automation] plan.md was updated. Run sub-agent reviews before approval.",
    "",
    `Plan: ${planPath}`,
  ];
  if (researchPath) {
    lines.push(`Research: ${researchPath}`);
  }

  const alwaysOnLines = [
    "1. subagent_type: logic-validator — Check logical consistency, assumptions, and contradictions",
    "2. subagent_type: scope-justification-reviewer — Verify change justification, scope coherence, and near-term necessity",
    "3. subagent_type: decision-quality-reviewer — Detect dominant-axis misalignment in design decisions (Decision Quality framework)",
    "4. subagent_type: greenfield-perspective-reviewer — Reconstruct the order from a clean slate and surface ambition gaps the incremental plan dropped",
  ];

  lines.push(
    "",
    "IMPORTANT: ALL reviewers below are Agent tool subagent_types. Execute every one via Agent tool with the specified subagent_type. A reviewer having the same name as a Skill does NOT mean it should be invoked as a Skill — always use Agent tool.",
    "",
    "Recommended sub-agents (use Agent tool, run ALL in parallel):",
    ...alwaysOnLines,
  );

  if (additionalReviewers.length > 0) {
    for (let i = 0; i < additionalReviewers.length; i++) {
      const r = additionalReviewers[i]!;
      const shortName = r.subagentType.split(":").pop()!;
      allReviewerNames.push(shortName);
      lines.push(`${i + 5}. subagent_type: ${r.subagentType} — ${r.label}`);
    }
  }

  const reviewersValue = allReviewerNames.join("+");
  lines.push(
    "",
    "After reviews, update plan.md:",
    "- Set `- Review Status: pass|needs-work|blocker` in ## Approval section",
    `- Append \`<!-- auto-review: verdict=...; hash=...; at=...; reviewers=${reviewersValue} -->\` marker`,
    "",
    "THEN run /intent-alignment-triage to filter divergent findings that bend the original intent to reduce scope.",
    "Do NOT present review results to the user before completing the intent alignment triage.",
  );
  return lines.join("\n");
}

function isReviewCompletePendingApproval(
  planContent: string,
  planHash: string,
  marker: AutoReviewMarker | null,
): boolean {
  if (!marker || marker.verdict !== "pass" || marker.hash !== planHash) {
    return false;
  }
  if (!PLAN_STATUS_COMPLETE_REGEX.test(planContent)) {
    return false;
  }
  if (APPROVAL_STATUS_APPROVED_REGEX.test(planContent)) {
    return false;
  }
  return true;
}

function buildSummaryReminder(planPath: string): string {
  return [
    "[plan-review-automation] Review complete (verdict=pass). MANDATORY: Present Executive Summary to user before requesting approval.",
    "",
    `Plan: ${planPath}`,
    "",
    "You MUST present the following Executive Summary format in your next response to the user:",
    "",
    "## Executive Summary (Review Request)",
    "- **Goal**: <plan.md の目的を 1 行で>",
    "- **Proposed Approach**: <採用する方針の本質を 1-3 行で>",
    "- **Experience Delta**: <この変更で体験がどう変わるか。変更前→変更後の具体的な違いを 1-2 行で>",
    "- **Scope**: <変更予定ファイル/モジュールを最大5件>",
    "- **Key Decisions**: <採用した設計判断と、却下した代替案を1-2行ずつ>",
    "- **Risks / Unknowns**: <既知リスク・未検証の前提・影響範囲の広い箇所>",
    "- **Review Status**: verdict / reviewers / hash from auto-review marker",
    "- **Open Questions**: <ユーザー判断を仰ぎたい点（なければ N/A）>",
    "- **Next Action**: `Approval Status: approved` にしてください / 追加修正を依頼してください",
    "",
    "Fill each field from plan.md content. Do NOT skip any field (use N/A if not applicable).",
  ].join("\n");
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
  buildSummaryReminder,
  computePlanHash,
  extractTargetPath,
  extractLatestReviewMarker,
  isReviewCompletePendingApproval,
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
