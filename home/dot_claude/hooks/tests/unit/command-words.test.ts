import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { leadingWords } from "../../lib/command-words.ts";
import { isSafeSessionId } from "../../lib/session-id.ts";

describe("leadingWords", () => {
  it("returns the first two words of a simple command", () => {
    deepStrictEqual(leadingWords("git commit -m x"), [["git", "commit"]]);
  });
  it("splits compound commands and skips git global options", () => {
    deepStrictEqual(leadingWords("cd /tmp/r && git -C x -c a=b commit"), [
      ["cd", "/tmp/r"],
      ["git", "commit"],
    ]);
  });
  it("skips assignments and env / sudo wrappers", () => {
    deepStrictEqual(leadingWords("FOO=1 BAR=2 env sudo pnpm test"), [
      ["pnpm", "test"],
    ]);
  });
  it("skips command", () => {
    deepStrictEqual(leadingWords("command git push"), [["git", "push"]]);
  });
  it("handles pipes", () => {
    deepStrictEqual(leadingWords("echo a | jactionlint"), [
      ["echo", "a"],
      ["jactionlint"],
    ]);
  });
  it("does not look inside bash -c", () => {
    deepStrictEqual(leadingWords("bash -c 'git push'"), [["bash", "-c"]]);
  });
  it("does not lower-case words", () => {
    deepStrictEqual(leadingWords("Git commit"), [["Git", "commit"]]);
  });
  it("returns [] for empty and oversized input", () => {
    deepStrictEqual(leadingWords(""), []);
    deepStrictEqual(leadingWords("a".repeat(32 * 1024 + 1)), []);
  });
  it("caps the number of simple commands at 64", () => {
    strictEqual(leadingWords("true;".repeat(100)).length, 64);
  });
});

describe("isSafeSessionId", () => {
  it("accepts ids made of [A-Za-z0-9_-] only", () => {
    strictEqual(isSafeSessionId("abc-DEF_09"), true);
    strictEqual(isSafeSessionId("../x"), false);
    strictEqual(isSafeSessionId(""), false);
  });
});
