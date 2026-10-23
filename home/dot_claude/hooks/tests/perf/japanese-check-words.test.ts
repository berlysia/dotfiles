// Upper bounds only. Behaviour is covered in unit/japanese-check-words.test.ts.
import { ok } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  compileEntries,
  findHits,
  parseWordList,
} from "../../../japanese-check/words.ts";

const WORDS_JSON = readFileSync(
  join(import.meta.dirname, "../../../japanese-check/data/words.json"),
  "utf-8",
);

function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

function loadWords() {
  const parsed = parseWordList(WORDS_JSON);
  ok(parsed.ok);
  return compileEntries(parsed.entries).compiled;
}

// 500 entries, one `+` per pattern, 3 allows each: the largest legal shape
function syntheticList() {
  const entries = Array.from({ length: 500 }, (_, i) => ({
    word: `w${i}`,
    kind: "named-translationese",
    action: "fix",
    match: "regex",
    origin: "o",
    pattern: `あ${i % 10}い+`,
    english: "e",
    fix: "f",
    allow: ["う+え", "お+か", "き+く"],
    examples: ["あ"],
    nonExamples: ["い"],
  }));
  // 500 x (1 + 3) = 2,000 regexes: exactly the limit
  const parsed = parseWordList(JSON.stringify({ schema: 1, entries }));
  ok(parsed.ok);
  return compileEntries(parsed.entries).compiled;
}

function worstText(): string {
  const line = (unit: string) => unit.repeat(2000).slice(0, 2000);
  const kinds = [line("あ"), line("道"), line("核"), line("握"), line("仕")];
  const lines: string[] = [];
  for (let size = 0; size < 256 * 1024;) {
    const l = kinds[lines.length % kinds.length] ?? "";
    lines.push(l);
    size += l.length + 1;
  }
  return lines.join("\n");
}

describe("words.ts time bounds", () => {
  it("parse + compile of data/words.json is under 100 ms", () => {
    const ms = elapsedMs(() => loadWords());
    console.error(`parse+compile: ${ms.toFixed(1)} ms`);
    ok(ms < 100, `${ms} ms`);
  });

  it("256 KB of hostile 2,000-char lines against all words is under 1 s", () => {
    const compiled = loadWords();
    const text = worstText();
    const ms = elapsedMs(() => findHits(text, compiled));
    console.error(`worst 256 KB: ${ms.toFixed(1)} ms`);
    ok(ms < 1000, `${ms} ms`);
  });

  it("legal-maximum synthetic list on 128 hostile lines returns within the deadline + 500 ms", () => {
    const compiled = syntheticList();
    const line = "あ0い".repeat(660).slice(0, 2000);
    const text = Array.from({ length: 128 }, () => line).join("\n");
    const started = performance.now();
    const r = findHits(text, compiled, started + 2000);
    const ms = performance.now() - started;
    console.error(
      `synthetic max: ${ms.toFixed(1)} ms truncated=${r.truncated}`,
    );
    ok(ms < 2500, `${ms} ms`);
  });

  it("many short lines against data/words.json and the synthetic list stay within the deadline + 500 ms", () => {
    const text = "あ\n".repeat(128 * 1024);
    for (const [name, compiled] of [
      ["words.json", loadWords()],
      ["synthetic", syntheticList()],
    ] as const) {
      const started = performance.now();
      findHits(text, compiled, started + 2000);
      const ms = performance.now() - started;
      console.error(`short lines ${name}: ${ms.toFixed(1)} ms`);
      ok(ms < 2500, `${name}: ${ms} ms`);
    }
  });
});
