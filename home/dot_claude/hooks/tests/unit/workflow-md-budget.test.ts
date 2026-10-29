#!/usr/bin/env node --test

import { equal, ok } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Repo root = five levels up from this test file
// (home/dot_claude/hooks/tests/unit/ -> repo root).
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");
const workflowMd = join(repoRoot, "home/dot_claude/rules/workflow.md");
const referenceSkill = join(
  repoRoot,
  ".skills/document-workflow-reference/SKILL.md",
);

// workflow.md is loaded in every session, so keep the ceiling close to the
// actual size. ADR-0025 trimmed it to about 11KB under a 12KB ceiling; ADR-0032
// raised the ceiling back to 13KB for the throwaway-script routing line, which
// must be read when a task starts and so cannot live in the reference skill.
// Raising it again needs its own reason recorded in an ADR. The extra 256
// bytes carry the approval-summary rule to the flow where the summary is
// written before `ask-approval` runs; the record is in ADR-0035's Amendments.
// Another 512 bytes carry the two reviewer-routing lines (step 5.4 and the
// record line under step 6), which must be read on every review round; their
// details live in the reference skill. The record is in ADR-0057.
const BUDGET_BYTES = 13 * 1024 + 768;

test("workflow.md stays within the operator-guide budget (K8)", () => {
  ok(existsSync(workflowMd), "workflow.md must exist");
  const size = statSync(workflowMd).size;
  ok(
    size <= BUDGET_BYTES,
    `workflow.md is ${size} bytes, must be <= ${BUDGET_BYTES}`,
  );
});

test("workflow.md keeps both SSoT reviewer marker regions (drift test depends on them)", () => {
  const content = readFileSync(workflowMd, "utf-8");
  for (const marker of [
    "ssot:spec-reviewers:start",
    "ssot:spec-reviewers:end",
    "ssot:plan-reviewers:start",
    "ssot:plan-reviewers:end",
  ]) {
    ok(content.includes(marker), `workflow.md must keep <!-- ${marker} -->`);
  }
});

test("workflow.md points the model at workflow-cli and the reference skill", () => {
  const content = readFileSync(workflowMd, "utf-8");
  ok(/workflow-cli/.test(content), "must mention workflow-cli");
  ok(
    /document-workflow-reference/.test(content),
    "must point at the reference skill",
  );
});

test("the document-workflow-reference skill exists", () => {
  ok(
    existsSync(referenceSkill),
    ".skills/document-workflow-reference/SKILL.md must exist",
  );
  const content = readFileSync(referenceSkill, "utf-8");
  ok(content.startsWith("---"), "reference skill must have frontmatter");
  ok(/name: document-workflow-reference/.test(content), "frontmatter name");
});

test("keeps the approval invariants in the operator guide", () => {
  const content = readFileSync(workflowMd, "utf-8");
  for (const fixed of [
    "## CRITICAL: 承認は人間のみ",
    "AskUserQuestion の `answers` を入れない",
    "承認行と `approvals.log` を書かない",
  ]) {
    ok(content.includes(fixed), `workflow.md must keep: ${fixed}`);
  }
});
