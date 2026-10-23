import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractQuestionTexts,
  hasPrefilledAnswer,
} from "../../lib/ask-user-question-input.ts";

describe("hasPrefilledAnswer", () => {
  it("is true when answers or annotations is present in any form", () => {
    for (const input of [
      { answers: {} },
      { answers: "" },
      { answers: null },
      { annotations: {} },
      { annotations: [] },
      { questions: [], answers: { q: "a" } },
    ]) {
      assert.equal(hasPrefilledAnswer(input), true, JSON.stringify(input));
    }
  });

  it("is false for an empty object, undefined fields, null and non-objects", () => {
    for (const input of [
      {},
      { answers: undefined },
      { annotations: undefined },
      { questions: [] },
      null,
      undefined,
      "answers",
      42,
    ]) {
      assert.equal(hasPrefilledAnswer(input), false, String(input));
    }
  });
});

describe("extractQuestionTexts", () => {
  it("returns question texts and option labels, not descriptions or headers", () => {
    const texts = extractQuestionTexts({
      questions: [
        {
          header: "HEADER",
          question: "Q1",
          options: [
            { label: "L1", description: "DESC1" },
            { label: "L2", description: "DESC2" },
          ],
        },
        { question: "Q2", options: [{ label: "L3" }] },
      ],
    });
    assert.deepEqual(texts, ["Q1", "L1", "L2", "Q2", "L3"]);
  });

  it("returns null when the shape is not the expected one", () => {
    for (const input of [
      null,
      undefined,
      "x",
      {},
      { questions: "x" },
      { questions: [null] },
      { questions: [1] },
      { questions: [{ question: 1 }] },
      { questions: [{ question: "q", options: "x" }] },
      { questions: [{ question: "q", options: [{ label: 1 }] }] },
      { questions: [{ question: "q", options: [null] }] },
    ]) {
      assert.equal(extractQuestionTexts(input), null, JSON.stringify(input));
    }
  });

  it("returns null instead of throwing on a hostile getter", () => {
    const hostile = {
      get questions(): unknown {
        throw new Error("boom");
      },
    };
    assert.equal(extractQuestionTexts(hostile), null);
  });

  it("accepts a question without options", () => {
    assert.deepEqual(extractQuestionTexts({ questions: [{ question: "q" }] }), [
      "q",
    ]);
  });
});
