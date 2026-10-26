// The word contract between the checks and an analyzer adapter: what
// makeTokenizer guarantees, what a check can learn from a token, and the
// structural rules that keep analyzer-specific names out of the checks.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calques, facts, terms } from "../../../japanese-check/analyze.ts";
import {
  AnalyzerOutputError,
  isNoun,
  isProperNoun,
  isVerb,
  lemmaClass,
  makeTokenizer,
  validateTokens,
} from "../../../japanese-check/contract.ts";
import type { AnalyzedToken } from "../../../japanese-check/contract.ts";
import { CHECKER_VERSION_FILES } from "../../../japanese-check/receipts.ts";
import { proseLines } from "../../../japanese-check/markdown.ts";
import {
  validateWordList,
  WORD_LIST_SCHEMA,
} from "../../../japanese-check/words.ts";
import { rawEntry, reviewFrom } from "../support/japanese-check-words.ts";

const tok = (
  surface: string,
  start: number,
  pos: AnalyzedToken["pos"] = "noun",
  lemma = surface,
  extra: Partial<AnalyzedToken> = {},
): AnalyzedToken => ({
  surface,
  start,
  end: start + surface.length,
  lemma,
  pos,
  ...extra,
});

const only = (text: string, analyzed: AnalyzedToken[]) =>
  makeTokenizer(() => analyzed)(text);

describe("makeTokenizer", () => {
  it("keeps UTF-16 positions for a surrogate pair", () => {
    const text = "𠮷野家の見落とし";
    const tokens = only(text, [
      tok("𠮷野家", 0),
      tok("の", 4, "particle"),
      tok("見落とし", 5),
    ]);
    for (const token of tokens)
      assert.equal(text.slice(token.start, token.end), token.surface);
  });

  it("rejects positions counted in UTF-8 bytes", () => {
    const text = "𠮷野家の見落とし";
    assert.throws(
      () =>
        only(text, [
          { surface: "𠮷野家", start: 0, end: 6, lemma: "x", pos: "noun" },
          { surface: "の", start: 6, end: 7, lemma: "の", pos: "particle" },
          tok("見落とし", 7),
        ]),
      AnalyzerOutputError,
    );
  });

  it("accepts original positions for half-width, emoji, wide and combining text", () => {
    for (const [text, parts] of [
      ["ｶﾞ", ["ｶﾞ"]],
      ["😀︎", ["😀", "︎"]],
      ["ＡＢＣ", ["ＡＢＣ"]],
      ["が", ["か", "゙"]],
    ] as const) {
      let start = 0;
      const analyzed = parts.map((part) => {
        const item = tok(part, start);
        start += part.length;
        return item;
      });
      for (const token of only(text, analyzed))
        assert.equal(text.slice(token.start, token.end), token.surface);
    }
  });

  it("accepts adjacent tokens", () => {
    assert.equal(only("あいう", [tok("あい", 0), tok("う", 2)]).length, 2);
  });

  it("rejects overlap, negative start, end past the text, empty and mismatching tokens with fixed text", () => {
    const text = "あいう";
    const bad: AnalyzedToken[][] = [
      [tok("あい", 0), { ...tok("いう", 1) }],
      [{ surface: "あ", start: -1, end: 0, lemma: "あ", pos: "noun" }],
      [{ surface: "あいうえ", start: 0, end: 4, lemma: "x", pos: "noun" }],
      [{ surface: "", start: 1, end: 1, lemma: "x", pos: "noun" }],
      [{ surface: "ぬ", start: 0, end: 1, lemma: "x", pos: "noun" }],
    ];
    for (const analyzed of bad) {
      assert.throws(
        () => validateTokens(text, analyzed),
        (error: unknown) => {
          assert.ok(error instanceof AnalyzerOutputError);
          for (const ch of ["あ", "い", "う", "ぬ"])
            assert.ok(!error.message.includes(ch));
          return true;
        },
      );
    }
  });

  it("calls the analysis once per text", () => {
    let calls = 0;
    const tokenize = makeTokenizer(() => {
      calls++;
      return [tok("あ", 0)];
    });
    const first = tokenize("あ");
    assert.equal(tokenize("あ"), first);
    assert.equal(calls, 1);
  });
});

describe("part-of-speech predicates", () => {
  const one = (pos: AnalyzedToken["pos"], extra: Partial<AnalyzedToken> = {}) =>
    only("拾う", [tok("拾う", 0, pos, "拾う", extra)])[0]!;

  it("treats a proper noun as a noun and a proper noun", () => {
    const token = one("properNoun");
    assert.ok(isNoun(token));
    assert.ok(isProperNoun(token));
    assert.equal(lemmaClass(token), "noun");
  });

  it("gives particles, suffixes and others no lemma class", () => {
    for (const pos of ["conjunctiveParticle", "suffix", "other"] as const)
      assert.equal(lemmaClass(one(pos)), undefined);
  });

  it("reads a verb without a conjugation", () => {
    const token = one("verb");
    assert.ok(isVerb(token));
    assert.equal(lemmaClass(token), "verb");
  });
});

describe("checks over a fake adapter", () => {
  const lemmaEntry = (pos: string) =>
    reviewFrom([
      rawEntry({
        word: "拾う",
        kind: "jargon",
        match: "lemma",
        lemmas: ["拾う"],
        pos,
      }),
    ]);

  it("matches a conjugation-less verb token to a verb entry", () => {
    const tokenize = makeTokenizer(() => [tok("拾っ", 0, "verb", "拾う")]);
    const found = calques(proseLines("拾った"), tokenize, lemmaEntry("verb"));
    assert.equal(found.length, 1);
    assert.equal(found[0]?.text, "拾っ");
  });

  it("matches only the four classes: a conjunctive particle, suffix or other with a noun entry's lemma does not hit", () => {
    for (const pos of ["conjunctiveParticle", "suffix", "other"] as const) {
      const tokenize = makeTokenizer(() => [tok("拾う", 0, pos, "拾う")]);
      assert.deepEqual(
        calques(proseLines("拾う"), tokenize, lemmaEntry("noun")),
        [],
        pos,
      );
    }
  });

  it("finds terms and proper-noun facts from the predicates", () => {
    const text = "Docker何か京都";
    const tokenize = makeTokenizer(() => [
      tok("Docker", 0, "noun"),
      tok("何", 6, "other"),
      tok("か", 7, "particle"),
      tok("京都", 8, "properNoun"),
    ]);
    const rows = proseLines(text);
    assert.deepEqual(
      terms(rows, tokenize).map((t) => t.term),
      ["Docker"],
    );
    assert.deepEqual(
      facts(rows, tokenize).filter((f) => f.kind === "name"),
      [{ value: "京都", kind: "name", line: 1 }],
    );
  });

  it("rejects a list of schema 1 and an entry with a Japanese part-of-speech name", () => {
    const rejected = validateWordList({ schema: 1, entries: [] });
    assert.equal(rejected.ok, false);
    const named = validateWordList({
      schema: WORD_LIST_SCHEMA,
      entries: [
        rawEntry({
          word: "x",
          kind: "jargon",
          match: "lemma",
          lemmas: ["x"],
          pos: "名詞",
        }),
      ],
    });
    assert.ok(named.ok);
    assert.deepEqual(named.entries, []);
    assert.equal(named.notices.length, 1);
  });

  it("rejects a words.json entry whose pos is not one of the four", () => {
    const result = validateWordList({
      schema: WORD_LIST_SCHEMA,
      entries: [
        rawEntry({
          word: "x",
          kind: "jargon",
          match: "lemma",
          lemmas: ["x"],
          pos: "副詞",
        }),
      ],
    });
    // A bad entry is skipped with a notice, not accepted.
    assert.ok(result.ok);
    assert.deepEqual(result.entries, []);
    assert.equal(result.notices.length, 1);
    assert.ok(!result.notices[0]?.includes("副詞"));
  });
});

// Structural rules. The type checker is the main guard (a Token has no readable
// part of speech); these catch what slips past it.
const dir = fileURLToPath(new URL("../../../japanese-check/", import.meta.url));
const sourceFiles = () => readdirSync(dir).filter((n) => n.endsWith(".ts"));

const ADAPTERS = ["adapter-lindera-unidic.ts"];

const NON_CHECK_FILES = new Set([
  "contract.ts",
  ...ADAPTERS,
  "cli.ts",
  "deps.ts",
  "safe-read.ts",
  "receipts.ts",
  "state.ts",
  "tracking.ts",
  "keep.ts",
  "secrets.ts",
  "types.ts",
  "profiles.ts",
  "words.ts",
  "markdown.ts",
]);

const POS_REFERENCE = /\.pos\b|\[\s*["']pos["']\s*\]/u;
const POS_NAMES =
  "名詞|固有名詞|代名詞|動詞|形容詞|形状詞|助詞|助動詞|接尾辞|記号";
const POS_NAME_USE = new RegExp(
  [
    `(?:===|!==)\\s*["'](?:${POS_NAMES})["']`,
    `["'](?:${POS_NAMES})["']\\s*(?:===|!==)`,
    `\\bcase\\s+["'](?:${POS_NAMES})["']\\s*:`,
    `\\[[^\\]]*["'](?:${POS_NAMES})["'][^\\]]*\\]\\s*\\.includes\\(`,
    `\\.includes\\(\\s*["'](?:${POS_NAMES})["']`,
    `[{,]\\s*["']?(?:${POS_NAMES})["']?\\s*:`,
  ].join("|"),
  "u",
);
const STATIC_IMPORT =
  /(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gu;

const importsOf = (source: string) =>
  [...source.matchAll(STATIC_IMPORT)].map((m) => m[1] ?? "");
const onlyNodeAndContract = (source: string) =>
  importsOf(source).every(
    (s) => s.startsWith("node:") || s === "./contract.ts",
  );
const onlyNode = (source: string) =>
  importsOf(source).every((s) => s.startsWith("node:"));

describe("structural rules of the word contract", () => {
  it("detects part-of-speech references", () => {
    assert.ok(POS_REFERENCE.test("if (token.pos) {}"));
    assert.ok(POS_REFERENCE.test("item.pos"));
    assert.ok(POS_REFERENCE.test('token["pos"]'));
    assert.ok(!POS_REFERENCE.test("position + item.lemmaClass"));
  });

  it("detects part-of-speech names used as comparison operands or keys", () => {
    assert.ok(POS_NAME_USE.test('x === "名詞"'));
    assert.ok(POS_NAME_USE.test('case "動詞":'));
    assert.ok(POS_NAME_USE.test('["名詞"].includes(x)'));
    assert.ok(POS_NAME_USE.test("{ 名詞: 1 }"));
    assert.ok(!POS_NAME_USE.test('const m = "動詞の項目に当たりました";'));
  });

  it("keeps part-of-speech names and `.pos` out of the check files", () => {
    const checks = sourceFiles().filter((n) => !NON_CHECK_FILES.has(n));
    assert.ok(checks.includes("analyze.ts"));
    for (const name of checks) {
      const source = readFileSync(join(dir, name), "utf8");
      const hint = `${name}: a new file is a check by default; add it to NON_CHECK_FILES if it is not one`;
      assert.ok(!POS_REFERENCE.test(source), hint);
      assert.ok(!POS_NAME_USE.test(source), hint);
    }
  });

  it("keeps part-of-speech names out of every file but the contract, the adapter and words.ts", () => {
    for (const name of sourceFiles()) {
      if (["contract.ts", ...ADAPTERS, "words.ts"].includes(name)) continue;
      assert.ok(
        !POS_NAME_USE.test(readFileSync(join(dir, name), "utf8")),
        name,
      );
    }
  });

  it("limits static imports of the contract and the adapter", () => {
    assert.ok(onlyNode(readFileSync(join(dir, "contract.ts"), "utf8")));
    for (const adapterName of ADAPTERS) {
      const adapter = readFileSync(join(dir, adapterName), "utf8");
      assert.ok(onlyNodeAndContract(adapter), adapterName);
      assert.ok(
        !onlyNodeAndContract(`${adapter}\nimport x from "lindera";`),
        adapterName,
      );
    }
    for (const name of sourceFiles().filter((n) => !NON_CHECK_FILES.has(n)))
      for (const spec of importsOf(readFileSync(join(dir, name), "utf8")))
        assert.ok(!ADAPTERS.some((a) => spec === `./${a}`), name);
  });

  it("has one computed import(), inside createAnalyzer", () => {
    const computed = /import\(\s*[^"'\s)]/gu;
    const total = sourceFiles().flatMap((name) => {
      const source = readFileSync(join(dir, name), "utf8");
      return [...source.matchAll(computed)].map(() => name);
    });
    assert.deepEqual(total.sort(), [...ADAPTERS].sort());
    for (const adapterName of ADAPTERS) {
      const adapter = readFileSync(join(dir, adapterName), "utf8");
      const at = adapter.indexOf("export async function createAnalyzer");
      assert.ok(at >= 0 && adapter.indexOf("import(pathToFileURL") > at);
    }
  });

  const covers = (list: readonly string[]) => {
    const files = sourceFiles().sort();
    const listed = list.filter((n) => n.endsWith(".ts")).sort();
    return JSON.stringify(files) === JSON.stringify(listed);
  };

  it("has no mention of the old analyzer in the checker or its tests", () => {
    // Spelled in two parts so that this file does not contain the word.
    const word = new RegExp("suda" + "chi", "iu");
    const testDir = fileURLToPath(new URL("./", import.meta.url));
    const files = [
      ...sourceFiles().map((name) => join(dir, name)),
      ...readdirSync(testDir)
        .filter((n) => /^japanese-.*\.test\.ts$/u.test(n))
        .map((name) => join(testDir, name)),
    ];
    for (const file of files)
      assert.ok(!word.test(readFileSync(file, "utf8")), file);
  });

  it("keeps CHECKER_VERSION_FILES equal to the .ts files of the directory", () => {
    assert.ok(covers(CHECKER_VERSION_FILES));
    assert.ok(
      !covers(CHECKER_VERSION_FILES.filter((n) => n !== "contract.ts")),
    );
    assert.ok(!covers([...CHECKER_VERSION_FILES, "no-such-file.ts"]));
  });
});
