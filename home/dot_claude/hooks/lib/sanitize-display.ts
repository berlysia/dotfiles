/**
 * Project a path or error message onto a form that cannot escape the surface it
 * is embedded in, bounded in length.
 *
 * Backticks are the concrete threat: `document-workflow-guard.ts` and
 * `block-plan-mode.ts` wrap interpolated values in markdown code spans inside
 * `permissionDecisionReason`, which reaches the model. A backtick closes the
 * span and turns the remainder into free-form markdown.
 *
 * Three properties a caller must know:
 *
 * 1. **The output is a projection, not a path.** Removal is deletion, so
 *    `/a`b.ts` and `/ab.ts` collapse to the same string. Never reconstruct a
 *    path from this output or copy it into a plan's Files section.
 * 2. **The set is defined by a Unicode property, not enumerated.**
 *    `\p{Default_Ignorable_Code_Point}` is what "renders as nothing, by
 *    design" means, and it reaches the invisible characters in `Mn` and `Lo`
 *    that a `\p{Cf}` set cannot. Exactly one code point is written by hand
 *    -- U+2800, the only invisible character that is not default-ignorable.
 *    Consequently a code point that a future Unicode release marks
 *    default-ignorable is covered by a runtime data update alone; what is not
 *    covered is the narrower class of "newly invisible but not
 *    default-ignorable".
 * 3. **`$` is deliberately kept.** The sink is model input, not a shell, and
 *    `$` is inert inside a code span. Removing it without a concrete threat
 *    would collapse `a$b.ts` onto `ab.ts` and manufacture the display/decision
 *    divergence this codebase is trying to remove.
 *
 * Distinct from `insight-digest.ts`'s `sanitize`, which redacts secrets and
 * reports a hit count. This one removes structure-breaking characters and
 * returns a bounded string; the two are not interchangeable.
 *
 * Not for JSON sinks: `JSON.stringify` escapes structurally, and stripping
 * there would corrupt paths irreversibly.
 */

/**
 * The stripped set, in the order it is written:
 *
 * - U+0060 backtick: closes a markdown code span.
 * - U+2026 ellipsis: reserved as the elision marker, so its presence in the
 *   output unambiguously means "elided here".
 * - U+2800 braille pattern blank: renders as nothing but is `So`, and is the
 *   one invisible code point below that no property here reaches.
 * - \p{Cc}: C0 controls, DEL and C1 (covers TAB, LF and CR).
 * - \p{Cf}: format controls. Overlaps the property below but is not
 *   contained by it -- U+0600-U+0605 and friends are `Cf` and not ignorable.
 * - \p{Zl} / \p{Zp}: U+2028 and U+2029, which are neither Cc nor Cf.
 * - \p{Default_Ignorable_Code_Point}: the Unicode property for "renders as
 *   nothing, by design". It covers the variation selectors (U+FE00-U+FE0F,
 *   U+180B-U+180F, U+E0100-U+E0FFF), the Hangul fillers, the tag block
 *   (U+E0000-U+E0FFF), the unassigned holes reserved inside those blocks, and
 *   U+2065. Enumerating those ranges by hand was tried and got four of them
 *   wrong: each hand-written range stopped one block short of its neighbour,
 *   leaving 3741 invisible code points through. Let Unicode define the set.
 *
 * Written with escapes rather than literals on purpose: a literal control
 * character makes git treat this file as binary, and this is the one file
 * whose correctness is exactly "which characters are in this set".
 */
const STRIP_REGEX =
  /[`\u2026\u2800\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Elided output is at most HEAD + 1 (ellipsis) + TAIL = MAX_LENGTH units. It is
 * one or two shorter when a boundary lands inside a surrogate pair.
 */
const MAX_LENGTH = 256;
const HEAD_LENGTH = 128;
const TAIL_LENGTH = 127;
const ELLIPSIS = "\u2026";

export function sanitizeForDisplay(value: string): string {
  // Strip before eliding: doing it after would let removed characters move the
  // boundaries, so the same input could elide at different points.
  const stripped = value.replace(STRIP_REGEX, "");
  if (stripped.length <= MAX_LENGTH) {
    return stripped;
  }
  // Keep both ends: the head carries the project-relative prefix a reader uses
  // to locate the file, the tail carries the file name that identifies it.
  const head = dropTrailingHighSurrogate(stripped.slice(0, HEAD_LENGTH));
  const tail = dropLeadingLowSurrogate(
    stripped.slice(stripped.length - TAIL_LENGTH),
  );
  return `${head}${ELLIPSIS}${tail}`;
}

function dropTrailingHighSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? value.slice(0, -1) : value;
}

function dropLeadingLowSurrogate(value: string): string {
  const first = value.charCodeAt(0);
  const isLowSurrogate = first >= 0xdc00 && first <= 0xdfff;
  return isLowSurrogate ? value.slice(1) : value;
}
