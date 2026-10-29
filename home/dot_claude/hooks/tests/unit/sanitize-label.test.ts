#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  hasUnsafeLabelChars,
  isAddressableName,
  sanitizeLabel,
} from "../../lib/sanitize-label.ts";

// Inputs are written with \u escapes: the subject is which code points are removed.
describe("sanitizeLabel", () => {
  const stripCases: ReadonlyArray<readonly [string, string, string]> = [
    ["BEL (Cc)", "ab\u0007c", "abc"],
    ["ESC (Cc)", "a\u001b[31mb", "a[31mb"],
    ["C1 NEL (Cc)", "a\u0085b", "ab"],
    ["RLO (Cf)", "a‮b", "ab"],
    ["LS and PS (Zl, Zp)", "a b c", "abc"],
    ["unassigned (Cn)", "a͸b", "ab"],
    ["private use (Co)", "x", "x"],
  ];
  for (const [name, input, expected] of stripCases) {
    it(`removes ${name}`, () => {
      strictEqual(sanitizeLabel(input, "head"), expected);
    });
  }

  it("returns null for a lone HANGUL FILLER", () => {
    strictEqual(sanitizeLabel("ㅤ", "head"), null);
  });

  it("returns null for whitespace only, keeps inner whitespace", () => {
    strictEqual(sanitizeLabel("　  ", "head"), null);
    strictEqual(sanitizeLabel("a　b", "head"), "a　b");
  });

  it("returns null for an empty string", () => {
    strictEqual(sanitizeLabel("", "tail"), null);
  });

  it("cuts the end at 80 code points when keeping the head", () => {
    strictEqual(sanitizeLabel("a".repeat(81), "head"), "a".repeat(80));
  });

  it("cuts the start and puts U+2026 first when keeping the tail", () => {
    const out = sanitizeLabel("/" + "d".repeat(100) + "/wt-tail", "tail");
    strictEqual(out?.startsWith("…"), true);
    strictEqual(out?.endsWith("/wt-tail"), true);
    strictEqual(Array.from(out ?? "").length, 80);
  });

  it("does not split a surrogate pair", () => {
    strictEqual(
      sanitizeLabel("a".repeat(79) + "\u{1F600}" + "b", "head"),
      "a".repeat(79) + "\u{1F600}",
    );
  });

  it("keeps a backtick", () => {
    strictEqual(sanitizeLabel("feat/`x`", "head"), "feat/`x`");
  });
});

describe("hasUnsafeLabelChars", () => {
  it("is false for a plain path", () => {
    strictEqual(hasUnsafeLabelChars("/r/.git"), false);
  });
  it("is true for RLO and HANGUL FILLER", () => {
    strictEqual(hasUnsafeLabelChars("/r/‮.git"), true);
    strictEqual(hasUnsafeLabelChars("/r/ㅤ"), true);
  });
});

describe("isAddressableName", () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["plain", "chezmoi-74", true],
    ["41 chars", "a".repeat(41), false],
    ["empty", "", false],
    ["space", "a b", false],
    ["zero width space", "a​b", false],
    ["trailing newline", "abc\n", false],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      strictEqual(isAddressableName(input), expected);
    });
  }

  it("invariant: addressable implies sanitizeLabel is the identity (1000 seeded values)", () => {
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    for (let i = 0; i < 1000; i++) {
      const length = 1 + (next() % 40);
      let value = "";
      for (let j = 0; j < length; j++)
        value += alphabet[next() % alphabet.length];
      strictEqual(isAddressableName(value), true);
      strictEqual(sanitizeLabel(value, "head"), value);
    }
  });
});
