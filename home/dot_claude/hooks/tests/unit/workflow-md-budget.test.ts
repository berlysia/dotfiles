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

const BUDGET_BYTES = 12 * 1024;

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
