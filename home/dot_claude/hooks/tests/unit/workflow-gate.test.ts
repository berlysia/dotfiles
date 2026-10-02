#!/usr/bin/env node --test

import { equal, match, ok } from "node:assert";
import { test } from "node:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeDocumentHash,
  SPEC_NORMALIZERS,
} from "../../lib/document-hash.ts";
import { appendApproval } from "../../lib/workflow-approval.ts";
import {
  diagnoseGate,
  evaluateApprovalReadiness,
  evaluateTarget,
  formatGateDiagnosis,
  listApprovalCandidates,
} from "../../lib/workflow-gate.ts";
import {
  approvedWorkflowRepo,
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  pendingWorkflowRepo,
  recordApprovalsForTest,
} from "./test-helpers.ts";

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
  recordApprovalsForTest(wf);
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  for (const cond of Object.values(d.primary.conditions)) {
    equal(cond.ok, true);
  }
  match(d.nextAction, /satisfied/);
});

test("diagnoseGate points approval at a conversational 承認 when only approval is pending", () => {
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
  match(d.nextAction, /承認 plan\.md/);
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
  recordApprovalsForTest(wf);
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

/** <repo>/.tmp/sessions/x with research.md, an approved spec.md and plan-1.md listing `files`. */
function twoLayerRepo(files: string[], omitParentSpecHash = false) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-2layer-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  const spec = buildPlanContent(approvedWorkflowRepo());
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      approvedWorkflowRepo(),
      files,
      computeWorkflowRepoPlanHash(spec),
      omitParentSpecHash,
    ),
  );
  recordApprovalsForTest(wf);
  return { repo, wf };
}

test("evaluateTarget: inactive without research.md or plan.md", () => {
  const wf = freshWf();
  equal(
    evaluateTarget({ wfDir: wf, target: join(wf, "a.ts"), projectRoot: wf })
      .kind,
    "inactive",
  );
});

test("evaluateTarget: single-layer approved plan allows and names plan.md", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const e = evaluateTarget({
    wfDir: wf,
    target: "/r/src/a.ts",
    projectRoot: "/r",
  });
  equal(e.kind, "allow");
  equal(e.kind === "allow" && e.owner, join(wf, "plan.md"));
});

test("evaluateTarget: an approved plan without research.md still denies", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  equal(
    evaluateTarget({ wfDir: wf, target: "/r/src/a.ts", projectRoot: "/r" })
      .kind,
    "deny",
  );
});

test("evaluateTarget: single-layer pending plan denies with a diagnosis", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  const e = evaluateTarget({
    wfDir: wf,
    target: "/r/src/a.ts",
    projectRoot: "/r",
  });
  equal(e.kind, "deny");
  ok(e.kind === "deny" && !e.diagnosis.primary.conditions.approvalStatus.ok);
});

test("evaluateTarget: two-layer allows a listed target and names its plan-N.md", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  equal(e.kind, "allow");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-1.md"));
});

test("evaluateTarget: two-layer unlisted target is no-plan-owner during implementation", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "b.ts"),
    projectRoot: repo,
  });
  equal(e.kind, "no-plan-owner");
  equal(e.kind === "no-plan-owner" && e.implementationPhase, true);
});

test("evaluateTarget: a plan-N.md without parent-spec-hash denies its listed target", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"], true);
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("evaluateTarget: an approved plan without a ledger entry denies, naming the next step", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  const record = e.diagnosis.primary.conditions.approvalRecord;
  equal(record.ok, false);
  match(record.foundLine ?? "", /^recorded=none current=[0-9a-f]{12}$/);
  match(e.diagnosis.nextAction, /承認 plan\.md/);
  match(
    formatGateDiagnosis(e.diagnosis, "src/a.ts"),
    /✗ approval \(found: recorded=none/,
  );
});

test("evaluateTarget: a ledger entry for an older version does not approve the current one", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  appendApproval(wf, {
    doc: "plan.md",
    hash: "c".repeat(64),
    session: "s",
    at: "t",
  });
  appendFileSync(join(wf, "approvals.log"), "garbage\n");
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  match(
    e.diagnosis.primary.conditions.approvalRecord.foundLine ?? "",
    /^recorded=cccccccccccc current=[0-9a-f]{12}; ignored-lines=1$/,
  );
});

test("evaluateTarget: an unreadable ledger keeps the gate closed", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  mkdirSync(join(wf, "approvals.log"));
  const e = evaluateTarget({
    projectRoot: "/r",
    wfDir: wf,
    target: "/r/src/a.ts",
  });
  equal(e.kind, "deny");
  if (e.kind !== "deny") return;
  match(
    e.diagnosis.primary.conditions.approvalRecord.foundLine ?? "",
    /ledger-unreadable/,
  );
});

test("evaluateTarget: the ledger's session is not matched", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  const plan = buildPlanContent(approvedWorkflowRepo());
  writeFileSync(join(wf, "plan.md"), plan);
  appendApproval(wf, {
    doc: "plan.md",
    hash: computeDocumentHash(plan, SPEC_NORMALIZERS),
    session: "another-session",
    at: "t",
  });
  equal(
    evaluateTarget({ projectRoot: "/r", wfDir: wf, target: "/r/src/a.ts" })
      .kind,
    "allow",
  );
});

test("evaluateTarget: the Approval line still revokes a recorded approval", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const approved = readFileSync(join(wf, "plan.md"), "utf-8");
  writeFileSync(
    join(wf, "plan.md"),
    approved.replace(
      "- Approval Status: approved",
      "- Approval Status: pending",
    ),
  );
  equal(
    evaluateTarget({ projectRoot: "/r", wfDir: wf, target: "/r/src/a.ts" })
      .kind,
    "deny",
  );
});

test("evaluateApprovalReadiness and listApprovalCandidates: ready means every condition but approval", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  equal(evaluateApprovalReadiness(wf, "plan.md").ready, false);
  equal(listApprovalCandidates(wf).length, 0);
  writeFileSync(
    join(wf, "plan.md"),
    buildPlanContent({
      planStatus: "complete",
      approvalStatus: "pending",
      review: { verdict: "pass" },
    }),
  );
  const r = evaluateApprovalReadiness(wf, "plan.md");
  equal(r.ready, true);
  equal(r.alreadyApproved, false);
  match(r.hash, /^[0-9a-f]{64}$/);
  equal(listApprovalCandidates(wf).join(","), "plan.md");
});

test("two-layer: once spec.md passes, the note and next step ask for 承認 of the owning plan-N.md", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "spec.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  ok(d.note && /承認 plan-N\.md/.test(d.note));
  match(d.nextAction, /承認 plan-N\.md/);
});
