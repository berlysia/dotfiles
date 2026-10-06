#!/usr/bin/env node --test

import { strict as assert } from "node:assert";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  APPROVALS_LOG,
  APPROVAL_QUESTION_TEXT,
  DECLINE_DESCRIPTION,
  DELEGATE_NO_DESCRIPTION,
  DELEGATION_QUESTION_TEXT,
  appendApproval,
  buildApprovalQuestions,
  deepEqualIgnoringKeyOrder,
  describeAnswerShape,
  isAnswerValue,
  isApprovalLikeQuestion,
  isApprovalShapedPrompt,
  matchApprovalAnswer,
  matchDelegationAnswer,
  parseApprovalUtterance,
  readLatestApprovals,
} from "../../lib/workflow-approval.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

describe("workflow-approval (spec K8)", () => {
  it("appends one JSON line per approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "plan.md",
      hash: H1,
      session: "s1",
      at: "2026-10-02T00:00:00.000Z",
    });
    assert.equal(
      readFileSync(join(wf, APPROVALS_LOG), "utf-8"),
      `${JSON.stringify({ v: 1, doc: "plan.md", hash: H1, session: "s1", at: "2026-10-02T00:00:00.000Z" })}\n`,
    );
  });

  it("uses only the last line for each document, so a revert does not revive an old approval", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t1" });
    appendApproval(wf, { doc: "plan.md", hash: H2, session: "s", at: "t2" });
    appendApproval(wf, { doc: "spec.md", hash: H1, session: "s", at: "t3" });
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.latest.get("spec.md")?.hash, H1);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("keeps delegate only when it is the known value", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "spec.md",
      hash: H1,
      session: "s",
      at: "t1",
      via: "ask",
      delegate: "plans-in-scope",
    });
    assert.equal(
      readLatestApprovals(wf).latest.get("spec.md")?.delegate,
      "plans-in-scope",
    );

    appendFileSync(
      join(wf, APPROVALS_LOG),
      `${JSON.stringify({ v: 1, doc: "spec.md", hash: H1, session: "s", at: "t2", delegate: "everything" })}\n`,
    );
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("spec.md")?.delegate, undefined);
    assert.equal(r.latest.get("spec.md")?.at, "t2");
    assert.equal(r.ignoredLines, 0);
  });

  it("a later line without delegate turns the delegation off", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "spec.md",
      hash: H1,
      session: "s",
      at: "t1",
      delegate: "plans-in-scope",
    });
    appendApproval(wf, { doc: "spec.md", hash: H1, session: "s", at: "t2" });
    assert.equal(
      readLatestApprovals(wf).latest.get("spec.md")?.delegate,
      undefined,
    );
  });

  it("skips malformed lines and other versions, and counts them", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendFileSync(
      join(wf, APPROVALS_LOG),
      [
        "not json",
        JSON.stringify({
          v: 2,
          doc: "plan.md",
          hash: H1,
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: "short",
          session: "s",
          at: "t",
        }),
        JSON.stringify({
          v: 1,
          doc: "plan.md",
          hash: H2,
          session: "s",
          at: "t",
        }),
        "",
      ].join("\n"),
    );
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.get("plan.md")?.hash, H2);
    assert.equal(r.ignoredLines, 3);
  });

  it("reads an absent log as no approvals", () => {
    const r = readLatestApprovals(mkdtempSync(join(tmpdir(), "approvals-")));
    assert.equal(r.latest.size, 0);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.readError, undefined);
  });

  it("refuses to append through a symlink at the ledger's name", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    const outside = join(wf, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(wf, APPROVALS_LOG));
    assert.throws(
      () =>
        appendApproval(wf, { doc: "plan.md", hash: H1, session: "s", at: "t" }),
      /ELOOP|EMLINK/,
    );
    assert.equal(readFileSync(outside, "utf-8"), "keep");
  });

  it("reports an unreadable log instead of throwing", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    mkdirSync(join(wf, APPROVALS_LOG));
    const r = readLatestApprovals(wf);
    assert.equal(r.latest.size, 0);
    assert.match(r.readError ?? "", /EISDIR/);
  });
});

describe("parseApprovalUtterance (spec K7)", () => {
  it("accepts the bare word, document names and a trailing mark", () => {
    assert.deepEqual(parseApprovalUtterance("承認"), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("  Approve!  "), { docs: [] });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md spec.md。"), {
      docs: ["plan-2.md", "spec.md"],
    });
    assert.deepEqual(parseApprovalUtterance("承認 plan-2.md plan-2.md"), {
      docs: ["plan-2.md"],
    });
  });

  it("ignores anything else", () => {
    for (const prompt of [
      "承認します",
      "承認、ただし T3 は直して",
      "approve this?",
      "plan.md 承認",
      "承認 notes.md",
      "承認 PLAN.MD",
      "/execute-plan 承認",
      "承認\n追記",
      "ok",
    ]) {
      assert.equal(
        parseApprovalUtterance(prompt),
        null,
        JSON.stringify(prompt),
      );
    }
  });
});

describe("isApprovalShapedPrompt (issue J: scheduled prompts)", () => {
  it("is true for what the recorder accepts, in any surrounding whitespace", () => {
    for (const prompt of [
      "承認",
      "承認 plan-99.md",
      "  Approve!  ",
      "承認\u3000spec.md。",
      "承認\n",
      "承認！",
      "\uFEFF承認",
      "\u00A0承認\u2028",
    ]) {
      assert.equal(
        isApprovalShapedPrompt(prompt),
        true,
        JSON.stringify(prompt),
      );
    }
  });

  it("is also true when NFKC and format-character removal make it an approval", () => {
    // The recorder would not record these as typed, but a front-end that
    // normalizes a fired prompt could turn them into one.
    assert.equal(isApprovalShapedPrompt("承\u200B認"), true);
    assert.equal(isApprovalShapedPrompt("ＡＰＰＲＯＶＥ"), true);
  });

  it("is false for anything else, including non-strings", () => {
    for (const prompt of [
      "承認します、ただし…",
      "J-probe",
      "承認\nfoo",
      "",
      123,
      null,
      undefined,
      { prompt: "承認" },
    ]) {
      assert.equal(
        isApprovalShapedPrompt(prompt),
        false,
        JSON.stringify(prompt),
      );
    }
  });
});

describe("approval question (spec K3/K4/K7)", () => {
  const spec = { name: "spec.md", hash: H1 };
  const plan1 = { name: "plan-1.md", hash: H2 };
  const plan2 = { name: "plan-2.md", hash: H1 };

  it("builds one multiSelect question with a decline option", () => {
    assert.deepEqual(buildApprovalQuestions([spec]), [
      {
        question: APPROVAL_QUESTION_TEXT,
        header: "承認",
        multiSelect: true,
        options: [
          { label: "spec.md", description: `hash=${H1.slice(0, 12)}` },
          { label: "承認しない", description: DECLINE_DESCRIPTION },
        ],
      },
    ]);
  });

  it("keeps the input order", () => {
    const [q] = buildApprovalQuestions([plan2, spec, plan1]);
    assert.deepEqual(
      q?.options.map((o) => o.label),
      ["plan-2.md", "spec.md", "plan-1.md", "承認しない"],
    );
  });

  it("throws on an unusable document list", () => {
    const bad = (name: string) => ({ name, hash: H1 });
    assert.throws(() => buildApprovalQuestions([]));
    assert.throws(() =>
      buildApprovalQuestions([spec, plan1, plan2, bad("plan-3.md")]),
    );
    assert.throws(() => buildApprovalQuestions([spec, spec]));
    for (const name of [
      "../x.md",
      "plan-0.md",
      "plan-01.md",
      "spec.md\n",
      "SPEC.md",
      "spec.md/",
      "spe\0c.md",
      "承認しない",
    ]) {
      assert.throws(() => buildApprovalQuestions([bad(name)]), name);
    }
  });

  it("isApprovalLikeQuestion holds for everything the builder produces", () => {
    assert.equal(isApprovalLikeQuestion(buildApprovalQuestions([spec])), true);
    assert.equal(
      isApprovalLikeQuestion(buildApprovalQuestions([plan2, spec, plan1])),
      true,
    );
  });

  it("adds the delegation question after the approval question", () => {
    const rows = [
      { entry: "src/", protected: false },
      { entry: "home/dot_claude/", protected: true },
    ];
    const questions = buildApprovalQuestions([spec], rows);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0], buildApprovalQuestions([spec])[0]);
    assert.deepEqual(questions[1], {
      question: DELEGATION_QUESTION_TEXT,
      header: "委任",
      multiSelect: false,
      options: [
        { label: "委任しない", description: DELEGATE_NO_DESCRIPTION },
        {
          label: "委任する",
          description:
            "Scope: src/, home/dot_claude/（委任の対象外）。レビューを通った plan-N.md は承認を待たずに実装へ進む",
        },
      ],
    });
    assert.equal(isApprovalLikeQuestion([questions[1]]), true);
  });

  it("refuses a delegation question without spec.md or without a row that can be delegated", () => {
    const delegable = [{ entry: "src/", protected: false }];
    assert.throws(() => buildApprovalQuestions([plan1], delegable));
    assert.throws(() =>
      buildApprovalQuestions(
        [spec],
        [{ entry: "home/dot_claude/", protected: true }],
      ),
    );
    assert.throws(() => buildApprovalQuestions([spec], []));
  });

  it("matchDelegationAnswer reads only the two labels", () => {
    assert.equal(matchDelegationAnswer("委任する"), "delegate");
    assert.equal(matchDelegationAnswer("委任しない"), "keep");
    assert.equal(matchDelegationAnswer("あとで"), "other");
    assert.equal(matchDelegationAnswer(["委任する"]), "other");
    assert.equal(matchDelegationAnswer(undefined), "other");
  });

  it("isApprovalLikeQuestion is true for approval-looking questions", () => {
    assert.equal(
      isApprovalLikeQuestion([
        { question: "Document Workflow の承認（改変）" },
      ]),
      true,
    );
    assert.equal(
      isApprovalLikeQuestion([
        { question: "x", options: [{ label: "a" }, { label: "承認しない" }] },
      ]),
      true,
    );
    assert.equal(
      isApprovalLikeQuestion([
        {
          question: "spec.md を承認しますか",
          options: [{ label: "spec.md" }, { label: "いいえ" }],
        },
      ]),
      true,
    );
    assert.equal(
      isApprovalLikeQuestion([
        { question: "ok?", options: [{ label: "a" }] },
        { question: "Document Workflow の承認", options: [] },
      ]),
      true,
    );
  });

  it("isApprovalLikeQuestion is false for ordinary questions", () => {
    assert.equal(
      isApprovalLikeQuestion([
        {
          question: "この方針で進めてよいか",
          options: [{ label: "はい" }, { label: "いいえ" }],
        },
      ]),
      false,
    );
    assert.equal(
      isApprovalLikeQuestion([
        {
          question: "承認フローを変えますか",
          options: [{ label: "はい" }, { label: "いいえ" }],
        },
      ]),
      false,
    );
  });

  it("isApprovalLikeQuestion never throws", () => {
    const thrower = Object.defineProperty({}, "question", {
      get() {
        throw new Error("x");
      },
    });
    for (const input of [
      undefined,
      null,
      "x",
      [null],
      [{ options: null }],
      [{ question: 1, options: [1] }],
      [thrower],
    ]) {
      assert.equal(isApprovalLikeQuestion(input), false);
    }
  });

  it("matchApprovalAnswer classifies the answer string", () => {
    const expected = buildApprovalQuestions([spec, plan1]);
    assert.deepEqual(matchApprovalAnswer(expected, "spec.md, plan-1.md"), {
      kind: "approve",
      docs: ["spec.md", "plan-1.md"],
    });
    assert.deepEqual(matchApprovalAnswer(expected, "spec.md, spec.md"), {
      kind: "approve",
      docs: ["spec.md"],
    });
    assert.deepEqual(matchApprovalAnswer(expected, "承認しない"), {
      kind: "decline",
    });
    assert.deepEqual(matchApprovalAnswer(expected, "spec.md, 承認しない"), {
      kind: "invalid",
      reason: "decline-mixed",
    });
    assert.deepEqual(matchApprovalAnswer(expected, ""), {
      kind: "freeText",
      text: "",
    });
    assert.deepEqual(matchApprovalAnswer(expected, "直してほしい"), {
      kind: "freeText",
      text: "直してほしい",
    });
    assert.deepEqual(matchApprovalAnswer(expected, "spec.md, plan-9.md"), {
      kind: "freeText",
      text: "spec.md, plan-9.md",
    });
  });

  it("matchApprovalAnswer takes an array as one selection per element", () => {
    const expected = buildApprovalQuestions([spec, plan1]);
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md"]), {
      kind: "approve",
      docs: ["spec.md"],
    });
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md", "plan-1.md"]), {
      kind: "approve",
      docs: ["spec.md", "plan-1.md"],
    });
    assert.deepEqual(matchApprovalAnswer(expected, ["承認しない"]), {
      kind: "decline",
    });
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md", "承認しない"]), {
      kind: "invalid",
      reason: "decline-mixed",
    });
    // One element is one selection: it is not split on ", ".
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md, plan-1.md"]), {
      kind: "freeText",
      text: "spec.md, plan-1.md",
    });
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md", "あとで直す"]), {
      kind: "freeText",
      text: "spec.md, あとで直す",
    });
    assert.deepEqual(matchApprovalAnswer(expected, ["spec.md", "spec.md"]), {
      kind: "approve",
      docs: ["spec.md"],
    });
    // No selection never approves, even if a caller skips isAnswerValue.
    assert.deepEqual(matchApprovalAnswer(expected, []), {
      kind: "freeText",
      text: "",
    });
  });

  it("isAnswerValue accepts a string or a non-empty array of strings", () => {
    for (const ok of ["", "spec.md", ["spec.md"], ["a", "b"]]) {
      assert.equal(isAnswerValue(ok), true, JSON.stringify(ok));
    }
    for (const ng of [
      [],
      [1],
      ["spec.md", 1],
      [["spec.md"]],
      1,
      null,
      undefined,
      {},
    ]) {
      assert.equal(isAnswerValue(ng), false, JSON.stringify(ng));
    }
  });

  it("describeAnswerShape names the type and never the content", () => {
    assert.equal(describeAnswerShape(1), "number");
    assert.equal(describeAnswerShape(null), "null");
    assert.equal(describeAnswerShape({ a: "secret" }), "object");
    assert.equal(describeAnswerShape([]), "array[0]");
    assert.equal(
      describeAnswerShape(["secret", 1]),
      "array[2] of number+string",
    );
    assert.equal(describeAnswerShape([null]), "array[1] of null");
  });

  it("deepEqualIgnoringKeyOrder ignores key order only", () => {
    assert.equal(
      deepEqualIgnoringKeyOrder({ a: 1, b: 2 }, { b: 2, a: 1 }),
      true,
    );
    assert.equal(deepEqualIgnoringKeyOrder([1, 2], [2, 1]), false);
    assert.equal(deepEqualIgnoringKeyOrder({ a: 1, b: 2 }, { a: 1 }), false);
    assert.equal(deepEqualIgnoringKeyOrder({ a: 1 }, { a: 1, b: 2 }), false);
    assert.equal(deepEqualIgnoringKeyOrder({ a: undefined }, {}), false);
    assert.equal(deepEqualIgnoringKeyOrder([], {}), false);
    assert.equal(deepEqualIgnoringKeyOrder(1, "1"), false);
    assert.equal(deepEqualIgnoringKeyOrder({ a: null }, {}), false);
    assert.equal(
      deepEqualIgnoringKeyOrder(
        { x: [{ a: 1, b: 2 }] },
        { x: [{ b: 2, a: 1 }] },
      ),
      true,
    );
  });
});

describe("ledger via field (spec K5)", () => {
  it("writes via as given", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    appendApproval(wf, {
      doc: "plan.md",
      hash: H1,
      session: "s",
      at: "t",
      via: "ask",
    });
    const line = readFileSync(join(wf, APPROVALS_LOG), "utf-8").trim();
    assert.deepEqual(JSON.parse(line), {
      v: 1,
      doc: "plan.md",
      hash: H1,
      session: "s",
      at: "t",
      via: "ask",
    });
  });

  it("reads via, and treats a missing or unknown via as undefined without ignoring the line", () => {
    const wf = mkdtempSync(join(tmpdir(), "approvals-"));
    const base = { v: 1, hash: H1, session: "s", at: "t" };
    appendFileSync(
      join(wf, APPROVALS_LOG),
      [
        { ...base, doc: "spec.md", via: "utterance" },
        { ...base, doc: "plan-1.md", via: "ask" },
        { ...base, doc: "plan-2.md" },
        { ...base, doc: "plan-3.md", via: "other" },
      ]
        .map((r) => `${JSON.stringify(r)}\n`)
        .join(""),
    );
    const r = readLatestApprovals(wf);
    assert.equal(r.ignoredLines, 0);
    assert.equal(r.latest.get("spec.md")?.via, "utterance");
    assert.equal(r.latest.get("plan-1.md")?.via, "ask");
    assert.equal(r.latest.get("plan-2.md")?.via, undefined);
    assert.equal(r.latest.get("plan-3.md")?.via, undefined);
  });
});
