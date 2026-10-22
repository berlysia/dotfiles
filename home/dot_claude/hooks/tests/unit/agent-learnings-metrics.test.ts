import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  detectFeedbackReader,
  findAcceptingInjection,
  formatFeedbackLine,
  formatInjectionLine,
  formatReviewLine,
  parseFeedbackLines,
  parseInjectionLines,
  summarizeMetrics,
  type FeedbackLine,
  type InjectionLine,
  type RecordKind,
  type ReviewItem,
  type Verdict,
} from "../../lib/agent-learnings/core/metrics.ts";

const NOW = new Date("2026-10-22T00:00:00.000Z");
const day = (n: number): string =>
  new Date(NOW.getTime() - n * 86400000).toISOString();
const REPO = "github.com/a/b";
const ID = "L-0123456789ab";

const inj = (
  over: Partial<InjectionLine> & { ago?: number } = {},
): InjectionLine => ({
  v: 1,
  at: day(over.ago ?? 1),
  repoKey: REPO,
  id: ID,
  kind: "pre",
  trigger: "cmd:git commit",
  ...over,
});
const fb = (
  verdict: Verdict,
  over: Partial<FeedbackLine> & { ago?: number } = {},
): FeedbackLine => ({
  v: 1,
  at: day(over.ago ?? 0.5),
  reader: "claude",
  repoKey: REPO,
  id: ID,
  verdict,
  kind: "pre",
  trigger: "cmd:git commit",
  ...over,
});

describe("line format and parse", () => {
  it("round-trips injection and feedback lines in spec key order", () => {
    const i = inj();
    const text = formatInjectionLine(i);
    ok(text.endsWith("\n"));
    deepStrictEqual(Object.keys(JSON.parse(text)), [
      "v",
      "at",
      "repoKey",
      "id",
      "kind",
      "trigger",
    ]);
    deepStrictEqual(parseInjectionLines(text), { lines: [i], unknown: 0 });
    const f = fb("wrong");
    deepStrictEqual(Object.keys(JSON.parse(formatFeedbackLine(f))), [
      "v",
      "at",
      "reader",
      "repoKey",
      "id",
      "verdict",
      "kind",
      "trigger",
    ]);
    deepStrictEqual(parseFeedbackLines(formatFeedbackLine(f)), {
      lines: [f],
      unknown: 0,
    });
  });

  it("accepts untagged", () => {
    strictEqual(
      parseInjectionLines(formatInjectionLine(inj({ trigger: "untagged" })))
        .lines.length,
      1,
    );
  });

  it("counts invalid objects as unknown and never yields them", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...inj(), v: 2 },
      { ...inj(), kind: "post" },
      { ...inj(), trigger: "cmd:git; rm" },
      { ...inj(), trigger: "cmd:git\n" },
      { ...inj(), trigger: "cmd:git\x1b[31m" },
      { ...inj(), trigger: "cmd:git\x00" },
      { ...inj(), trigger: "cmd:git‮" },
      { ...inj(), repoKey: "github.com/a/b\n" },
      { ...inj(), repoKey: "github.com/a/\x1b" },
      { ...inj(), id: `${ID}\n` },
      { ...inj(), at: "2026-10-22" },
      { ...inj(), trigger: `cmd:${"a".repeat(10 * 1024)}` },
    ];
    for (const record of bad) {
      const r = parseInjectionLines(`${JSON.stringify(record)}\n`);
      deepStrictEqual(
        r,
        { lines: [], unknown: 1 },
        JSON.stringify(record).slice(0, 80),
      );
    }
    deepStrictEqual(
      parseFeedbackLines(
        `${JSON.stringify({ ...fb("wrong"), reader: "human" })}\n`,
      ),
      { lines: [], unknown: 1 },
    );
    deepStrictEqual(
      parseFeedbackLines(
        `${JSON.stringify({ ...fb("wrong"), verdict: "good" })}\n`,
      ),
      { lines: [], unknown: 1 },
    );
  });

  it("drops broken JSON, blank lines and non-objects without counting", () => {
    deepStrictEqual(parseInjectionLines('\n{"v":1,"at":\n[1]\n"x"\nnull\n\n'), {
      lines: [],
      unknown: 0,
    });
  });

  it("counts a valid JSON line over 2KB as unknown", () => {
    const line = JSON.stringify({ ...inj(), pad: "x".repeat(3000) });
    deepStrictEqual(parseInjectionLines(`${line}\n`), {
      lines: [],
      unknown: 1,
    });
  });
});

describe("detectFeedbackReader", () => {
  it("decides by name presence in the documented order", () => {
    strictEqual(detectFeedbackReader(["CLAUDECODE", "AI_AGENT"]), "claude");
    strictEqual(detectFeedbackReader(["AI_AGENT"]), "codex");
    strictEqual(detectFeedbackReader(["CODEX_SANDBOX", "CLAUDECODE"]), "codex");
    strictEqual(
      detectFeedbackReader(["CODEX_SANDBOX_NETWORK_DISABLED"]),
      "codex",
    );
    strictEqual(detectFeedbackReader([]), "unknown");
  });
});

describe("findAcceptingInjection", () => {
  it("returns the newest of the same group only", () => {
    const lines = [
      inj({ ago: 3, trigger: "cmd:git" }),
      inj({ ago: 1, trigger: "cmd:git commit" }),
      inj({ ago: 0.1, kind: "fail" }),
      inj({ ago: 0.1, repoKey: "github.com/x/y" }),
    ];
    const q = { repoKey: REPO, id: ID, kind: "pre" as RecordKind, now: NOW };
    strictEqual(findAcceptingInjection(lines, q)?.trigger, "cmd:git commit");
    strictEqual(findAcceptingInjection([inj({ ago: 15 })], q), null);
    strictEqual(findAcceptingInjection([], q), null);
  });
});

describe("summarizeMetrics", () => {
  const three = [
    inj({ ago: 3 }),
    inj({ ago: 2 }),
    inj({ ago: 1, trigger: "cmd:git" }),
  ];
  it("lists a review candidate and formats it", () => {
    const s = summarizeMetrics({
      injections: three,
      feedback: [fb("mistimed"), fb("mistimed")],
      now: NOW,
    });
    strictEqual(s.reviewCount, 1);
    deepStrictEqual(s.injections, { session: 0, pre: 3, fail: 0, path: 0 });
    strictEqual(
      formatReviewLine(s.review[0] as ReviewItem),
      `review: ${ID}（mistimed 2 wrong 0 / 3 pre; cmd:git commit 2, cmd:git 1）${REPO}`,
    );
  });
  it("needs 3 injections", () => {
    const s = summarizeMetrics({
      injections: three.slice(0, 2),
      feedback: [fb("mistimed"), fb("mistimed")],
      now: NOW,
    });
    strictEqual(s.reviewCount, 0);
  });
  it("needs at least half negative; mistimed+wrong sums", () => {
    const six = Array.from({ length: 6 }, (_, i) => inj({ ago: i + 1 }));
    strictEqual(
      summarizeMetrics({
        injections: six,
        feedback: [fb("mistimed"), fb("mistimed")],
        now: NOW,
      }).reviewCount,
      0,
    );
    strictEqual(
      summarizeMetrics({
        injections: six,
        feedback: [
          fb("mistimed", { ago: 0.1 }),
          fb("mistimed", { ago: 0.2 }),
          fb("wrong", { ago: 0.3 }),
        ],
        now: NOW,
      }).reviewCount,
      1,
    );
  });
  it("caps feedback to the injection count", () => {
    const s = summarizeMetrics({
      injections: [inj()],
      feedback: Array.from({ length: 5 }, () => fb("helpful")),
      now: NOW,
    });
    strictEqual(s.feedback.helpful, 1);
  });
  it("keeps the newest feedback when over the cap", () => {
    const s = summarizeMetrics({
      injections: [inj({ ago: 2 }), inj({ ago: 3 })],
      feedback: [
        fb("mistimed", { ago: 0.9 }),
        fb("wrong", { ago: 0.2 }),
        fb("wrong", { ago: 0.1 }),
      ],
      now: NOW,
    });
    deepStrictEqual(s.feedback, { helpful: 0, mistimed: 0, wrong: 2 });
  });
  it("ignores feedback without injections, old and future records", () => {
    const s = summarizeMetrics({
      injections: [inj({ ago: 15 }), inj({ ago: -1 })],
      feedback: [fb("wrong"), fb("wrong", { id: "L-ffffffffffff" })],
      now: NOW,
    });
    deepStrictEqual(s.injections, { session: 0, pre: 0, fail: 0, path: 0 });
    deepStrictEqual(s.feedback, { helpful: 0, mistimed: 0, wrong: 0 });
  });
  it("limits triggers to 5 and review lines to 10 while counting all", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      inj({ ago: 1, trigger: `cmd:git x${i}` }),
    );
    const s = summarizeMetrics({
      injections: many,
      feedback: [
        fb("mistimed", { ago: 0.1 }),
        fb("mistimed", { ago: 0.2 }),
        fb("mistimed", { ago: 0.3 }),
        fb("mistimed", { ago: 0.4 }),
      ],
      now: NOW,
    });
    strictEqual(s.review[0]?.triggers.length, 5);
    const ids = Array.from(
      { length: 12 },
      (_, i) => `L-${i.toString(16).padStart(12, "0")}`,
    );
    const injections = ids.flatMap((id) => three.map((l) => ({ ...l, id })));
    const feedback = ids.flatMap((id) => [
      fb("mistimed", { id }),
      fb("mistimed", { id }),
    ]);
    const s2 = summarizeMetrics({ injections, feedback, now: NOW });
    strictEqual(s2.reviewCount, 12);
    strictEqual(s2.review.length, 10);
  });
});

describe("formatReviewLine", () => {
  it("returns null when a value carries control characters", () => {
    const item: ReviewItem = {
      repoKey: REPO,
      id: ID,
      kind: "pre",
      injections: 3,
      mistimed: 2,
      wrong: 0,
      triggers: [{ trigger: "cmd:git\x1b[31m", count: 3 }],
    };
    strictEqual(formatReviewLine(item), null);
    strictEqual(formatReviewLine({ ...item, repoKey: "a/b‮" }), null);
  });
});
