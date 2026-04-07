#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildRecommendation,
  computePlanHash,
  extractLatestReviewMarker,
  extractTargetPath,
  isPlanFile,
  normalizeForHash,
  REVIEWER_CATALOG,
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
  it("always includes logic-validator and change-conservatism-reviewer", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nUpdate README",
    );
    ok(result.includes("logic-validator"));
    ok(result.includes("change-conservatism-reviewer"));
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
        "reviewers=logic-validator+change-conservatism-reviewer+security-sentinel",
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
      result.includes("reviewers=logic-validator+change-conservatism-reviewer"),
    );
  });

  it("numbers catalog reviewers starting at 3 after always-on reviewers", () => {
    const result = buildRecommendation(
      "/tmp/plan.md",
      null,
      "## Plan\nRefactor the architecture boundary",
    );
    ok(result.includes("1. subagent_type: logic-validator"));
    ok(result.includes("2. subagent_type: change-conservatism-reviewer"));
    ok(result.includes("3. subagent_type:"));
  });
});
