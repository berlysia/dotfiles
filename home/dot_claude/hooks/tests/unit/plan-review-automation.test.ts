#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALWAYS_ON_REVIEWERS,
  PLAN_NORMALIZERS,
  PLAN_REVIEWERS,
  SPEC_NORMALIZERS,
  SPEC_REVIEWERS,
  buildRecommendation,
  buildSummaryReminder,
  computeDocumentHash,
  computePlanHash,
  extractLatestReviewMarker,
  extractTargetPath,
  getWorkflowDocumentType,
  isPlanFile,
  isReviewCompletePendingApproval,
  isWorkflowDocument,
  normalizeForHash,
  normalizersForDocumentType,
  REVIEWER_CATALOG,
  reviewersForDocumentType,
  selectReviewers,
  stripReviewMarkers,
} from "../../implementations/plan-review-automation.ts";

describe("plan-review-automation.ts helpers", () => {
  it("isPlanFile detects plan.md in any directory", () => {
    strictEqual(isPlanFile("/tmp/plan.md"), true);
    strictEqual(isPlanFile("/project/.tmp/sessions/abcd1234/plan.md"), true);
    strictEqual(isPlanFile("/tmp/plan.mdx"), false);
    strictEqual(isPlanFile("/project/src/app.ts"), false);
  });

  it("extractTargetPath reads file_path for write-like tools", () => {
    strictEqual(
      extractTargetPath("Write", { file_path: ".tmp/plan.md" }),
      ".tmp/plan.md",
    );
    strictEqual(
      extractTargetPath("Edit", { file_path: ".tmp/plan.md" }),
      ".tmp/plan.md",
    );
    strictEqual(
      extractTargetPath("MultiEdit", { file_path: ".tmp/plan.md" }),
      ".tmp/plan.md",
    );
  });

  it("extractTargetPath reads notebook_path for NotebookEdit", () => {
    strictEqual(
      extractTargetPath("NotebookEdit", { notebook_path: ".tmp/plan.md" }),
      ".tmp/plan.md",
    );
  });

  it("extractTargetPath returns null for unsupported payload", () => {
    strictEqual(extractTargetPath("Write", { path: ".tmp/plan.md" }), null);
    strictEqual(extractTargetPath("Write", null), null);
    strictEqual(extractTargetPath("Bash", { command: "echo hi" }), null);
  });

  it("stripReviewMarkers removes auto-review markers", () => {
    const content = [
      "# Plan",
      "",
      "- task",
      "",
      "<!-- auto-review: verdict=pass; hash=abc -->",
    ].join("\n");

    strictEqual(stripReviewMarkers(content), "# Plan\n\n- task");
  });

  it("extractLatestReviewMarker parses verdict and hash from latest marker", () => {
    const content = [
      "# Plan",
      "",
      "<!-- auto-review: verdict=needs-work; hash=111 -->",
      "",
      "<!-- auto-review: verdict=pass; hash=222; at=2026-02-19T00:00:00.000Z -->",
    ].join("\n");

    deepStrictEqual(extractLatestReviewMarker(content), {
      verdict: "pass",
      hash: "222",
    });
  });

  it("computePlanHash is stable regardless of marker presence", () => {
    const base = "# Plan\n\n- task";
    const withMarker = `${base}\n\n<!-- auto-review: verdict=pass; hash=abc -->\n`;

    strictEqual(computePlanHash(base), computePlanHash(withMarker));
  });

  it("computePlanHash is stable across Approval Status changes", () => {
    const pending = [
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pass",
      "- Approval Status: pending",
    ].join("\n");
    const approved = [
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pass",
      "- Approval Status: approved",
    ].join("\n");

    strictEqual(computePlanHash(pending), computePlanHash(approved));
  });

  it("computePlanHash is stable across checkbox state changes", () => {
    const unchecked = [
      "## Success Criteria",
      "- [ ] Tests pass",
      "- [ ] No regressions",
    ].join("\n");
    const checked = [
      "## Success Criteria",
      "- [x] Tests pass",
      "- [ ] No regressions",
    ].join("\n");

    strictEqual(computePlanHash(unchecked), computePlanHash(checked));
  });

  it("computePlanHash changes when substantive plan content changes", () => {
    const original = [
      "## Plan",
      "- Refactor module A",
      "## Approval",
      "- Approval Status: pending",
    ].join("\n");
    const modified = [
      "## Plan",
      "- Refactor module A and B",
      "## Approval",
      "- Approval Status: pending",
    ].join("\n");

    ok(computePlanHash(original) !== computePlanHash(modified));
  });

  it("normalizeForHash strips markers, approval value, and checkbox state", () => {
    const content = [
      "## Plan",
      "- [ ] task one",
      "- [x] task two",
      "## Approval",
      "- Approval Status: approved",
      "",
      "<!-- auto-review: verdict=pass; hash=abc -->",
    ].join("\n");

    const expected = [
      "## Plan",
      "- [ ] task one",
      "- [ ] task two",
      "## Approval",
      "- Approval Status:",
    ].join("\n");

    strictEqual(normalizeForHash(content), expected);
  });
});

describe("selectReviewers", () => {
  it("selects architecture-strategist for English architecture keywords", () => {
    const content =
      "## Plan\nRefactor the module boundary and dependency graph";
    const result = selectReviewers(content);
    ok(
      result.some(
        (r) =>
          r.subagentType ===
          "compound-engineering:review:architecture-strategist",
      ),
    );
  });

  it("selects architecture-strategist for Japanese keywords", () => {
    const content = "## Plan\nアーキテクチャの変更と依存関係の整理";
    const result = selectReviewers(content);
    ok(
      result.some(
        (r) =>
          r.subagentType ===
          "compound-engineering:review:architecture-strategist",
      ),
    );
  });

  it("selects security-sentinel for security keywords", () => {
    const content = "## Plan\nAdd authentication and authorization logic";
    const result = selectReviewers(content);
    ok(
      result.some(
        (r) =>
          r.subagentType === "compound-engineering:review:security-sentinel",
      ),
    );
  });

  it("returns empty array when no keywords match", () => {
    const content = "## Plan\nUpdate README with new instructions";
    const result = selectReviewers(content);
    strictEqual(result.length, 0);
  });

  it("limits to maximum 3 additional reviewers", () => {
    const content = [
      "## Plan",
      "Refactor architecture with security auth",
      "Optimize database migration performance cache",
      "Add resilience retry and deploy rollback",
      "Test coverage regression tdd strategy",
    ].join("\n");
    const result = selectReviewers(content);
    ok(result.length <= 3);
  });

  it("sorts by priority (lower number first)", () => {
    const content = [
      "## Plan",
      "Deploy rollback pipeline",
      "Architecture module boundary",
    ].join("\n");
    const result = selectReviewers(content);
    for (let i = 1; i < result.length; i++) {
      ok(result[i]!.priority >= result[i - 1]!.priority);
    }
  });

  it("ignores keywords inside Approval section", () => {
    const content = [
      "## Plan",
      "Update README",
      "## Approval",
      "- Plan Status: complete",
      "Architecture security database performance",
    ].join("\n");
    const result = selectReviewers(content);
    strictEqual(result.length, 0);
  });

  it("handles plan without Approval section", () => {
    const content = "## Plan\nAdd security token validation";
    const result = selectReviewers(content);
    ok(
      result.some(
        (r) =>
          r.subagentType === "compound-engineering:review:security-sentinel",
      ),
    );
  });
});

describe("buildRecommendation with dynamic reviewers", () => {
  it("always includes logic-validator, scope-justification-reviewer, decision-quality-reviewer, and greenfield-perspective-reviewer", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nUpdate README",
    );
    ok(result.includes("logic-validator"));
    ok(result.includes("scope-justification-reviewer"));
    ok(result.includes("decision-quality-reviewer"));
    ok(result.includes("greenfield-perspective-reviewer"));
  });

  it("includes dynamic reviewers in recommendation text", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nRefactor the architecture boundary",
    );
    ok(result.includes("architecture-strategist"));
    ok(result.includes("run ALL in parallel"));
  });

  it("includes reviewers= field with always-on and selected reviewer names", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nAdd security authentication",
    );
    ok(
      result.includes(
        "reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer+security-sentinel",
      ),
    );
  });

  it("always uses parallel form even when no additional reviewers matched", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nUpdate README",
    );
    ok(
      result.includes(
        "Recommended sub-agents (use Agent tool, run ALL in parallel):",
      ),
    );
    ok(
      result.includes(
        "reviewers=logic-validator+scope-justification-reviewer+decision-quality-reviewer+greenfield-perspective-reviewer",
      ),
    );
  });

  it("numbers catalog reviewers starting at 5 after always-on reviewers", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nRefactor the architecture boundary",
    );
    ok(result.includes("1. subagent_type: logic-validator"));
    ok(result.includes("2. subagent_type: scope-justification-reviewer"));
    ok(result.includes("3. subagent_type: decision-quality-reviewer"));
    ok(result.includes("4. subagent_type: greenfield-perspective-reviewer"));
    ok(result.includes("5. subagent_type:"));
  });

  it("warns explicitly that all reviewers are Agent subagent_types, not Skills", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nUpdate README",
    );
    ok(
      result.includes("ALL reviewers below are Agent tool subagent_types"),
      "should explicitly state reviewers are Agent subagent_types",
    );
    ok(
      result.includes("same name as a Skill"),
      "should warn about reviewers sharing names with Skills",
    );
  });
});

describe("isReviewCompletePendingApproval", () => {
  function makePlan(opts: {
    planStatus?: string;
    reviewStatus?: string;
    approvalStatus?: string;
    markerVerdict?: string;
  }): {
    content: string;
    hash: string;
    marker: { verdict: string; hash: string } | null;
  } {
    const lines = [
      "## Plan",
      "Refactor module A",
      "",
      "## Approval",
      `- Plan Status: ${opts.planStatus ?? "complete"}`,
      `- Review Status: ${opts.reviewStatus ?? "pass"}`,
      `- Approval Status: ${opts.approvalStatus ?? "pending"}`,
    ];
    const content = lines.join("\n");
    const hash = computePlanHash(content);
    const marker =
      opts.markerVerdict != null ? { verdict: opts.markerVerdict, hash } : null;
    return { content, hash, marker };
  }

  it("returns true when plan is complete, review passed, and not yet approved", () => {
    const { content, hash, marker } = makePlan({ markerVerdict: "pass" });
    strictEqual(isReviewCompletePendingApproval(content, hash, marker), true);
  });

  it("returns false when plan is not complete", () => {
    const { content, hash, marker } = makePlan({
      planStatus: "draft",
      markerVerdict: "pass",
    });
    strictEqual(isReviewCompletePendingApproval(content, hash, marker), false);
  });

  it("returns false when already approved", () => {
    const { content, hash, marker } = makePlan({
      approvalStatus: "approved",
      markerVerdict: "pass",
    });
    strictEqual(isReviewCompletePendingApproval(content, hash, marker), false);
  });

  it("returns false when marker verdict is not pass", () => {
    const { content, hash, marker } = makePlan({ markerVerdict: "needs-work" });
    strictEqual(isReviewCompletePendingApproval(content, hash, marker), false);
  });

  it("returns false when marker hash does not match", () => {
    const { content, hash } = makePlan({ markerVerdict: "pass" });
    const staleMarker = { verdict: "pass", hash: "stale-hash" };
    strictEqual(
      isReviewCompletePendingApproval(content, hash, staleMarker),
      false,
    );
  });

  it("returns false when marker is null", () => {
    const { content, hash } = makePlan({});
    strictEqual(isReviewCompletePendingApproval(content, hash, null), false);
  });
});

describe("buildSummaryReminder", () => {
  it("includes MANDATORY instruction and Executive Summary template", () => {
    const result = buildSummaryReminder("/tmp/sessions/abc/plan.md");
    ok(result.includes("MANDATORY"));
    ok(result.includes("Executive Summary"));
    ok(result.includes("/tmp/sessions/abc/plan.md"));
  });

  it("includes all required fields from workflow.md template", () => {
    const result = buildSummaryReminder("/tmp/plan.md");
    ok(result.includes("**Goal**"));
    ok(result.includes("**Proposed Approach**"));
    ok(result.includes("**Experience Delta**"));
    ok(result.includes("**Scope**"));
    ok(result.includes("**Key Decisions**"));
    ok(result.includes("**Risks / Unknowns**"));
    ok(result.includes("**Review Status**"));
    ok(result.includes("**Open Questions**"));
    ok(result.includes("**Next Action**"));
  });
});

describe("SPEC_REVIEWERS / PLAN_REVIEWERS derivation", () => {
  it("ALWAYS_ON_REVIEWERS is an alias of SPEC_REVIEWERS (backward compat)", () => {
    strictEqual(ALWAYS_ON_REVIEWERS, SPEC_REVIEWERS);
  });

  it("SPEC_REVIEWERS contains the 4 design-layer slugs in order", () => {
    const expected = [
      "logic-validator",
      "scope-justification-reviewer",
      "decision-quality-reviewer",
      "greenfield-perspective-reviewer",
    ];
    deepStrictEqual(
      SPEC_REVIEWERS.map((r) => r.slug as string),
      expected,
    );
  });

  it("PLAN_REVIEWERS contains the 2 execution-layer slugs in order", () => {
    const expected = ["logic-validator", "scope-justification-reviewer"];
    deepStrictEqual(
      PLAN_REVIEWERS.map((r) => r.slug as string),
      expected,
    );
  });

  it("logic-validator and scope-justification-reviewer appear in both layers (intentional duplication)", () => {
    const specSlugs = new Set(SPEC_REVIEWERS.map((r) => r.slug as string));
    const planSlugs = new Set(PLAN_REVIEWERS.map((r) => r.slug as string));
    ok(specSlugs.has("logic-validator"));
    ok(planSlugs.has("logic-validator"));
    ok(specSlugs.has("scope-justification-reviewer"));
    ok(planSlugs.has("scope-justification-reviewer"));
  });

  it("decision-quality-reviewer and greenfield-perspective-reviewer are spec-only", () => {
    const planSlugs = new Set(PLAN_REVIEWERS.map((r) => r.slug as string));
    ok(!planSlugs.has("decision-quality-reviewer"));
    ok(!planSlugs.has("greenfield-perspective-reviewer"));
  });

  it("derives spec alwaysOnLines with exact format including em-dash separator", () => {
    const expected = [
      "1. subagent_type: logic-validator — Check logical consistency, assumptions, and contradictions",
      "2. subagent_type: scope-justification-reviewer — Verify change justification, scope coherence, and near-term necessity",
      "3. subagent_type: decision-quality-reviewer — Detect dominant-axis misalignment in design decisions (Decision Quality framework)",
      "4. subagent_type: greenfield-perspective-reviewer — Reconstruct the order from a clean slate and surface ambition gaps the incremental plan dropped",
    ];
    deepStrictEqual(
      SPEC_REVIEWERS.map(
        (r, i) => `${i + 1}. subagent_type: ${r.slug} — ${r.responsibility}`,
      ),
      expected,
    );
  });
});

describe("computeDocumentHash with normalizers", () => {
  it("computeDocumentHash equals computePlanHash when SPEC_NORMALIZERS is passed", () => {
    const content = "## Plan\n- task\n";
    strictEqual(
      computeDocumentHash(content, SPEC_NORMALIZERS),
      computePlanHash(content),
    );
  });

  it("computeDocumentHash with PLAN_NORMALIZERS is currently equivalent to SPEC_NORMALIZERS", () => {
    const content =
      "## Plan\n- [x] task\n## Approval\n- Approval Status: pending\n";
    strictEqual(
      computeDocumentHash(content, SPEC_NORMALIZERS),
      computeDocumentHash(content, PLAN_NORMALIZERS),
    );
  });

  it("normalizersForDocumentType picks plan normalizers for plan-numbered, spec normalizers otherwise", () => {
    strictEqual(normalizersForDocumentType("plan-numbered"), PLAN_NORMALIZERS);
    strictEqual(normalizersForDocumentType("spec"), SPEC_NORMALIZERS);
    strictEqual(normalizersForDocumentType("plan"), SPEC_NORMALIZERS);
  });

  it("reviewersForDocumentType picks plan reviewers for plan-numbered, spec reviewers otherwise", () => {
    strictEqual(reviewersForDocumentType("plan-numbered"), PLAN_REVIEWERS);
    strictEqual(reviewersForDocumentType("spec"), SPEC_REVIEWERS);
    strictEqual(reviewersForDocumentType("plan"), SPEC_REVIEWERS);
  });
});

describe("getWorkflowDocumentType / isWorkflowDocument", () => {
  it("detects spec.md / plan.md / plan-numbered.md", () => {
    strictEqual(getWorkflowDocumentType("/tmp/spec.md"), "spec");
    strictEqual(getWorkflowDocumentType("/tmp/plan.md"), "plan");
    strictEqual(getWorkflowDocumentType("/tmp/plan-1.md"), "plan-numbered");
    strictEqual(getWorkflowDocumentType("/tmp/plan-99.md"), "plan-numbered");
  });

  it("rejects suffixed / dotted / non-numeric variants (false-allow防止)", () => {
    strictEqual(getWorkflowDocumentType("/tmp/plan-draft.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-rejected.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-template.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-1.md.bak"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-1.md.swp"), null);
    strictEqual(getWorkflowDocumentType("/tmp/.plan-1.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-1a.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-2-draft.md"), null);
    strictEqual(getWorkflowDocumentType("/tmp/plan-2-wip.md"), null);
  });

  it("isWorkflowDocument returns true for spec/plan/plan-N.md and false otherwise", () => {
    strictEqual(isWorkflowDocument("/tmp/spec.md"), true);
    strictEqual(isWorkflowDocument("/tmp/plan.md"), true);
    strictEqual(isWorkflowDocument("/tmp/plan-7.md"), true);
    strictEqual(isWorkflowDocument("/tmp/plan-2-draft.md"), false);
    strictEqual(isWorkflowDocument("/tmp/research.md"), false);
    strictEqual(isWorkflowDocument("/tmp/code.ts"), false);
  });
});

describe("buildRecommendation document-type branching", () => {
  it("for spec.md uses spec reviewers (4 names) and includes <spec> delimiter note", () => {
    const result = buildRecommendation(
      "/tmp/wf/spec.md",
      null,
      "## Goal\nDesign a new module",
    );
    ok(result.includes("spec.md was updated"));
    ok(result.includes("logic-validator"));
    ok(result.includes("decision-quality-reviewer"));
    ok(result.includes("greenfield-perspective-reviewer"));
    ok(result.includes("<spec>...</spec>"));
  });

  it("for plan-N.md uses plan reviewers (2 names) and includes parent-spec-hash field", () => {
    const result = buildRecommendation(
      "/tmp/wf/plan-1.md",
      null,
      "## Tasks\n- T1: implement",
      {
        documentType: "plan-numbered",
        specPath: "/tmp/wf/spec.md",
        parentSpecHash: "abcdef1234",
      },
    );
    ok(result.includes("plan-1.md was updated"));
    ok(result.includes("logic-validator"));
    ok(result.includes("scope-justification-reviewer"));
    ok(result.includes("parent-spec-hash=abcdef1234"));
    ok(result.includes("<plan>...</plan>"));
    // Plan layer does not include design-layer reviewers as always-on.
    ok(!result.includes("1. subagent_type: decision-quality-reviewer"));
    ok(!result.includes("1. subagent_type: greenfield-perspective-reviewer"));
  });

  it("for plan.md (single-layer) uses spec reviewers and no parent-spec-hash field", () => {
    const result = buildRecommendation(
      "/tmp/wf/plan.md",
      null,
      "## Plan\n- task",
    );
    ok(result.includes("plan.md was updated"));
    ok(result.includes("decision-quality-reviewer"));
    ok(!result.includes("parent-spec-hash"));
  });

  it("plan-N.md without computed parent-spec-hash falls back to placeholder", () => {
    const result = buildRecommendation(
      "/tmp/wf/plan-1.md",
      null,
      "## Tasks\n- T1: implement",
      { documentType: "plan-numbered", specPath: "/tmp/wf/spec.md" },
    );
    ok(result.includes("parent-spec-hash=<spec.md hash here>"));
  });
});

describe("doc drift detection (integration boundary)", () => {
  const RULES_DIR = fileURLToPath(new URL("../../../rules/", import.meta.url));
  const DOC_BASENAMES = ["workflow.md", "external-review.md"];

  // Slugs in the SSoT regions appear inside backticks (`logic-validator`) or
  // after the bold marker `**logic-validator**`. We extract slugs only from
  // these specific contexts to avoid picking up marker words like
  // "spec-reviewer" / "plan-reviewer" embedded in marker comments themselves.
  const INLINE_CODE_SLUG_REGEX =
    /`([a-z][a-z-]*-(?:reviewer|validator|evaluator))`/g;
  const BOLD_SLUG_REGEX =
    /\*\*([a-z][a-z-]*-(?:reviewer|validator|evaluator))\*\*/g;

  function readDoc(basename: string): string {
    return readFileSync(join(RULES_DIR, basename), "utf-8");
  }

  function extractSsotRegion(
    content: string,
    layer: "spec-reviewers" | "plan-reviewers",
  ): string {
    const startMarker = `<!-- ssot:${layer}:start -->`;
    const endMarker = `<!-- ssot:${layer}:end -->`;
    const startIdx = content.indexOf(startMarker);
    const endIdx = content.indexOf(endMarker);
    return content.slice(startIdx + startMarker.length, endIdx);
  }

  function extractSlugSet(region: string): Set<string> {
    const slugs = new Set<string>();
    let match: RegExpExecArray | null;
    INLINE_CODE_SLUG_REGEX.lastIndex = 0;
    while ((match = INLINE_CODE_SLUG_REGEX.exec(region)) !== null) {
      if (match[1]) slugs.add(match[1]);
    }
    BOLD_SLUG_REGEX.lastIndex = 0;
    while ((match = BOLD_SLUG_REGEX.exec(region)) !== null) {
      if (match[1]) slugs.add(match[1]);
    }
    return slugs;
  }

  for (const basename of DOC_BASENAMES) {
    for (const layer of ["spec-reviewers", "plan-reviewers"] as const) {
      const startMarker = `<!-- ssot:${layer}:start -->`;
      const endMarker = `<!-- ssot:${layer}:end -->`;

      it(`${basename} contains both ${layer} SSoT markers`, () => {
        const content = readDoc(basename);
        ok(
          content.includes(startMarker),
          `${basename} is missing ${startMarker}`,
        );
        ok(content.includes(endMarker), `${basename} is missing ${endMarker}`);
      });

      it(`${basename} ${layer} markers appear in start-then-end order`, () => {
        const content = readDoc(basename);
        const startIdx = content.indexOf(startMarker);
        const endIdx = content.indexOf(endMarker);
        ok(
          startIdx !== -1 && endIdx !== -1 && startIdx < endIdx,
          `${basename} ${layer} markers out of order: start=${startIdx}, end=${endIdx}`,
        );
      });
    }

    it(`${basename} spec-reviewers SSoT region slug set equals SPEC_REVIEWERS slug set`, () => {
      const content = readDoc(basename);
      const region = extractSsotRegion(content, "spec-reviewers");
      const docSlugs = extractSlugSet(region);
      const constantSlugs = new Set(
        SPEC_REVIEWERS.map((r) => r.slug as string),
      );
      deepStrictEqual(docSlugs, constantSlugs);
    });

    it(`${basename} plan-reviewers SSoT region slug set equals PLAN_REVIEWERS slug set`, () => {
      const content = readDoc(basename);
      const region = extractSsotRegion(content, "plan-reviewers");
      const docSlugs = extractSlugSet(region);
      const constantSlugs = new Set(
        PLAN_REVIEWERS.map((r) => r.slug as string),
      );
      deepStrictEqual(docSlugs, constantSlugs);
    });
  }
});
