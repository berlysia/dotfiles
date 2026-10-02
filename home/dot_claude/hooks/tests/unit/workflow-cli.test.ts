#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  resolveCliDeps,
  runWorkflowCli,
  wouldTouchApprovalStatus,
} from "../../cli/workflow.ts";
import {
  formatRoundBudgetHeadline,
  ROUND_BUDGET,
  ROUND_REFRAMER_CAP,
  ROUND_SELF_CAP,
  type RoundBudgetPhase,
} from "../../lib/workflow-review-core.ts";
import {
  approvedWorkflowRepo,
  buildPlanContent,
  buildPlanNContent,
  computeWorkflowRepoPlanHash,
  EnvironmentHelper,
  pendingWorkflowRepo,
  recordApprovalsForTest,
  seedWorkflow,
} from "./test-helpers.ts";

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
        wfDirSource: "derived",
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
        wfDirSource: "derived",
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

  it("writes round=<current round> into the marker", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-1.md",
      round: 2,
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
        wfDirSource: "derived",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(
      readFileSync(join(wf, "plan-1.md"), "utf-8"),
      /<!-- auto-review: verdict=pass; hash=[0-9a-f]{64}; design-hash=[^;]+; round=2;/,
    );
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
        wfDirSource: "derived",
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
        wfDirSource: "derived",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /Reviewer Outputs/);
  });
});

describe("workflow-cli: --wf-dir validation", () => {
  it("refuses a --wf-dir outside .tmp/sessions instead of falling back to the default dir", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const before = readFileSync(join(wf, "plan-1.md"), "utf-8");
    const r = runWorkflowCli(
      ["round", "plan-1.md", "--wf-dir", ".tmp/elsewhere"],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        wfDirSource: "derived",
        now: NOW,
      },
    );
    assert.equal(r.exitCode, 1);
    assert.match(
      r.stderr,
      /--wf-dir "\.tmp\/elsewhere" is not a strict descendant of \.tmp\/sessions/,
    );
    assert.equal(readFileSync(join(wf, "plan-1.md"), "utf-8"), before);
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
      wfDirSource: "derived",
      now: NOW,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8");
    assert.match(doc, /## Reviewer Outputs \(Round 2\)/);
    assert.ok(existsSync(join(wf, ".round-baseline")));
    const baseline = readFileSync(join(wf, ".round-baseline"), "utf-8");
    assert.match(baseline, /^2\t/m);
  });

  const ROUND_DEPS = (wf: string) => ({
    cwd: wf,
    wfDir: wf,
    sessionId: "test-ses",
    wfDirSource: "derived",
    now: NOW,
  });

  it("refuses a 4th round in the same review cycle", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 3,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf));
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes(formatRoundBudgetHeadline("self-extendable")));
    assert.match(r.stderr, /--extend --reason/);
    assert.match(r.stderr, /--self-extend --reason/);
    assert.doesNotMatch(
      readFileSync(join(wf, "plan-1.md"), "utf-8"),
      /Round 4/,
    );
  });

  it("allows round 3 (2 rounds so far in the cycle)", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 2,
      ledgerSlugs: [],
    });
    assert.equal(
      runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf)).exitCode,
      0,
    );
  });

  it("starts a fresh budget after a pass marker with round=", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 3,
      ledgerSlugs: [],
    });
    const p = join(wf, "plan-1.md");
    writeFileSync(
      p,
      `${readFileSync(p, "utf-8")}\n<!-- auto-review: verdict=pass; hash=x; design-hash=y; round=3; at=z; reviewers=a -->\n`,
    );
    assert.equal(
      runWorkflowCli(["round", "plan-1.md"], ROUND_DEPS(wf)).exitCode,
      0,
    );
  });

  it("--extend without --reason is refused", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 3,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(
      ["round", "plan-1.md", "--extend"],
      ROUND_DEPS(wf),
    );
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /--reason/);
  });

  it("--extend --reason proceeds, logs the extension, and composes with --full", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 3,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(
      [
        "round",
        "plan-1.md",
        "--extend",
        "--reason",
        "user: continue once",
        "--full",
      ],
      ROUND_DEPS(wf),
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout, /^extended beyond round budget \(3\)$/m);
    assert.doesNotMatch(r.stdout, /self-extended|reframer-extended/);
    assert.match(
      readFileSync(join(wf, "plan-1.md"), "utf-8"),
      /## Reviewer Outputs \(Round 4\)/,
    );
    const log = readFileSync(join(wf, "round-extensions.log"), "utf-8");
    assert.match(log, /^2026-.*\tplan-1\.md\t4\thuman\tuser: continue once$/m);
  });
});

const PLAN = "plan-1.md";
/** Fixed times keep the `at >= baseline` string comparison independent of the clock. */
const BASELINE_AT = "2000-01-01T00:00:00.000Z";
const LAUNCH_AT = "2000-01-01T01:00:00.000Z";
const EARLIER_AT = "1999-12-31T23:00:00.000Z";

const deps = (wf: string) => ({
  cwd: wf,
  wfDir: wf,
  sessionId: "test-ses",
  wfDirSource: "derived",
  now: NOW,
});

const runRound = (wf: string, ...args: string[]) =>
  runWorkflowCli(["round", PLAN, ...args], deps(wf));

const readDoc = (wf: string) => readFileSync(join(wf, PLAN), "utf-8");
const readLog = (wf: string) => {
  const p = join(wf, "round-extensions.log");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
};

const reframerSection = (
  round: number,
  overrides: { agent?: string; recommendation?: string } = {},
) =>
  [
    `## Reframer Review (Round ${round})`,
    `- agent: ${overrides.agent ?? "review-reframer"}`,
    `- recommendation: ${overrides.recommendation ?? "(a)"}`,
    "- rejected: x",
    "- hypothesis: x",
    "- plan: x",
    "",
  ].join("\n");

interface ReframedSeed {
  /** Rounds already in the document. */
  round: number;
  /** `round=` of a pass marker appended to the document (start of the cycle). */
  passRound?: number;
  /** Round the record file's section claims; omit for "no record file". */
  sectionRound?: number;
  sections?: string;
  baselineRound?: number | null;
  launchAt?: string | null;
}

/** A workflow dir where `--reframer-extend` is fully backed unless told otherwise. */
function seedReframed(seed: ReframedSeed): string {
  const sectionRound = seed.sectionRound;
  const baselineRound =
    seed.baselineRound === undefined ? sectionRound : seed.baselineRound;
  const launchAt = seed.launchAt === undefined ? LAUNCH_AT : seed.launchAt;
  const { wf } = seedWorkflow({
    doc: PLAN,
    round: seed.round,
    ledgerSlugs: [],
    omitBaseline: true,
    extraBaselines:
      baselineRound === undefined || baselineRound === null
        ? []
        : [{ round: baselineRound, at: BASELINE_AT }],
    ledgerEntries:
      launchAt === null ? [] : [{ slug: "review-reframer", at: launchAt }],
  });
  if (seed.passRound !== undefined) {
    writeFileSync(
      join(wf, PLAN),
      `${readDoc(wf)}\n<!-- auto-review: verdict=pass; hash=x; design-hash=y; round=${seed.passRound}; at=z; reviewers=a -->\n`,
    );
  }
  if (seed.sections !== undefined) {
    writeFileSync(join(wf, "reframer-review.plan-1.md"), seed.sections);
  } else if (sectionRound !== undefined) {
    writeFileSync(
      join(wf, "reframer-review.plan-1.md"),
      reframerSection(sectionRound),
    );
  }
  return wf;
}

type Call = "plain" | "self" | "reframer" | "human";
const CALL_ARGS: Record<Call, string[]> = {
  plain: [],
  self: ["--self-extend", "--reason", "x"],
  reframer: ["--reframer-extend", "--reason", "x"],
  human: ["--extend", "--reason", "x"],
};
const APPROVER_OF: Record<Call, string | null> = {
  plain: null,
  self: "self",
  reframer: "reframer",
  human: "human",
};

describe("workflow-cli: staged round budget matrix", () => {
  const cases: Array<[number, RoundBudgetPhase, Record<Call, boolean>]> = [
    [2, "open", { plain: true, self: true, reframer: true, human: true }],
    [
      3,
      "self-extendable",
      { plain: false, self: true, reframer: false, human: true },
    ],
    [
      5,
      "self-extendable",
      { plain: false, self: true, reframer: false, human: true },
    ],
    [
      6,
      "reframer-review",
      { plain: false, self: false, reframer: true, human: true },
    ],
    [
      8,
      "reframer-review",
      { plain: false, self: false, reframer: true, human: true },
    ],
    [
      9,
      "human-only",
      { plain: false, self: false, reframer: false, human: true },
    ],
  ];
  for (const [round, phase, expected] of cases) {
    for (const call of ["plain", "self", "reframer", "human"] as const) {
      const allowed = expected[call];
      it(`round=${round} (${phase}) ${call} -> ${allowed ? "allowed" : "refused"}`, () => {
        // The reframer's consultation is at Round ROUND_SELF_CAP of the cycle,
        // so a backed `--reframer-extend` at round 8 still cites Round 6.
        const wf = seedReframed({
          round,
          sectionRound:
            phase === "reframer-review" ? ROUND_SELF_CAP : undefined,
        });
        const r = runRound(wf, ...CALL_ARGS[call]);
        const log = readLog(wf);
        if (allowed) {
          assert.equal(r.exitCode, 0, r.stderr);
          assert.match(
            readDoc(wf),
            new RegExp(`## Reviewer Outputs \\(Round ${round + 1}\\)`),
          );
          if (phase === "open") {
            assert.equal(log, "");
            assert.doesNotMatch(r.stdout, /extended beyond/);
          } else {
            const approver = APPROVER_OF[call];
            assert.match(
              log.trimEnd().split("\n").at(-1) ?? "",
              new RegExp(`\\t${round + 1}\\t${approver}\\tx$`),
            );
          }
        } else {
          assert.equal(r.exitCode, 1);
          assert.doesNotMatch(readDoc(wf), new RegExp(`Round ${round + 1}\\)`));
          assert.ok(
            r.stderr.includes(
              formatRoundBudgetHeadline(
                phase as Exclude<RoundBudgetPhase, "open">,
              ),
            ),
            r.stderr,
          );
        }
      });
    }
  }
});

describe("workflow-cli: extension wording and logging", () => {
  it("self extension names the budget and self cap, logs `self`", () => {
    const wf = seedReframed({ round: ROUND_BUDGET });
    const reason = "non-pass 2→1; remaining: x";
    const r = runRound(wf, "--self-extend", "--reason", reason);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(
      r.stdout.includes(
        `self-extended beyond round budget (${ROUND_BUDGET}); self cap ${ROUND_SELF_CAP}`,
      ),
    );
    assert.doesNotMatch(r.stdout, /^extended beyond/m);
    assert.match(
      readLog(wf),
      new RegExp(
        `^\\d{4}-\\d{2}-\\d{2}T.*\\tplan-1\\.md\\t4\\tself\\t${reason}$`,
        "m",
      ),
    );
  });

  it("reframer extension names the self cap and reframer cap, logs `reframer`", () => {
    const wf = seedReframed({
      round: ROUND_SELF_CAP,
      sectionRound: ROUND_SELF_CAP,
    });
    const reason = "reframer: (a) x; rejected: y";
    const r = runRound(wf, "--reframer-extend", "--reason", reason);
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(
      r.stdout.includes(
        `reframer-extended beyond self cap (${ROUND_SELF_CAP}); reframer cap ${ROUND_REFRAMER_CAP}`,
      ),
    );
    assert.match(
      readLog(wf),
      /\t7\treframer\treframer: \(a\) x; rejected: y$/m,
    );
  });

  it("a plain round at the self cap points at the reframer and its record file", () => {
    const wf = seedReframed({ round: ROUND_SELF_CAP });
    const r = runRound(wf);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes(`Round self cap reached (${ROUND_SELF_CAP})`));
    assert.ok(r.stderr.includes("review-reframer"));
    assert.ok(r.stderr.includes("reframer-review.plan-1.md"));
  });

  it("flattens a multi-line reason into one 5-column log line", () => {
    const wf = seedReframed({ round: ROUND_BUDGET });
    const r = runRound(wf, "--self-extend", "--reason", "a\tb\nc");
    assert.equal(r.exitCode, 0, r.stderr);
    const lines = readLog(wf).trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /\t4\tself\ta b c$/);
    assert.equal((lines[0] ?? "").split("\t").length, 5);
  });
});

describe("workflow-cli: --reframer-extend backing checks", () => {
  const expectRefusal = (wf: string, pattern: RegExp) => {
    const r = runRound(wf, "--reframer-extend", "--reason", "x");
    assert.equal(r.exitCode, 1, r.stdout);
    assert.match(r.stderr, pattern);
    assert.doesNotMatch(readDoc(wf), /Round 7\)/);
    assert.equal(readLog(wf), "");
  };

  it("refuses without a record file", () => {
    expectRefusal(seedReframed({ round: 6 }), /reframer-review\.plan-1\.md/);
  });
  it("refuses a record file without a section", () => {
    expectRefusal(
      seedReframed({ round: 6, sections: "nothing\n" }),
      /Reframer Review/,
    );
  });
  it("refuses recommendation (b)", () => {
    expectRefusal(
      seedReframed({
        round: 6,
        sections: reframerSection(6, { recommendation: "(b)" }),
      }),
      /recommendation/,
    );
  });
  it("refuses recommendation with trailing text", () => {
    expectRefusal(
      seedReframed({
        round: 6,
        sections: reframerSection(6, { recommendation: "(a) 続行" }),
      }),
      /recommendation/,
    );
  });
  it("refuses another agent name", () => {
    expectRefusal(
      seedReframed({
        round: 6,
        sections: reframerSection(6, { agent: "general-purpose" }),
      }),
      /review-reframer/,
    );
  });
  it("refuses a section before or after the cycle's consultation round", () => {
    expectRefusal(seedReframed({ round: 6, sectionRound: 5 }), /round/);
    expectRefusal(seedReframed({ round: 6, sectionRound: 7 }), /round/);
  });
  it("judges by the last section, so a later section cannot redo the consultation", () => {
    expectRefusal(
      seedReframed({
        round: 6,
        sections: `${reframerSection(6)}\n${reframerSection(7)}`,
        baselineRound: 6,
      }),
      /round/,
    );
  });
  it("refuses when the consultation round has no baseline", () => {
    expectRefusal(
      seedReframed({ round: 6, sectionRound: 6, baselineRound: null }),
      /baseline missing/,
    );
  });
  it("refuses when no reframer launch was recorded", () => {
    expectRefusal(
      seedReframed({ round: 6, sectionRound: 6, launchAt: null }),
      /no review-reframer run recorded/,
    );
  });
  it("refuses a launch recorded before the baseline", () => {
    expectRefusal(
      seedReframed({ round: 6, sectionRound: 6, launchAt: EARLIER_AT }),
      /no review-reframer run recorded/,
    );
  });
  it("counts a namespaced launch (ledger is compared by bare slug)", () => {
    const wf = seedWorkflow({
      doc: PLAN,
      round: 6,
      ledgerSlugs: [],
      omitBaseline: true,
      extraBaselines: [{ round: 6, at: BASELINE_AT }],
      ledgerEntries: [{ slug: "plugin:review-reframer", at: LAUNCH_AT }],
    }).wf;
    writeFileSync(join(wf, "reframer-review.plan-1.md"), reframerSection(6));
    assert.equal(
      runRound(wf, "--reframer-extend", "--reason", "x").exitCode,
      0,
    );
  });
});

describe("workflow-cli: cycle resets and the per-cycle consultation round", () => {
  it("a pass at the current round starts a fresh open cycle", () => {
    const wf = seedReframed({ round: 3, passRound: 3 });
    assert.equal(runRound(wf).exitCode, 0);
  });
  it("3 rounds in cycle: --self-extend works after a pass", () => {
    const wf = seedReframed({ round: 6, passRound: 3 });
    const r = runRound(wf, "--self-extend", "--reason", "x");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(readLog(wf), /\t7\tself\tx$/m);
  });
  it("5 rounds in cycle: --self-extend works after a pass", () => {
    const wf = seedReframed({ round: 8, passRound: 3 });
    const r = runRound(wf, "--self-extend", "--reason", "x");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(readLog(wf), /\t9\tself\tx$/m);
  });
  it("6 in cycle: self is refused, a reframer extension citing round pass+6 works", () => {
    const wf = seedReframed({ round: 9, passRound: 3, sectionRound: 9 });
    const self = runRound(wf, "--self-extend", "--reason", "x");
    assert.equal(self.exitCode, 1);
    assert.ok(
      self.stderr.includes(`Round self cap reached (${ROUND_SELF_CAP})`),
    );
    const r = runRound(wf, "--reframer-extend", "--reason", "x");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(readLog(wf), /\t10\treframer\tx$/m);
  });
  it("6 in cycle: a section from the previous cycle's entry round is refused", () => {
    const wf = seedReframed({
      round: 9,
      passRound: 3,
      sectionRound: 6,
      baselineRound: 6,
    });
    const r = runRound(wf, "--reframer-extend", "--reason", "x");
    assert.equal(r.exitCode, 1);
  });
  it("8 in cycle: reframer extension still works, 9 in cycle is human-only", () => {
    const at8 = seedReframed({ round: 11, passRound: 3, sectionRound: 9 });
    assert.equal(
      runRound(at8, "--reframer-extend", "--reason", "x").exitCode,
      0,
    );
    const at9 = seedReframed({ round: 12, passRound: 3, sectionRound: 9 });
    const r = runRound(at9, "--reframer-extend", "--reason", "x");
    assert.equal(r.exitCode, 1);
    assert.ok(
      r.stderr.includes(`Round reframer cap reached (${ROUND_REFRAMER_CAP})`),
    );
  });
  it("a pass marker without round= leaves 3 rounds in cycle (plain refused)", () => {
    const wf = seedReframed({ round: 3 });
    writeFileSync(
      join(wf, PLAN),
      `${readDoc(wf)}\n<!-- auto-review: verdict=pass; hash=x -->\n`,
    );
    const r = runRound(wf);
    assert.equal(r.exitCode, 1);
    assert.ok(r.stderr.includes(`Round budget reached (${ROUND_BUDGET})`));
  });
});

describe("workflow-cli: argument validation for round", () => {
  it("rejects document names that could leave the workflow dir", () => {
    const wf = seedReframed({ round: 1 });
    for (const name of ["../plan-1.md", "sub/plan-1.md", "plan-1.txt", ".md"]) {
      const r = runWorkflowCli(["round", name], deps(wf));
      assert.equal(r.exitCode, 1, name);
      assert.match(r.stderr, /document name/, name);
    }
  });
  it("a backslash name is not a path separator here and fails at lookup", () => {
    const wf = seedReframed({ round: 1 });
    const r = runWorkflowCli(["round", "sub\\plan-1.md"], deps(wf));
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /document not found/);
    assert.doesNotMatch(r.stderr, /document name/);
  });
  it("rejects two or more extension flags", () => {
    const wf = seedReframed({ round: 3 });
    for (const flags of [
      ["--extend", "--self-extend"],
      ["--extend", "--reframer-extend"],
      ["--self-extend", "--reframer-extend"],
    ]) {
      const r = runRound(wf, ...flags, "--reason", "x");
      assert.equal(r.exitCode, 1, flags.join(" "));
      assert.match(
        r.stderr,
        /use only one of --extend, --self-extend, --reframer-extend/,
      );
    }
  });
  it("checks the flag count before --full", () => {
    const wf = seedReframed({ round: 3 });
    const r = runRound(
      wf,
      "--self-extend",
      "--extend",
      "--full",
      "--reason",
      "x",
    );
    assert.match(r.stderr, /use only one of/);
  });
  it("refuses --self-extend / --reframer-extend with --full", () => {
    const self = runRound(
      seedReframed({ round: 3 }),
      "--self-extend",
      "--full",
      "--reason",
      "x",
    );
    assert.equal(self.exitCode, 1);
    assert.match(self.stderr, /cannot be combined with --full/);
    const reframer = runRound(
      seedReframed({ round: 6, sectionRound: 6 }),
      "--reframer-extend",
      "--full",
      "--reason",
      "x",
    );
    assert.equal(reframer.exitCode, 1);
    assert.match(reframer.stderr, /cannot be combined with --full/);
  });
  it("lets the human's --extend combine with --full", () => {
    const wf = seedReframed({ round: 3 });
    assert.equal(
      runRound(wf, "--extend", "--full", "--reason", "x").exitCode,
      0,
    );
  });
  it("fixes the order of checks: flag count, --full, reason, then phase", () => {
    const wf3 = seedReframed({ round: 3 });
    assert.match(
      runRound(wf3, "--self-extend", "--extend").stderr,
      /use only one of/,
    );
    assert.match(
      runRound(wf3, "--self-extend", "--full").stderr,
      /cannot be combined with --full/,
    );
    for (const round of [2, 9]) {
      const wf = seedReframed({ round });
      assert.match(
        runRound(wf, "--self-extend", "--full", "--reason", "x").stderr,
        /cannot be combined with --full/,
      );
    }
    assert.match(
      runRound(seedReframed({ round: 9 }), "--reframer-extend").stderr,
      /--reason/,
    );
    // phase allows the call; the missing record is what refuses it
    assert.match(
      runRound(seedReframed({ round: 6 }), "--reframer-extend", "--reason", "x")
        .stderr,
      /reframer-review\.plan-1\.md/,
    );
  });
  it("refuses empty or whitespace-only reasons on every extension flag", () => {
    const wf = seedReframed({ round: 3 });
    const attempts: string[][] = [
      ["--self-extend"],
      ["--self-extend", "--reason", "   "],
      ["--extend", "--reason", "   "],
      ["--self-extend", "--reason", "\n"],
    ];
    for (const args of attempts) {
      const r = runRound(wf, ...args);
      assert.equal(r.exitCode, 1, args.join(" "));
      assert.match(r.stderr, /--reason/);
    }
  });
});

describe("workflow-cli: stamp ignores reframer ledger lines", () => {
  it("stamps normally when the ledger also holds a review-reframer launch", () => {
    const { wf, ledger } = seedWorkflow({
      doc: PLAN,
      round: 1,
      ledgerSlugs: [
        "logic-validator",
        "scope-justification-reviewer",
        "review-reframer",
      ],
    });
    const r = runWorkflowCli(
      [
        "stamp",
        PLAN,
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      { ...deps(wf), ledgerPath: ledger },
    );
    assert.equal(r.exitCode, 0, r.stderr);
  });
});

/**
 * spec.md whose Round 1 is fully filled: only scope-justification-reviewer
 * asked for changes. Round 2 is optionally present (as `round` would insert).
 */
function writeSpecAfterRound1(wf: string, withRound2: boolean): void {
  const round1 = [
    "## Reviewer Outputs (Round 1)",
    "",
    "### logic-validator",
    "- verdict: pass",
    "",
    "### scope-justification-reviewer",
    "- verdict: needs-work",
    "",
    "### decision-quality-reviewer",
    "- verdict: pass",
    "",
    "### greenfield-perspective-reviewer",
    "- verdict: pass",
    "",
    "<!-- auto-review: verdict=needs-work; hash=h; at=2026-01-01T00:00:00.000Z; reviewers=x -->",
    "",
  ];
  const round2 = withRound2
    ? [
        "## Reviewer Outputs (Round 2)",
        "",
        "### logic-validator",
        "- verdict: pass",
        "",
        "### scope-justification-reviewer",
        "- verdict: pass",
        "",
      ]
    : [];
  writeFileSync(
    join(wf, "spec.md"),
    [
      "## Key Decisions",
      "- K1",
      "",
      ...round1,
      ...round2,
      "## Approval",
      "- Plan Status: complete",
      "- Review Status: needs-work",
      "- Approval Status: pending",
    ].join("\n"),
  );
}

describe("workflow-cli: delta re-review (K6)", () => {
  it("round skeleton lists re-run reviewers and prefills carried passes", () => {
    const { wf } = seedWorkflow({ doc: "plan.md", round: 0, ledgerSlugs: [] });
    writeSpecAfterRound1(wf, false);
    const r = runWorkflowCli(["round", "spec.md"], {
      cwd: wf,
      wfDir: wf,
      sessionId: "test-ses",
      wfDirSource: "derived",
      now: NOW,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const doc = readFileSync(join(wf, "spec.md"), "utf-8");
    const round2 = doc.slice(doc.indexOf("## Reviewer Outputs (Round 2)"));
    assert.match(round2, /### logic-validator\n- verdict: \n/);
    assert.match(round2, /### scope-justification-reviewer\n- verdict: \n/);
    assert.match(
      round2,
      /### decision-quality-reviewer\n- verdict: pass \(carried from Round 1\)/,
    );
    assert.match(
      r.stdout,
      /re-run: logic-validator, scope-justification-reviewer/,
    );
  });

  it("round --full lists every mandatory reviewer unfilled", () => {
    const { wf } = seedWorkflow({ doc: "plan.md", round: 0, ledgerSlugs: [] });
    writeSpecAfterRound1(wf, false);
    const r = runWorkflowCli(["round", "spec.md", "--full"], {
      cwd: wf,
      wfDir: wf,
      sessionId: "test-ses",
      wfDirSource: "derived",
      now: NOW,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    const doc = readFileSync(join(wf, "spec.md"), "utf-8");
    assert.doesNotMatch(doc, /carried from Round 1/);
    assert.match(doc, /### greenfield-perspective-reviewer\n- verdict: \n/);
  });

  it("stamp accepts a round where only the re-run reviewers ran", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan.md",
      round: 0,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    writeSpecAfterRound1(wf, true);
    const r = runWorkflowCli(
      [
        "stamp",
        "spec.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        wfDirSource: "derived",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.equal(r.exitCode, 0, r.stderr);
  });

  it("stamp still requires the re-run reviewers", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan.md",
      round: 0,
      ledgerSlugs: ["logic-validator"],
    });
    writeSpecAfterRound1(wf, true);
    const r = runWorkflowCli(
      [
        "stamp",
        "spec.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator",
      ],
      {
        cwd: wf,
        wfDir: wf,
        sessionId: "test-ses",
        wfDirSource: "derived",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /scope-justification-reviewer/);
  });
});

describe("workflow-cli: delta re-review never exceeds a full round (K6)", () => {
  it("stamp does not require a content-selected reviewer that returned needs-work", () => {
    const { wf, ledger } = seedWorkflow({
      doc: "plan-1.md",
      round: 0,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    const doc = readFileSync(join(wf, "plan-1.md"), "utf-8").replace(
      "## Approval",
      [
        "## Reviewer Outputs (Round 1)",
        "",
        "### logic-validator",
        "- verdict: needs-work",
        "",
        "### scope-justification-reviewer",
        "- verdict: needs-work",
        "",
        "### security-sentinel",
        "- verdict: needs-work",
        "",
        "<!-- auto-review: verdict=needs-work; hash=h; at=2026-01-01T00:00:00.000Z; reviewers=x -->",
        "",
        "## Reviewer Outputs (Round 2)",
        "",
        "## Approval",
      ].join("\n"),
    );
    writeFileSync(join(wf, "plan-1.md"), doc);
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
        wfDirSource: "derived",
        now: NOW,
        ledgerPath: ledger,
      },
    );
    assert.equal(r.exitCode, 0, r.stderr);
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
      {
        cwd: wf,
        wfDir: wf,
        wfDirSource: "derived",
        sessionId: "test-ses",
        now: NOW,
      },
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
      wfDirSource: "derived",
      now: NOW,
    });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /Document workflow gate/);
    assert.match(r.stdout, /tripwire:/);
  });

  function statusRepo(): { repo: string; wf: string } {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "cli-status-")));
    const wf = join(repo, ".tmp", "sessions", "x");
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, "research.md"), "x");
    return { repo, wf };
  }

  function status(repo: string, wf: string, path: string) {
    return runWorkflowCli(["status", path], {
      cwd: repo,
      wfDir: wf,
      sessionId: "test-ses",
      wfDirSource: "derived",
      now: NOW,
    });
  }

  it("status <path> names plan.md when an approved single-layer plan allows the target", () => {
    const { repo, wf } = statusRepo();
    writeFileSync(
      join(wf, "plan.md"),
      buildPlanContent(approvedWorkflowRepo()),
    );
    recordApprovalsForTest(wf);
    const r = status(repo, wf, "src/a.ts");
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /src\/a\.ts` is allowed by `plan\.md`/);
  });

  it("status <path> shows the blocking diagnosis while the plan is pending", () => {
    const { repo, wf } = statusRepo();
    writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
    const r = status(repo, wf, "src/a.ts");
    assert.match(r.stdout, /src\/a\.ts` is blocked/);
    assert.match(r.stdout, /✗ Approval Status/);
  });

  it("status without a target does not claim the gate is blocked when every condition holds", () => {
    const { repo, wf } = statusRepo();
    writeFileSync(
      join(wf, "plan.md"),
      buildPlanContent(approvedWorkflowRepo()),
    );
    recordApprovalsForTest(wf);
    const r = runWorkflowCli(["status"], {
      cwd: repo,
      wfDir: wf,
      sessionId: "test-ses",
      wfDirSource: "derived",
      now: NOW,
    });
    assert.doesNotMatch(r.stdout, /is blocked/);
    assert.match(r.stdout, /conditions on `plan\.md`:/);
  });

  it("status <path> shows research.md as the missing condition for an approved plan", () => {
    const { repo, wf } = statusRepo();
    writeFileSync(
      join(wf, "plan.md"),
      buildPlanContent(approvedWorkflowRepo()),
    );
    recordApprovalsForTest(wf);
    unlinkSync(join(wf, "research.md"));
    const r = status(repo, wf, "src/a.ts");
    assert.match(r.stdout, /is blocked/);
    assert.match(r.stdout, /✗ research\.md/);
  });

  it("status <path> names the owning plan-N.md, or reports an unlisted target, in two-layer mode", () => {
    const { repo, wf } = statusRepo();
    const spec = buildPlanContent(approvedWorkflowRepo());
    writeFileSync(join(wf, "spec.md"), spec);
    writeFileSync(
      join(wf, "plan-1.md"),
      buildPlanNContent(
        approvedWorkflowRepo(),
        ["src/a.ts"],
        computeWorkflowRepoPlanHash(spec),
      ),
    );
    recordApprovalsForTest(wf);
    assert.match(
      status(repo, wf, "src/a.ts").stdout,
      /src\/a\.ts` is allowed by `plan-1\.md`/,
    );
    assert.match(
      status(repo, wf, "src/b.ts").stdout,
      /no plan-N\.md lists `.*src\/b\.ts`/,
    );
  });

  it("status <path> reports the guard's shortcuts as not gated", () => {
    const { repo, wf } = statusRepo();
    writeFileSync(join(wf, "plan.md"), buildPlanContent(pendingWorkflowRepo()));
    assert.match(
      status(repo, wf, join(wf, "notes.md")).stdout,
      /is not gated \(a workflow document\)/,
    );
    assert.match(
      status(repo, wf, "/etc/hosts").stdout,
      /is not gated \(outside the project\)/,
    );
  });
});

describe("workflow-cli: resolveCliDeps (spec K3)", () => {
  const envHelper = new EnvironmentHelper();
  const NOW = new Date("2026-10-02T00:00:00.000Z");
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cli-deps-")));
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", root);
    envHelper.set("CLAUDE_CODE_SESSION_ID", "abcdef1234567890");
    envHelper.set("CLAUDE_SESSION_ID", "ffffffff99999999");
    envHelper.set("DOCUMENT_WORKFLOW_DIR", undefined);
  });

  afterEach(() => {
    envHelper.restore();
  });

  it("derives the dir from CLAUDE_PROJECT_DIR and CLAUDE_CODE_SESSION_ID, ignoring CLAUDE_SESSION_ID", () => {
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r, JSON.stringify(r));
    assert.equal(r.deps.cwd, root);
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "abcdef12"));
    assert.equal(r.deps.wfDirSource, "derived");
  });

  it("reports a startup pin as source env", () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/pinned00");
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r);
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "pinned00"));
    assert.equal(r.deps.wfDirSource, "env");
  });

  it("falls back to the derived dir with a warning when the startup pin is rejected", () => {
    envHelper.set("DOCUMENT_WORKFLOW_DIR", "../outside");
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("deps" in r);
    assert.equal(r.deps.wfDirSource, "derived");
    assert.equal(r.deps.wfDir, join(root, ".tmp", "sessions", "abcdef12"));
    assert.match(
      r.warning ?? "",
      /DOCUMENT_WORKFLOW_DIR="\.\.\/outside" is not a verified descendant/,
    );
  });

  it("fails without CLAUDE_PROJECT_DIR unless --wf-dir has a value", () => {
    envHelper.set("CLAUDE_PROJECT_DIR", undefined);
    for (const argv of [["status"], ["status", "--wf-dir"]]) {
      const r = resolveCliDeps(argv, NOW);
      assert.ok("error" in r, argv.join(" "));
      assert.match(r.error, /CLAUDE_PROJECT_DIR/);
      assert.match(r.error, /restart Claude Code/);
    }
    assert.ok(
      "deps" in resolveCliDeps(["status", "--wf-dir", ".tmp/sessions/x"], NOW),
    );
  });

  it("fails when CLAUDE_PROJECT_DIR is relative or does not exist", () => {
    for (const value of ["relative/dir", join(root, "missing")]) {
      envHelper.set("CLAUDE_PROJECT_DIR", value);
      const r = resolveCliDeps(["status"], NOW);
      assert.ok("error" in r, value);
      assert.match(r.error, /CLAUDE_PROJECT_DIR/);
    }
  });

  it("fails without CLAUDE_CODE_SESSION_ID unless --wf-dir is given", () => {
    envHelper.set("CLAUDE_CODE_SESSION_ID", undefined);
    const r = resolveCliDeps(["status"], NOW);
    assert.ok("error" in r);
    assert.match(r.error, /CLAUDE_CODE_SESSION_ID/);
    assert.match(r.error, /--wf-dir/);
    const withFlag = resolveCliDeps(
      ["status", "--wf-dir", ".tmp/sessions/x"],
      NOW,
    );
    assert.ok("deps" in withFlag);
    assert.equal(withFlag.deps.wfDirSource, "none");
  });
});

describe("workflow-cli: --wf-dir override (spec K3)", () => {
  // `dir` reads no document, so a bare <root>/.tmp/sessions/<id> is enough;
  // seedWorkflow's wf is a plain tmp dir with no project root above it.
  function sessionsRoot(): { root: string; wf: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-override-")));
    const wf = join(root, ".tmp", "sessions", "abcdef12");
    mkdirSync(wf, { recursive: true });
    return { root, wf };
  }

  function depsWith(
    root: string,
    wf: string,
    source: "derived" | "env" | "none",
  ) {
    return {
      cwd: root,
      wfDir: source === "none" ? "" : wf,
      wfDirSource: source,
      sessionId: "test-ses",
      now: NOW,
    };
  }

  it("dir --wf-dir reports source=override and warns when it differs from the resolved dir", () => {
    const { root, wf } = sessionsRoot();
    const other = join(wf, "..", "other000");
    mkdirSync(other, { recursive: true });
    const r = runWorkflowCli(
      ["dir", "--wf-dir", other],
      depsWith(root, wf, "derived"),
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout, `wfDir=${resolve(other)}\nsource=override\n`);
    assert.match(
      r.stderr,
      /--wf-dir points at .*other000, not the resolved dir/,
    );
  });

  it("does not warn when --wf-dir names the resolved dir itself", () => {
    const { root, wf } = sessionsRoot();
    const r = runWorkflowCli(
      ["dir", "--wf-dir", wf],
      depsWith(root, wf, "env"),
    );
    assert.equal(r.stderr, "");
  });

  it("refuses an empty --wf-dir value and a missing resolved dir", () => {
    const { root, wf } = sessionsRoot();
    const empty = runWorkflowCli(
      ["dir", "--wf-dir"],
      depsWith(root, wf, "derived"),
    );
    assert.equal(empty.exitCode, 1);
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /--wf-dir needs a value/);
    const none = runWorkflowCli(["dir"], depsWith(root, wf, "none"));
    assert.equal(none.exitCode, 1);
    assert.match(none.stderr, /pass --wf-dir/);
  });

  it("warns when an overridden or pinned dir does not exist, but not for a fresh derived dir", () => {
    const { root, wf } = sessionsRoot();
    const missing = join(wf, "..", "missing0");
    const override = runWorkflowCli(
      ["dir", "--wf-dir", missing],
      depsWith(root, wf, "derived"),
    );
    assert.equal(override.exitCode, 0);
    assert.match(
      override.stderr,
      /missing0 does not exist \(source=override\)/,
    );
    const derived = runWorkflowCli(["dir"], depsWith(root, missing, "derived"));
    assert.doesNotMatch(derived.stderr, /does not exist/);
  });
});

describe("workflow-cli: output provenance (spec K5)", () => {
  function depsFor(wf: string) {
    return {
      cwd: wf,
      wfDir: wf,
      wfDirSource: "derived" as const,
      sessionId: "test-ses",
      now: NOW,
    };
  }

  it("round, stamp and triage end with wfDir=, source= and wrote= lines", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 0,
      ledgerSlugs: ["logic-validator", "scope-justification-reviewer"],
    });
    const lastLines = (stdout: string) =>
      stdout.trimEnd().split("\n").slice(-3);
    const expected = [
      `wfDir=${wf}`,
      "source=derived",
      `wrote=${join(wf, "plan-1.md")}`,
    ];

    const round = runWorkflowCli(["round", "plan-1.md"], depsFor(wf));
    assert.equal(round.exitCode, 0, round.stderr);
    assert.deepEqual(lastLines(round.stdout), expected);

    const stamp = runWorkflowCli(
      [
        "stamp",
        "plan-1.md",
        "--verdict",
        "needs-work",
        "--reviewers",
        "logic-validator+scope-justification-reviewer",
      ],
      depsFor(wf),
    );
    assert.equal(stamp.exitCode, 0, stamp.stderr);
    assert.deepEqual(lastLines(stamp.stdout), expected);

    const triage = runWorkflowCli(
      ["triage", "plan-1.md", "--adopted", "1", "--excluded", "0"],
      depsFor(wf),
    );
    assert.equal(triage.exitCode, 0, triage.stderr);
    assert.deepEqual(lastLines(triage.stdout), expected);
  });

  it("dir prints exactly the wfDir= and source= lines", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: [],
    });
    const r = runWorkflowCli(["dir"], depsFor(wf));
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, `wfDir=${wf}\nsource=derived\n`);
  });

  it("stamp and triage refuse a path and leave stdout empty", () => {
    const { wf } = seedWorkflow({
      doc: "plan-1.md",
      round: 1,
      ledgerSlugs: ["logic-validator"],
    });
    for (const argv of [
      [
        "stamp",
        "../plan-1.md",
        "--verdict",
        "pass",
        "--reviewers",
        "logic-validator",
      ],
      ["triage", "sub/plan-1.md", "--adopted", "1", "--excluded", "0"],
    ]) {
      const r = runWorkflowCli(argv, depsFor(wf));
      assert.equal(r.exitCode, 1, argv.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /bare file name/);
    }
  });
});
