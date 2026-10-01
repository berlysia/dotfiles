#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bareSlug,
  buildRecommendation,
  canSkip,
  type CacheState,
  computeDocumentHash,
  type ExtensionApprover,
  formatExtensionLogLine,
  formatRoundBudgetGuidance,
  formatRoundBudgetHeadline,
  getReframerReviewFileName,
  getRoundBudgetPhase,
  getRoundsInCycle,
  isCompleteAndChanged,
  isExtensionAllowed,
  isRecordedAgentSlug,
  parseLatestReframerReview,
  PLAN_REVIEWERS,
  planRoundReviewers,
  readDocCache,
  REFRAMER_AGENT,
  REVIEWER_CATALOG,
  ROUND_BUDGET,
  ROUND_REFRAMER_CAP,
  ROUND_SELF_CAP,
  type RoundBudgetPhase,
  sanitizeExtensionReason,
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
  it("selects security-vulnerability-analyzer for security keywords", () => {
    const content = "## Plan\nAdd authentication and authorization logic";
    const result = selectReviewers(content);
    ok(
      result.some((r) => r.subagentType === "security-vulnerability-analyzer"),
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

function docWithRound(round: number, verdicts: Record<string, string>): string {
  const lines = ["## Key Decisions", "- K1", "", "## Tasks", "- T1", ""];
  lines.push(`## Reviewer Outputs (Round ${round})`, "");
  for (const [slug, verdict] of Object.entries(verdicts)) {
    lines.push(`### ${slug}`, `- verdict: ${verdict}`, "- 主指摘: x", "");
  }
  lines.push(
    "<!-- auto-review: verdict=needs-work; hash=h; at=2026-01-01T00:00:00.000Z; reviewers=x -->",
    "",
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: needs-work",
    "- Approval Status: pending",
  );
  return lines.join("\n");
}

const ALL_SPEC_PASS_BUT_SCOPE = {
  "logic-validator": "pass",
  "scope-justification-reviewer": "needs-work",
  "decision-quality-reviewer": "pass",
  "greenfield-perspective-reviewer": "pass（軽微あり）",
};

describe("workflow-review-core: planRoundReviewers (K6 delta re-review)", () => {
  it("is full when there is no prior round", () => {
    deepStrictEqual(planRoundReviewers(docWithRound(1, {}), "spec", 0), {
      kind: "full",
    });
  });

  it("re-runs non-pass reviewers plus logic-validator and carries the rest", () => {
    const plan = planRoundReviewers(
      docWithRound(1, ALL_SPEC_PASS_BUT_SCOPE),
      "spec",
      1,
    );
    deepStrictEqual(plan, {
      kind: "delta",
      rerun: ["logic-validator", "scope-justification-reviewer"],
      carried: ["decision-quality-reviewer", "greenfield-perspective-reviewer"],
    });
  });

  it("requires a content-selected reviewer that returned needs-work", () => {
    const plan = planRoundReviewers(
      docWithRound(1, {
        "logic-validator": "pass",
        "scope-justification-reviewer": "pass",
        "security-vulnerability-analyzer": "needs-work",
      }),
      "plan-numbered",
      1,
    );
    deepStrictEqual(plan, {
      kind: "delta",
      rerun: ["logic-validator", "security-vulnerability-analyzer"],
      carried: ["scope-justification-reviewer"],
    });
  });

  it("re-runs a mandatory reviewer missing from the prior round", () => {
    const plan = planRoundReviewers(
      docWithRound(1, {
        "logic-validator": "pass",
        "scope-justification-reviewer": "pass",
        "decision-quality-reviewer": "pass",
      }),
      "spec",
      1,
    );
    deepStrictEqual(plan, {
      kind: "delta",
      rerun: ["logic-validator", "greenfield-perspective-reviewer"],
      carried: ["scope-justification-reviewer", "decision-quality-reviewer"],
    });
  });

  it("treats carried lines as pass so the chain does not oscillate", () => {
    const plan = planRoundReviewers(
      docWithRound(2, {
        "logic-validator": "pass",
        "scope-justification-reviewer": "pass",
        "decision-quality-reviewer": "pass (carried from Round 1)",
        "greenfield-perspective-reviewer": "pass (carried from Round 1)",
      }),
      "spec",
      2,
    );
    strictEqual(plan.kind, "delta");
    deepStrictEqual(plan.kind === "delta" ? plan.rerun : [], [
      "logic-validator",
    ]);
  });

  it("falls back to full when any verdict in the prior round is unfilled", () => {
    const plan = planRoundReviewers(
      docWithRound(1, { ...ALL_SPEC_PASS_BUT_SCOPE, "logic-validator": "" }),
      "spec",
      1,
    );
    deepStrictEqual(plan, { kind: "full" });
  });

  it("falls back to full when any reviewer returned blocker", () => {
    const plan = planRoundReviewers(
      docWithRound(1, {
        ...ALL_SPEC_PASS_BUT_SCOPE,
        "decision-quality-reviewer": "blocker",
      }),
      "spec",
      1,
    );
    deepStrictEqual(plan, { kind: "full" });
  });

  it("falls back to full when the requested prior round section is absent", () => {
    deepStrictEqual(
      planRoundReviewers(docWithRound(1, ALL_SPEC_PASS_BUT_SCOPE), "spec", 2),
      { kind: "full" },
    );
  });
});

describe("workflow-review-core: buildRecommendation delta (K6)", () => {
  it("lists only the re-run reviewers once a round has verdicts", () => {
    const result = buildRecommendation(
      "/tmp/wf/spec.md",
      null,
      docWithRound(1, ALL_SPEC_PASS_BUT_SCOPE),
    );
    ok(result.includes("subagent_type: logic-validator"));
    ok(result.includes("subagent_type: scope-justification-reviewer"));
    ok(!result.includes("subagent_type: decision-quality-reviewer"));
    ok(!result.includes("subagent_type: greenfield-perspective-reviewer"));
    ok(result.includes("Carried from Round 1"));
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

describe("workflow-review-core: every reviewer roster points at local agents", () => {
  const agentsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../agents",
  );
  const slugs = [
    ...SPEC_REVIEWERS.map((r) => r.slug as string),
    ...PLAN_REVIEWERS.map((r) => r.slug as string),
    ...REVIEWER_CATALOG.map((r) => r.subagentType),
  ];
  it("every slug is bare and has a definition under home/dot_claude/agents", () => {
    for (const slug of slugs) {
      ok(!slug.includes(":"), `${slug} must not be a plugin agent`);
      ok(
        existsSync(join(agentsDir, `${slug}.md`)),
        `missing agents/${slug}.md`,
      );
    }
  });
});

const proseFiles =
  "## Files\n\n```\n.skills/pr-description/SKILL.md\n```\n\n## Tasks\npermission timeout モジュール\n";
const codeFiles =
  "## Files\n\n```\nhome/dot_claude/hooks/lib/x.ts\n```\n\n## Tasks\npermission timeout モジュール\n";

describe("workflow-review-core: prose-only change", () => {
  it("recommends no catalog reviewers and says why", () => {
    const result = buildRecommendation("/tmp/wf/plan.md", null, proseFiles);
    ok(!result.includes("security-vulnerability-analyzer"));
    ok(!result.includes("resilience-analyzer"));
    ok(
      result.includes(
        "Additional reviewers: skipped (all ## Files entries are prose)",
      ),
    );
    ok(result.includes("1. subagent_type: logic-validator"));
  });
  it("keeps keyword selection when Files lists code", () => {
    const result = buildRecommendation("/tmp/wf/plan.md", null, codeFiles);
    ok(result.includes("security-vulnerability-analyzer"));
    ok(!result.includes("Additional reviewers: skipped"));
  });
});

describe("workflow-review-core: round budget line", () => {
  const rounds = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `## Reviewer Outputs (Round ${i + 1})\n`,
    ).join("\n");
  it("mentions --extend once the cycle reaches 3 rounds", () => {
    const content = `## Goal\nx\n${rounds(3)}\n<!-- auto-review: verdict=needs-work; hash=1; round=3 -->\n`;
    ok(
      buildRecommendation("/tmp/wf/spec.md", null, content).includes(
        "--extend --reason",
      ),
    );
  });
  it("is silent when the cycle restarted after a pass at round 3", () => {
    const content = `## Goal\nx\n${rounds(4)}\n<!-- auto-review: verdict=pass; hash=1; round=3 -->\n<!-- auto-review: verdict=needs-work; hash=2; round=4 -->\n`;
    ok(
      !buildRecommendation("/tmp/wf/spec.md", null, content).includes(
        "Round budget reached",
      ),
    );
  });
});

const roundsN = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `## Reviewer Outputs (Round ${i + 1})\n`,
  ).join("\n");

describe("workflow-review-core: getRoundBudgetPhase", () => {
  const table: Array<[number, RoundBudgetPhase]> = [
    [0, "open"],
    [ROUND_BUDGET - 1, "open"],
    [ROUND_BUDGET, "self-extendable"],
    [ROUND_SELF_CAP - 1, "self-extendable"],
    [ROUND_SELF_CAP, "reframer-review"],
    [ROUND_REFRAMER_CAP - 1, "reframer-review"],
    [ROUND_REFRAMER_CAP, "human-only"],
    [12, "human-only"],
  ];
  for (const [rounds, phase] of table) {
    it(`${rounds} rounds in cycle -> ${phase}`, () => {
      strictEqual(getRoundBudgetPhase(rounds), phase);
    });
  }
});

describe("workflow-review-core: isExtensionAllowed", () => {
  const phases: RoundBudgetPhase[] = [
    "open",
    "self-extendable",
    "reframer-review",
    "human-only",
  ];
  const approvers: ExtensionApprover[] = ["human", "self", "reframer"];
  const allowed: Record<RoundBudgetPhase, ExtensionApprover[]> = {
    open: ["human", "self", "reframer"],
    "self-extendable": ["human", "self"],
    "reframer-review": ["human", "reframer"],
    "human-only": ["human"],
  };
  for (const phase of phases) {
    for (const approver of approvers) {
      const expected = allowed[phase].includes(approver);
      it(`${phase} x ${approver} -> ${expected}`, () => {
        strictEqual(isExtensionAllowed(phase, approver), expected);
      });
    }
  }
});

describe("workflow-review-core: getRoundsInCycle", () => {
  it("counts every round when there is no pass marker", () => {
    strictEqual(getRoundsInCycle(roundsN(4)), 4);
  });
  it("counts from the last pass marker's round=", () => {
    const content = `${roundsN(9)}\n<!-- auto-review: verdict=pass; hash=1; round=3 -->\n`;
    strictEqual(getRoundsInCycle(content), 6);
  });
  it("treats a pass marker without round= as cycle start 0", () => {
    const content = `${roundsN(3)}\n<!-- auto-review: verdict=pass; hash=1 -->\n`;
    strictEqual(getRoundsInCycle(content), 3);
  });
  it("is 0 right after a pass at the current round", () => {
    const content = `${roundsN(3)}\n<!-- auto-review: verdict=pass; hash=1; round=3 -->\n`;
    strictEqual(getRoundsInCycle(content), 0);
  });
  it("clamps an anomalous round= above the heading count to 0", () => {
    const content = `${roundsN(2)}\n<!-- auto-review: verdict=pass; hash=1; round=5 -->\n`;
    strictEqual(getRoundsInCycle(content), 0);
  });
});

describe("workflow-review-core: bareSlug / isRecordedAgentSlug", () => {
  it("bareSlug keeps the last colon-separated segment", () => {
    strictEqual(bareSlug("a:b:review-reframer"), "review-reframer");
    strictEqual(bareSlug("logic-validator"), "logic-validator");
  });
  it("records reviewers and the reframer, with or without a namespace", () => {
    ok(isRecordedAgentSlug("logic-validator"));
    ok(isRecordedAgentSlug("review-reframer"));
    ok(isRecordedAgentSlug("x:review-reframer"));
  });
  it("does not record other agents", () => {
    ok(!isRecordedAgentSlug("general-purpose"));
    ok(!isRecordedAgentSlug("review-reframer-x"));
    ok(!isRecordedAgentSlug(""));
  });
});

describe("workflow-review-core: round budget wording", () => {
  it("formatRoundBudgetHeadline names the cap reached", () => {
    strictEqual(
      formatRoundBudgetHeadline("self-extendable"),
      `Round budget reached (${ROUND_BUDGET})`,
    );
    strictEqual(
      formatRoundBudgetHeadline("reframer-review"),
      `Round self cap reached (${ROUND_SELF_CAP})`,
    );
    strictEqual(
      formatRoundBudgetHeadline("human-only"),
      `Round reframer cap reached (${ROUND_REFRAMER_CAP})`,
    );
  });

  it("self-extendable guidance offers --self-extend and --extend only", () => {
    const text = formatRoundBudgetGuidance("self-extendable", "plan.md");
    ok(text.includes("--self-extend --reason"));
    ok(text.includes("--extend --reason"));
    ok(!text.includes("--reframer-extend"));
  });

  it("reframer-review guidance tells the operator how to consult and record", () => {
    const text = formatRoundBudgetGuidance("reframer-review", "plan.md");
    for (const needle of [
      `subagent_type: ${REFRAMER_AGENT}`,
      "reframer-review.plan.md",
      "(a)",
      "(b)",
      "(c)",
      "(d)",
      "/scope-guard",
      "--reframer-extend --reason",
      "--extend --reason",
      String(ROUND_REFRAMER_CAP),
      "do not relaunch",
    ]) {
      ok(text.includes(needle), `missing: ${needle}`);
    }
    ok(!text.includes("--self-extend"));
    ok(!text.includes("model"));
  });

  it("human-only guidance leaves continuation to --extend", () => {
    const text = formatRoundBudgetGuidance("human-only", "plan.md");
    ok(text.includes("--extend --reason"));
    ok(!text.includes("--self-extend"));
    ok(!text.includes("--reframer-extend"));
  });

  it("never names a concrete model", () => {
    const phases = [
      "self-extendable",
      "reframer-review",
      "human-only",
    ] as const;
    for (const phase of phases) {
      const text = `${formatRoundBudgetHeadline(phase)}\n${formatRoundBudgetGuidance(phase, "plan.md")}`;
      ok(!/fable|opus|sonnet/i.test(text), `${phase} names a model`);
    }
  });
});

describe("workflow-review-core: extension log helpers", () => {
  it("sanitizeExtensionReason flattens control and line-separator characters", () => {
    strictEqual(sanitizeExtensionReason("a\tb\nc"), "a b c");
    strictEqual(sanitizeExtensionReason("a b"), "a b");
    strictEqual(sanitizeExtensionReason("a\u007fb"), "a b");
    strictEqual(sanitizeExtensionReason("  x  "), "x");
    strictEqual(sanitizeExtensionReason("x".repeat(600)).length, 500);
    strictEqual(sanitizeExtensionReason("\n"), "");
  });

  it("formatExtensionLogLine puts the approver before the reason", () => {
    const at = new Date("2026-10-01T00:00:00.000Z");
    strictEqual(
      formatExtensionLogLine({
        at,
        doc: "plan.md",
        round: 4,
        approver: "self",
        reason: "a\tb\nc",
      }),
      `${at.toISOString()}\tplan.md\t4\tself\ta b c`,
    );
  });
});

describe("workflow-review-core: reframer review record", () => {
  it("getReframerReviewFileName prefixes the document name", () => {
    strictEqual(
      getReframerReviewFileName("plan.md"),
      "reframer-review.plan.md",
    );
    strictEqual(
      getReframerReviewFileName("plan-2.md"),
      "reframer-review.plan-2.md",
    );
  });

  const section = (round: string, agent: string, rec: string) =>
    `## Reframer Review (Round ${round})\n- agent: ${agent}\n- recommendation: ${rec}\n- rejected: r\n`;

  it("returns the last section", () => {
    const content = `${section("6", "review-reframer", "(a)")}\n${section("7", "review-reframer", "(b)")}`;
    deepStrictEqual(parseLatestReframerReview(content), {
      round: 7,
      agent: "review-reframer",
      recommendation: "(b)",
    });
  });
  it("trims values but leaves trailing text for the caller to judge", () => {
    const content = section("6", "  review-reframer ", " (a) 続行 ");
    deepStrictEqual(parseLatestReframerReview(content), {
      round: 6,
      agent: "review-reframer",
      recommendation: "(a) 続行",
    });
  });
  it("returns null without a section or with a non-numeric round", () => {
    strictEqual(parseLatestReframerReview("nothing here\n"), null);
    strictEqual(
      parseLatestReframerReview(section("x", "review-reframer", "(a)")),
      null,
    );
  });
  it("ends a section at the next ## line", () => {
    const content = `${section("6", "review-reframer", "(a)")}## Other\n- recommendation: (b)\n`;
    strictEqual(parseLatestReframerReview(content)?.recommendation, "(a)");
  });
  it("returns null when agent or recommendation is missing", () => {
    strictEqual(
      parseLatestReframerReview(
        "## Reframer Review (Round 6)\n- recommendation: (a)\n",
      ),
      null,
    );
    strictEqual(
      parseLatestReframerReview(
        "## Reframer Review (Round 6)\n- agent: review-reframer\n",
      ),
      null,
    );
  });
  it("returns null when recommendation appears twice in a section", () => {
    const content = `${section("6", "review-reframer", "(b)")}- recommendation: (a)\n`;
    strictEqual(parseLatestReframerReview(content), null);
  });
  it("returns null when the agent line exists only in an earlier section", () => {
    const content = `${section("6", "review-reframer", "(a)")}\n## Reframer Review (Round 7)\n- recommendation: (a)\n`;
    strictEqual(parseLatestReframerReview(content), null);
  });
});

describe("workflow-review-core: reframer agent definition", () => {
  const agentFile = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../agents/review-reframer.md",
  );
  it("frontmatter name matches REFRAMER_AGENT", () => {
    const frontmatter = readFileSync(agentFile, "utf-8").split("---")[1] ?? "";
    const name = /^name:\s*(\S+)\s*$/m.exec(frontmatter)?.[1];
    strictEqual(name, REFRAMER_AGENT);
  });
  it("is not part of any reviewer roster", () => {
    const rosterSlugs = [
      ...SPEC_REVIEWERS.map((r) => r.slug as string),
      ...PLAN_REVIEWERS.map((r) => r.slug as string),
      ...REVIEWER_CATALOG.map((r) => r.subagentType),
    ];
    ok(!rosterSlugs.includes(REFRAMER_AGENT));
  });
});

describe("workflow-review-core: staged round budget notice", () => {
  const notice = (content: string) =>
    buildRecommendation("/tmp/wf/spec.md", null, content);
  const nw = (round: number | string) =>
    `<!-- auto-review: verdict=needs-work; hash=1; round=${round} -->\n`;
  const pass = (round: number) =>
    `<!-- auto-review: verdict=pass; hash=0; round=${round} -->\n`;
  const headlines = [
    "Round budget reached",
    "Round self cap reached",
    "Round reframer cap reached",
  ];

  it("is silent below the budget", () => {
    const text = notice(`## Goal\nx\n${roundsN(2)}\n${nw(2)}`);
    for (const h of headlines) ok(!text.includes(h));
  });
  for (const n of [3, 5]) {
    it(`rounds(${n}) offers a self extension`, () => {
      const text = notice(`## Goal\nx\n${roundsN(n)}\n${nw(n)}`);
      ok(text.includes(`Round budget reached (${ROUND_BUDGET})`));
      ok(text.includes("--self-extend --reason"));
      ok(!text.includes("Round self cap reached"));
    });
  }
  for (const n of [6, 8]) {
    it(`rounds(${n}) points at the reframer`, () => {
      const text = notice(`## Goal\nx\n${roundsN(n)}\n${nw(n)}`);
      ok(text.includes(`Round self cap reached (${ROUND_SELF_CAP})`));
      ok(text.includes("review-reframer"));
      ok(text.includes("--reframer-extend"));
      ok(!text.includes("--self-extend"));
    });
  }
  for (const n of [9, 10]) {
    it(`rounds(${n}) is human-only`, () => {
      const text = notice(`## Goal\nx\n${roundsN(n)}\n${nw(n)}`);
      ok(text.includes(`Round reframer cap reached (${ROUND_REFRAMER_CAP})`));
      ok(text.includes("--extend --reason"));
      ok(!text.includes("--reframer-extend"));
    });
  }
  it("uses the in-cycle count after a pass (6 in cycle)", () => {
    const text = notice(`${roundsN(9)}\n${pass(3)}${nw(9)}`);
    ok(text.includes("Round self cap reached"));
  });
  it("uses the in-cycle count after a pass (3 in cycle)", () => {
    const text = notice(`${roundsN(6)}\n${pass(3)}${nw(6)}`);
    ok(text.includes("Round budget reached"));
    ok(!text.includes("Round self cap reached"));
  });

  it("stays silent while the newest round is only a skeleton", () => {
    const text = notice(`${roundsN(6)}\n${nw(5)}`);
    for (const h of headlines) ok(!text.includes(h));
  });
  it("speaks once the newest round is stamped", () => {
    ok(notice(`${roundsN(6)}\n${nw(6)}`).includes("Round self cap reached"));
  });
  it("treats a marker without round= as stamped", () => {
    const text = notice(
      `${roundsN(6)}\n<!-- auto-review: verdict=needs-work; hash=1 -->\n`,
    );
    ok(text.includes("Round self cap reached"));
  });
});
