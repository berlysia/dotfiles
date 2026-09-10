#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  runWorkflowCli,
  wouldTouchApprovalStatus,
} from "../../cli/workflow.ts";
import { seedWorkflow } from "./test-helpers.ts";

const NOW = new Date("2026-09-10T05:00:00.000Z");

describe("workflow-cli: stamp", () => {
  it("fails when the ledger lacks a mandatory reviewer", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: ["logic-validator"], // scope-justification-reviewer missing
    });
    const r = runWorkflowCli(
      [
        "stamp",
        "plan-1.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /scope-justification-reviewer/);
    // document must be unchanged
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8");
    assert.doesNotMatch(doc, /^- Review Status: pass$/m);
  });

  it("writes strict Review Status and appends a marker when the ledger is complete", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    const r = runWorkflowCli(
      [
        "stamp",
        "plan-1.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.equal(r.exitCode, 0);
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8");
    assert.match(doc, /^- Review Status: pass$/m);
    assert.match(doc, /<!-- auto-review: verdict=pass; hash=[0-9a-f]{64};/);
    assert.match(doc, /parent-spec-hash=[0-9a-f]{64}/);
  });

  it("normalizes plugin-namespaced ledger entries when checking coverage", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-2.md",
      round: 1,
      ledgerSlugs: [],
    });
    // Hand-write a ledger with a namespaced subagent_type instead of a bare one.
    // Timestamps must fall at/after the round baseline seedWorkflow wrote
    // (real clock), so use "now + a little" rather than a fixed past instant.
    const afterBaseline = new Date(Date.now() + 1_000).toISOString();
    writeFileSync(
      ledger,
      [
        `test-ses\tlogic-validator\t${afterBaseline}`,
        `test-ses\tcompound-engineering:review:scope-justification-reviewer\t${afterBaseline}`,
      ].join("\n") + "\n",
    );
    const r = runWorkflowCli(
      [
        "stamp",
        "plan-2.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.equal(r.exitCode, 0, r.stderr);
  });

  it("fails when no Reviewer Outputs round section exists", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-3.md",
      round: 0,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    const r = runWorkflowCli(
      [
        "stamp",
        "plan-3.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Reviewer Outputs/);
  });
});

describe("workflow-cli: round", () => {
  it("inserts the next round skeleton and records a round-baseline entry", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(["round", "plan-1.md"], {
      cwd: wf,
      wfDir: wf,
      sessionId: "test-ses",
      now: NOW,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8");
    assert.match(doc, /## Reviewer Outputs \(Round 2\)/);
    assert.ok(existsSync(join(wf, ".round-baseline")));
    const baseline = readFileSync(join(wf, ".round-baseline"), "utf-8");
    assert.match(baseline, /^2\t/m);
  });
});

describe("workflow-cli: triage", () => {
  it("appends an intent-triage marker", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(
      ["triage", "plan-1.md", "--adopted", "3", "--excluded", "1"],
      { cwd: wf, wfDir: wf, sessionId: "test-ses", now: NOW },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8");
    assert.match(
      doc,
      /<!-- intent-triage: adopted=3; excluded=1; at=2026-09-10T05:00:00\.000Z -->/,
    );
  });
});

describe("workflow-cli: Approval Status is never touched", () => {
  it("wouldTouchApprovalStatus detects any diff to the Approval Status line", () => {
    const before = "- Plan Status: complete\n- Approval Status: pending\n";
    const untouched =
      "- Plan Status: complete\n- Review Status: pass\n- Approval Status: pending\n";
    const touched = "- Plan Status: complete\n- Approval Status: approved\n";
    assert.equal(wouldTouchApprovalStatus(before, untouched), false);
    assert.equal(wouldTouchApprovalStatus(before, touched), true);
  });
});

describe("workflow-cli: status", () => {
  it("reports the gate diagnosis without throwing", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(["status"], {
      cwd: wf,
      wfDir: wf,
      sessionId: "test-ses",
      now: NOW,
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Document workflow gate/);
    assert.match(r.stdout, /tripwire:/);
  });
});
