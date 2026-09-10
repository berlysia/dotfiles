#!/usr/bin/env node
// Document Workflow session audit (spec K8 acceptance check).
//
// Given one or more `.tmp/sessions/<id>` directories, report the ceremony
// completeness and rough injection volume so a post-change 5-session sweep can
// confirm the overhaul held: Reviewer Outputs present, intent-triage present,
// and the plan-review recommendation cost stayed bounded (round count × ~2KB).
//
// Usage: node docs/scripts/workflow-session-audit.mjs .tmp/sessions/<id> [...]
// Checked in (not $CLAUDE_JOB_DIR-ephemeral) so the K8 acceptance check is
// reproducible.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

function auditDoc(path) {
  const content = readFileSync(path, "utf-8");
  const rounds = (content.match(/^## Reviewer Outputs \(Round \d+\)/gm) ?? [])
    .length;
  const hasTriage = /<!--\s*intent-triage:\s*adopted=/.test(content);
  const hasMarker = /<!--\s*auto-review:\s*verdict=/.test(content);
  return {
    doc: basename(path),
    bytes: Buffer.byteLength(content, "utf-8"),
    reviewerOutputRounds: rounds,
    hasTriage,
    hasMarker,
  };
}

function auditSession(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { dir, error: "not a directory" };
  }
  const docs = readdirSync(dir).filter(
    (n) => n === "spec.md" || n === "plan.md" || /^plan-\d+\.md$/.test(n),
  );
  const results = docs.map((n) => auditDoc(join(dir, n)));
  const missingReviewerOutputs = results.filter(
    (r) => r.hasMarker && r.reviewerOutputRounds === 0,
  );
  const missingTriage = results.filter((r) => r.hasMarker && !r.hasTriage);
  return {
    dir,
    docs: results,
    missingReviewerOutputs: missingReviewerOutputs.map((r) => r.doc),
    missingTriage: missingTriage.map((r) => r.doc),
  };
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error(
    "usage: node docs/scripts/workflow-session-audit.mjs <session-dir> [...]",
  );
  process.exit(2);
}

const report = targets.map(auditSession);
console.log(JSON.stringify(report, null, 2));

const anyGap = report.some(
  (s) =>
    !s.error &&
    (s.missingReviewerOutputs.length > 0 || s.missingTriage.length > 0),
);
// Exit non-zero if any approved-marker doc is missing its mandatory Reviewer
// Outputs or intent-triage — the K8 acceptance criterion.
process.exit(anyGap ? 1 : 0);
