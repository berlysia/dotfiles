#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  compileEntries,
  findHits,
  parseWordList,
  selectEntries,
  validateWordList,
  type WordEntry,
} from "../../../japanese-check/words.ts";

const CHECK_DIR = join(import.meta.dirname, "../../../japanese-check");
const WORDS_JSON = readFileSync(join(CHECK_DIR, "data/words.json"), "utf-8");

interface Raw {
  [key: string]: unknown;
}

function base(overrides: Raw = {}): Raw {
  return {
    word: "w",
    kind: "named-translationese",
    action: "fix",
    match: "regex",
    origin: "o",
    pattern: "あい",
    english: "e",
    fix: "f",
    examples: ["あいう"],
    nonExamples: ["う"],
    ...overrides,
  };
}

function list(entries: unknown[]): string {
  return JSON.stringify({ schema: 2, entries });
}

function loadAll(entries: unknown[]) {
  const parsed = parseWordList(list(entries));
  ok(parsed.ok, JSON.stringify(parsed));
  const compiled = compileEntries(parsed.entries);
  return {
    parseNotices: parsed.notices,
    compiled: compiled.compiled,
    notices: [...parsed.notices, ...compiled.notices],
  };
}

function skipped(entry: unknown): string | null {
  const { notices, compiled } = loadAll([entry]);
  if (notices.length === 0) return null;
  strictEqual(notices.length, 1);
  strictEqual(compiled.length, 0);
  return notices[0] ?? null;
}

function passes(entry: unknown): boolean {
  return skipped(entry) === null;
}

describe("data/words.json", () => {
  const parsed = parseWordList(WORDS_JSON);

  // The named translationese entries are the ones the hook also reads; the
  // review entries are covered by japanese-check-word-migration.test.ts.
  const named = () => {
    ok(parsed.ok);
    return selectEntries(parsed.entries, {
      kind: "named-translationese",
      action: "fix",
      match: "regex",
    });
  };

  it("loads all 30 named entries and every review entry without notices", () => {
    ok(parsed.ok);
    strictEqual(named().length, 30);
    deepStrictEqual(parsed.notices, []);
    const compiled = compileEntries(parsed.entries);
    deepStrictEqual(compiled.notices, []);
    strictEqual(
      compiled.compiled.length,
      parsed.entries.filter((e) => e.match === "regex").length,
    );
  });

  it("each example hits its own entry and no nonExample hits (allow included)", () => {
    const entries = named();
    const { compiled } = compileEntries(entries);
    for (const [i, entry] of entries.entries()) {
      const one = compiled[i];
      ok(one);
      for (const example of entry.examples) {
        ok(findHits(example, [one]).total > 0, `${entry.word}: ${example}`);
      }
      for (const text of entry.nonExamples) {
        strictEqual(
          findHits(text, compiled).total,
          0,
          `${entry.word}: ${text}`,
        );
      }
    }
  });

  it("no example, nonExample or fix hits another entry", () => {
    const entries = named();
    const { compiled } = compileEntries(entries);
    strictEqual(compiled.length, entries.length);
    for (const [i, e] of entries.entries()) {
      const fields = {
        examples: e.examples,
        nonExamples: e.nonExamples,
        fix: [e.fix],
      };
      for (const [field, texts] of Object.entries(fields)) {
        for (const text of texts) {
          for (const [j, o] of compiled.entries()) {
            if (j === i) continue;
            strictEqual(
              findHits(text, [o]).total,
              0,
              `${e.word}.${field}: 「${text}」 hits ${o.word}`,
            );
          }
        }
      }
    }
  });
});

describe("boundaries", () => {
  it("pattern and allow: 100 chars pass, 101 are skipped", () => {
    const p100 = "あ".repeat(100);
    ok(passes(base({ pattern: p100 })));
    ok(!passes(base({ pattern: "あ".repeat(101) })));
    ok(passes(base({ allow: [p100] })));
    ok(!passes(base({ allow: ["あ".repeat(101)] })));
  });

  it("text fields: 200 chars pass, 201 are skipped", () => {
    const t200 = "あ".repeat(200);
    const t201 = "あ".repeat(201);
    for (const field of ["word", "origin", "english", "fix"]) {
      ok(passes(base({ [field]: t200 })), field);
      ok(!passes(base({ [field]: t201 })), field);
    }
    ok(passes(base({ examples: [t200] })));
    ok(!passes(base({ examples: [t201] })));
    // 200 code points that are 400 code units still pass
    ok(passes(base({ fix: "𠮷".repeat(200) })));
  });

  it("allow / examples / nonExamples: 10 pass, 11 are skipped", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `い${i}`);
    const eleven = [...ten, "い10"];
    ok(passes(base({ allow: ten })));
    ok(!passes(base({ allow: eleven })));
    ok(passes(base({ examples: ten })));
    ok(!passes(base({ examples: eleven })));
    ok(passes(base({ nonExamples: ten })));
    ok(!passes(base({ nonExamples: eleven })));
  });

  it("lemmas: 20 pass, 21 and 0 are skipped", () => {
    const lemma = (lemmas: string[]) =>
      base({
        kind: "calque",
        action: "review",
        match: "lemma",
        pattern: undefined,
        lemmas,
        pos: "verb",
      });
    const n = (k: number) => Array.from({ length: k }, (_, i) => `語${i}`);
    ok(passes(lemma(n(20))));
    ok(!passes(lemma(n(21))));
    ok(!passes(lemma([])));
  });

  it("entries: 500 pass, 501 make the whole list unusable", () => {
    const entry = (i: number) => base({ word: `w${i}`, pattern: `あ${i}い` });
    const ok500 = parseWordList(
      list(Array.from({ length: 500 }, (_, i) => entry(i))),
    );
    ok(ok500.ok);
    strictEqual(ok500.entries.length, 500);
    const over = parseWordList(
      list(Array.from({ length: 501 }, (_, i) => entry(i))),
    );
    strictEqual(over.ok, false);
  });

  it("regex total: 2,000 pass, 2,001 make the whole list unusable", () => {
    // 500 entries x (1 pattern + 3 allow) = 2,000
    const entry = (i: number, allows: number) =>
      base({
        word: `w${i}`,
        pattern: `あ${i}`,
        allow: Array.from({ length: allows }, (_, k) => `い${k}`),
      });
    const exact = parseWordList(
      list(Array.from({ length: 500 }, (_, i) => entry(i, 3))),
    );
    ok(exact.ok);
    const entries = Array.from({ length: 500 }, (_, i) => entry(i, 3));
    entries[0] = entry(0, 4);
    strictEqual(parseWordList(list(entries)).ok, false);
  });

  it("256 KB: exactly passes, one byte more is unusable", () => {
    const shell = list([base({ fix: "" })]);
    const empty = Buffer.byteLength(JSON.stringify({ schema: 2, entries: [] }));
    // pad with whitespace inside the JSON to hit the byte count exactly
    const pad = (bytes: number) =>
      JSON.stringify({ schema: 2, entries: [] }) + " ".repeat(bytes - empty);
    strictEqual(Buffer.byteLength(pad(256 * 1024)), 256 * 1024);
    ok(parseWordList(pad(256 * 1024)).ok);
    strictEqual(parseWordList(pad(256 * 1024 + 1)).ok, false);
    void shell;
  });
});

describe("entry shape", () => {
  it("skips each broken entry with a matching reason", () => {
    const cases: [string, Raw, RegExp][] = [
      ["slop+fix", base({ kind: "slop", action: "fix" }), /fix/],
      [
        "nt+review",
        base({ action: "review" }),
        /named-translationese は action: fix/,
      ],
      [
        "nt+lemma",
        base({ match: "lemma", lemmas: ["あ"], pos: "noun" }),
        /match: regex/,
      ],
      [
        "lemma+allow",
        base({
          kind: "slop",
          action: "review",
          match: "lemma",
          lemmas: ["あ"],
          pos: "noun",
          allow: ["あ"],
        }),
        /allow/,
      ],
      ["no pattern", base({ pattern: undefined }), /pattern/],
      ["no english", base({ english: undefined }), /english/],
      ["empty english", base({ english: "" }), /english/],
      ["no nonExamples", base({ nonExamples: undefined }), /nonExamples/],
      ["newline in fix", base({ fix: "a\nb" }), /fix/],
      ["RLO in word", base({ word: "a‮b" }), /word/],
      ["https url", base({ fix: "https://x" }), /URL/],
      ["HTTPS url", base({ fix: "HTTPS://x" }), /URL/],
      ["ftp url", base({ fix: "ftp://x" }), /URL/],
      ["www", base({ fix: "www.x" }), /URL/],
      ["mailto", base({ fix: "mailto:a" }), /URL/],
      ["file", base({ fix: "file:/x" }), /URL/],
      ["scheme-relative", base({ fix: "//host/p" }), /URL/],
      ["fullwidth url", base({ fix: "ｈｔｔｐｓ：／／x" }), /URL/],
      ["chapter RLO", base({ chapter: "a‮b" }), /chapter/],
      ["unknown kind", base({ kind: "zzz" }), /kind/],
      ["unknown action", base({ action: "zzz" }), /action/],
      ["allow string", base({ allow: "x" }), /allow/],
      ["examples not strings", base({ examples: [1] }), /examples/],
      ["pattern number", base({ pattern: 5 }), /pattern/],
    ];
    for (const [name, entry, reason] of cases) {
      const notice = skipped(entry);
      ok(notice?.startsWith("項目 1 を飛ばした: "), `${name}: ${notice}`);
      ok(reason.test(notice ?? ""), `${name}: ${notice}`);
    }
    for (const value of [null, [], 5]) {
      ok(!passes(value), String(value));
    }
  });

  it("lemma entries: lemmas element with newline is skipped", () => {
    ok(
      !passes(
        base({
          kind: "calque",
          action: "review",
          match: "lemma",
          pattern: undefined,
          lemmas: ["a\nb"],
          pos: "verb",
        }),
      ),
    );
  });

  it("english is optional for kinds other than named-translationese and calque", () => {
    ok(passes(base({ kind: "slop", action: "review", english: undefined })));
    ok(
      !passes(
        base({
          kind: "calque",
          action: "review",
          english: undefined,
        }),
      ),
    );
  });

  it("allows an ASCII colon in a Japanese explanation", () => {
    ok(passes(base({ fix: "例: 型の道具" })));
  });

  it("keeps good entries and reports one notice for a skipped one", () => {
    const { compiled, notices } = loadAll([
      base({ kind: "zzz" }),
      base({ word: "good" }),
    ]);
    strictEqual(compiled.length, 1);
    strictEqual(compiled[0]?.index, 2);
    strictEqual(notices.length, 1);
    ok(notices[0]?.startsWith("項目 1 を飛ばした: "));
  });
});

describe("regex constraints", () => {
  const reject = [
    "(a+)+b",
    "a*a*a*b",
    "(a|a)+b",
    "a?a?b",
    "a+?b",
    "a{1,}b",
    "a{1,11}b",
    ".*x",
    "[^x]*y",
    "\\S*y",
    "x(?=y)",
    "(?<!x)y",
    "(?<n>a)b",
    "(a)\\1",
    "x?",
    "\\bx",
    "^x",
    "x$",
    "a|",
    "|a",
    "(?:)",
    "(",
    "\\p{L}x",
    "\\P{L}x",
    "[\\p{L}]x",
    "\\u{41}",
    "a{2,1}b",
    "a{0}b",
    "a{11}b",
    "(?:x*)*",
    "(ab){2,}",
  ];
  const accept = [
    "a+b",
    "a{1,10}b",
    "a\\+b",
    "[+*]x",
    "仕掛け(る|て|た|ら)",
    "[一-龠々]核",
    "x{abc}",
    "\\\\px",
  ];

  it("skips the dangerous or misleading shapes", () => {
    for (const pattern of reject) {
      ok(!passes(base({ pattern })), pattern);
      // the same source is rejected as an allow too
      ok(!passes(base({ allow: [pattern] })), `allow ${pattern}`);
    }
  });

  it("names the quantifier as the reason for quantified groups", () => {
    for (const pattern of ["(a|aa)+", "(a+)+", "(?:x*)*", "(ab){2,}"]) {
      ok(skipped(base({ pattern }))?.includes("量指定"), pattern);
    }
  });

  it("accepts ordinary shapes", () => {
    for (const pattern of accept) ok(passes(base({ pattern })), pattern);
  });
});

describe("unusable lists", () => {
  it("does not throw and gives a reason", () => {
    for (const text of [
      '{"schema": 1, "entries": []}',
      "[]",
      "{ broken",
      '{"schema": 2, "entries": {}}',
      "null",
    ]) {
      const r = parseWordList(text);
      strictEqual(r.ok, false, text);
    }
    const deep = `${"[".repeat(10_000)}${"]".repeat(10_000)}`;
    strictEqual(parseWordList(deep).ok, false);
    strictEqual(
      validateWordList(JSON.parse('{"schema":2,"entries":[]}')).ok,
      true,
    );
  });
});

describe("selectEntries", () => {
  it("keeps only the entries that match all three conditions", () => {
    const parsed = parseWordList(
      list([
        base(),
        base({ kind: "slop", action: "review", word: "s" }),
        base({
          kind: "slop",
          action: "review",
          match: "lemma",
          pattern: undefined,
          lemmas: ["あ"],
          pos: "noun",
          word: "l",
        }),
      ]),
    );
    ok(parsed.ok);
    const picked: WordEntry[] = selectEntries(parsed.entries, {
      kind: "named-translationese",
      action: "fix",
      match: "regex",
    });
    strictEqual(picked.length, 1);
    strictEqual(picked[0]?.word, "w");
  });
});

describe("module hygiene", () => {
  it("imports only node: modules and has no dynamic import or require", () => {
    const source = readFileSync(join(CHECK_DIR, "words.ts"), "utf-8");
    for (const m of source.matchAll(
      /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g,
    )) {
      ok(m[1]?.startsWith("node:"), m[1]);
    }
    ok(!source.includes("import("));
    ok(!source.includes("require("));
  });
});

describe("findHits", () => {
  const { compiled } = loadAll([
    base({ word: "道具立て", pattern: "道具立て" }),
  ]);

  it("skips code fences and inline code, needs a Japanese line", () => {
    strictEqual(findHits("```\n道具立て\n```\n", compiled).total, 0);
    strictEqual(findHits("`道具立て`を使う", compiled).total, 0);
    strictEqual(findHits("道具立てを使う", compiled).total, 1);
  });

  it("reports truncation reasons", () => {
    const longLine = `あ${"x".repeat(2000)}`;
    ok(findHits(longLine, compiled).truncated.includes("line-chars"));
    const dense = loadAll([base({ pattern: "あ" })]).compiled;
    ok(findHits("あ".repeat(1001), dense).truncated.includes("line-hits"));
    strictEqual(findHits("あ".repeat(1000), dense).truncated.length, 0);
    ok(
      findHits(`${"あ\n".repeat(140_000)}`, compiled).truncated.includes(
        "scan-size",
      ),
    );
  });

  it("returns nothing and says so when the deadline already passed", () => {
    const past = -1; // performance.now() is never negative
    for (let i = 0; i < 3; i++) {
      const r = findHits("道具立てを使う", compiled, past);
      strictEqual(r.hits.length, 0);
      ok(r.truncated.includes("time-budget"));
    }
  });

  it("finds overlapping allow matches so 核核核 is excused", () => {
    const { compiled: kaku } = loadAll([
      base({
        word: "核",
        pattern: "核",
        allow: ["[一-龠々]核", "核[一-龠々]"],
      }),
    ]);
    strictEqual(findHits("核核核", kaku).total, 0);
    strictEqual(findHits("設計の核を決める", kaku).total, 1);
    strictEqual(findHits("核心に触れる", kaku).total, 0);
  });
});
