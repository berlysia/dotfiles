// Upper bounds only. The extraction runs inside the completion gate's close
// handler on up to 64 MiB of output, so a quadratic scan would stall the Stop
// hook. The bounds are loose on purpose (the correctness cases are in
// unit/check-failure-excerpt.test.ts) and live here, not in unit, because
// timing under parallel load is flaky (docs/plans/timing-sensitive-tests-under-load.md).
import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { extractFailureExcerpt } from "../../lib/check-failure-excerpt.ts";

const HUNDRED_CHARS = "x".repeat(99);

function repeatedLines(count: number, line: string): string {
  return Array.from({ length: count }, () => line).join("\n");
}

function timed<T>(run: () => T): { result: T; elapsedMs: number } {
  const started = performance.now();
  const result = run();
  return { result, elapsedMs: performance.now() - started };
}

describe("extractFailureExcerpt on large outputs", () => {
  it("returns the failure section after 200,000 lines and a 1 MiB line (elapsed < 2 s)", () => {
    const stdout = [
      repeatedLines(200_000, HUNDRED_CHARS),
      "y".repeat(1024 * 1024),
      "ℹ fail 1",
      "",
      "✖ failing tests:",
      "",
      "test at a.test.mjs:1:1",
      "✖ the real failure (1ms)",
    ].join("\n");
    const { result, elapsedMs } = timed(() =>
      extractFailureExcerpt({ stdout, stderr: "" }),
    );
    ok(elapsedMs < 2000, `${elapsedMs} ms`);
    strictEqual(result.source, "section");
    ok(result.text.includes("the real failure"), result.text);
    ok(result.text.length < 10_000, `${result.text.length} chars`);
  });

  it("falls back to the tail of 200,000 lines without a marker (elapsed < 2 s)", () => {
    const stdout = repeatedLines(200_000, HUNDRED_CHARS);
    const { result, elapsedMs } = timed(() =>
      extractFailureExcerpt({ stdout, stderr: "" }),
    );
    ok(elapsedMs < 2000, `${elapsedMs} ms`);
    strictEqual(result.source, "tail");
  });

  it("handles 2,000 node:test files that failed to load (elapsed < 2 s)", () => {
    const count = 2000;
    const above = Array.from({ length: count }, (_, i) =>
      [
        `Error [ERR_MODULE_NOT_FOUND]: cannot find module for f${i}`,
        `    at load f${i}`,
        `✖ f${i}.test.mjs (1ms)`,
      ].join("\n"),
    ).join("\n");
    const section = Array.from({ length: count }, (_, i) =>
      [
        `test at f${i}.test.mjs:1:1`,
        `✖ f${i}.test.mjs (1ms)`,
        "  'test failed'",
      ].join("\n"),
    ).join("\n");
    const stdout = `${above}\nℹ fail ${count}\n\n✖ failing tests:\n\n${section}`;
    const { result, elapsedMs } = timed(() =>
      extractFailureExcerpt({ stdout, stderr: "" }),
    );
    ok(elapsedMs < 2000, `${elapsedMs} ms`);
    strictEqual(result.source, "section");
    ok(result.text.includes("ERR_MODULE_NOT_FOUND"), result.text);
  });

  it("handles 100,000 weak (fail) markers in stderr (elapsed < 2 s)", () => {
    const stderr = repeatedLines(100_000, "(fail) x");
    const { elapsedMs } = timed(() =>
      extractFailureExcerpt({ stdout: "", stderr }),
    );
    ok(elapsedMs < 2000, `${elapsedMs} ms`);
  });

  it("handles about 60 MiB, close to the gate's output limit, without throwing (elapsed < 5 s)", () => {
    const stdout = repeatedLines(600_000, HUNDRED_CHARS);
    const { elapsedMs } = timed(() =>
      extractFailureExcerpt({ stdout, stderr: "" }),
    );
    ok(elapsedMs < 5000, `${elapsedMs} ms`);
  });
});
