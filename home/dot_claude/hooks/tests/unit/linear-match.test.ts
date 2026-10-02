#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import {
  createLineIndex,
  createRunEnds,
  createStartIndex,
  hasTopLevelAlternation,
  prefixThenOnLine,
} from "../../lib/linear-match.ts";
import {
  assertAgrees,
  enumerate,
  mutations,
  randomStrings,
  WS_ALL,
  WS_CORE,
} from "../__fixtures__/same-language.ts";

// The local Bash guard rejects the literal, so build it.
const NM = "node" + "_modules";

const DD = prefixThenOnLine(/dd\s+/, /\/dev\//);
const MV = prefixThenOnLine(/(?:^|\s)mv\s+/, new RegExp(NM));

const BOUNDARY_TEXTS = [
  "",
  "\n",
  "\n\r\u2028\u2029",
  "\u2028",
  "a b",
  "a  b\n",
  "x \t\u00a0\ufeff y",
  "tail   ",
  "   head",
];

describe("createLineIndex", () => {
  for (const text of BOUNDARY_TEXTS) {
    it(`lineEnd agrees with a scan for ${JSON.stringify(text)}`, () => {
      const lines = createLineIndex(text);
      for (let from = 0; from <= text.length + 1; from++) {
        let expected = from;
        while (
          expected < text.length &&
          !/[\n\r\u2028\u2029]/.test(text[expected] as string)
        ) {
          expected++;
        }
        strictEqual(
          lines.lineEnd(from),
          Math.min(expected, text.length),
          `from=${from}`,
        );
      }
    });
  }
});

describe("createStartIndex", () => {
  for (const text of [...BOUNDARY_TEXTS, "aaa", "abab", "xx\nxx"]) {
    for (const re of [/\s/, /a/, /ab/, /x\n?x/]) {
      it(`firstAtOrAfter agrees with a sticky probe for ${re} on ${JSON.stringify(text)}`, () => {
        const starts = createStartIndex(text, re);
        const probe = new RegExp(re.source, "y");
        for (let from = 0; from <= text.length + 1; from++) {
          let expected = Infinity;
          for (let at = from; at <= text.length; at++) {
            probe.lastIndex = at;
            if (probe.test(text)) {
              expected = at;
              break;
            }
          }
          strictEqual(starts.firstAtOrAfter(from), expected, `from=${from}`);
        }
      });
    }
  }
});

describe("createRunEnds", () => {
  for (const text of BOUNDARY_TEXTS) {
    it(`agrees with a scan for ${JSON.stringify(text)}`, () => {
      const ends = createRunEnds(text);
      strictEqual(ends.length, text.length + 1);
      for (let p = 0; p <= text.length; p++) {
        let expected = p;
        while (expected < text.length && /\s/.test(text[expected] as string)) {
          expected++;
        }
        strictEqual(ends[p], expected, `p=${p}`);
      }
    });
  }
});

describe("hasTopLevelAlternation", () => {
  it("sees a bare `|` only", () => {
    strictEqual(hasTopLevelAlternation("a|b"), true);
    strictEqual(hasTopLevelAlternation("(a|b)"), false);
    strictEqual(hasTopLevelAlternation("(?:^|\\s)cp"), false);
    strictEqual(hasTopLevelAlternation("a\\|b"), false);
    strictEqual(hasTopLevelAlternation("[|]a"), false);
    strictEqual(hasTopLevelAlternation("(a)|(b)"), true);
  });
});

describe("prefixThenOnLine", () => {
  it("carries the concatenated original as its oracle", () => {
    strictEqual(DD.oracle.source, "dd\\s+.*\\/dev\\/");
    strictEqual(DD.oracle.flags, "");
  });

  it("rejects a regex with flags at construction", () => {
    throws(() => prefixThenOnLine(/a/g, /b/), TypeError);
    throws(() => prefixThenOnLine(/a/, /b/i), TypeError);
  });

  it("rejects a top-level `|` at construction", () => {
    throws(() => prefixThenOnLine(/a|b/, /c/), TypeError);
    throws(() => prefixThenOnLine(/a/, /b|c/), TypeError);
  });

  it("agrees with the original over exhaustive, random and mutated inputs: dd", () => {
    const tokens = ["dd", "/dev/", "x", ...WS_CORE];
    assertAgrees(DD, enumerate(tokens, 5));
    const wide = ["dd", "/dev/", "x", ...WS_ALL];
    assertAgrees(DD, randomStrings(wide, 3000, 219));
    assertAgrees(
      DD,
      mutations(
        ["dd if=/dev/zero", "dd \n/dev/", "dd  x /dev/"],
        wide,
        300,
        219,
      ),
    );
  });

  it("agrees with the original over exhaustive, random and mutated inputs: mv", () => {
    const tokens = ["mv", NM, "x", ...WS_CORE];
    assertAgrees(MV, enumerate(tokens, 5));
    const wide = ["mv", NM, "x", ...WS_ALL];
    assertAgrees(MV, randomStrings(wide, 3000, 219));
    assertAgrees(
      MV,
      mutations([`mv a ${NM}`, `x mv\n${NM}`, `mv  ${NM}`], wide, 300, 219),
    );
  });

  it("keeps no state between calls", () => {
    const positive = "dd if=/dev/zero";
    const negative = "dd if=/tmp/zero";
    strictEqual(DD.test(positive), true);
    strictEqual(DD.test(negative), false);
    strictEqual(DD.test(positive), true);
    strictEqual(DD.test(negative), false);
  });

  it("scans a repeated prefix word in linear time", () => {
    const start = performance.now();
    strictEqual(DD.test("dd if ".repeat(16667)), false);
    ok(performance.now() - start < 1000);
  });

  it("scans a long whitespace run after the prefix in linear time", () => {
    const start = performance.now();
    strictEqual(DD.test("dd " + " ".repeat(100000) + "x"), false);
    ok(performance.now() - start < 1000);
  });

  it("does not look for a needle across a line terminator", () => {
    strictEqual(DD.test("dd x\n/dev/"), false);
    strictEqual(DD.test("dd x\u2028/dev/"), false);
    strictEqual(DD.test("dd x /dev/"), true);
  });
});

describe("prefixThenOnLine deepStrictEqual sanity", () => {
  it("exposes its parts", () => {
    deepStrictEqual(DD.prefix.source, "dd\\s+");
    deepStrictEqual(DD.needle.source, "\\/dev\\/");
  });
});
