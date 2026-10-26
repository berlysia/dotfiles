// Upper bounds only. Behaviour is covered in unit/japanese-check-words.test.ts.
import { ok } from "node:assert";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildReviewEntries,
  calques,
} from "../../../japanese-check/analyze.ts";
import type { ReviewEntry } from "../../../japanese-check/analyze.ts";
import { proseLines } from "../../../japanese-check/markdown.ts";
import { createAnalyzer } from "../../../japanese-check/adapter-lindera-unidic.ts";
import { validateTokens } from "../../../japanese-check/contract.ts";
import type { AnalyzedToken, Token } from "../../../japanese-check/contract.ts";
import { RUNTIME_DIR } from "../support/japanese-check-runtime.ts";
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
  const parsed = parseWordList(JSON.stringify({ schema: 2, entries }));
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

describe("review entries time bounds", () => {
  function reviewEntries() {
    const parsed = parseWordList(WORDS_JSON);
    ok(parsed.ok);
    return buildReviewEntries(parsed.entries).review;
  }

  // Lines of 2,000 characters, each built from the first characters of the
  // review patterns (partial matches) or of whole matches.
  function reviewWorstText(): string {
    const units = [
      "観",
      "ロ",
      "ゲ",
      "価",
      "ア",
      "静",
      "に落",
      "た瞬",
      "段",
      "最",
      // whole matches: every entry has a dense line to report
      "観測",
      "ロバスト",
      "既定では",
      "静かに壊れ",
      "ゲート",
      "道具",
    ];
    const lines: string[] = [];
    for (let size = 0; size < 256 * 1024;) {
      const unit = units[lines.length % units.length] ?? "あ";
      const line = unit.repeat(2000).slice(0, 2000);
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join("\n");
  }

  it("256 KB of 2,000-char lines against every review regex entry is under 1 s", () => {
    const compiled = reviewEntries().flatMap((entry) =>
      entry.match === "regex" ? [entry.compiled] : [],
    );
    ok(compiled.length > 0);
    const text = reviewWorstText();
    const ms = elapsedMs(() => findHits(text, compiled));
    console.error(`review regex worst 256 KB: ${ms.toFixed(1)} ms`);
    ok(ms < 1000, `${ms} ms`);
  });

  it("lemma matching over 256 KB of dummy tokens is under 1 s", () => {
    const entries: ReviewEntry[] = reviewEntries().filter(
      (entry) => entry.match === "lemma",
    );
    const keys = entries.flatMap((entry) =>
      entry.match === "lemma"
        ? entry.lemmas.map((lemma) => ({
            lemma,
            pos: entry.lemmaClass,
          }))
        : [],
    );
    ok(keys.length > 0);
    // Every two characters is one token that hits some lemma. The tokens go
    // through validateTokens, the only way to make one.
    const tokenize = (text: string): readonly Token[] =>
      validateTokens(
        text,
        Array.from(
          { length: Math.ceil(text.length / 2) },
          (_, i): AnalyzedToken => {
            const key = keys[i % keys.length] ?? {
              lemma: "",
              pos: "noun" as const,
            };
            return {
              surface: text.slice(i * 2, i * 2 + 2),
              lemma: key.lemma,
              pos: key.pos,
              start: i * 2,
              end: Math.min(text.length, i * 2 + 2),
            };
          },
        ),
      );
    const line = "あ".repeat(2000);
    const text = Array.from({ length: 128 }, () => line).join("\n");
    const rows = proseLines(text);
    const ms = elapsedMs(() => calques(rows, tokenize, entries));
    console.error(`lemma matching 256 KB: ${ms.toFixed(1)} ms`);
    ok(ms < 1000, `${ms} ms`);
  });
});

describe("lindera-unidic line time", () => {
  it("analyzes a 888-character line within 2 seconds", async () => {
    const entry = realpathSync(
      join(RUNTIME_DIR, "node_modules/lindera/index.js"),
    );
    const analyze = await createAnalyzer(entry, RUNTIME_DIR);
    const line = "データを拾って、薬が効いた。".repeat(64).slice(0, 888);
    const ms = elapsedMs(() => validateTokens(line, analyze(line)));
    console.error(`lindera 888-character line: ${ms.toFixed(1)} ms`);
    ok(ms < 2000, `${ms} ms`);
  });
});
