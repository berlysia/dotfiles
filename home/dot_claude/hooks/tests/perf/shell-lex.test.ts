import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  trimSpaces,
  trimSpaceTab,
  trimTrailingBlanks,
} from "../../lib/shell-lex.ts";

describe("trimTrailingBlanks / trimSpaceTab", () => {
  it("runs in linear time on long inner blank runs", () => {
    const input = `ls${" ".repeat(200000)}b`;
    const start = performance.now();
    strictEqual(trimTrailingBlanks(input), input);
    strictEqual(trimSpaceTab(input), input);
    ok(performance.now() - start < 200);
  });
});

describe("trimSpaces", () => {
  it("trims a long inner blank run in linear time", () => {
    const input = "x" + " ".repeat(500000) + "y";
    const start = performance.now();
    strictEqual(trimSpaces(input), input);
    ok(performance.now() - start < 200);
  });
});
