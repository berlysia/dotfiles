import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { containsKeyLike } from "../../lib/key-like.ts";

describe("containsKeyLike", () => {
  const mixed = "Abcdefghij0123456789Abcdefghij01";
  it("detects a mixed token at the 32 character boundary", () => {
    strictEqual(mixed.length, 32);
    strictEqual(containsKeyLike(mixed), true);
  });
  it("accepts a 31 character token", () => {
    const short = mixed.slice(0, -1);
    strictEqual(short.length, 31);
    strictEqual(containsKeyLike(short), false);
  });
  it("accepts lowercase and digits without uppercase", () => {
    const token = "a1".repeat(20);
    strictEqual(token.length, 40);
    strictEqual(containsKeyLike(token), false);
  });
  it("accepts mixed case without digits", () => {
    const token = "Ab".repeat(16);
    strictEqual(token.length, 32);
    strictEqual(containsKeyLike(token), false);
  });
  it("accepts empty text", () => {
    strictEqual(containsKeyLike(""), false);
  });
  it("detects the same token on consecutive calls", () => {
    strictEqual(containsKeyLike(mixed), true);
    strictEqual(containsKeyLike(mixed), true);
  });
  it("checks later tokens after a nonmatching token", () => {
    strictEqual(containsKeyLike(`${"a1".repeat(20)} ${mixed}`), true);
  });
  it("does not combine character classes across tokens", () => {
    strictEqual(
      containsKeyLike(`${"A".repeat(32)} ${"a".repeat(32)} ${"1".repeat(32)}`),
      false,
    );
  });
});
