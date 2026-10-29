/**
 * Labels that another session decided (name, branch, worktree) and that are
 * shown to a reader or a model. The set removed here is the set that either
 * disappears on screen or breaks a one-line layout.
 *
 * Why not reuse the existing sets:
 * - `sanitizeForDisplay` (sanitize-display.ts) elides at 256 units and also
 *   removes backticks, U+2026 and U+2800. A branch name keeps its backticks and
 *   this label is cut at 80, so the limits differ.
 * - `INVISIBLE` (invisible-chars.ts) is an enumerated set without Co, Cn, Zl
 *   and Zp, and offers a keep-newline switch a label never needs.
 *
 * The set is written as Unicode properties, not code point ranges: hand-written
 * ranges were tried in sanitize-display.ts and got several of them wrong.
 * Combining marks (Mn) in a run are not removed, so a label can still render
 * oddly; that is a known limit, not a defense.
 */
const UNSAFE_CHARS =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
const UNSAFE_CHARS_GLOBAL = new RegExp(UNSAFE_CHARS.source, "gu");
const BLANK_ONLY = /^\p{White_Space}*$/u;
const ADDRESSABLE = /^[A-Za-z0-9._-]{1,40}$/;

const MAX_CODE_POINTS = 80;
const ELLIPSIS = "…";

export function hasUnsafeLabelChars(value: string): boolean {
  return UNSAFE_CHARS.test(value);
}

/**
 * keep "head": the start identifies the label (name, branch), cut the end.
 * keep "tail": the last path element identifies it (worktree), cut the start
 * and put U+2026 first so the total stays 80.
 */
export function sanitizeLabel(
  value: string,
  keep: "head" | "tail",
): string | null {
  const stripped = value.replace(UNSAFE_CHARS_GLOBAL, "");
  if (BLANK_ONLY.test(stripped)) return null;
  const points = Array.from(stripped);
  if (points.length <= MAX_CODE_POINTS) return stripped;
  if (keep === "head") return points.slice(0, MAX_CODE_POINTS).join("");
  return (
    ELLIPSIS + points.slice(points.length - (MAX_CODE_POINTS - 1)).join("")
  );
}

/** Judged on the raw value: a value that only matches after sanitizing is not addressable. */
export function isAddressableName(value: string): boolean {
  return ADDRESSABLE.test(value);
}
