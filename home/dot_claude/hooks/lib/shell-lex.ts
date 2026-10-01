// lib/shell-lex.ts — pure, no I/O, no imports
//
// The one character-level reading of Bash/zsh text that the read-only exemption
// (read-only-command.ts) and the safe-list scanner share. It only says what the
// character at `i` is in the current quote state. Where to split and what to
// reject is each caller's policy: the exemption allows a backslash-newline inside
// one command, the safe-list scanner rejects it.
//
// Callers call lexStep only with i < cmd.length, and reject non-space/tab/newline
// whitespace and control characters before lexing.

export type QuoteState = "outside" | "single" | "double";

export type LexStep =
  | { kind: "literal"; next: number }
  | { kind: "quote"; state: QuoteState; next: number }
  | { kind: "escape"; escaped: string; next: number }
  | { kind: "operator"; char: string; next: number }
  | { kind: "reject"; next: number };

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const BRACED_NAME = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
const UNQUOTED_OPERATORS = "\n`;&|(){}<>";
// `(` `)` are listed although both callers reject them first, so the reading of
// a comment start does not depend on that policy.
const COMMENT_BOUNDARY_BEFORE = " \t\n;&|<>()";

/**
 * Returns the index after a `$` that is followed by an allowed form, or -1.
 * Anything not listed (`$(`, `$((`, `$[`, `${(`, `${X:-y}`, `$'`, ...) is -1.
 */
export function skipDollar(cmd: string, at: number, inDouble: boolean): number {
  const next = cmd[at + 1];
  if (next === undefined || next === " " || next === "\t") return at + 1;
  if (inDouble && next === '"') return at + 1;
  if (NAME_START.test(next)) {
    let end = at + 2;
    while (end < cmd.length && NAME_CHAR.test(cmd[end] as string)) end++;
    return end;
  }
  if (inDouble && next === "{") {
    const braced = BRACED_NAME.exec(cmd.slice(at + 1));
    return braced ? at + 1 + braced[0].length : -1;
  }
  if (/[0-9@*#?!$-]/.test(next)) return at + 2;
  return -1;
}

/**
 * The shell starts a comment at a `#` that begins a word. Judged on the raw
 * previous character, not on lexer state: quotes inside a comment are not
 * quotes to the shell. Some non-comments are reported too, which only makes
 * callers reject more: `a\<newline>#c` and `a\ #c` (the shell reads `a#c` and
 * `a #c`). `a \<newline>#c` is a real comment and is reported as one.
 * Only for comments; a redirect word boundary needs its own check.
 */
export function isCommentStart(cmd: string, at: number): boolean {
  return at === 0 || COMMENT_BOUNDARY_BEFORE.includes(cmd[at - 1] as string);
}

export function lexStep(cmd: string, i: number, state: QuoteState): LexStep {
  const c = cmd[i] as string;
  if (state === "single") {
    return c === "'"
      ? { kind: "quote", state: "outside", next: i + 1 }
      : { kind: "literal", next: i + 1 };
  }
  if (state === "double") {
    if (c === "`") return { kind: "reject", next: i + 1 };
    if (c === '"') return { kind: "quote", state: "outside", next: i + 1 };
    if (c === "\\") {
      const next = cmd[i + 1];
      const width = next !== undefined && '$`"\\\n'.includes(next) ? 2 : 1;
      return { kind: "literal", next: i + width };
    }
    if (c === "$") {
      const end = skipDollar(cmd, i, true);
      return end === -1
        ? { kind: "reject", next: i + 1 }
        : { kind: "literal", next: end };
    }
    return { kind: "literal", next: i + 1 };
  }
  if (c === "\\") {
    const next = cmd[i + 1];
    return next === undefined
      ? { kind: "reject", next: i + 1 }
      : { kind: "escape", escaped: next, next: i + 2 };
  }
  if (c === "'") return { kind: "quote", state: "single", next: i + 1 };
  if (c === '"') return { kind: "quote", state: "double", next: i + 1 };
  if (c === "#" && isCommentStart(cmd, i)) {
    return { kind: "operator", char: "#", next: i + 1 };
  }
  if (UNQUOTED_OPERATORS.includes(c)) {
    return { kind: "operator", char: c, next: i + 1 };
  }
  if (c === "$") {
    const end = skipDollar(cmd, i, false);
    return end === -1
      ? { kind: "reject", next: i + 1 }
      : { kind: "literal", next: end };
  }
  return { kind: "literal", next: i + 1 };
}
