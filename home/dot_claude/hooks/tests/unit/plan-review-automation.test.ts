#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  computePlanHash,
  extractTargetPath,
  extractLatestReviewMarker,
  isPlanFile,
  normalizeForHash,
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
