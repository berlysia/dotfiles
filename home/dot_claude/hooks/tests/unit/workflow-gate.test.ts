#!/usr/bin/env node --test

import { equal, match, ok } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDocumentHash,
  SPEC_NORMALIZERS,
} from "../../lib/document-hash.ts";
import { diagnoseGate, formatGateDiagnosis } from "../../lib/workflow-gate.ts";

function freshWf(): string {
  const wf = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(wf, { recursive: true });
  return wf;
}

test("diagnoseGate flags a hyphen-less Review Status as the failing line", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(
    join(wf, "plan.md"),
    [
      "- Plan Status: complete",
      "Review Status: pass",
      "- Approval Status: approved",
    ].join("\n"),
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  equal(d.twoLayer, false);
  equal(d.primary.conditions.planStatus.ok, true);
  equal(d.primary.conditions.reviewStatus.ok, false);
  match(
    d.primary.conditions.reviewStatus.foundLine ?? "",
    /Review Status: pass/,
  );
  match(d.nextAction, /workflow-cli/);
});

test("diagnoseGate reports all conditions satisfied for an approved single-layer plan", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  const body = [
    "# Plan",
    "",
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: pass",
    "- Approval Status: approved",
  ].join("\n");
  const hash = computeDocumentHash(body, SPEC_NORMALIZERS);
  writeFileSync(
    join(wf, "plan.md"),
    `${body}\n\n<!-- auto-review: verdict=pass; hash=${hash}; at=2026-01-01T00:00:00Z; reviewers=logic-validator -->`,
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  for (const cond of Object.values(d.primary.conditions)) {
    equal(cond.ok, true);
  }
  match(d.nextAction, /satisfied/);
});

test("diagnoseGate points approval at a human when only approval is pending", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  const body = [
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: pass",
    "- Approval Status: pending",
  ].join("\n");
  const hash = computeDocumentHash(body, SPEC_NORMALIZERS);
  writeFileSync(
    join(wf, "plan.md"),
    `${body}\n\n<!-- auto-review: verdict=pass; hash=${hash}; at=2026-01-01T00:00:00Z -->`,
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  equal(d.primary.conditions.approvalStatus.ok, false);
  match(d.nextAction, /human/);
});

test("two-layer diagnosis adds the owning plan-N note once spec.md passes", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  const body = [
    "## Approval",
    "- Plan Status: complete",
    "- Review Status: pass",
    "- Approval Status: approved",
  ].join("\n");
  const hash = computeDocumentHash(body, SPEC_NORMALIZERS);
  writeFileSync(
    join(wf, "spec.md"),
    `${body}\n\n<!-- auto-review: verdict=pass; hash=${hash}; at=2026-01-01T00:00:00Z -->`,
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  equal(d.twoLayer, true);
  ok(d.note && /plan-N\.md/.test(d.note));
});

test("formatGateDiagnosis renders the failing condition with a checkmark line", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(
    join(wf, "plan.md"),
    [
      "- Plan Status: complete",
      "- Review Status: needs-work",
      "- Approval Status: pending",
    ].join("\n"),
  );
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  const text = formatGateDiagnosis(d, "src/a.ts");
  match(text, /✗ Review Status/);
  match(text, /Next:/);
});
