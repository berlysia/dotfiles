// Upper bounds only. The behaviour of the same inputs is covered in
// unit/translationese-scan.test.ts.
import { ok } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  compileEntries,
  findHits,
} from "../../implementations/translationese-scan.ts";

const REPO_LIST = join(
  import.meta.dirname,
  "../../../../../.skills/ja-notation/references/translationese-words.json",
);
const compiled = compileEntries(JSON.parse(readFileSync(REPO_LIST, "utf-8")));

function elapsedMs(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe("translationese-scan time bounds", () => {
  it("each entry survives hostile 2,000-char lines (< 100 ms per entry)", () => {
    ok(compiled);
    const raw = JSON.parse(readFileSync(REPO_LIST, "utf-8")) as {
      word: string;
    }[];
    for (const [i, entry] of compiled.entries.entries()) {
      const firstChar = (raw[i]?.word ?? "あ").charAt(0);
      for (const line of ["あ".repeat(2000), firstChar.repeat(2000)]) {
        const ms = elapsedMs(() => findHits([entry], line));
        ok(ms < 100, `${raw[i]?.word}: ${ms} ms`);
      }
    }
  });

  it("large inputs finish under 2 s each", () => {
    ok(compiled);
    const inputs = [
      "道具立てを使う。\n".repeat(1000),
      `${"あ".repeat(100_000)}道具立て`,
      "道具立て".repeat(1000),
    ];
    for (const text of inputs) {
      const ms = elapsedMs(() => findHits(compiled.entries, text));
      ok(ms < 2000, `${ms} ms`);
    }
  });
});
