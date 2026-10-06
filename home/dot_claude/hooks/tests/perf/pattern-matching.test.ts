import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { matchGitignorePattern } from "../../lib/pattern-matcher.ts";

const ctx = { cwd: "/repo", home: "/home/u", settingsRoot: "/proj" };

describe("matchGitignorePattern: absolute wildcard patterns", () => {
  it("stays fast on long paths with stacked ** (no backtracking blowup)", () => {
    const longPath = `/${Array(200).fill("a").join("/")}/b`;
    const start = performance.now();
    strictEqual(
      matchGitignorePattern(longPath, "//**/**/**/**/c", ctx, "grant"),
      false,
    );
    strictEqual(
      matchGitignorePattern(`/repo${longPath}`, ".env", ctx, "restrict"),
      false,
    );
    const elapsed = performance.now() - start;
    strictEqual(elapsed < 50, true, `took ${elapsed}ms`);
  });
});
