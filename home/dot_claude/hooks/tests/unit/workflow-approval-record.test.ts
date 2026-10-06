#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  APPROVALS_LOG,
  APPROVAL_QUESTION_TEXT,
  DELEGATION_QUESTION_TEXT,
  buildApprovalQuestions,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";
import {
  describeRecordResult,
  recordOne,
  verifyAndRecordApprovalAnswer,
} from "../../lib/workflow-approval-record.ts";
import {
  buildPlanContent,
  buildPlanNContent,
  buildSpecWithScope,
  computeWorkflowRepoPlanHash,
  type WorkflowRepoOptions,
} from "../support/test-helpers.ts";

const REVIEWED: WorkflowRepoOptions = {
  planStatus: "complete",
  approvalStatus: "pending",
  review: { verdict: "pass" },
};

type Response = Record<string, unknown>;

describe("workflow-approval-record (spec K3/K5/K8)", () => {
  let wf: string;
  let specHash: string;
  let plan1Hash: string;

  beforeEach(() => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-record-")));
    wf = join(repo, ".tmp", "sessions", "abcd1234");
    mkdirSync(wf, { recursive: true });
    const spec = buildPlanContent(REVIEWED);
    specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(join(wf, "spec.md"), spec);
    const plan1 = buildPlanNContent(REVIEWED, ["src/a.ts"], specHash);
    plan1Hash = computeWorkflowRepoPlanHash(plan1);
    writeFileSync(join(wf, "plan-1.md"), plan1);
  });

  const logLines = (): Record<string, unknown>[] =>
    existsSync(join(wf, APPROVALS_LOG))
      ? readFileSync(join(wf, APPROVALS_LOG), "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  const response = (
    answer: unknown,
    docs = ["spec.md", "plan-1.md"],
  ): Response => {
    const hashes: Record<string, string> = {
      "spec.md": specHash,
      "plan-1.md": plan1Hash,
    };
    return {
      questions: buildApprovalQuestions(
        docs.map((name) => ({ name, hash: hashes[name] ?? specHash })),
      ),
      answers: { [APPROVAL_QUESTION_TEXT]: answer },
    };
  };

  const verify = (r: unknown) => verifyAndRecordApprovalAnswer(wf, r, "sess");

  describe("recordOne", () => {
    it("records, writes via, and rewrites the Approval line", () => {
      const result = recordOne(wf, "spec.md", specHash, "s", "t", "ask");
      assert.deepEqual(
        { doc: result.doc, state: result.state, hash: result.hash },
        { doc: "spec.md", state: "recorded", hash: specHash },
      );
      assert.equal(logLines()[0]?.via, "ask");
      assert.match(
        readFileSync(join(wf, "spec.md"), "utf-8"),
        /^- Approval Status: approved$/m,
      );
    });

    it("reports loggedOnly for a symlinked document", () => {
      renameSync(join(wf, "spec.md"), join(wf, "real-spec.md"));
      symlinkSync(join(wf, "real-spec.md"), join(wf, "spec.md"));
      const result = recordOne(wf, "spec.md", specHash, "s", "t", "ask");
      assert.equal(result.state, "loggedOnly");
    });

    it("reports failed without throwing when the ledger cannot be appended", () => {
      mkdirSync(join(wf, APPROVALS_LOG));
      const result = recordOne(wf, "spec.md", specHash, "s", "t", "ask");
      assert.equal(result.state, "failed");
    });

    it("is harmless to run twice with the same hash", () => {
      recordOne(wf, "spec.md", specHash, "s", "t1", "ask");
      recordOne(wf, "spec.md", specHash, "s", "t2", "ask");
      assert.equal(logLines().length, 2);
      assert.equal(
        readLatestApprovals(wf).latest.get("spec.md")?.hash,
        specHash,
      );
    });
  });

  describe("verifyAndRecordApprovalAnswer", () => {
    it("records every selected document with the verified hash", () => {
      const r = verify(response("spec.md, plan-1.md"));
      assert.equal(r.kind, "recorded");
      if (r.kind !== "recorded") return;
      assert.deepEqual(
        r.results.map(({ doc, state }) => ({ doc, state })),
        [
          { doc: "spec.md", state: "recorded" },
          { doc: "plan-1.md", state: "recorded" },
        ],
      );
      const lines = logLines();
      assert.equal(lines.length, 2);
      assert.deepEqual(
        lines.map((l) => [l.doc, l.hash, l.via]),
        [
          ["spec.md", specHash, "ask"],
          ["plan-1.md", plan1Hash, "ask"],
        ],
      );
    });

    it("reports a symlinked document as loggedOnly next to a recorded one", () => {
      renameSync(join(wf, "plan-1.md"), join(wf, "target.txt"));
      symlinkSync(join(wf, "target.txt"), join(wf, "plan-1.md"));
      const r = verify(response("spec.md, plan-1.md"));
      assert.equal(r.kind, "recorded");
      if (r.kind !== "recorded") return;
      assert.deepEqual(
        r.results.map((x) => x.state),
        ["recorded", "loggedOnly"],
      );
    });

    it("returns afk, and logs nothing", () => {
      assert.deepEqual(
        verify({ ...response("spec.md, plan-1.md"), afkTimeoutMs: 1000 }),
        { kind: "afk" },
      );
      assert.equal(logLines().length, 0);
    });

    it("returns freeText for a response key", () => {
      assert.deepEqual(
        verify({ ...response("spec.md"), response: "やっぱり待って" }),
        { kind: "freeText", text: "やっぱり待って" },
      );
      assert.equal(logLines().length, 0);
    });

    const base = () => response("spec.md, plan-1.md");
    const q0 = (r: Response) =>
      (r.questions as Record<string, unknown>[])[0] as Record<string, unknown>;
    const options = (r: Response) => q0(r).options as Record<string, unknown>[];
    const cases: [string, (r: Response) => Response | unknown][] = [
      ["extra key", (r) => ({ ...r, extra: 1 })],
      ["no answers", (r) => ({ questions: r.questions })],
      ["answers null", (r) => ({ ...r, answers: null })],
      ["answers empty", (r) => ({ ...r, answers: {} })],
      ["answers wrong key", (r) => ({ ...r, answers: { other: "spec.md" } })],
      [
        "answers two keys",
        (r) => ({
          ...r,
          answers: { [APPROVAL_QUESTION_TEXT]: "spec.md", other: "x" },
        }),
      ],
      ["two questions", (r) => ({ ...r, questions: [q0(r), q0(r)] })],
      [
        "question text changed",
        (r) => {
          q0(r).question = "Document Workflow の承認: 全部承認する";
          return {
            ...r,
            answers: { [q0(r).question as string]: "spec.md, plan-1.md" },
          };
        },
      ],
      [
        "header changed",
        (r) => {
          q0(r).header = "確認";
          return r;
        },
      ],
      [
        "multiSelect false",
        (r) => {
          q0(r).multiSelect = false;
          return r;
        },
      ],
      [
        "preview added",
        (r) => {
          (options(r)[0] as Record<string, unknown>).preview = "x";
          return r;
        },
      ],
      [
        "decline moved first",
        (r) => {
          q0(r).options = [options(r).at(-1), ...options(r).slice(0, -1)];
          return r;
        },
      ],
      [
        "hash digit changed",
        (r) => {
          const o = options(r)[0] as Record<string, string>;
          o.description = o.description?.replace(/.$/, "b") ?? "";
          return r;
        },
      ],
      [
        "description suffix",
        (r) => {
          const o = options(r)[0] as Record<string, string>;
          o.description += " ※差し戻し";
          return r;
        },
      ],
      [
        "decline description changed",
        (r) => {
          (options(r).at(-1) as Record<string, string>).description = "x";
          return r;
        },
      ],
      [
        "decline removed",
        (r) => {
          q0(r).options = options(r).slice(0, -1);
          return r;
        },
      ],
      [
        "decline twice",
        (r) => {
          q0(r).options = [...options(r), options(r).at(-1)];
          return r;
        },
      ],
      [
        "answer mixes decline",
        (r) => ({
          ...r,
          answers: { [APPROVAL_QUESTION_TEXT]: "spec.md, 承認しない" },
        }),
      ],
    ];
    for (const [name, mutate] of cases) {
      it(`malformed: ${name}`, () => {
        assert.deepEqual(verify(mutate(base())), { kind: "malformed" });
        assert.equal(logLines().length, 0);
      });
    }

    for (const label of ["../x.md", "plan-01.md", "SPEC.md", "spec.md\n"]) {
      it(`malformed: label ${JSON.stringify(label)}`, () => {
        const r = base();
        (options(r)[0] as Record<string, unknown>).label = label;
        r.answers = { [APPROVAL_QUESTION_TEXT]: label };
        assert.deepEqual(verify(r), { kind: "malformed" });
        assert.equal(logLines().length, 0);
      });
    }

    it("rejects a label that resolves to a real document through the path", () => {
      const label = `../${basename(wf)}/spec.md`;
      const r = base();
      (options(r)[0] as Record<string, unknown>).label = label;
      r.answers = { [APPROVAL_QUESTION_TEXT]: label };
      assert.deepEqual(verify(r), { kind: "malformed" });
      assert.equal(logLines().length, 0);
    });

    it("reports notCandidate for a document that is not waiting", () => {
      writeFileSync(
        join(wf, "plan-2.md"),
        buildPlanNContent(
          { ...REVIEWED, review: { verdict: "needs-work" } },
          ["src/b.ts"],
          specHash,
        ),
      );
      const r = response("plan-2.md", ["plan-2.md"]);
      assert.deepEqual(verify(r), {
        kind: "notCandidate",
        docs: ["plan-2.md"],
      });
      assert.equal(logLines().length, 0);
    });

    describe("array answers", () => {
      it("records a single selection sent as an array", () => {
        const result = verify(response(["spec.md"]));
        assert.equal(result.kind, "recorded");
        assert.deepEqual(
          logLines().map((l) => [l.doc, l.hash, l.via]),
          [["spec.md", specHash, "ask"]],
        );
      });

      it("records every selection sent as an array", () => {
        const result = verify(response(["spec.md", "plan-1.md"]));
        assert.equal(result.kind, "recorded");
        assert.deepEqual(
          logLines().map((l) => l.doc),
          ["spec.md", "plan-1.md"],
        );
      });

      it("treats a decline sent as an array as a decline", () => {
        assert.deepEqual(verify(response(["承認しない"])), { kind: "decline" });
        assert.equal(logLines().length, 0);
      });

      it("rejects a decline mixed with a document", () => {
        assert.deepEqual(verify(response(["spec.md", "承認しない"])), {
          kind: "malformed",
        });
        assert.equal(logLines().length, 0);
      });

      it("returns free text typed into Other and records nothing", () => {
        const typed = "回避の案として。 承認 plan-1.md";
        assert.deepEqual(verify(response([typed])), {
          kind: "freeText",
          text: typed,
        });
        assert.equal(logLines().length, 0);
      });

      it("does not split one element on the separator", () => {
        assert.deepEqual(verify(response(["spec.md, plan-1.md"])), {
          kind: "freeText",
          text: "spec.md, plan-1.md",
        });
        assert.equal(logLines().length, 0);
      });
    });

    describe("answerShape", () => {
      const shapes: [unknown, string][] = [
        [1, "number"],
        [null, "null"],
        [{}, "object"],
        [[], "array[0]"],
        [[1], "array[1] of number"],
        [["spec.md", 1], "array[2] of number+string"],
        [[["spec.md"]], "array[1] of array"],
      ];
      for (const [value, shape] of shapes) {
        it(`reports ${shape} and records nothing`, () => {
          assert.deepEqual(verify(response(value)), {
            kind: "answerShape",
            shape,
            docs: ["spec.md", "plan-1.md"],
          });
          assert.equal(logLines().length, 0);
        });
      }

      it("stays malformed when the question does not match either", () => {
        const r = response(1);
        (r.questions as Record<string, unknown>[])[0]!.header = "確認";
        assert.deepEqual(verify(r), { kind: "malformed" });
      });

      it("returns the notes before looking at the answer shape", () => {
        const r = {
          ...response(1),
          annotations: { [APPROVAL_QUESTION_TEXT]: { notes: "ここを直す" } },
        };
        assert.deepEqual(verify(r), { kind: "notes", notes: "ここを直す" });
      });
    });

    it("accepts different key order in the questions", () => {
      const r = base();
      const reordered = {
        answers: r.answers,
        questions: (r.questions as Record<string, unknown>[]).map((q) => ({
          options: (q.options as Record<string, unknown>[]).map((o) => ({
            description: o.description,
            label: o.label,
          })),
          multiSelect: q.multiSelect,
          header: q.header,
          question: q.question,
        })),
      };
      assert.equal(verify(reordered).kind, "recorded");
    });

    it("accepts a different document order", () => {
      const r = {
        questions: buildApprovalQuestions([
          { name: "plan-1.md", hash: plan1Hash },
          { name: "spec.md", hash: specHash },
        ]),
        answers: { [APPROVAL_QUESTION_TEXT]: "spec.md, plan-1.md" },
      };
      assert.equal(verify(r).kind, "recorded");
    });

    it("returns decline and logs nothing", () => {
      assert.deepEqual(verify(response("承認しない")), { kind: "decline" });
      assert.equal(logLines().length, 0);
    });

    it("returns notes and logs nothing", () => {
      const r = {
        ...response("spec.md"),
        annotations: { [APPROVAL_QUESTION_TEXT]: { notes: "ここ直して" } },
      };
      assert.deepEqual(verify(r), { kind: "notes", notes: "ここ直して" });
      assert.equal(logLines().length, 0);
    });

    it("returns freeText for an answer that is not a label", () => {
      assert.deepEqual(verify(response("直してほしい")), {
        kind: "freeText",
        text: "直してほしい",
      });
      assert.equal(logLines().length, 0);
    });

    it("returns notApproval for an ordinary question", () => {
      const r = {
        questions: [
          {
            question: "進めてよいか",
            header: "確認",
            multiSelect: false,
            options: [
              { label: "はい", description: "" },
              { label: "いいえ", description: "" },
            ],
          },
        ],
        answers: { 進めてよいか: "はい" },
      };
      assert.deepEqual(verify(r), { kind: "notApproval" });
      assert.deepEqual(verify(undefined), { kind: "notApproval" });
      assert.equal(logLines().length, 0);
    });
  });

  describe("describeRecordResult", () => {
    const hash = "c".repeat(64);
    it("states the fact for each state, without a route-specific recovery", () => {
      assert.equal(
        describeRecordResult({ doc: "spec.md", state: "recorded", hash }),
        "spec.md を hash=cccccccccccc で承認として記録した",
      );
      assert.equal(
        describeRecordResult({ doc: "spec.md", state: "loggedOnly", hash }),
        "spec.md は log には記録したが承認行の書き換えに失敗した。`workflow-cli status` で確認する",
      );
      assert.equal(
        describeRecordResult({ doc: "spec.md", state: "failed", hash }),
        "spec.md は記録できなかった（何も書いていない）。`workflow-cli status` で確認する",
      );
    });
  });
});

describe("workflow-approval-record: delegation question (spec K6)", () => {
  let repo: string;
  let wf: string;
  let specHash: string;
  const rows = [{ entry: "src/", protected: false }];

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "approval-deleg-")));
    wf = join(repo, ".tmp", "sessions", "abcd1234");
    mkdirSync(wf, { recursive: true });
    const spec = buildSpecWithScope(REVIEWED, ["src/"]);
    specHash = computeWorkflowRepoPlanHash(spec);
    writeFileSync(join(wf, "spec.md"), spec);
  });

  const response = (
    docAnswer: unknown,
    delegationAnswer?: unknown,
    withSecondQuestion = true,
  ): Record<string, unknown> => ({
    questions: buildApprovalQuestions(
      [{ name: "spec.md", hash: specHash }],
      withSecondQuestion ? rows : undefined,
    ),
    answers: {
      [APPROVAL_QUESTION_TEXT]: docAnswer,
      ...(delegationAnswer === undefined
        ? {}
        : { [DELEGATION_QUESTION_TEXT]: delegationAnswer }),
    },
  });
  const verify = (r: unknown) =>
    verifyAndRecordApprovalAnswer(wf, r, "sess", new Date(), repo);
  const lines = (): Record<string, unknown>[] => {
    const path = join(wf, "approvals.log");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  it("records the delegation on the spec.md line", () => {
    const r = verify(response("spec.md", "委任する"));
    assert.equal(r.kind, "recorded");
    assert.equal(r.kind === "recorded" && r.results[0]?.delegated, true);
    assert.deepEqual(
      lines().map((l) => [l.doc, l.hash, l.via, l.delegate]),
      [["spec.md", specHash, "ask", "plans-in-scope"]],
    );
  });

  it("records the approval without delegation when the user keeps per-plan approval", () => {
    const r = verify(response("spec.md", "委任しない"));
    assert.equal(r.kind, "recorded");
    assert.equal(r.kind === "recorded" && r.results[0]?.delegated, undefined);
    assert.deepEqual(
      lines().map((l) => l.delegate),
      [undefined],
    );
  });

  it("records nothing when the user declines, whatever the second answer", () => {
    assert.deepEqual(verify(response("承認しない", "委任する")), {
      kind: "decline",
    });
    assert.deepEqual(verify(response("承認しない", "あとで決める")), {
      kind: "decline",
    });
    assert.equal(lines().length, 0);
  });

  it("treats a typed second answer as a remark and records nothing", () => {
    const r = verify(response("spec.md", "あとで決める"));
    assert.deepEqual(r, { kind: "freeText", text: "あとで決める" });
    assert.equal(lines().length, 0);
  });

  const malformed: [string, () => unknown][] = [
    [
      "the second question was dropped",
      () => response("spec.md", undefined, false),
    ],
    ["the second answer is missing", () => response("spec.md")],
    [
      "the second answer is not a string",
      () => response("spec.md", ["委任する"]),
    ],
    [
      "the delegation description was edited",
      () => {
        const r = response("spec.md", "委任する");
        const questions = structuredClone(r.questions) as {
          options: { description: string }[];
        }[];
        const option = questions[1]?.options[1];
        if (option) option.description = "Scope: src/";
        return { ...r, questions };
      },
    ],
    [
      "the two delegation labels were swapped",
      () => {
        const r = response("spec.md", "委任しない");
        const questions = structuredClone(r.questions) as {
          options: unknown[];
        }[];
        questions[1]?.options.reverse();
        return { ...r, questions };
      },
    ],
    [
      "a third question was added",
      () => {
        const r = response("spec.md", "委任する");
        const questions = r.questions as unknown[];
        return { ...r, questions: [...questions, questions[1]] };
      },
    ],
  ];
  for (const [name, build] of malformed) {
    it(`malformed: ${name}`, () => {
      assert.deepEqual(verify(build()), { kind: "malformed" });
      assert.equal(lines().length, 0);
    });
  }

  it("is malformed without a project root, because the offer cannot be rebuilt", () => {
    assert.deepEqual(
      verifyAndRecordApprovalAnswer(
        wf,
        response("spec.md", "委任する"),
        "sess",
      ),
      { kind: "malformed" },
    );
    assert.equal(lines().length, 0);
  });

  it("reports a document that is not waiting before it looks at the answer keys", () => {
    const r = {
      questions: buildApprovalQuestions([
        { name: "spec.md", hash: specHash },
        { name: "plan-1.md", hash: specHash },
      ]),
      answers: { "some other text": "spec.md" },
    };
    assert.deepEqual(verify(r), { kind: "notCandidate", docs: ["plan-1.md"] });
    assert.equal(lines().length, 0);
  });

  it("is malformed when the Scope changed after the question was built", () => {
    const r = response("spec.md", "委任する");
    writeFileSync(
      join(wf, "spec.md"),
      buildSpecWithScope(REVIEWED, ["src/", "lib/"]),
    );
    assert.deepEqual(verify(r), { kind: "malformed" });
    assert.equal(lines().length, 0);
  });

  it("describes a delegated record", () => {
    const r = verify(response("spec.md", "委任する"));
    assert.ok(r.kind === "recorded" && r.results[0]);
    assert.match(
      describeRecordResult(r.results[0]),
      /spec\.md を hash=[0-9a-f]{12} で承認として記録した（Scope に収まる plan-N\.md を委任）/,
    );
  });
});
