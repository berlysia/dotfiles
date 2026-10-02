// Differential-test helpers: a linear matcher must accept exactly the language
// of the regex it replaces (Issue #219). Generators are deterministic (seeded)
// so a failure reproduces from its printed input.
import { strictEqual } from "node:assert";
import type { OracleMatcher } from "../../lib/linear-match.ts";

// The characters that `\s` and `.` disagree on, written as escapes: " " is
// matched by both, "\n" / "\u2028" are `\s` but not `.`.
export const WS_CORE = [" ", "\n", "\u2028"];
export const WS_ALL = [
  " ",
  "\t",
  "\n",
  "\r",
  "\u000b",
  "\u2028",
  "\u2029",
  "\u00a0",
  "\ufeff",
];

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exhaustive concatenations of `tokens`, up to `maxLen` tokens (the empty string included). */
export function* enumerate(
  tokens: readonly string[],
  maxLen: number,
): Generator<string> {
  function* walk(prefix: string, depth: number): Generator<string> {
    yield prefix;
    if (depth === maxLen) return;
    for (const token of tokens) yield* walk(prefix + token, depth + 1);
  }
  yield* walk("", 0);
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

/** `count` random concatenations of 0-30 tokens. */
export function* randomStrings(
  tokens: readonly string[],
  count: number,
  seed: number,
): Generator<string> {
  const random = mulberry32(seed);
  for (let n = 0; n < count; n++) {
    const length = Math.floor(random() * 31);
    let s = "";
    for (let i = 0; i < length; i++) s += pick(tokens, random);
    yield s;
  }
}

/** Each seed string mutated 1-3 times (insert a token, delete a character, or replace a character with a token), `perSeed` times. */
export function* mutations(
  seeds: readonly string[],
  tokens: readonly string[],
  perSeed: number,
  seed: number,
): Generator<string> {
  const random = mulberry32(seed);
  for (const base of seeds) {
    for (let n = 0; n < perSeed; n++) {
      let s = base;
      const rounds = 1 + Math.floor(random() * 3);
      for (let r = 0; r < rounds; r++) {
        const at = Math.floor(random() * (s.length + 1));
        const kind = Math.floor(random() * 3);
        if (kind === 0) s = s.slice(0, at) + pick(tokens, random) + s.slice(at);
        else if (kind === 1) s = s.slice(0, at) + s.slice(at + 1);
        else s = s.slice(0, at) + pick(tokens, random) + s.slice(at + 1);
      }
      yield s;
    }
  }
}

export function assertAgrees(
  matcher: OracleMatcher,
  inputs: Iterable<string>,
): void {
  for (const s of inputs) {
    strictEqual(matcher.test(s), matcher.oracle.test(s), JSON.stringify(s));
  }
}
