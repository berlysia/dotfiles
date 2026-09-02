#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { sanitizeForDisplay } from "../../lib/sanitize-display.ts";

/**
 * Code points are written numerically rather than as literals or escapes: this
 * suite's entire subject is which code points belong to the stripped set, and a
 * literal would make the file undiffable while an escape would make the set
 * unreadable at review time.
 */
const cp = (...codePoints: number[]): string =>
  String.fromCodePoint(...codePoints);

/**
 * Every code point the stripped set must contain, with why it is in it.
 *
 * Eight entries are unassigned code points reserved inside default-ignorable
 * blocks (U+2065, U+E0000, U+FFF0, U+FFF8, U+E0080, U+E00FF, U+E01F0,
 * U+E0FFF). They double as a tripwire on the runtime's Unicode version: if one
 * of them starts failing without a source change, Unicode has assigned it to
 * something that is no longer default-ignorable. Confirm against the UCD and
 * move that code point to KEPT rather than widening STRIP_REGEX by hand.
 */
const STRIPPED: ReadonlyArray<readonly [number, string]> = [
  [0x0060, "backtick, closes a markdown code span"],
  [0x0000, "NUL (Cc)"],
  [0x0009, "TAB (Cc)"],
  [0x000a, "LF (Cc)"],
  [0x000d, "CR (Cc)"],
  [0x001f, "last C0 control (Cc)"],
  [0x007f, "DEL (Cc)"],
  [0x009f, "last C1 control (Cc)"],
  [0x00ad, "soft hyphen (Cf)"],
  [0x034f, "combining grapheme joiner (Mn, invisible)"],
  [0x061c, "arabic letter mark (Cf)"],
  [0x115f, "hangul choseong filler (Lo, invisible)"],
  [0x1160, "hangul jungseong filler (Lo, invisible)"],
  [0x17b4, "khmer inherent vowel AQ (Mn, invisible)"],
  [0x17b5, "khmer inherent vowel AA (Mn, invisible)"],
  [0x200b, "zero width space (Cf)"],
  [0x200e, "left-to-right mark (Cf)"],
  [0x200f, "right-to-left mark (Cf)"],
  [0x2026, "ellipsis, reserved as the elision marker"],
  [0x2028, "line separator (Zl)"],
  [0x2029, "paragraph separator (Zp)"],
  [0x202a, "left-to-right embedding (Cf)"],
  [0x202e, "right-to-left override (Cf)"],
  [0x2060, "word joiner (Cf)"],
  [0x2064, "invisible plus (Cf)"],
  [0x2065, "unassigned hole inside the U+2060-U+206F block (Cn)"],
  [0x2066, "left-to-right isolate (Cf)"],
  [0x2069, "pop directional isolate (Cf)"],
  [0x206f, "nominal digit shapes (Cf)"],
  [0x2800, "braille pattern blank (So, invisible)"],
  [0x3164, "hangul filler (Lo, invisible)"],
  [0xfe00, "first variation selector (Mn, invisible)"],
  [0xfe0f, "last variation selector (Mn, invisible)"],
  [0xfeff, "byte order mark (Cf)"],
  [0xfff9, "interlinear annotation anchor (Cf)"],
  [0xfffb, "interlinear annotation terminator (Cf)"],
  [0xffa0, "halfwidth hangul filler (Lo, invisible)"],
  [0xe0000, "unassigned edge of the tag block (Cn)"],
  [0xe0001, "language tag (Cf)"],
  [0xe0041, "tag latin capital A (Cf)"],
  [0xe007f, "cancel tag (Cf)"],
  [0xe0100, "first variation selector supplement (Mn, invisible)"],
  [0xe01ef, "last variation selector supplement (Mn, invisible)"],
  // The four ranges below sit immediately after a range that an earlier
  // hand-written version of STRIP_REGEX stopped at. Each one is the neighbour
  // that enumeration missed; they are here so the set cannot silently shrink
  // back to an enumeration.
  [0x180b, "mongolian free variation selector one"],
  [0x180f, "mongolian free variation selector four"],
  [0xfff0, "unassigned default-ignorable, just before U+FFF9"],
  [0xfff8, "unassigned default-ignorable, just before U+FFF9"],
  [0xe0080, "tag block continuation, just after U+E007F"],
  [0xe00ff, "tag block continuation"],
  [0xe01f0, "variation selector supplement continuation, just after U+E01EF"],
  [0xe0fff, "last default-ignorable in the supplementary planes"],
];

/** Code points that must survive, so the set cannot quietly widen. */
const KEPT: ReadonlyArray<readonly [number, string]> = [
  [0x0020, "space"],
  [0x0024, "dollar sign, legal in a POSIX filename and inert in a code span"],
  [0x002d, "hyphen"],
  [0x002e, "full stop"],
  [0x002f, "solidus"],
  [0x005f, "low line"],
  [0x00e9, "e with acute"],
  [0x3000, "ideographic space (Zs, not Zl/Zp)"],
  [0x3042, "hiragana A"],
  [0x8a08, "CJK ideograph"],
  [0x1f600, "astral emoji"],
];

/**
 * Legitimate inputs this function knowingly collapses. Listed so the decision
 * is visible where it is enforced: a reader must be able to tell a deliberate
 * collapse from an oversight, and the docstring's "the output is a projection,
 * not a path" is what licenses these.
 */
const INTENTIONALLY_COLLAPSED: ReadonlyArray<
  readonly [string, string, string]
> = [
  [
    "ZWJ emoji sequence",
    cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f466),
    cp(0x1f468, 0x1f469, 0x1f466),
  ],
  [
    "ideographic variation sequence",
    cp(0x845b, 0xe0101) + ".md",
    cp(0x845b) + ".md",
  ],
  [
    "emoji presentation selector",
    cp(0x2764, 0xfe0f) + ".md",
    cp(0x2764) + ".md",
  ],
];

/** Sequences that must survive, because nothing in them is invisible. */
const SEQUENCES_KEPT: ReadonlyArray<readonly [string, string]> = [
  ["regional indicator flag", cp(0x1f1ef, 0x1f1f5) + ".md"],
  ["skin tone modifier", cp(0x1f44d, 0x1f3fd) + ".md"],
];

describe("sanitize-display.ts", () => {
  it("removes every code point in the stripped set", () => {
    const survivors = STRIPPED.filter(
      ([point]) => sanitizeForDisplay(cp(point)) !== "",
    ).map(([point, why]) => `U+${point.toString(16).toUpperCase()} ${why}`);
    deepStrictEqual(survivors, []);
  });

  it("keeps every code point outside the stripped set", () => {
    const casualties = KEPT.filter(
      ([point]) => sanitizeForDisplay(cp(point)) !== cp(point),
    ).map(([point, why]) => `U+${point.toString(16).toUpperCase()} ${why}`);
    deepStrictEqual(casualties, []);
  });

  it("removes a backtick so a markdown code span cannot be closed", () => {
    strictEqual(sanitizeForDisplay("/repo/src/a`b.ts"), "/repo/src/ab.ts");
  });

  it("keeps a dollar sign, which is legal in a path and inert in a code span", () => {
    strictEqual(sanitizeForDisplay("/repo/src/a$b.ts"), "/repo/src/a$b.ts");
  });

  it("leaves a legitimate path untouched", () => {
    const path =
      "/home/u/.local/share/chezmoi/home/dot_claude/hooks/lib/a-b_c.ts";
    strictEqual(sanitizeForDisplay(path), path);
  });

  it("leaves spaces, CJK text and astral characters untouched", () => {
    const kept = "a b" + cp(0x3000) + cp(0x8a08, 0x753b) + cp(0x1f600) + ".md";
    strictEqual(sanitizeForDisplay(kept), kept);
  });

  it("returns a value that fits unchanged", () => {
    const input = "a".repeat(256);
    strictEqual(sanitizeForDisplay(input), input);
  });

  it("elides the middle so the filename at the end survives", () => {
    // A path long enough to elide: the identifying part of a path is its last
    // segment, so a tail-dropping truncation would delete exactly the part the
    // reader needs to act on.
    const input = "/repo/" + "nested/".repeat(60) + "target-file-name.ts";
    const out = sanitizeForDisplay(input);
    strictEqual(out.length, 256);
    strictEqual(out.startsWith("/repo/nested/"), true);
    strictEqual(out.endsWith("target-file-name.ts"), true);
    strictEqual(out.includes(cp(0x2026)), true);
  });

  it("strips before eliding so removal cannot move the boundary", () => {
    // 10 backticks interleaved with 10 "x", then 250 "y" = 270 units.
    // Stripping leaves 260, which still exceeds the limit and elides.
    const out = sanitizeForDisplay("`x".repeat(10) + "y".repeat(250));
    strictEqual(out.length, 256);
    strictEqual(out.startsWith("x".repeat(10)), true);
    strictEqual(out.endsWith("y".repeat(10)), true);
  });

  it("does not split a surrogate pair at either elision boundary", () => {
    const astral = cp(0x1f600);
    const head = sanitizeForDisplay("a".repeat(127) + astral + "b".repeat(200));
    const tail = sanitizeForDisplay("a".repeat(200) + astral + "b".repeat(126));
    for (const out of [head, tail]) {
      for (let i = 0; i < out.length; i++) {
        const unit = out.charCodeAt(i);
        // No lone surrogate may remain: every high surrogate is followed by a
        // low one and vice versa.
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = out.charCodeAt(i + 1);
          strictEqual(next >= 0xdc00 && next <= 0xdfff, true);
        }
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          const prev = out.charCodeAt(i - 1);
          strictEqual(prev >= 0xd800 && prev <= 0xdbff, true);
        }
      }
    }
  });

  it("collapses these legitimate sequences, deliberately", () => {
    for (const [label, input, expected] of INTENTIONALLY_COLLAPSED) {
      strictEqual(sanitizeForDisplay(input), expected, label);
    }
  });

  it("keeps sequences whose parts are all visible", () => {
    for (const [label, input] of SEQUENCES_KEPT) {
      strictEqual(sanitizeForDisplay(input), input, label);
    }
  });

  it("returns an empty string for an empty input", () => {
    strictEqual(sanitizeForDisplay(""), "");
  });
});
