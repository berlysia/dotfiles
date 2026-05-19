#!/usr/bin/env node --test
import { deepStrictEqual, ok } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PLAN_REVIEWERS,
  SPEC_REVIEWERS,
} from "../../implementations/plan-review-automation.ts";

// Test file: <repo>/home/dot_claude/hooks/tests/unit/. workflow.md is at
// <repo>/home/dot_claude/rules/ (3 levels up to dot_claude). docs/ is at the
// repo root, a sibling of home/ (5 levels up).
const rulesUrl = (p: string) =>
  fileURLToPath(new URL(`../../../rules/${p}`, import.meta.url));
const repoUrl = (p: string) =>
  fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));

describe("S1: mechanical-lane routing row", () => {
  const wf = () => readFileSync(rulesUrl("workflow.md"), "utf-8");

  it("workflow.md routing table contains a mechanical-lane row mapping to plan.md-only", () => {
    const c = wf();
    ok(c.includes("mechanical-lane"));
    ok(/mechanical-lane[^\n]*plan\.md/.test(c.replace(/\n/g, " ")));
  });

  it("criteria states 4 conditions and the AND requirement with no-fallback to two-layer", () => {
    const c = wf();
    ok(
      c.includes("(i)") &&
        c.includes("(ii)") &&
        c.includes("(iii)") &&
        c.includes("(iv)"),
    );
    ok(c.includes("AND") || c.includes("全条件"));
    ok(
      c.includes("1条件でも") ||
        c.includes("いずれか") ||
        c.includes("1 条件でも"),
    );
    ok(c.includes("判定根拠") && c.includes("plan.md"));
  });

  it("criteria text avoids banned vague words as sole basis", () => {
    const c = wf();
    const section = c.slice(c.indexOf("mechanical-lane"));
    ok(
      !/criteria[^\n]*(シンプルだから|安全だから|リスクが低いから)/.test(
        section,
      ),
    );
  });
});

describe("S1: ADR-0009 amends (not supersedes) ADR-0006, ADR-0005 unrevised", () => {
  const adr9 = () =>
    readFileSync(
      repoUrl("docs/decisions/0009-document-workflow-mechanical-lane.md"),
      "utf-8",
    );
  const adr6 = () =>
    readFileSync(
      repoUrl("docs/decisions/0006-document-workflow-two-layer.md"),
      "utf-8",
    );

  it("ADR-0009 exists with Status and explicitly amends ADR-0006", () => {
    const c = adr9();
    ok(/##\s*Status/.test(c));
    ok(c.includes("Amends ADR-0006") || c.includes("ADR-0006 を amend"));
    ok(c.includes("supersede しない") || c.includes("not supersede"));
  });

  it("ADR-0009 states ADR-0005 is unrevised (reviewer constants immutable)", () => {
    ok(adr9().includes("ADR-0005"));
    ok(/ADR-0005[^\n]*(無改訂|unchanged|immutable|不変)/.test(adr9()));
  });

  it("ADR-0006 has a forward-reference to ADR-0009", () => {
    ok(adr6().includes("0009"));
  });
});

describe("S1: ADR-0005 unrevised — reviewer constant slug sets immutable", () => {
  it("SPEC_REVIEWERS slug set is exactly the 4 design-layer reviewers", () => {
    deepStrictEqual(
      new Set(SPEC_REVIEWERS.map((r) => r.slug as string)),
      new Set([
        "logic-validator",
        "scope-justification-reviewer",
        "decision-quality-reviewer",
        "greenfield-perspective-reviewer",
      ]),
    );
  });
  it("PLAN_REVIEWERS slug set is exactly the 2 execution-layer reviewers", () => {
    deepStrictEqual(
      new Set(PLAN_REVIEWERS.map((r) => r.slug as string)),
      new Set(["logic-validator", "scope-justification-reviewer"]),
    );
  });
});
