// Upper bounds only. Behaviour is covered in unit/japanese-check-phrases.test.ts.
// The analyzer is faked so the time is that of the checks themselves.
import { ok } from "node:assert";
import { describe, it } from "node:test";
import { makeTokenizer } from "../../../japanese-check/contract.ts";
import type { AnalyzedToken } from "../../../japanese-check/contract.ts";
import { proseLines, proseMasks } from "../../../japanese-check/markdown.ts";
import { phraseFindings } from "../../../japanese-check/phrases.ts";

type Unit = Pick<AnalyzedToken, "surface" | "pos" | "lemma">;

// Splits a line made only of the given units into one token per unit.
function fakeTokenizer(units: readonly Unit[]) {
  return makeTokenizer((text) => {
    const tokens: AnalyzedToken[] = [];
    let at = 0;
    while (at < text.length) {
      const unit = units.find((item) => text.startsWith(item.surface, at));
      if (unit === undefined) {
        at++;
        continue;
      }
      tokens.push({ ...unit, start: at, end: at + unit.surface.length });
      at += unit.surface.length;
    }
    return tokens;
  });
}

const noun = (surface: string): Unit => ({
  surface,
  pos: "noun",
  lemma: surface,
});
const particle = (surface: string): Unit => ({
  surface,
  pos: "particle",
  lemma: surface,
});
const degree: Unit = { surface: "適切", pos: "adjectivalNoun", lemma: "適切" };
const copula: Unit = { surface: "な", pos: "auxiliary", lemma: "だ" };

const CASES: Array<{ name: string; line: string; units: Unit[] }> = [
  {
    name: "degree words repeated",
    line: "適切な".repeat(20_000),
    units: [degree, copula],
  },
  {
    name: "effect words repeated",
    line: "最適化".repeat(20_000),
    units: [{ surface: "最適化", pos: "noun", lemma: "最適化" }],
  },
  {
    name: "nouns and の repeated",
    line: "業務の".repeat(20_000),
    units: [noun("業務"), particle("の")],
  },
  {
    name: "barrier ranges",
    line: "業務`x`".repeat(5_000),
    units: [noun("業務")],
  },
];

describe("phrase checks stay linear on a long line", () => {
  for (const { name, line, units } of CASES)
    it(`${name} in under 1,000 ms`, () => {
      const tokenize = fakeTokenizer(units);
      const lines = proseLines(line);
      const masks = proseMasks(line);
      const started = performance.now();
      phraseFindings(lines, masks, tokenize);
      const elapsed = performance.now() - started;
      ok(elapsed < 1_000, `${elapsed.toFixed(0)} ms`);
    });
});
