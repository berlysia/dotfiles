import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { extractFailureExcerpt } from "../../lib/check-failure-excerpt.ts";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "check-failure",
);

function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("extractFailureExcerpt fallback to the cleaned tail", () => {
  it("returns the last 60 lines of an output with no marker and no noise", () => {
    const result = extractFailureExcerpt({
      stdout: numberedLines(100),
      stderr: "",
    });
    strictEqual(result.source, "tail");
    ok(result.text.includes("line 41\n"), result.text);
    ok(result.text.endsWith("line 100"), result.text);
    ok(!result.text.includes("line 40\n"), result.text);
  });

  it("drops passed-test lines and ELIFECYCLE lines from a real turbo tail, ANSI included", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("turbo-elifecycle-tail.stdout.txt"),
      stderr: "",
    });
    strictEqual(result.source, "tail");
    ok(result.text.trim() !== "");
    ok(!result.text.includes("ELIFECYCLE"), result.text);
    ok(!result.text.includes("✓"), result.text);
    ok(!result.text.includes("\x1b"), result.text);
    ok(result.text.includes("Failed:    @x/pkg#test"), result.text);
  });

  it("drops a passed-test line that starts with an ANSI code", () => {
    const result = extractFailureExcerpt({
      stdout: "\x1b[32m✓ ok one\x1b[39m\nreal line",
      stderr: "",
    });
    strictEqual(result.text, "real line");
  });

  it("returns the last 20 lines of the input when the cleaning leaves nothing", () => {
    const result = extractFailureExcerpt({
      stdout: "✓ a\n ELIFECYCLE  Test failed. See above for more details.",
      stderr: "",
    });
    strictEqual(result.source, "tail");
    ok(result.text.includes("✓ a"), result.text);
    ok(result.text.includes("ELIFECYCLE"), result.text);
  });

  it("cuts a 2,000-character line to 500 characters and an ellipsis", () => {
    const result = extractFailureExcerpt({
      stdout: `${"x".repeat(2000)}\nnext`,
      stderr: "",
    });
    const first = result.text.split("\n")[0]!;
    strictEqual(first, `${"x".repeat(500)}…`);
  });

  it("puts stderr before stdout like the gate did before", () => {
    const result = extractFailureExcerpt({
      stdout: "from stdout",
      stderr: "from stderr",
    });
    deepStrictEqual(result.text.split("\n"), ["from stderr", "from stdout"]);
  });

  it("collapses consecutive blank lines into one", () => {
    const result = extractFailureExcerpt({
      stdout: "a\n\n\n\nb",
      stderr: "",
    });
    strictEqual(result.text, "a\n\nb");
  });
});

// Fixtures were produced by node 24, vitest 4.0.18 and bun 1.4.3 running 30
// passing tests that each console.log, plus 2 failing tests. vitest and bun
// write the failure to stderr and the rest to stdout; node:test writes only
// to stdout.
describe("extractFailureExcerpt failure sections", () => {
  it("keeps both failures and the counts of node:test, and drops passed tests and node internals", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("node-test.stdout.txt"),
      stderr: "",
    });
    strictEqual(result.source, "section");
    for (const expected of [
      "compares objects",
      "throws",
      "Expected values to be strictly deep-equal",
      "boom: x is undefined",
      "ℹ fail 2",
    ]) {
      ok(result.text.includes(expected), `${expected}\n${result.text}`);
    }
    ok(!result.text.includes("✔ passes"), result.text);
    ok(!result.text.includes("node:internal"), result.text);
  });

  it("takes vitest's section from stderr and its counts from the end of stdout", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("vitest.stdout.txt"),
      stderr: fixture("vitest.stderr.txt"),
    });
    strictEqual(result.source, "section");
    for (const expected of [
      "suite > compares objects",
      "suite > throws",
      "expected { a: 1, b: [ 1, 2 ] } to deeply equal",
      "boom: x is undefined",
      "Tests  2 failed | 30 passed (32)",
    ]) {
      ok(result.text.includes(expected), `${expected}\n${result.text}`);
    }
    ok(!result.text.includes("✓ passes"), result.text);
    ok(!result.text.includes("noise log"), result.text);
  });

  it("takes bun's errors, which precede their (fail) lines, and its counts", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("bun-test.stdout.txt"),
      stderr: fixture("bun-test.stderr.txt"),
    });
    strictEqual(result.source, "section");
    for (const expected of [
      "error: expect(received).toEqual(expected)",
      "boom: x is undefined",
      "(fail) suite > compares objects",
      "(fail) suite > throws",
      "2 fail",
    ]) {
      ok(result.text.includes(expected), `${expected}\n${result.text}`);
    }
    ok(!result.text.includes("(pass)"), result.text);
    // The source frame bun prints for a failure quotes the test's console.log
    // call, so only the stdout lines themselves (they start the line) are
    // checked.
    ok(
      !result.text.split("\n").some((line) => line.startsWith("noise log")),
      result.text,
    );
  });

  it("prefers vitest's strong marker over a console.error that looks like a FAIL line before it", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("vitest.stdout.txt"),
      stderr: ` FAIL  noise from console.error\n${fixture("vitest.stderr.txt")}`,
    });
    ok(result.text.split("\n")[0]!.includes("Failed Tests 2"), result.text);
    ok(!result.text.includes("FAIL  noise"), result.text);
  });

  it("keeps both bun failures when a console.error looks like a (fail) line before them", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("bun-test.stdout.txt"),
      stderr: `(fail) noise from console.error\n${fixture("bun-test.stderr.txt")}`,
    });
    strictEqual(result.source, "section");
    ok(result.text.includes("error: expect(received).toEqual(expected)"));
    ok(result.text.includes("boom: x is undefined"), result.text);
  });

  it("prefers a strong marker in stdout over a weak marker in stderr", () => {
    const result = extractFailureExcerpt({
      stdout:
        "ℹ fail 1\n\n✖ failing tests:\n\ntest at a.test.mjs:1:1\n✖ real failure",
      stderr: "(fail) not it\nstderr rest",
    });
    ok(result.text.includes("real failure"), result.text);
    ok(!result.text.includes("stderr rest"), result.text);
  });

  it("cuts a long section to 60 lines, says how many were omitted, then keeps the counts", () => {
    const block = (n: number) =>
      [
        `test at a.test.mjs:${n}:3`,
        `✖ case ${n} (1ms)`,
        ...Array.from({ length: 10 }, (_, i) => `  detail ${n}.${i}`),
      ].join("\n");
    const section = Array.from({ length: 5 }, (_, i) => block(i + 1)).join(
      "\n",
    );
    const stdout = `ℹ tests 7\nℹ pass 2\nℹ fail 5\n\n✖ failing tests:\n${section}`;
    const result = extractFailureExcerpt({ stdout, stderr: "" });
    const lines = result.text.split("\n");
    // marker line + 5 blocks of 12 lines = 61 lines, 60 kept.
    strictEqual(lines[0], "✖ failing tests:");
    strictEqual(lines[60], "... 1 more lines omitted");
    strictEqual(lines[61], "ℹ tests 7");
    ok(lines.includes("ℹ fail 5"));
    ok(!result.text.includes("detail 5.9"), result.text);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("extractFailureExcerpt with turbo", () => {
  it("selects the failed package's lines, strips the prefix, and keeps the Failed line", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("turbo-vitest.stdout.txt"),
      stderr: "",
    });
    strictEqual(result.source, "section");
    for (const expected of [
      "suite > compares objects",
      "suite > throws",
      "expected { a: 1, b: [ 1, 2 ] } to deeply equal",
      "boom: x is undefined",
      "Failed:    @x/bad#test",
    ]) {
      ok(result.text.includes(expected), `${expected}\n${result.text}`);
    }
    ok(!result.text.includes("@x/bad:test: "), result.text);
    ok(!result.text.includes("@x/ok:test:"), result.text);
    ok(!result.text.includes("ELIFECYCLE"), result.text);
    ok(result.text.split("\n")[0]!.includes("Failed Tests 2"), result.text);
  });

  it("does not select by prefix when two packages failed, and shows each Failed line once", () => {
    const stdout = `${fixture("turbo-vitest.stdout.txt").trimEnd()}\nFailed:    @x/other#test\n`;
    const result = extractFailureExcerpt({ stdout, stderr: "" });
    ok(result.text.trim() !== "");
    ok(result.text.includes("@x/bad:test: "), result.text);
    strictEqual(countOccurrences(result.text, "Failed:    @x/bad#test"), 1);
    strictEqual(countOccurrences(result.text, "Failed:    @x/other#test"), 1);
  });

  it("falls back to the plain result plus the Failed line when no line carries the failed package's prefix", () => {
    const withoutFailed = fixture("vitest.stdout.txt");
    const plain = extractFailureExcerpt({
      stdout: withoutFailed,
      stderr: fixture("vitest.stderr.txt"),
    });
    const result = extractFailureExcerpt({
      stdout: `${withoutFailed}Failed:    @x/none#test\n`,
      stderr: fixture("vitest.stderr.txt"),
    });
    strictEqual(result.text, `${plain.text}\nFailed:    @x/none#test`);
  });

  it("selects a prefixed line whose text is empty even if turbo trimmed the trailing space", () => {
    const result = extractFailureExcerpt({
      stdout: [
        "@x/bad:test:",
        "@x/bad:test: ✖ failing tests:",
        "@x/bad:test:",
        "@x/bad:test: test at a.test.mjs:1:1",
        "@x/bad:test: ✖ case (1ms)",
        "@x/ok:test: other",
        "Failed:    @x/bad#test",
      ].join("\n"),
      stderr: "",
    });
    strictEqual(
      result.text,
      [
        "✖ failing tests:",
        "",
        "test at a.test.mjs:1:1",
        "✖ case (1ms)",
        "Failed:    @x/bad#test",
      ].join("\n"),
    );
  });
});

describe("extractFailureExcerpt with a node:test file that failed to load", () => {
  it("adds the load error found above the section after the 'test failed' line", () => {
    const result = extractFailureExcerpt({
      stdout: fixture("node-test-import-failure.stdout.txt"),
      stderr: "",
    });
    strictEqual(result.source, "section");
    ok(result.text.includes("boom: x is undefined"), result.text);
    ok(result.text.includes("Expected values to be strictly deep-equal"));
    ok(result.text.includes("ERR_MODULE_NOT_FOUND"), result.text);
    ok(result.text.includes("d.test.mjs"), result.text);
    const lines = result.text.split("\n");
    const failed = lines.indexOf("  'test failed'");
    ok(failed >= 0, result.text);
    ok(
      lines
        .slice(failed + 1, failed + 31)
        .some((line) => line.includes("ERR_MODULE_NOT_FOUND")),
      result.text,
    );
  });

  it("inserts nothing and does not throw when the top-level line above the section is missing", () => {
    // The first "✖ d.test.mjs (" line is the top-level one above the section;
    // the section repeats the line, so only the first is removed.
    const full = fixture("node-test-import-failure.stdout.txt").split("\n");
    const first = full.findIndex((line) => line.startsWith("✖ d.test.mjs ("));
    const withoutTopLevel = full.filter((_, i) => i !== first).join("\n");
    const result = extractFailureExcerpt({
      stdout: withoutTopLevel,
      stderr: "",
    });
    const lines = result.text.split("\n");
    const failed = lines.indexOf("  'test failed'");
    ok(failed >= 0, result.text);
    ok(!result.text.includes("ERR_MODULE_NOT_FOUND"), result.text);
  });

  it("inserts at most 30 lines per load failure", () => {
    const longError = Array.from({ length: 80 }, (_, i) => `detail ${i}`);
    const stdout = [
      "✖ suite (1ms)",
      ...longError,
      "✖ d.test.mjs (2ms)",
      "ℹ fail 1",
      "",
      "✖ failing tests:",
      "",
      "test at d.test.mjs:1:1",
      "✖ d.test.mjs (2ms)",
      "  'test failed'",
    ].join("\n");
    const result = extractFailureExcerpt({ stdout, stderr: "" });
    ok(result.text.includes("detail 0"), result.text);
    ok(result.text.includes("detail 29"), result.text);
    ok(!result.text.includes("detail 30"), result.text);
  });
});
