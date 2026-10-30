#!/usr/bin/env node --test

import { equal, match, ok } from "node:assert";
import { test } from "node:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
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
  classifyPlan,
  diagnoseGate,
  evaluateApprovalReadiness,
  evaluateTarget,
  formatGateDiagnosis,
  formatTargetEvaluation,
  implementationPhaseBasis,
  isImplementationPhase,
  listApprovalCandidates,
  resolveDelegationOffer,
  resolveSpecContext,
  summarizePlans,
} from "../../lib/workflow-gate.ts";
import { resolveWorkflowPaths } from "../../lib/workflow-paths.ts";
import {
  approvedWorkflowRepo,
  buildPlanContent,
  buildPlanNContent,
  buildSpecWithScope,
  computeWorkflowRepoPlanHash,
  pendingWorkflowRepo,
  recordApprovalsForTest,
} from "../support/test-helpers.ts";

function freshWf(): string {
  const wf = realpathSync(mkdtempSync(join(tmpdir(), "gate-")));
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
  equal(d.research.ok, true);
  match(formatGateDiagnosis(d, "src/a.ts"), /✓ research\.md/);
});

test("diagnoseGate names a missing research.md instead of saying the gate is satisfied", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  equal(d.research.ok, false);
  match(d.nextAction, /research\.md/);
  const text = formatGateDiagnosis(d, "src/a.ts");
  match(text, /✗ research\.md/);
  ok(!/satisfied/.test(text));
});

test("diagnoseGate asks for research.md before the approval when both are missing", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  match(d.nextAction, /research\.md/);
  ok(!/承認/.test(d.nextAction));
});

test("diagnoseGate in two-layer mode without research.md drops the plan-N note", () => {
  const { wf } = twoLayerRepo(["src/a.ts"]);
  unlinkSync(join(wf, "research.md"));
  const d = diagnoseGate(wf, "src/a.ts");
  equal(d.note, undefined);
  match(formatGateDiagnosis(d, "src/a.ts"), /✗ research\.md/);
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
  match(d.nextAction, /ask-approval/);
  match(d.nextAction, /approve plan\.md/);
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
function twoLayerRepo(
  files: string[],
  omitParentSpecHash = false,
  approval: { specApproved?: boolean; planApproved?: boolean } = {},
) {
  const { specApproved = true, planApproved = true } = approval;
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-2layer-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  const spec = buildPlanContent(
    specApproved ? approvedWorkflowRepo() : pendingWorkflowRepo(),
  );
  writeFileSync(join(wf, "spec.md"), spec);
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      planApproved ? approvedWorkflowRepo() : pendingWorkflowRepo(),
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
  equal(e.kind === "no-plan-owner" && e.relaxable, true);
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
  match(e.diagnosis.nextAction, /ask-approval/);
  match(e.diagnosis.nextAction, /approve plan\.md/);
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

test("evaluateApprovalReadiness: title comes from the normalized text the hash covers", () => {
  const wf = freshWf();
  const reviewed = buildPlanContent({
    planStatus: "complete",
    approvalStatus: "pending",
    review: { verdict: "pass" },
  });
  const content = `# Spec: Z\n\n${reviewed}`;
  writeFileSync(join(wf, "plan.md"), content);
  const r = evaluateApprovalReadiness(wf, "plan.md");
  equal(r.title, "Spec: Z");
  equal(r.hash, computeDocumentHash(content, SPEC_NORMALIZERS));
  // The marker hash covers the document without the H1, so the gate is not ready.
  equal(r.ready, false);
  equal(r.alreadyApproved, false);
});

test("evaluateApprovalReadiness: title is null when the document is unreadable or has no H1", () => {
  const wf = freshWf();
  equal(evaluateApprovalReadiness(wf, "plan.md").title, null);
  writeFileSync(
    join(wf, "plan.md"),
    buildPlanContent({
      planStatus: "complete",
      approvalStatus: "pending",
      review: { verdict: "pass" },
    }),
  );
  equal(evaluateApprovalReadiness(wf, "plan.md").title, null);
});

test("evaluateApprovalReadiness: plan-N.md readable but spec.md not: hash computed, title null", () => {
  const wf = freshWf();
  const plan = `# Plan: Y\n\n${buildPlanContent({
    planStatus: "complete",
    approvalStatus: "pending",
    review: { verdict: "pass" },
  })}`;
  writeFileSync(join(wf, "plan-1.md"), plan);
  const r = evaluateApprovalReadiness(wf, "plan-1.md");
  equal(r.title, null);
  equal(r.hash, computeDocumentHash(plan, SPEC_NORMALIZERS));
  equal(r.ready, false);
});

test("evaluateApprovalReadiness: an H1 only inside a Reviewer Outputs section is not a title", () => {
  const wf = freshWf();
  writeFileSync(
    join(wf, "plan.md"),
    `## Reviewer Outputs (Round 1)\n# x\n\n${buildPlanContent({
      planStatus: "complete",
      approvalStatus: "pending",
    })}`,
  );
  equal(evaluateApprovalReadiness(wf, "plan.md").title, null);
});

test("two-layer: once spec.md passes, the note and next step ask for 承認 of the owning plan-N.md", () => {
  const wf = freshWf();
  writeFileSync(join(wf, "research.md"), "x");
  writeFileSync(join(wf, "spec.md"), buildPlanContent(approvedWorkflowRepo()));
  recordApprovalsForTest(wf);
  const d = diagnoseGate(wf, join(wf, "..", "src", "a.ts"));
  ok(d.note && /approve plan-N\.md/.test(d.note));
  ok(d.note && /ask-approval/.test(d.note));
  match(d.nextAction, /ask-approval/);
  match(d.nextAction, /approve plan-N\.md/);
});

test("isImplementationPhase is false without research.md, single-layer and two-layer", () => {
  const single = freshWf();
  writeFileSync(
    join(single, "plan.md"),
    buildPlanContent(approvedWorkflowRepo()),
  );
  recordApprovalsForTest(single);
  equal(
    isImplementationPhase(single, resolveWorkflowPaths(single), false, single),
    false,
  );

  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  equal(isImplementationPhase(wf, resolveWorkflowPaths(wf), true, repo), true);
  unlinkSync(join(wf, "research.md"));
  equal(isImplementationPhase(wf, resolveWorkflowPaths(wf), true, repo), false);
});

// Invariant: whenever the gate is closed (deny, or no-plan-owner outside the
// implementation phase), the rendered diagnosis shows a failing line (a ✗ row
// or a `note:` line) and never says the conditions are satisfied. When a gate
// condition is added, add the states that exercise it to this table.
// Before diagnoseGate reported research.md, only "single-layer approved plan,
// research.md missing" broke it (all rows ✓ yet "satisfied"). The two-layer rows
// were already covered by the specOk note and are regression guards.
interface InvariantState {
  name: string;
  build: () => { repo: string; wf: string; target: string };
}

function singleLayerState(approved: boolean): InvariantState["build"] {
  return () => {
    const wf = freshWf();
    writeFileSync(join(wf, "research.md"), "x");
    writeFileSync(
      join(wf, "plan.md"),
      buildPlanContent(
        approved ? approvedWorkflowRepo() : pendingWorkflowRepo(),
      ),
    );
    recordApprovalsForTest(wf);
    return { repo: wf, wf, target: join(wf, "src", "a.ts") };
  };
}

function twoLayerState(
  options: Parameters<typeof twoLayerRepo>[2],
  omitParentSpecHash = false,
  listed = "src/a.ts",
): InvariantState["build"] {
  return () => {
    const { repo, wf } = twoLayerRepo([listed], omitParentSpecHash, options);
    return { repo, wf, target: join(repo, "src", "a.ts") };
  };
}

const INVARIANT_STATES: InvariantState[] = [
  { name: "single-layer pending plan", build: singleLayerState(false) },
  { name: "single-layer approved plan", build: singleLayerState(true) },
  {
    name: "two-layer, spec pending",
    build: twoLayerState({ specApproved: false }),
  },
  {
    name: "two-layer, spec approved, plan-1 pending",
    build: twoLayerState({ planApproved: false }),
  },
  { name: "two-layer, both approved", build: twoLayerState({}) },
  {
    name: "two-layer, plan-1 without parent-spec-hash",
    build: twoLayerState({}, true),
  },
  {
    name: "two-layer, no plan-N lists the target, plan-1 pending",
    build: twoLayerState({ planApproved: false }, false, "src/b.ts"),
  },
];

for (const withResearch of [true, false]) {
  for (const state of INVARIANT_STATES) {
    test(`gate-closed diagnosis names a failure (${state.name}, research.md ${withResearch ? "present" : "missing"})`, () => {
      const { repo, wf, target } = state.build();
      if (!withResearch) {
        unlinkSync(join(wf, "research.md"));
      }
      const e = evaluateTarget({ wfDir: wf, target, projectRoot: repo });
      const closed =
        e.kind === "deny" || (e.kind === "no-plan-owner" && !e.relaxable);
      if (!closed) {
        return;
      }
      const text = formatGateDiagnosis(e.diagnosis, "src/a.ts");
      ok(/✗ /.test(text) || /\n {2}note: /.test(text), text);
      ok(!/satisfied/.test(text), text);
    });
  }
}

interface DelegPlan {
  name: string;
  files: string[];
  approved?: boolean;
  body?: string;
}

function delegatedRepo(
  scope: string[],
  plans: DelegPlan[],
  options: { delegate?: boolean } = {},
) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gate-deleg-")));
  const wf = join(repo, ".tmp", "sessions", "x");
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, "research.md"), "x");
  const spec = buildSpecWithScope(approvedWorkflowRepo(), scope);
  writeFileSync(join(wf, "spec.md"), spec);
  for (const plan of plans) {
    const base = approvedWorkflowRepo();
    writeFileSync(
      join(wf, plan.name),
      buildPlanNContent(
        plan.approved ? base : { ...base, approvalStatus: "pending" },
        plan.files,
        computeWorkflowRepoPlanHash(spec),
        false,
        plan.body,
      ),
    );
  }
  recordApprovalsForTest(wf, { delegateSpec: options.delegate ?? true });
  return { repo, wf };
}

function classifyDelegationBody(body: string, approved = false) {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"], approved, body }],
  );
  return classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
}

function assertExternalSendBlocked(body: string) {
  const result = classifyDelegationBody(body);
  equal(result.kind, "blocked");
  ok(
    result.kind === "blocked" &&
      result.blockedBy.includes("外部送信: 可 の Task があるため委任しない"),
  );
}

const externalSendBlockedCases: Array<[string, string]> = [
  ["a canonical available row", "**外部送信**: 可"],
  ["a row without space after the colon", "**外部送信**:可"],
  ["a row whose value begins with 可", "**外部送信**: 可能"],
  ["an English available value", "外部送信: yes"],
  ["a fullwidth colon with an available value", "**外部送信**：可"],
  ["a bullet-prefixed available row", "- **外部送信**: 可"],
  ["an available row inside a code fence", "```\n**外部送信**: 可\n```"],
  ["the term without a colon or value", "**外部送信**"],
  ["a row with an empty value", "**外部送信**: "],
  [
    "an explanatory comment that mentions the term, even beside a deny row",
    "<!-- 外部送信: 可は、この Task の本文を外部へ送ってよいという承認 -->\n**外部送信**: 不可",
  ],
  [
    "comment rows inside a code fence and after a quoted fence marker",
    [
      "```",
      "<!-- **外部送信**: 可 -->",
      "> ```",
      "<!-- **外部送信**: 可 -->",
      "```",
    ].join("\n"),
  ],
  ["a deny row whose reason mentions 可", "**外部送信**: 不可（Task 2 は可）"],
  [
    "a deny-looking row whose reason mentions the term",
    "**外部送信**: 不可（外部送信しない）",
  ],
  ["a quoted deny row", "> **外部送信**: 不可"],
  ["a deny row with an unrecognized prefix", "x **外部送信**: 不可"],
  [
    "a value that appends text after 不可",
    "**外部送信**: 不可。ただし Task 2 は可",
  ],
  ["a value that starts with 不可 but continues", "**外部送信**: 不可能"],
  [
    "a reason with a second parenthetical group",
    "**外部送信**: 不可（a）可（b）",
  ],
  [
    "a reason with separated parenthetical groups",
    "**外部送信**: 不可（x） 可 （y）",
  ],
  ["two parenthetical reason groups", "**外部送信**: 不可（a）（b）"],
  ["a nested parenthetical reason", "**外部送信**: 不可（a（b））"],
  [
    "a reason containing angle brackets",
    "**外部送信**: 不可 <ただし Task 2 は可>",
  ],
  ["an angle-bracketed available value", "外部送信: 不可 < 可 >"],
  [
    "a comment opener, available row, and comment closer on separate lines",
    "<!--\n**外部送信**: 可\n-->",
  ],
  [
    "invalid numeric character references beside an available row",
    "&#x110000; &#xD800; &#0;\n**外部送信**: 可",
  ],
];

for (const [description, body] of externalSendBlockedCases) {
  test(`classifyPlan: external-send gate blocks ${description}`, () => {
    assertExternalSendBlocked(body);
  });
}

const externalSendDelegatedCases: Array<[string, string]> = [
  ["one strict deny row", "**外部送信**: 不可"],
  ["an NFKC-normalized fullwidth deny row", "＊＊外部送信＊＊： 不可"],
  [
    "a deny row with a non-disclosing parenthetical reason",
    "**外部送信**: 不可（brief に非公開の設計を含む）",
  ],
  ["a deny row with ASCII parentheses", "**外部送信**: 不可(reason)"],
  [
    "a comment that explains the field without the term plus a deny row",
    "<!-- この欄に 可 と書くと、この Task の本文を外部へ送ってよいという承認になる -->\n**外部送信**: 不可",
  ],
  ["a strict deny row inside a code fence", "```\n**外部送信**: 不可\n```"],
  ["two strict deny rows", "**外部送信**: 不可\n**外部送信**: 不可"],
  [
    "numbered and indented bullet deny rows",
    "1. 外部送信: 不可\n   * **外部送信**: 不可",
  ],
  [
    "strict deny rows separated by a bare carriage return",
    "**外部送信**: 不可\r**外部送信**: 不可",
  ],
  [
    "invalid numeric references after removing the strict deny row",
    "**外部送信**: 不可\n&#x110000; &#xD800; &#0;",
  ],
];

for (const [description, body] of externalSendDelegatedCases) {
  test(`classifyPlan: external-send gate delegates with ${description}`, () => {
    equal(classifyDelegationBody(body).kind, "delegated");
  });
}

test("classifyPlan: absence of an external-send row is outside the guarantee", () => {
  equal(classifyDelegationBody("Ordinary task body.").kind, "delegated");
});

const obfuscatedExternalSendCases: Array<[string, string]> = [
  ["emphasis in the middle of the term", "外部**送信**: 可"],
  ["a numeric character reference", "外部&#x9001;信: 可"],
  ["a zero-width numeric character reference", "外部&#8203;送信: 可"],
  ["a space numeric character reference", "外部&#x20;送信: 可"],
  ["a named soft-hyphen reference", "外部&shy;送信: 可"],
  ["a named nonbreaking-space reference", "外部&nbsp;送信: 可"],
  ["a numeric reference without a semicolon", "外部&#x9001信: 可"],
  ["an uppercase hexadecimal marker", "外部&#X9001;信: 可"],
  ["a named reference without a semicolon", "外部&shy送信: 可"],
  ["a zero-width space", `外部${String.fromCodePoint(0x200b)}送信: 可`],
  ["an embedded space", "外部 送信: 可"],
  ["a line break inside the term", "外部\n送信: 可"],
  [
    "default-ignorable and combining characters",
    `外部${String.fromCodePoint(0x3164, 0xfe0f, 0x0301, 0x2800)}送信: 可`,
  ],
  ["formatting that splits 不可", "**外部送信**: ~~不~~可"],
  ["a tag that splits 不可", "**外部送信**: <span hidden>不</span>可"],
  [
    "a lone carriage return between an unavailable and available row",
    "**外部送信**: 不可\r**外部送信**: 可",
  ],
  ["a term in an HTML tag attribute", '<b title="**外部送信**: 可">'],
  ["a term across tag lines", "<a\n**外部送信**: 可\n>"],
  [
    "a term after an HTML comment on the same line",
    "<!-- 説明 --> **外部送信**: 可",
  ],
  ["a term in a tilde code fence", "~~~\n**外部送信**: 可\n~~~"],
  [
    "a numeric reference that is outside Unicode, a surrogate, and zero",
    "&#x110000; &#xD800; &#0;\n**外部送信**: 可",
  ],
];

for (const [description, body] of obfuscatedExternalSendCases) {
  test(`classifyPlan: reduced text detects ${description}`, () => {
    assertExternalSendBlocked(body);
  });
}

for (const [description, body] of [
  ["a tag between the words", "外部<b></b>送信: 可"],
  ["a comment between the words", "外部<!--c-->送信: 可"],
]) {
  test(`classifyPlan: guarantee is outside intentional ${description}`, () => {
    equal(classifyDelegationBody(body).kind, "delegated");
  });
}

test("classifyPlan: human approval still wins over an external-send row", () => {
  equal(classifyDelegationBody("**外部送信**: 可", true).kind, "approved");
});

test("classifyPlan: added external-send row blocks before a stale review hash", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const planPath = join(wf, "plan-1.md");
  const original = readFileSync(planPath, "utf-8");
  equal(classifyPlan(planPath, resolveSpecContext(wf, repo)).kind, "delegated");
  writeFileSync(planPath, `${original}\n\n**外部送信**: 可`);
  const changed = classifyPlan(planPath, resolveSpecContext(wf, repo));
  equal(changed.kind, "blocked");
  ok(
    changed.kind === "blocked" &&
      changed.blockedBy.includes("外部送信: 可 の Task があるため委任しない"),
  );
});

test("classifyPlan: restoring the reviewed deny row delegates again", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"], body: "**外部送信**: 不可" }],
  );
  const planPath = join(wf, "plan-1.md");
  const reviewed = readFileSync(planPath, "utf-8");
  writeFileSync(
    planPath,
    reviewed.replace("**外部送信**: 不可", "**外部送信**: 可"),
  );
  const changed = classifyPlan(planPath, resolveSpecContext(wf, repo));
  equal(changed.kind, "blocked");
  ok(
    changed.kind === "blocked" &&
      changed.blockedBy.includes("外部送信: 可 の Task があるため委任しない"),
  );
  writeFileSync(planPath, reviewed);
  equal(classifyPlan(planPath, resolveSpecContext(wf, repo)).kind, "delegated");
});

test("summarizePlans: an external-send plan shows the delegation reason", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      {
        name: "plan-1.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 可",
      },
    ],
  );
  const plan = summarizePlans(wf, repo).find(
    (item) => item.name === "plan-1.md",
  );
  ok(plan);
  ok(plan.blockedBy?.includes("外部送信: 可 の Task があるため委任しない"));
});

test("listApprovalCandidates: an external-send plan is offered for approval", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      {
        name: "plan-1.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 可",
      },
    ],
  );
  equal(listApprovalCandidates(wf, repo).join(","), "plan-1.md");
});

test("evaluateTarget: an external-send plan denies its listed file", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      {
        name: "plan-1.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 可",
      },
    ],
  );
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("evaluateTarget: an earlier delegated owner still clears a later external-send plan", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      {
        name: "plan-2.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 可",
      },
    ],
  );
  const result = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(result.kind === "allow" && result.basis === "delegated");
  equal(result.kind === "allow" && result.planName, "plan-1.md");
});

test("implementationPhaseBasis: an external-send-only plan is not delegated", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      {
        name: "plan-1.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 可",
      },
    ],
  );
  equal(
    implementationPhaseBasis(wf, resolveWorkflowPaths(wf), true, repo),
    "none",
  );
});

test("implementationPhaseBasis: a strict deny row remains delegated-only", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      {
        name: "plan-1.md",
        files: ["src/a.ts"],
        body: "**外部送信**: 不可",
      },
    ],
  );
  equal(
    implementationPhaseBasis(wf, resolveWorkflowPaths(wf), true, repo),
    "delegated-only",
  );
});

test("classifyPlan: a reviewed plan within the Scope is delegated", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const ctx = resolveSpecContext(wf, repo);
  equal(ctx.delegation !== null, true);
  equal(classifyPlan(join(wf, "plan-1.md"), ctx).kind, "delegated");
});

test("classifyPlan: without the delegate flag the plan waits for approval", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    { delegate: false },
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind, "blocked");
  equal(c.kind === "blocked" && c.blockedBy, "Approval Status");
});

test("classifyPlan: a human-approved plan is approved, with or without delegation", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["other/a.ts"], approved: true }],
  );
  equal(
    classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo)).kind,
    "approved",
  );
});

test("classifyPlan: outside the Scope or on a protected path falls back to approval", () => {
  const { repo, wf } = delegatedRepo(
    ["src/", "home/"],
    [
      { name: "plan-1.md", files: ["other/a.ts"] },
      { name: "plan-2.md", files: ["home/dot_claude/x.ts"] },
    ],
  );
  const ctx = resolveSpecContext(wf, repo);
  const c1 = classifyPlan(join(wf, "plan-1.md"), ctx);
  const c2 = classifyPlan(join(wf, "plan-2.md"), ctx);
  equal(
    c1.kind === "blocked" && c1.blockedBy,
    "Approval Status (delegation: outside-scope)",
  );
  equal(
    c2.kind === "blocked" && c2.blockedBy,
    "Approval Status (delegation: protected)",
  );
});

test("classifyPlan: a plan that has not passed review is never delegated", () => {
  const { repo, wf } = delegatedRepo(["src/"], []);
  const spec = readFileSync(join(wf, "spec.md"), "utf-8");
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      pendingWorkflowRepo(),
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
    ),
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind, "blocked");
  ok(c.kind === "blocked" && !c.blockedBy.startsWith("Approval"));
});

test("resolveSpecContext: delegation is off when the spec.md approval line is pending", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const specPath = join(wf, "spec.md");
  writeFileSync(
    specPath,
    readFileSync(specPath, "utf-8").replace(
      "- Approval Status: approved",
      "- Approval Status: pending",
    ),
  );
  equal(resolveSpecContext(wf, repo).delegation, null);
});

test("resolveSpecContext: delegation is off once the spec.md body changes", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const specPath = join(wf, "spec.md");
  writeFileSync(
    specPath,
    readFileSync(specPath, "utf-8").replace("src/", "src/\nlib/"),
  );
  const ctx = resolveSpecContext(wf, repo);
  equal(ctx.delegation, null);
  const c = classifyPlan(join(wf, "plan-1.md"), ctx);
  equal(c.kind === "blocked" && c.blockedBy, "Approval Status");
});

test("resolveSpecContext: delegation is off when approvals.log cannot be read", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  unlinkSync(join(wf, "approvals.log"));
  mkdirSync(join(wf, "approvals.log"));
  equal(resolveSpecContext(wf, repo).delegation, null);
});

test("classifyPlan: a plan without parent-spec-hash is not delegated", () => {
  const { repo, wf } = delegatedRepo(["src/"], []);
  const spec = readFileSync(join(wf, "spec.md"), "utf-8");
  writeFileSync(
    join(wf, "plan-1.md"),
    buildPlanNContent(
      { ...approvedWorkflowRepo(), approvalStatus: "pending" },
      ["src/a.ts"],
      computeWorkflowRepoPlanHash(spec),
      true,
    ),
  );
  const c = classifyPlan(join(wf, "plan-1.md"), resolveSpecContext(wf, repo));
  equal(c.kind === "blocked" && c.blockedBy, "parent-spec-hash");
});

test("resolveSpecContext: delegation is off when the Scope is invalid or the root is unknown", () => {
  const { repo, wf } = delegatedRepo(
    ["/etc/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  equal(resolveSpecContext(wf, repo).delegation, null);
  const valid = delegatedRepo(["src/"], []);
  equal(resolveSpecContext(valid.wf, undefined).delegation, null);
});

test("evaluateTarget: a delegated plan allows its listed target and says so", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  equal(e.kind, "allow");
  ok(e.kind === "allow" && e.basis === "delegated");
  ok(
    e.kind === "allow" && e.basis === "delegated" && e.planName === "plan-1.md",
  );
  ok(
    e.kind === "allow" &&
      e.basis === "delegated" &&
      /^[0-9a-f]{64}$/.test(e.planHash),
  );
  ok(
    e.kind === "allow" &&
      e.basis === "delegated" &&
      /^[0-9a-f]{64}$/.test(e.specHash),
  );
});

test("evaluateTarget: without delegation the same plan denies", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    { delegate: false },
  );
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("evaluateTarget: a human-approved plan allows with basis approved", () => {
  const { repo, wf } = twoLayerRepo(["src/a.ts"]);
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "approved");
});

test("evaluateTarget: an approved plan wins over a delegated one for the same target", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["src/a.ts"], approved: true },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "approved");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-2.md"));
});

test("evaluateTarget: a delegated first plan allows even when a later plan listing the target is blocked", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/x.ts", "src/a.ts"] },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "allow" && e.basis === "delegated");
  equal(e.kind === "allow" && e.owner, join(wf, "plan-1.md"));
});

test("formatTargetEvaluation: says when a write clears by delegation", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "src", "a.ts"),
    projectRoot: repo,
  });
  match(
    formatTargetEvaluation(e, "src/a.ts", "spec.md"),
    /allowed by `plan-1\.md` through the spec's delegation/,
  );
  const approved = twoLayerRepo(["src/a.ts"]);
  const a = evaluateTarget({
    wfDir: approved.wf,
    target: join(approved.repo, "src", "a.ts"),
    projectRoot: approved.repo,
  });
  ok(!/delegation/.test(formatTargetEvaluation(a, "src/a.ts", "spec.md")));
});

test("evaluateTarget: a blocked first plan still denies, as before", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["other/x.ts", "src/a.ts"] },
      { name: "plan-2.md", files: ["src/a.ts"], approved: true },
    ],
  );
  equal(
    evaluateTarget({
      wfDir: wf,
      target: join(repo, "src", "a.ts"),
      projectRoot: repo,
    }).kind,
    "deny",
  );
});

test("off-plan under delegation only: relaxed inside the Scope, denied outside", () => {
  const { repo, wf } = delegatedRepo(
    ["src/", "home/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const at = (rel: string) =>
    evaluateTarget({ wfDir: wf, target: join(repo, rel), projectRoot: repo });
  const inside = at("src/b.ts");
  const outside = at("other/c.ts");
  const protectedPath = at("home/dot_claude/x.ts");
  ok(
    inside.kind === "no-plan-owner" &&
      inside.implementationPhase &&
      inside.relaxable,
  );
  ok(
    outside.kind === "no-plan-owner" &&
      outside.implementationPhase &&
      !outside.relaxable,
  );
  ok(protectedPath.kind === "no-plan-owner" && !protectedPath.relaxable);
  ok(
    outside.kind === "no-plan-owner" &&
      /## Scope/.test(outside.diagnosis.note ?? ""),
  );
});

test("off-plan with a human-approved plan: relaxed everywhere, as before", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["lib/z.ts"], approved: true },
    ],
  );
  const e = evaluateTarget({
    wfDir: wf,
    target: join(repo, "other", "c.ts"),
    projectRoot: repo,
  });
  ok(e.kind === "no-plan-owner" && e.relaxable);
});

test("implementationPhaseBasis: none, delegated-only, approved", () => {
  const basisOf = (r: { repo: string; wf: string }) =>
    implementationPhaseBasis(r.wf, resolveWorkflowPaths(r.wf), true, r.repo);
  equal(
    basisOf(
      delegatedRepo(["src/"], [{ name: "plan-1.md", files: ["src/a.ts"] }], {
        delegate: false,
      }),
    ),
    "none",
  );
  equal(
    basisOf(
      delegatedRepo(["src/"], [{ name: "plan-1.md", files: ["src/a.ts"] }]),
    ),
    "delegated-only",
  );
  equal(
    basisOf(
      delegatedRepo(
        ["src/"],
        [
          { name: "plan-1.md", files: ["src/a.ts"] },
          { name: "plan-2.md", files: ["lib/z.ts"], approved: true },
        ],
      ),
    ),
    "approved",
  );
});

test("summarizePlans: marks a delegated plan and keeps blockedBy for the rest", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/b.ts"] },
      { name: "plan-3.md", files: ["lib/c.ts"], approved: true },
    ],
  );
  const byName = new Map(summarizePlans(wf, repo).map((p) => [p.name, p]));
  equal(byName.get("plan-1.md")?.via, "delegation");
  equal(byName.get("plan-1.md")?.blockedBy, undefined);
  equal(
    byName.get("plan-2.md")?.blockedBy,
    "Approval Status (delegation: outside-scope)",
  );
  equal(byName.get("plan-3.md")?.via, undefined);
  equal(byName.get("plan-3.md")?.blockedBy, undefined);
});

test("summarizePlans: without a project root it reports as before", () => {
  const { wf } = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  equal(summarizePlans(wf)[0]?.blockedBy, "Approval Status");
});

test("listApprovalCandidates: a delegated plan is not asked about", () => {
  const { repo, wf } = delegatedRepo(
    ["src/"],
    [
      { name: "plan-1.md", files: ["src/a.ts"] },
      { name: "plan-2.md", files: ["other/b.ts"] },
    ],
  );
  equal(listApprovalCandidates(wf, repo).join(","), "plan-2.md");
  equal(listApprovalCandidates(wf).join(","), "plan-1.md,plan-2.md");
});

test("diagnoseGate: under delegation it does not tell the user to approve each plan", () => {
  const on = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const off = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
    { delegate: false },
  );
  const delegated = diagnoseGate(on.wf, "x", on.repo);
  match(delegated.note ?? "", /delegates its plan-N\.md/);
  ok(!/must also be/.test(delegated.note ?? ""));
  ok(!/approve plan-N\.md/.test(delegated.nextAction));
  match(delegated.nextAction, /workflow-cli status/);

  for (const d of [
    diagnoseGate(off.wf, "x", off.repo),
    diagnoseGate(on.wf, "x"),
  ]) {
    match(d.note ?? "", /must also be/);
    match(d.nextAction, /approve plan-N\.md/);
  }
});

test("resolveDelegationOffer: the rows of the current spec.md, or null without one", () => {
  const { repo, wf } = delegatedRepo(["src/", "home/dot_claude/"], []);
  equal(
    JSON.stringify(resolveDelegationOffer(wf, repo)),
    JSON.stringify([
      { entry: "src/", protected: false },
      { entry: "home/dot_claude/", protected: true },
    ]),
  );
  equal(resolveDelegationOffer(freshWf(), repo), null);
});

test("no-plan-owner carries what the implementation phase rests on", () => {
  const delegated = delegatedRepo(
    ["src/"],
    [{ name: "plan-1.md", files: ["src/a.ts"] }],
  );
  const e = evaluateTarget({
    wfDir: delegated.wf,
    target: join(delegated.repo, "src", "b.ts"),
    projectRoot: delegated.repo,
  });
  ok(e.kind === "no-plan-owner" && e.phaseBasis === "delegated-only");
  ok(e.kind === "no-plan-owner" && /^[0-9a-f]{64}$/.test(e.specHash));

  const approved = twoLayerRepo(["src/a.ts"]);
  const a = evaluateTarget({
    wfDir: approved.wf,
    target: join(approved.repo, "src", "b.ts"),
    projectRoot: approved.repo,
  });
  ok(a.kind === "no-plan-owner" && a.phaseBasis === "approved");
});
