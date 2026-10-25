// Builds the `review` argument of check()/calques() the way cli.ts does, so a
// test can pass the shipped data/words.json or a hand-made list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewEntries } from "../../../japanese-check/analyze.ts";
import type {
  ReviewEntry,
  ReviewKind,
} from "../../../japanese-check/analyze.ts";
import {
  parseWordList,
  validateWordList,
} from "../../../japanese-check/words.ts";

export const SHIPPED_WORD_LIST = join(
  import.meta.dirname,
  "../../../japanese-check/data/words.json",
);

function build(
  result: ReturnType<typeof validateWordList>,
  kinds: readonly ReviewKind[] | undefined,
): ReviewEntry[] {
  if (!result.ok) throw new Error(result.reason);
  const built = buildReviewEntries(result.entries);
  if (result.notices.length + built.notices.length > 0)
    throw new Error([...result.notices, ...built.notices].join("\n"));
  return kinds === undefined
    ? built.review
    : built.review.filter((entry) => kinds.includes(entry.kind));
}

/** The shipped list's review entries, optionally only some kinds. */
export function shippedReview(kinds?: readonly ReviewKind[]): ReviewEntry[] {
  return build(parseWordList(readFileSync(SHIPPED_WORD_LIST, "utf8")), kinds);
}

/** Review entries from raw entry objects (the same shape as data/words.json). */
export function reviewFrom(entries: readonly unknown[]): ReviewEntry[] {
  return build(validateWordList({ schema: 1, entries }), undefined);
}

/** A raw review entry with the required fields filled in. */
export function rawEntry(overrides: Record<string, unknown>) {
  return {
    word: "w",
    action: "review",
    origin: "test",
    fix: "確かめる。",
    examples: ["あ"],
    nonExamples: ["い"],
    ...overrides,
  };
}
