#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  computePlanHash,
  decideVerdict,
  extractTargetPath,
  extractLatestReviewMarker,
  isPlanFile,
  parseReviewerResult,
  parseStructuredOutput,
  stripReviewMarkers,
  upsertReviewMarker,
  upsertReviewStatus,
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

  it("upsertReviewMarker appends marker and replaces old marker", () => {
    const base = "# Plan\n\n- task";
    const first = upsertReviewMarker(base, "<!-- auto-review: verdict=pass; hash=111 -->");
    const second = upsertReviewMarker(first, "<!-- auto-review: verdict=pass; hash=222 -->");

    strictEqual(first.includes("hash=111"), true);
    strictEqual(second.includes("hash=111"), false);
    strictEqual(second.includes("hash=222"), true);
  });

  it("upsertReviewStatus replaces existing review status", () => {
    const base = [
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: pending",
      "- Approval Status: approved",
    ].join("\n");

    const updated = upsertReviewStatus(base, "pass");
    strictEqual(updated.includes("- Review Status: pass"), true);
    strictEqual(updated.includes("- Review Status: pending"), false);
  });

  it("upsertReviewStatus inserts review status when missing", () => {
    const base = [
      "## Approval",
      "- Plan Status: complete",
      "- Approval Status: pending",
    ].join("\n");

    const updated = upsertReviewStatus(base, "needs-work");
    strictEqual(updated.includes("- Review Status: needs-work"), true);
  });

  it("decideVerdict returns blocker when any P0 exists", () => {
    const verdict = decideVerdict([
      {
        reviewer: "logic-validator",
        score: 4,
        summary: "ok",
        findings: [
          {
            severity: "P0",
            title: "fatal",
            detail: "detail",
            suggestion: "fix",
          },
        ],
      },
      {
        reviewer: "architecture-boundary-analyzer",
        score: 5,
        summary: "ok",
        findings: [],
      },
    ]);

    strictEqual(verdict, "blocker");
  });

  it("decideVerdict returns needs-work when P1 exists without P0", () => {
    const verdict = decideVerdict([
      {
        reviewer: "logic-validator",
        score: 4,
        summary: "ok",
        findings: [
          {
            severity: "P1",
            title: "important",
            detail: "detail",
            suggestion: "fix",
          },
        ],
      },
    ]);

    strictEqual(verdict, "needs-work");
  });

  it("decideVerdict returns pass when findings are P2 or empty", () => {
    const verdict = decideVerdict([
      {
        reviewer: "logic-validator",
        score: 5,
        summary: "ok",
        findings: [
          {
            severity: "P2",
            title: "minor",
            detail: "detail",
            suggestion: "optional",
          },
        ],
      },
    ]);

    strictEqual(verdict, "pass");
  });

  it("parseReviewerResult parses valid JSON payload", () => {
    const response = JSON.stringify({
      score: 5,
      summary: "No issues",
      findings: [
        {
          severity: "P1",
          title: "Missing rollback",
          detail: "Rollback path is not documented",
          suggestion: "Add rollback section",
        },
      ],
    });

    const result = parseReviewerResult("logic-validator", response);

    strictEqual(result.reviewer, "logic-validator");
    strictEqual(result.score, 5);
    strictEqual(result.summary, "No issues");
    deepStrictEqual(result.findings, [
      {
        severity: "P1",
        title: "Missing rollback",
        detail: "Rollback path is not documented",
        suggestion: "Add rollback section",
      },
    ]);
  });

  it("parseReviewerResult falls back when JSON is invalid", () => {
    const result = parseReviewerResult("logic-validator", "not-json");

    strictEqual(result.reviewer, "logic-validator");
    strictEqual(result.score, 2);
    strictEqual(result.findings.length, 1);
    strictEqual(result.findings[0]?.severity, "P1");
  });

  it("parseStructuredOutput parses valid structured output", () => {
    const output = {
      score: 4,
      summary: "Minor issues found",
      findings: [
        {
          severity: "P2",
          title: "Style nit",
          detail: "Consider renaming variable",
          suggestion: "Use descriptive name",
        },
      ],
    };

    const result = parseStructuredOutput("logic-validator", output);

    strictEqual(result.reviewer, "logic-validator");
    strictEqual(result.score, 4);
    strictEqual(result.summary, "Minor issues found");
    deepStrictEqual(result.findings, [
      {
        severity: "P2",
        title: "Style nit",
        detail: "Consider renaming variable",
        suggestion: "Use descriptive name",
      },
    ]);
  });

  it("parseStructuredOutput falls back for non-object input", () => {
    const result = parseStructuredOutput("logic-validator", "not-an-object");

    strictEqual(result.reviewer, "logic-validator");
    strictEqual(result.score, 2);
    strictEqual(result.findings.length, 1);
    strictEqual(result.findings[0]?.severity, "P1");
  });

  it("parseStructuredOutput handles empty findings", () => {
    const output = {
      score: 5,
      summary: "All good",
      findings: [],
    };

    const result = parseStructuredOutput("release-safety-evaluator", output);

    strictEqual(result.score, 5);
    strictEqual(result.summary, "All good");
    deepStrictEqual(result.findings, []);
  });

  it("parseStructuredOutput normalizes out-of-range scores", () => {
    const output = {
      score: 10,
      summary: "Inflated score",
      findings: [],
    };

    const result = parseStructuredOutput("logic-validator", output);

    strictEqual(result.score, 5);
  });
});
