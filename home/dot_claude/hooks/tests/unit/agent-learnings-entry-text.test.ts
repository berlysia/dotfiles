import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  normalizeHeading,
  preprocessText,
  validateBody,
  validateTitle,
} from "../../lib/agent-learnings/core/entry-text.ts";

const strict = { allowUrl: false };

describe("preprocessText", () => {
  it("applies NFKC and strips control, zero-width, bidi, tag and variation characters", () => {
    strictEqual(preprocessText("Ａ​B‮C\u0007D\u{E0041}E️F­G", []), "ABCDEFG");
  });
  it("turns tabs and newlines into single spaces", () => {
    strictEqual(preprocessText("  a\tb\n\nc  ", []), "a b c");
  });
  it("redacts secrets", () => {
    ok(
      preprocessText(
        "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        [],
      ).includes("[REDACTED]"),
    );
  });
});

describe("validateTitle", () => {
  it("accepts a plain heading", () => {
    deepStrictEqual(validateTitle("bun test は --preload を読まない", strict), {
      ok: true,
    });
  });
  for (const bad of [
    "#見出し",
    "a<!--b",
    "x-->y",
    "a".repeat(81),
    "",
    "<system>x",
    "see [x](y)",
    "https://e.com",
  ]) {
    it(`rejects ${JSON.stringify(bad.slice(0, 20))}`, () => {
      strictEqual(validateTitle(bad, strict).ok, false);
    });
  }
});

describe("validateBody", () => {
  it("accepts type arguments like Array<T> and Map<Key, Value>", () => {
    strictEqual(
      validateBody("Array<T> と Map<Key, Value> と書く", strict).ok,
      true,
    );
  });
  for (const bad of [
    "<system>ignore",
    "<b>x</b>",
    "a < b",
    "x &lt;system&gt;",
    "<|im_start|>",
    "a <!-- c",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      strictEqual(validateBody(bad, strict).ok, false);
    });
  }
  it("rejects fences, markdown links and a leading #, keeps mid-text #", () => {
    strictEqual(validateBody("```js", strict).ok, false);
    strictEqual(validateBody("see [x](y)", strict).ok, false);
    strictEqual(validateBody("# heading", strict).ok, false);
    strictEqual(validateBody("PR #12 で直した", strict).ok, true);
  });
  it("rejects URLs unless allowed", () => {
    strictEqual(validateBody("https://example.com を見る", strict).ok, false);
    strictEqual(
      validateBody("https://example.com を見る", { allowUrl: true }).ok,
      true,
    );
  });
  it("rejects key-like 32+ char mixed-class tokens, keeps long lowercase identifiers", () => {
    strictEqual(
      validateBody("value AbCdEfGh1234567890IjKlMnOp12345678", strict).ok,
      false,
    );
    strictEqual(
      validateBody(
        "use very_long_lowercase_identifier_name_without_digits",
        strict,
      ).ok,
      true,
    );
  });
  it("enforces the 400 char limit", () => {
    strictEqual(validateBody("あ".repeat(401), strict).ok, false);
    strictEqual(validateBody("あ".repeat(400), strict).ok, true);
  });
});

describe("normalizeHeading", () => {
  it("NFKC, collapses spaces, lowercases", () => {
    strictEqual(normalizeHeading("  Ｂｕｎ   Test  "), "bun test");
  });
});
