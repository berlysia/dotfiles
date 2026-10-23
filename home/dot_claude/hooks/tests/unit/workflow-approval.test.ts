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
  APPROVAL_QUESTION_PREFIX,
  DECLINE_DESCRIPTION,
  DELEGATE_NO_DESCRIPTION,
  DELEGATION_QUESTION_TEXT,
  appendApproval,
  buildApprovalQuestionText,
  buildApprovalQuestions,
  deepEqualIgnoringKeyOrder,
  describeAnswerShape,
  describeApprovalWorkflow,
  extractDocumentTitle,
  isAnswerValue,
  isApprovalLikeQuestion,
  isApprovalShapedPrompt,
  matchApprovalAnswer,
  matchDelegationAnswer,
  parseApprovalUtterance,
  projectApprovalText,
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
  const spec = { name: "spec.md", hash: H1, title: null };
  const plan1 = { name: "plan-1.md", hash: H2, title: null };
  const plan2 = { name: "plan-2.md", hash: H1, title: null };
  const wf = { tree: "wt-a", id: "ab6d64e3" };

  it("builds one multiSelect question with a decline option", () => {
    assert.deepEqual(buildApprovalQuestions([spec], wf), [
      {
        question: buildApprovalQuestionText(wf),
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
    const [q] = buildApprovalQuestions([plan2, spec, plan1], wf);
    assert.deepEqual(
      q?.options.map((o) => o.label),
      ["plan-2.md", "spec.md", "plan-1.md", "承認しない"],
    );
  });

  it("throws on an unusable document list", () => {
    const bad = (name: string) => ({ name, hash: H1, title: null });
    assert.throws(() => buildApprovalQuestions([], wf));
    assert.throws(() =>
      buildApprovalQuestions([spec, plan1, plan2, bad("plan-3.md")], wf),
    );
    assert.throws(() => buildApprovalQuestions([spec, spec], wf));
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
      assert.throws(() => buildApprovalQuestions([bad(name)], wf), name);
    }
  });

  it("isApprovalLikeQuestion holds for everything the builder produces", () => {
    assert.equal(
      isApprovalLikeQuestion(buildApprovalQuestions([spec], wf)),
      true,
    );
    assert.equal(
      isApprovalLikeQuestion(buildApprovalQuestions([plan2, spec, plan1], wf)),
      true,
    );
  });

  it("adds the delegation question after the approval question", () => {
    const rows = [
      { entry: "src/", protected: false },
      { entry: "home/dot_claude/", protected: true },
    ];
    const questions = buildApprovalQuestions([spec], wf, rows);
    assert.equal(questions.length, 2);
    assert.deepEqual(questions[0], buildApprovalQuestions([spec], wf)[0]);
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
    assert.throws(() => buildApprovalQuestions([plan1], wf, delegable));
    assert.throws(() =>
      buildApprovalQuestions([spec], wf, [
        { entry: "home/dot_claude/", protected: true },
      ]),
    );
    assert.throws(() => buildApprovalQuestions([spec], wf, []));
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
    const expected = buildApprovalQuestions([spec, plan1], wf);
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
    const expected = buildApprovalQuestions([spec, plan1], wf);
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

describe("describeApprovalWorkflow and buildApprovalQuestionText", () => {
  const D = describeApprovalWorkflow;

  it("reads the work tree and id from <tree>/.tmp/sessions/<id>", () => {
    assert.deepEqual(D("/r/wt-a/.tmp/sessions/ab6d64e3"), {
      tree: "wt-a",
      id: "ab6d64e3",
    });
    assert.deepEqual(D("/r/wt-a/.tmp/sessions/ab6d64e3/"), {
      tree: "wt-a",
      id: "ab6d64e3",
    });
  });

  it("leaves the tree null for any other shape", () => {
    assert.deepEqual(D("/r/wt-a/.tmp/sessions/a/b"), { tree: null, id: "b" });
    assert.deepEqual(D("/x/sessions/ab6d64e3"), { tree: null, id: "ab6d64e3" });
    assert.deepEqual(D("/.tmp/sessions/ab6d64e3"), {
      tree: null,
      id: "ab6d64e3",
    });
  });

  it("projects the id and nulls it when nothing is left", () => {
    assert.equal(D("/r/wt/.tmp/sessions/\u200B").id, null);
    assert.equal(D("/r/wt/.tmp/sessions/a（b）").id, "ab");
  });

  it("removes parentheses, newlines, backticks and bidi from the tree", () => {
    const { tree } = D("/r/x）: 承認する文書に（y\n`z\u202E/.tmp/sessions/ab");
    assert.equal(tree, "x: 承認する文書にy z");
    const text = buildApprovalQuestionText({ tree, id: "ab" });
    assert.equal(
      text,
      `${APPROVAL_QUESTION_PREFIX}（x: 承認する文書にy z / ab）: 承認する文書にチェックを付けてください（議論したいときは Esc）`,
    );
    assert.equal(text.split("（").length - 1, 2);
  });

  it("keeps both ends of a 300 character tree and nulls an empty projection", () => {
    const long = `${"a".repeat(150)}${"b".repeat(150)}`;
    const { tree } = D(`/r/${long}/.tmp/sessions/ab`);
    assert.ok(tree?.includes("…"));
    assert.equal(tree?.split("…").length, 2);
    assert.ok(tree?.endsWith("b".repeat(100)));
    assert.equal(D("/r/\u200B/.tmp/sessions/ab").tree, null);
  });

  it("builds the fixed text when both parts are null, with no parentheses", () => {
    assert.equal(
      buildApprovalQuestionText({ tree: null, id: null }),
      "Document Workflow の承認: 承認する文書にチェックを付けてください（議論したいときは Esc）",
    );
  });

  it("puts tree and id in one pair of parentheses, after the prefix", () => {
    const text = buildApprovalQuestionText({ tree: "wt-a", id: "ab6d64e3" });
    assert.ok(text.startsWith(APPROVAL_QUESTION_PREFIX));
    assert.equal(
      text,
      "Document Workflow の承認（wt-a / ab6d64e3）: 承認する文書にチェックを付けてください（議論したいときは Esc）",
    );
    assert.ok(
      buildApprovalQuestionText({ tree: null, id: "ab6d64e3" }).startsWith(
        `${APPROVAL_QUESTION_PREFIX}（ab6d64e3）: `,
      ),
    );
  });

  it("isApprovalLikeQuestion holds for texts with odd tree names", () => {
    for (const tree of ["委任", "a（b）/c", "x"]) {
      const text = buildApprovalQuestionText({ tree, id: "ab" });
      assert.equal(isApprovalLikeQuestion([{ question: text }]), true);
    }
  });
});

describe("approval question descriptions with titles", () => {
  const wf = { tree: "wt-a", id: "ab6d64e3" };
  const doc = (name: string, title: string | null) => ({
    name,
    hash: H1,
    title,
  });
  const descriptions = (docs: ReturnType<typeof doc>[]) =>
    buildApprovalQuestions(docs, wf)[0]?.options.map((o) => o.description);

  it("appends the title after the hash, or only the hash when null", () => {
    assert.deepEqual(descriptions([doc("spec.md", "Spec: X")]), [
      `hash=${H1.slice(0, 12)} 「Spec: X」`,
      DECLINE_DESCRIPTION,
    ]);
    assert.deepEqual(descriptions([doc("spec.md", null)]), [
      `hash=${H1.slice(0, 12)}`,
      DECLINE_DESCRIPTION,
    ]);
  });

  it("gives each document its own title", () => {
    const d = descriptions([doc("spec.md", "A"), doc("plan-1.md", "B")]);
    assert.ok(d?.[0]?.endsWith("「A」"));
    assert.ok(d?.[1]?.endsWith("「B」"));
  });

  it("cannot let a title act as a label or fake a hash", () => {
    const run = (raw: string) => {
      const title = extractDocumentTitle(`# ${raw}\n`);
      return buildApprovalQuestions([doc("spec.md", title)], wf)[0];
    };
    const decline = run("承認しない");
    assert.equal(decline?.options[0]?.label, "spec.md");
    assert.equal(
      decline?.options.filter((o) => o.label === "承認しない").length,
      1,
    );
    assert.equal(
      decline?.options[0]?.description,
      `hash=${H1.slice(0, 12)} 「承認しない」`,
    );
    const fake = run("」 hash=000000000000 「x");
    assert.equal(
      fake?.options[0]?.description,
      `hash=${H1.slice(0, 12)} 「hash=000000000000 x」`,
    );
  });
});

describe("extractDocumentTitle", () => {
  const T = extractDocumentTitle;

  it("takes the first H1", () => {
    assert.equal(
      T("<!-- spec-ref: spec.md -->\n\n# Plan: Y (Execution layer)\n"),
      "Plan: Y (Execution layer)",
    );
    assert.equal(T("# First\n# Second\n"), "First");
  });

  it("returns null without an H1", () => {
    for (const text of ["", "## A\n", "#x\n", "# \n", "  # T\n"]) {
      assert.equal(T(text), null, JSON.stringify(text));
    }
  });

  it("stops at the first ## line outside fences", () => {
    assert.equal(T("## Approval\n# Late\n"), null);
  });

  it("skips headings inside fences", () => {
    assert.equal(T("```\n# comment\n```\n# Real\n"), "Real");
    assert.equal(T("```\n## not a section\n```\n# Real\n"), "Real");
  });

  it("handles CRLF and a BOM", () => {
    assert.equal(T("# T\r\n"), "T");
    assert.equal(T("\uFEFF# T\n"), "T");
  });

  it("follows the fence closing rules", () => {
    assert.equal(T("```\n# T\n"), null);
    assert.equal(T("````\n```\n# no\n````\n# T\n"), "T");
    assert.equal(T("~~~\n```\n# no\n~~~\n# T\n"), "T");
    assert.equal(T("```\n```js\n# A\n```\n# B\n"), "B");
    assert.equal(T("```\n``` x\n# A\n```\n# B\n"), "B");
    assert.equal(T("```js\n# A\n```  \n# B\n"), "B");
  });

  it("keeps a trailing closing hash and drops U+2026", () => {
    assert.equal(T("# T #\n"), "T #");
    assert.equal(T("# A…B\n"), "AB");
  });
});

describe("projectApprovalText", () => {
  const P = (raw: string, max = 60) => projectApprovalText(raw, max);

  it("turns whitespace and separators into single spaces", () => {
    assert.equal(P("a\nb\tc\u0085d e　f g"), "a b c d e f g");
  });

  it("removes invisible and structural characters without adding spaces", () => {
    assert.equal(P("a\u202Eb\u200Bc`d\uFEFFe"), "abcde");
  });

  it("trims and returns empty strings for nothing visible", () => {
    assert.equal(P("  前後  "), "前後");
    assert.equal(P("   "), "");
    assert.equal(P("\u200B\u202E"), "");
  });

  it("truncates to the code point limit with a trailing ellipsis", () => {
    const sixtyOne = "あ".repeat(61);
    assert.equal(P(sixtyOne), `${"あ".repeat(59)}…`);
    assert.equal(P("あ".repeat(60)), "あ".repeat(60));
    const spaced = `${"x".repeat(58)} y${"z".repeat(5)}`;
    assert.equal(P(spaced), `${"x".repeat(58)}…`);
  });

  it("never leaves a lone surrogate when an emoji straddles the limit", () => {
    for (const pad of [57, 58, 59, 60]) {
      const out = P(`${"a".repeat(pad)}😀😀😀😀`);
      assert.equal(out.isWellFormed(), true);
      assert.ok([...out].length <= 60);
    }
  });

  it("elides a 300-unit input in the middle first, then cuts to the limit", () => {
    const out = P("a".repeat(150) + "b".repeat(150));
    assert.equal([...out].length, 60);
    assert.equal(out.split("…").length, 2);
    assert.ok(out.endsWith("…"));
  });

  it("produces NFC fixed points, also for composed-after-removal input", () => {
    const base = ["が", "e\u034F́", "a\u200B́"];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const pool = [..."aeお が́\u034F\u200B\u202E`\n「」 😀…"];
    for (let i = 0; i < 200; i++) {
      const len = next() % 90;
      let raw = "";
      for (let j = 0; j < len; j++) raw += pool[next() % pool.length];
      base.push(raw);
    }
    for (const raw of base) {
      const p = P(raw);
      assert.equal(p.normalize("NFC"), p);
      assert.equal(p, p.trim());
      if (!p.endsWith("…")) assert.equal(P(p), p);
    }
  });

  it("removes the caller's strip characters before composing and collapsing", () => {
    const out = projectApprovalText("a 「 」 b", 60, /[「」]/gu);
    assert.equal(out, "a b");
  });
});
