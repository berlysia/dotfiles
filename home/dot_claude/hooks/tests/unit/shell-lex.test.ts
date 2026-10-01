#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { isCommentStart, lexStep, skipDollar } from "../../lib/shell-lex.ts";

describe("lexStep", () => {
  it("reports unquoted operators for the caller to judge", () => {
    for (const c of ["\n", "`", ";", "&", "|", "(", ")", "{", "}", "<", ">"]) {
      deepStrictEqual(lexStep(`a${c}b`, 1, "outside"), {
        kind: "operator",
        char: c,
        next: 2,
      });
    }
  });

  it("reports `#` as an operator only at a word start", () => {
    deepStrictEqual(lexStep("#x", 0, "outside"), {
      kind: "operator",
      char: "#",
      next: 1,
    });
    deepStrictEqual(lexStep("a #x", 2, "outside"), {
      kind: "operator",
      char: "#",
      next: 3,
    });
    deepStrictEqual(lexStep("a;#x", 2, "outside"), {
      kind: "operator",
      char: "#",
      next: 3,
    });
    deepStrictEqual(lexStep("a\\\n#x", 3, "outside"), {
      kind: "operator",
      char: "#",
      next: 4,
    });
    deepStrictEqual(lexStep("a#x", 1, "outside"), { kind: "literal", next: 2 });
    deepStrictEqual(lexStep("'a'#x", 3, "outside"), {
      kind: "literal",
      next: 4,
    });
  });

  it("hands escapes to the caller, including backslash-newline", () => {
    deepStrictEqual(lexStep("a\\;", 1, "outside"), {
      kind: "escape",
      escaped: ";",
      next: 3,
    });
    deepStrictEqual(lexStep("a\\\nb", 1, "outside"), {
      kind: "escape",
      escaped: "\n",
      next: 3,
    });
    deepStrictEqual(lexStep("a\\", 1, "outside"), { kind: "reject", next: 2 });
  });

  it("tracks quotes and treats their contents as literal", () => {
    deepStrictEqual(lexStep("'", 0, "outside"), {
      kind: "quote",
      state: "single",
      next: 1,
    });
    deepStrictEqual(lexStep('"', 0, "outside"), {
      kind: "quote",
      state: "double",
      next: 1,
    });
    deepStrictEqual(lexStep(";", 0, "single"), { kind: "literal", next: 1 });
    deepStrictEqual(lexStep('"', 0, "single"), { kind: "literal", next: 1 });
    deepStrictEqual(lexStep("'", 0, "single"), {
      kind: "quote",
      state: "outside",
      next: 1,
    });
    deepStrictEqual(lexStep(";", 0, "double"), { kind: "literal", next: 1 });
    deepStrictEqual(lexStep('\\"', 0, "double"), { kind: "literal", next: 2 });
    deepStrictEqual(lexStep("\\a", 0, "double"), { kind: "literal", next: 1 });
    deepStrictEqual(lexStep("`", 0, "double"), { kind: "reject", next: 1 });
  });

  it("accepts only the listed `$` forms", () => {
    deepStrictEqual(lexStep("$HOME/x", 0, "outside"), {
      kind: "literal",
      next: 5,
    });
    deepStrictEqual(lexStep("$(x)", 0, "outside"), { kind: "reject", next: 1 });
    deepStrictEqual(lexStep("${X}", 0, "outside"), { kind: "reject", next: 1 });
    deepStrictEqual(lexStep("${X}", 0, "double"), { kind: "literal", next: 4 });
    deepStrictEqual(lexStep("$'x'", 0, "outside"), { kind: "reject", next: 1 });
  });
});

describe("skipDollar / isCommentStart", () => {
  it("keeps the F2 forms", () => {
    strictEqual(skipDollar("$#x", 0, false), 2);
    strictEqual(skipDollar("$", 0, false), 1);
    strictEqual(skipDollar("$((1))", 0, false), -1);
  });

  it("judges word starts on the raw previous character", () => {
    strictEqual(isCommentStart("#", 0), true);
    strictEqual(isCommentStart("a #", 2), true);
    strictEqual(isCommentStart("a\t#", 2), true);
    strictEqual(isCommentStart("a<#", 2), true);
    strictEqual(isCommentStart("a(#", 2), true);
    strictEqual(isCommentStart("a#", 1), false);
    strictEqual(isCommentStart('"a"#', 3), false);
  });
});
