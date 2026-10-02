// lib/linear-match.ts — pure, no I/O, no imports
//
// Linear-time replacements for deny/ask-path regexes of the shape `X\s+.*Y` / `X.*Y`
// (Issue #219). On a long blank run or a repeated word those regexes are
// quadratic or worse, and a hook that runs past run-guard's timeout blocks a
// legitimate command. Each matcher here accepts exactly the same language as
// the regex it replaces and carries that regex as `oracle`, so differential
// tests can compare the two over the production tables.
//
// Do not add a regex of the form `X\s+.*Y` / `X.*Y` to a deny/ask table; use
// prefixThenOnLine (see Issue #219).

/** Anything with RegExp's `test`; a RegExp satisfies it structurally. */
export interface TextMatcher {
  test(text: string): boolean;
}

/** A linear replacement that carries the regex it must agree with, for differential tests. */
export interface OracleMatcher extends TextMatcher {
  /** test-only: never call from production paths (it is the super-linear original). */
  readonly oracle: RegExp;
}

export interface PrefixThenOnLineMatcher extends OracleMatcher {
  readonly prefix: RegExp;
  readonly needle: RegExp;
}

export interface LineIndex {
  /** First position at or after `from` that `.` does not match, or text.length. */
  lineEnd(from: number): number;
}

export interface StartIndex {
  /** First match start at or after `from`, or Infinity when there is none. */
  firstAtOrAfter(from: number): number;
}

/** First index of `sorted` whose value is >= `from`, or sorted.length. */
function lowerBound(sorted: readonly number[], from: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as number) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;
const LINE_TERMINATORS_GLOBAL = /[\n\r\u2028\u2029]/g;
const WHITESPACE = /\s/;

/** The characters `.` does not match (no `s` flag). */
export function isLineTerminator(ch: string | undefined): boolean {
  return ch !== undefined && LINE_TERMINATOR.test(ch);
}

/** `/\s/` on one character; undefined (past the end) is not whitespace. */
export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && WHITESPACE.test(ch);
}

export function createLineIndex(text: string): LineIndex {
  const terminators: number[] = [];
  for (const m of text.matchAll(LINE_TERMINATORS_GLOBAL)) {
    terminators.push(m.index);
  }
  return {
    lineEnd(from) {
      const at = lowerBound(terminators, from);
      return at < terminators.length
        ? (terminators[at] as number)
        : text.length;
    },
  };
}

/**
 * Every position where `re` matches, found by retrying from index + 1 after
 * each match (a plain global scan would skip overlapping starts).
 */
export function createStartIndex(text: string, re: RegExp): StartIndex {
  const scan = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : `${re.flags}g`,
  );
  const starts: number[] = [];
  for (let m = scan.exec(text); m; m = scan.exec(text)) {
    starts.push(m.index);
    scan.lastIndex = m.index + 1;
  }
  return {
    firstAtOrAfter(from) {
      const at = lowerBound(starts, from);
      return at < starts.length ? (starts[at] as number) : Infinity;
    },
  };
}

/**
 * For each position (and text.length), where the `\s` run containing it ends;
 * a non-whitespace position maps to itself. One right-to-left pass.
 */
export function createRunEnds(text: string): Int32Array {
  const ends = new Int32Array(text.length + 1);
  ends[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    ends[i] = isWhitespace(text[i]) ? (ends[i + 1] as number) : i;
  }
  return ends;
}

/** Whether a match start lies in [from, end of the line containing `from`]. */
export function onLine(
  lines: LineIndex,
  starts: StartIndex,
  from: number,
): boolean {
  return starts.firstAtOrAfter(from) <= lines.lineEnd(from);
}

/** Whether `source` has a `|` outside any group or character class. */
export function hasTopLevelAlternation(source: string): boolean {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
    } else if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
    } else if (c === "|" && depth === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Linear equivalent of `new RegExp(prefix.source + ".*" + needle.source)`
 * (no flags). Scans each prefix start once and asks, by binary search, whether
 * a needle starts on the same line at or after the prefix's greedy end.
 *
 * Equivalent to the concatenated regex when all of these hold; the first two
 * are asserted by tests over the production tables, the last two at
 * construction:
 * - (P1) the needle never starts its match at a `\s` character;
 * - (P2) for any end j of a prefix match from the same start, [j, greedy end)
 *   is all `\s` (so the greedy end is never worse: the `.*` of the original
 *   would have to absorb that whitespace, and by P1 the needle start lies at
 *   or beyond the greedy end);
 * - (P3) no flags, so `^` holds only at index 0, and any `\b` or lookbehind is
 *   zero-width: restarting at index + 1 loses no start;
 * - (P4) neither source has a top-level `|`, so concatenation keeps the meaning.
 */
export function prefixThenOnLine(
  prefix: RegExp,
  needle: RegExp,
): PrefixThenOnLineMatcher {
  if (prefix.flags !== "" || needle.flags !== "") {
    throw new TypeError("prefixThenOnLine takes flag-less regexes");
  }
  if (
    hasTopLevelAlternation(prefix.source) ||
    hasTopLevelAlternation(needle.source)
  ) {
    throw new TypeError("prefixThenOnLine rejects a top-level `|`");
  }
  return {
    prefix,
    needle,
    oracle: new RegExp(`${prefix.source}.*${needle.source}`),
    test(text) {
      const scan = new RegExp(prefix.source, "g");
      let lines: LineIndex | undefined;
      let needles: StartIndex | undefined;
      for (let m = scan.exec(text); m; m = scan.exec(text)) {
        const end = m.index + m[0].length;
        lines ??= createLineIndex(text);
        needles ??= createStartIndex(text, needle);
        if (onLine(lines, needles, end)) return true;
        scan.lastIndex = m.index + 1;
      }
      return false;
    },
  };
}
