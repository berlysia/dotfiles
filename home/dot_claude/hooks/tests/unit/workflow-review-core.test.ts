#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRecommendation,
  canSkip,
  type CacheState,
  computeDocumentHash,
  isCompleteAndChanged,
  PLAN_REVIEWERS,
  readDocCache,
  REVIEWER_CATALOG,
  scanPlaceholders,
  selectReviewers,
  SPEC_NORMALIZERS,
  SPEC_REVIEWERS,
  writeDocCache,
} from "../../lib/workflow-review-core.ts";
import type { AutoReviewMarker } from "../../lib/workflow-marker.ts";
import { seedCache } from "./test-helpers.ts";

describe("workflow-review-core: reviewer roster slugs", () => {
  it("SPEC_REVIEWERS carries the 4 design-layer slugs in order", () => {
    deepStrictEqual(
      SPEC_REVIEWERS.map((r) => r.slug as string),
      [
        "logic-validator",
        "scope-justification-reviewer",
        "decision-quality-reviewer",
        "greenfield-perspective-reviewer",
      ],
    );
  });

  it("PLAN_REVIEWERS carries the 2 execution-layer slugs in order", () => {
    deepStrictEqual(
      PLAN_REVIEWERS.map((r) => r.slug as string),
      ["logic-validator", "scope-justification-reviewer"],
    );
  });
});

describe("workflow-review-core: canSkip", () => {
  const marker = (verdict: string, hash: string): AutoReviewMarker => ({
    verdict,
    hash,
    designHash: null,
    parentSpecHash: null,
  });
  const cache = (planHash: string): CacheState => ({
    planHash,
    recommendedAt: "2026-01-01T00:00:00.000Z",
  });

  it("returns true when marker hash matches and verdict is non-empty", () => {
    strictEqual(canSkip(null, "abc", marker("pass", "abc")), true);
  });

  it("returns true when cache planHash matches, regardless of marker", () => {
    strictEqual(canSkip(cache("abc"), "abc", null), true);
  });

  it("returns false when neither marker nor cache matches", () => {
    strictEqual(canSkip(cache("zzz"), "abc", marker("pass", "yyy")), false);
  });

  it("returns false when marker hash matches but verdict is empty", () => {
    strictEqual(canSkip(null, "abc", marker("", "abc")), false);
  });

  it("returns false when both cache and marker are absent", () => {
    strictEqual(canSkip(null, "abc", null), false);
  });
});

describe("workflow-review-core: per-doc cache", () => {
  it("keeps spec and plan entries separate", () => {
    const wf = mkdtempSync(join(tmpdir(), "cache-"));
    writeDocCache(wf, "spec.md", {
      planHash: "aaa",
      recommendedAt: "t1",
    });
    writeDocCache(wf, "plan-1.md", {
      planHash: "bbb",
      recommendedAt: "t2",
    });
    strictEqual(readDocCache(wf, "spec.md")?.planHash, "aaa");
    strictEqual(readDocCache(wf, "plan-1.md")?.planHash, "bbb");
  });

  it("returns null for a doc with no entry", () => {
    const wf = mkdtempSync(join(tmpdir(), "cache-"));
    writeDocCache(wf, "spec.md", { planHash: "aaa", recommendedAt: "t1" });
    strictEqual(readDocCache(wf, "plan-1.md"), null);
  });

  it("reads a legacy top-level cache shape as empty", () => {
    const wf = mkdtempSync(join(tmpdir(), "cache-"));
    writeFileSync(
      join(wf, "plan-review.cache.json"),
      JSON.stringify({ planHash: "old", recommendedAt: "t" }),
    );
    strictEqual(readDocCache(wf, "spec.md"), null);
  });

  it("a write after a legacy file discards the legacy entry and starts fresh", () => {
    const wf = mkdtempSync(join(tmpdir(), "cache-"));
    writeFileSync(
      join(wf, "plan-review.cache.json"),
      JSON.stringify({ planHash: "old", recommendedAt: "t" }),
    );
    writeDocCache(wf, "plan.md", { planHash: "new", recommendedAt: "t2" });
    strictEqual(readDocCache(wf, "plan.md")?.planHash, "new");
  });
});

describe("workflow-review-core: selectReviewers", () => {
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
});

describe("workflow-review-core: scanPlaceholders", () => {
  it("finds a line containing TBD with 1-indexed line number", () => {
    const content = "# Goal\nTBD\n## K1\n通常記述";
    const findings = scanPlaceholders(content);
    ok(findings.some((f) => f.line === 2 && f.name === "TBD"));
  });

  it("skips content inside an ignore block", () => {
    const content = [
      "# Goal",
      "<!-- placeholder-scan: ignore -->",
      "TBD",
      "<!-- /placeholder-scan: ignore -->",
      "通常記述",
    ].join("\n");
    const findings = scanPlaceholders(content);
    strictEqual(findings.length, 0);
  });
});

describe("workflow-review-core: buildRecommendation parity", () => {
  it("spec.md draft: includes full 4-reviewer roster and the intent-triage trailer", () => {
    const result = buildRecommendation(
      "/tmp/wf/spec.md",
      null,
      "## Goal\nDesign a new module",
    );
    ok(result.includes("spec.md was updated"));
    ok(result.includes("1. subagent_type: logic-validator"));
    ok(result.includes("2. subagent_type: scope-justification-reviewer"));
    ok(result.includes("3. subagent_type: decision-quality-reviewer"));
    ok(result.includes("4. subagent_type: greenfield-perspective-reviewer"));
    ok(result.includes("/intent-alignment-triage"));
    ok(result.includes("<spec>...</spec>"));
  });

  it("plan-N.md: includes the 2-reviewer roster, parent-spec-hash, and the intent-triage trailer", () => {
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
    ok(result.includes("1. subagent_type: logic-validator"));
    ok(result.includes("2. subagent_type: scope-justification-reviewer"));
    ok(result.includes("parent-spec-hash=abcdef1234"));
    ok(result.includes("/intent-alignment-triage"));
    ok(result.includes("<plan>...</plan>"));
    ok(!result.includes("1. subagent_type: decision-quality-reviewer"));
  });
});

function specWithRounds(n: number): string {
  const parts = ["## Goal", "Design a new module", ""];
  for (let round = 1; round <= n; round++) {
    parts.push(
      `## Reviewer Outputs (Round ${round})`,
      "",
      "### logic-validator",
      "- verdict: pass",
      "",
    );
  }
  parts.push(
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: pending",
    "- Approval Status: pending",
  );
  return parts.join("\n");
}

describe("workflow-review-core: buildRecommendation pointer-ization (K6)", () => {
  it("emits full text on the first recommendation for a round", () => {
    const doc = specWithRounds(1);
    const first = buildRecommendation("/tmp/wf/spec.md", null, doc, {
      fullTextEmittedForRound: 0,
    });
    ok(first.length > 400);
    ok(first.includes("1. subagent_type: logic-validator"));
  });

  it("emits a short pointer for a second change within the same round", () => {
    const doc = specWithRounds(1);
    const second = buildRecommendation("/tmp/wf/spec.md", null, doc, {
      fullTextEmittedForRound: 1,
    });
    ok(Buffer.byteLength(second, "utf-8") <= 160);
    ok(/workflow-cli/.test(second));
  });

  it("emits full text again once the round count advances", () => {
    const doc = specWithRounds(2);
    const result = buildRecommendation("/tmp/wf/spec.md", null, doc, {
      fullTextEmittedForRound: 1,
    });
    ok(result.length > 400);
  });

  it("no cache entry (undefined fullTextEmittedForRound) always emits full text", () => {
    const doc = specWithRounds(1);
    const result = buildRecommendation("/tmp/wf/spec.md", null, doc);
    ok(result.length > 400);
  });
});

describe("workflow-review-core: isCompleteAndChanged (K10)", () => {
  it("fires only when the post-write doc is complete and hash changed", () => {
    const wf = seedCache("spec.md", "oldhash");
    strictEqual(
      isCompleteAndChanged(wf, "spec.md", "- Plan Status: complete\nbody-v2"),
      true,
    );
    strictEqual(
      isCompleteAndChanged(wf, "spec.md", "- Plan Status: draft\nbody-v2"),
      false,
    );
  });

  it("returns false when the hash is unchanged from the cached entry", () => {
    const content = "- Plan Status: complete\nbody";
    const wf = mkdtempSync(join(tmpdir(), "cache-"));
    writeDocCache(wf, "spec.md", {
      planHash: computeDocumentHash(content, SPEC_NORMALIZERS),
      recommendedAt: "t1",
    });
    strictEqual(isCompleteAndChanged(wf, "spec.md", content), false);
  });
});

describe("workflow-review-core: REVIEWER_CATALOG (K9a code-simplicity-reviewer)", () => {
  it("includes code-simplicity-reviewer", () => {
    ok(
      REVIEWER_CATALOG.some(
        (r) =>
          r.subagentType ===
          "compound-engineering:review:code-simplicity-reviewer",
      ),
    );
  });

  it("selects code-simplicity-reviewer for simplification keywords", () => {
    const sel = selectReviewers("この計画は YAGNI 観点で簡素化の余地がある");
    ok(
      sel.some(
        (r) =>
          r.subagentType ===
          "compound-engineering:review:code-simplicity-reviewer",
      ),
    );
  });
});
