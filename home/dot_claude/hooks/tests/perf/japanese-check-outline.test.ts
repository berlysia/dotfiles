// Upper bounds only. Behaviour is covered in unit/japanese-check.test.ts.
import { deepStrictEqual, ok } from "node:assert";
import { describe, it } from "node:test";
import { outline, splitSentences } from "../../../japanese-check/analyze.ts";
import { proseLines } from "../../../japanese-check/markdown.ts";

interface Shape {
  count: number;
  first: string;
  last: string;
}

interface Case {
  name: string;
  build: (repeat: number) => string;
  // Repeat counts for the full-size input; the baseline uses a quarter of it.
  size: number;
  shape: (size: number) => Shape;
  // The outline path is skipped when leading spaces would make Markdown drop
  // the line as indented code.
  splitOnly?: boolean;
  limitMs?: number;
}

const whole = (unit: string, size: number): Shape => ({
  count: 1,
  first: unit.repeat(size),
  last: unit.repeat(size),
});

const CASES: Case[] = [
  {
    name: "closers only",
    size: 100_000,
    build: (n) => "」".repeat(n),
    shape: (n) => whole("」", n),
  },
  {
    name: "openers only",
    size: 100_000,
    build: (n) => "「".repeat(n),
    shape: (n) => whole("「", n),
  },
  {
    name: "end mark then closers",
    size: 100_000,
    build: (n) => `。${"」".repeat(n)}`,
    shape: (n) => ({
      count: 1,
      first: `。${"」".repeat(n)}`,
      last: `。${"」".repeat(n)}`,
    }),
  },
  {
    name: "end marks only",
    size: 100_000,
    build: (n) => "。".repeat(n),
    shape: (n) => whole("。", n),
  },
  {
    name: "many short sentences",
    size: 50_000,
    build: (n) => "A。".repeat(n),
    shape: (n) => ({ count: n, first: "A。", last: "A。" }),
  },
  {
    name: "quoted sentences",
    size: 30_000,
    build: (n) => "「B。」".repeat(n),
    shape: (n) => whole("「B。」", n),
  },
  {
    name: "quote after letter",
    size: 30_000,
    build: (n) => "A「B。」".repeat(n),
    shape: (n) => whole("A「B。」", n),
  },
  {
    name: "spaces then letter",
    size: 100_000,
    splitOnly: true,
    build: (n) => `${" ".repeat(n)}A`,
    shape: () => ({ count: 1, first: "A", last: "A" }),
  },
  {
    name: "sentence, spaces, sentence",
    size: 100_000,
    build: (n) => `A。${" ".repeat(n)}B。`,
    shape: () => ({ count: 2, first: "A。", last: "B。" }),
  },
  {
    name: "end mark plus closer repeated",
    size: 50_000,
    build: (n) => "A。」".repeat(n),
    shape: (n) => ({ count: n, first: "A。」", last: "A。」" }),
  },
  {
    name: "paired end marks",
    size: 50_000,
    build: (n) => "！？".repeat(n),
    shape: (n) => whole("！？", n),
  },
  {
    name: "closer then end mark",
    size: 50_000,
    build: (n) => "」。".repeat(n),
    shape: (n) => whole("」。", n),
  },
  {
    name: "one sentence per line",
    size: 50_000,
    build: (n) => "A。\n".repeat(n),
    shape: (n) => ({ count: n, first: "A。", last: "A。" }),
  },
  {
    name: "opener run then closer run",
    size: 50_000,
    build: (n) => `${"「".repeat(n)}。${"」".repeat(n)}`,
    shape: (n) => ({
      count: 1,
      first: `${"「".repeat(n)}。${"」".repeat(n)}`,
      last: `${"「".repeat(n)}。${"」".repeat(n)}`,
    }),
  },
  {
    // Long enough that the quarter-size baseline exceeds 5 ms, so the
    // linearity ratio is actually judged for at least one case.
    name: "closers only, one million",
    size: 1_000_000,
    limitMs: 5000,
    build: (n) => "」".repeat(n),
    shape: (n) => whole("」", n),
  },
];

function elapsedMs(fn: () => unknown): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function minOfThree(fn: () => unknown): number {
  return Math.min(elapsedMs(fn), elapsedMs(fn), elapsedMs(fn));
}

type Path = "splitSentences" | "outline";

function runner(path: Path, input: string): () => Shape {
  if (path === "splitSentences") {
    return () => {
      const sentences = splitSentences(input);
      return {
        count: sentences.length,
        first: sentences[0] ?? "",
        last: sentences.at(-1) ?? "",
      };
    };
  }
  return () => {
    const rows = proseLines(input);
    const [entry] = outline(rows);
    ok(
      entry && entry.kind === "paragraph",
      "outline path: expected a paragraph",
    );
    return {
      count: entry.sentences,
      first: entry.text,
      last: entry.last ?? entry.text,
    };
  };
}

describe("japanese-check outline: bounded time on adversarial paragraphs", () => {
  for (const item of CASES) {
    const paths: Path[] = item.splitOnly
      ? ["splitSentences"]
      : ["splitSentences", "outline"];
    for (const path of paths) {
      it(`${item.name} (${path})`, () => {
        const limit = item.limitMs ?? 1000;
        const input = item.build(item.size);
        const run = runner(path, input);
        run(); // warm-up
        const expected = item.shape(item.size);
        const started = performance.now();
        const actual = run();
        const full = performance.now() - started;
        deepStrictEqual(actual, expected, `${path}: wrong result`);
        ok(full < limit, `${path}: ${full.toFixed(1)} ms for ${item.name}`);

        const quarter = Math.floor(item.size / 4);
        const baselineRun = runner(path, item.build(quarter));
        baselineRun();
        const base = minOfThree(baselineRun);
        const large = minOfThree(run);
        if (base >= 5) {
          ok(
            large / base < 10,
            `${path}: 4x input took ${(large / base).toFixed(1)}x (${base.toFixed(1)} -> ${large.toFixed(1)} ms) for ${item.name}`,
          );
        }
      });
    }
  }
});
