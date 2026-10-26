// The words that lived in the textlint rules (no-ai-words, no-ai-jargon) and in
// calques() now live in data/words.json. The ledger below was written from the
// old dictionary and rules before they were removed: one row per old item, and
// `to` names the entry that took it over. The test no longer reads the old
// dictionary, so only `to` may change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildReviewEntries,
  calques,
  check,
} from "../../../japanese-check/analyze.ts";
import type { ReviewEntry } from "../../../japanese-check/analyze.ts";
import { proseLines } from "../../../japanese-check/markdown.ts";
import { parseWordList } from "../../../japanese-check/words.ts";
import { SHIPPED_WORD_LIST } from "../support/japanese-check-words.ts";
import {
  createTestTokenizer,
  needsRuntime,
} from "../support/japanese-check-runtime.ts";

interface LedgerRow {
  source: "no-ai-words" | "no-ai-jargon" | "calques";
  old: string;
  // More than one entry when the new list splits one old item, such as the
  // verb 効く (a lemma entry) and its noun form 効き (a regex entry).
  to: string | string[];
}

const targetsOf = (row: LedgerRow): string[] =>
  Array.isArray(row.to) ? row.to : [row.to];

const ledger = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../fixtures/japanese-check/word-migration-ledger.json",
    ),
    "utf8",
  ),
) as LedgerRow[];
const parsed = parseWordList(readFileSync(SHIPPED_WORD_LIST, "utf8"));
assert.ok(parsed.ok);
const built = buildReviewEntries(parsed.entries);
const reviewWords = new Set(
  parsed.entries.filter((e) => e.action === "review").map((e) => e.word),
);
const reviewEntries = parsed.entries.filter((e) => e.action === "review");

// Why not list entry names or add a marker field to data/words.json: a name
// list needs a test edit for every new review entry, and a marker field
// changes the list schema. The origin already names where a migrated entry came
// from, so an entry whose origin starts with a migration source must be pointed
// at by a ledger row; entries with any other origin (added after the migration)
// are out of scope. Convention: do not start the origin of a later entry with
// one of these prefixes, because that would demand a ledger row for it.
const ORIGIN_PREFIX_BY_SOURCE: Record<LedgerRow["source"], string> = {
  "no-ai-words": "textlint-rule-preset-ai-words-ja",
  "no-ai-jargon": "tanteki の no-ai-jargon",
  calques: "analyze.ts の calques()",
};

const sourceOfOrigin = (origin: string): LedgerRow["source"] | undefined =>
  (
    Object.entries(ORIGIN_PREFIX_BY_SOURCE) as [LedgerRow["source"], string][]
  ).find(([, prefix]) => origin.startsWith(prefix))?.[0];

describe("word migration ledger", () => {
  it("has one row per old item: 54 dictionary entries, 13 jargon rows, 11 calque lemmas", () => {
    for (const [source, count] of [
      ["no-ai-words", 54],
      ["no-ai-jargon", 13],
      ["calques", 11],
    ] as const) {
      assert.equal(
        ledger.filter((row) => row.source === source).length,
        count,
        source,
      );
    }
    assert.equal(ledger.length, 78);
  });

  it("names every old item once", () => {
    const keys = ledger.map((row) => `${row.source}\0${row.old}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("points every row at a review entry of data/words.json", () => {
    for (const row of ledger)
      for (const to of targetsOf(row))
        assert.ok(reviewWords.has(to), `${row.source} ${row.old} -> ${to}`);
  });

  it("leaves no migrated review entry that no old item points at", () => {
    const targets = new Set(ledger.flatMap(targetsOf));
    for (const entry of reviewEntries) {
      if (sourceOfOrigin(entry.origin) === undefined) continue;
      assert.ok(targets.has(entry.word), entry.word);
    }
  });

  // Not "the prefix of that row's source": some entries merge items from two
  // sources (the no-ai-words 効く and 入口 rows point at the calques() entries),
  // so only a target whose origin left every migration prefix is an error.
  it("starts the origin of each row's target with a migration prefix", () => {
    for (const row of ledger)
      for (const to of targetsOf(row)) {
        const entry = reviewEntries.find((e) => e.word === to);
        assert.ok(entry, to);
        assert.ok(
          sourceOfOrigin(entry.origin) !== undefined,
          `${row.source} ${row.old} -> ${to}: ${entry.origin}`,
        );
      }
  });

  it("maps the origin prefixes one to one onto the ledger sources", () => {
    assert.deepEqual(
      new Set(Object.keys(ORIGIN_PREFIX_BY_SOURCE)),
      new Set(ledger.map((row) => row.source)),
    );
    assert.equal(
      new Set(Object.values(ORIGIN_PREFIX_BY_SOURCE)).size,
      Object.keys(ORIGIN_PREFIX_BY_SOURCE).length,
    );
  });
});

describe("review entries of data/words.json", needsRuntime, () => {
  const tokenizer = createTestTokenizer();
  const withSource = parsed.entries.filter((e) => e.action === "review");

  function only(word: string): ReviewEntry {
    const found = built.review.find((entry) => entry.word === word);
    assert.ok(found, word);
    return found;
  }
  const hits = async (text: string, entries: ReviewEntry[]) =>
    calques(proseLines(text), await tokenizer, entries);

  it("compiles without notices", () => {
    assert.deepEqual(parsed.notices, []);
    assert.deepEqual(built.notices, []);
    assert.equal(built.review.length, withSource.length);
  });

  it("reports every example from its own entry", async () => {
    for (const entry of withSource) {
      const target = only(entry.word);
      for (const example of entry.examples)
        assert.ok(
          (await hits(example, [target])).length > 0,
          `${entry.word}: ${example}`,
        );
    }
  });

  it("reports no nonExample from its own entry", async () => {
    for (const entry of withSource) {
      const target = only(entry.word);
      for (const text of entry.nonExamples)
        assert.deepEqual(
          (await hits(text, [target])).map((item) => item.text),
          [],
          `${entry.word}: ${text}`,
        );
    }
  });

  it("lets compounds and allowed phrases through, and catches the bare words", async () => {
    for (const text of [
      "可観測性を高める。",
      "レバレッジ比率を見る。",
      "ロバストな推定を使う。",
    ])
      assert.deepEqual(await hits(text, built.review), [], text);
    for (const text of [
      "状態を観測した。",
      "レバレッジを効かせる。",
      "ロバストだ。",
    ])
      assert.ok((await hits(text, built.review)).length > 0, text);
  });

  it("reports the noun form of each stem entry that moved to lemma matching", async () => {
    for (const [word, text, surface] of [
      ["疑う", "疑いが残る。", "疑い"],
      ["見落とす", "私の見落としがある。", "見落とし"],
      ["突き合わせる", "一覧の突き合わせをする。", "突き合わせ"],
      ["溶かす", "境界の溶かしが進む。", "溶かし"],
    ] as const)
      assert.deepEqual(
        (await hits(text, [only(word)])).map((item) => item.text),
        [surface],
        word,
      );
    assert.deepEqual(
      (await hits("効きが落ちる。", [only("効き")])).map((item) => item.text),
      ["効き"],
    );
  });

  it("leaves a compound that contains a moved stem alone", async () => {
    const moved = ["疑う", "見落とす", "突き合わせる", "溶かす"].map(only);
    for (const text of ["落とし穴がある。", "疑問が残った。", "疑似的に扱う。"])
      assert.deepEqual(await hits(text, moved), [], text);
  });

  it("builds the layer for every nominal entry (no lemma silently drops out)", async () => {
    const nominal = built.review.filter(
      (entry) => entry.match === "lemma" && entry.nominal === true,
    );
    assert.deepEqual(
      nominal.map((entry) => entry.word).sort(),
      ["疑う", "見落とす", "突き合わせる", "溶かす"].sort(),
    );
    const report = check("本文。\n", await tokenizer, built.review, {
      engine: "t",
      version: "0",
      dictionary: "t",
    });
    assert.deepEqual(
      report.limitations.filter((item) => item.includes("連用形")),
      [],
    );
  });

  it("keeps 焼く as a regex entry with a reason: the dictionary splits 焼き菓子", async () => {
    const entry = reviewEntries.find((e) => e.word === "焼く");
    assert.ok(entry);
    assert.equal(entry.match, "regex");
    assert.ok(entry.allow?.length === 1);
    assert.ok(entry.reason);
    for (const text of [
      "焼き鳥を食べた。",
      "焼き肉を食べた。",
      "焼き魚を食べた。",
      "焼き芋を食べた。",
      "焼きそばを食べた。",
      "焼き菓子を買った。",
      "焼き印を押した。",
    ])
      assert.deepEqual(await hits(text, [only("焼く")]), [], text);
    // The lemma form of the same entry would report this spot (焼き + 菓子).
    assert.ok(
      (await tokenizer)("焼き菓子を買った。").some(
        (token) => token.surface === "焼き" && token.lemma === "焼く",
      ),
    );
  });

  it("gives every regex entry that the stem migration left a reason", () => {
    for (const word of ["焼く", "効き", "穴", "実測", "事故"]) {
      const entry = reviewEntries.find((e) => e.word === word);
      assert.ok(entry?.reason, word);
    }
  });
});
