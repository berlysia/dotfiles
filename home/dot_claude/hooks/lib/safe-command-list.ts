// lib/safe-command-list.ts — pure, no I/O; imports only shell-lex.ts, itself pure
//
// Decides whether a whole Bash command can be split, without any parser, into
// simple commands that are all the shell will run (spec K1). auto-approve and
// permission-auto-approve allow a Bash command only through this split: the
// fragments of bash-parser cover what may run (good for deny) but are not a
// partition of it, so allowing on them let unseen text run.
//
// Any form this scanner cannot read returns null and the caller must not allow.
// When widening it, only add forms the shell is known to read the same way.

import {
  lexStep,
  type QuoteState,
  trimSpaceTab,
  trimTrailingBlanks,
} from "./shell-lex.ts";

const HEAD = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

// Reserved words: the "simple command" would be part of a compound command.
const RESERVED_HEADS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "for",
  "select",
  "while",
  "until",
  "do",
  "done",
  "in",
  "function",
  "time",
  "coproc",
]);

// Heads whose arguments are themselves run as commands, and declarations that
// change how later commands resolve. Not exhaustive: it only matters when an
// allow rule names one of them (see README).
const EXECUTING_HEADS = new Set([
  "xargs",
  "find",
  "env",
  "timeout",
  "sudo",
  "doas",
  "nohup",
  "nice",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "eval",
  "exec",
  "source",
  "command",
  "builtin",
  "export",
  "declare",
  "typeset",
  "local",
  "readonly",
  "unset",
]);

const ALLOWED_REDIRECTS = ["2>&1", ">/dev/null", "2>/dev/null", "</dev/null"];
const REDIRECT_END = new Set([" ", "\t", "\n", ";", "&", "|"]);

export function scanSafeList(fullCommand: string): string[] | null {
  try {
    return scan(fullCommand);
  } catch (error) {
    console.error(
      `[safe-command-list] scan failed: length=${fullCommand.length} error=${error instanceof Error ? error.name : typeof error}`,
    );
    return null;
  }
}

function scan(fullCommand: string): string[] | null {
  const w = trimTrailingBlanks(fullCommand);
  if (w === "") return null;
  if (/[^\S \t\n]/.test(w) || /[\x00-\x08\x0b-\x1f\x7f]/.test(w)) return null;

  const commands: string[] = [];
  let state: QuoteState = "outside";
  let start = 0;
  let i = 0;

  // Ends the segment [start, end). A blank segment is fine only when a newline
  // ends it: a leading newline, a blank line, or a newline right after an
  // operator, none of which runs anything.
  const endSegment = (end: number, byNewline: boolean): boolean => {
    const segment = trimSpaceTab(w.slice(start, end));
    if (segment === "") return byNewline;
    if (!isAllowedHead(segment)) return false;
    commands.push(segment);
    return true;
  };

  while (i < w.length) {
    const step = lexStep(w, i, state);
    switch (step.kind) {
      case "reject":
        return null;
      case "quote":
        state = step.state;
        i = step.next;
        break;
      case "escape":
        if (step.escaped === "\n") return null;
        i = step.next;
        break;
      case "literal":
        i = step.next;
        break;
      case "operator": {
        const c = step.char;
        if (c === "<" || c === ">") {
          const next = skipAllowedRedirect(w, i);
          if (next === -1) return null;
          i = next;
        } else if (c === "\n" || c === ";") {
          if (!endSegment(i, c === "\n")) return null;
          start = i = i + 1;
        } else if (c === "&" && w[i + 1] === "&") {
          if (!endSegment(i, false)) return null;
          start = i = i + 2;
        } else if (c === "|" && w[i + 1] === "|") {
          if (!endSegment(i, false)) return null;
          start = i = i + 2;
        } else if (c === "|" && w[i + 1] !== "&") {
          if (!endSegment(i, false)) return null;
          start = i = i + 1;
        } else {
          // `#`, background `&`, `|&`, backtick, parens and braces
          return null;
        }
        break;
      }
      default: {
        // A LexStep kind added without updating this switch must never allow.
        const unhandled: never = step;
        void unhandled;
        return null;
      }
    }
  }
  if (state !== "outside") return null;
  if (!endSegment(w.length, false)) return null;
  return commands.length > 0 ? commands : null;
}

// A newline right after `&&` `||` `|` `;` belongs to the separator: the shell
// keeps reading the list on the next line. scan() gets this for free because
// the newline then ends a blank segment, which endSegment accepts.

/** Returns the index after one of ALLOWED_REDIRECTS at `at` (the `<` or `>`), or -1. */
function skipAllowedRedirect(w: string, at: number): number {
  const tokenStart =
    w[at - 1] === "2" && (w[at - 2] === " " || w[at - 2] === "\t")
      ? at - 1
      : at;
  if (w[tokenStart - 1] !== " " && w[tokenStart - 1] !== "\t") return -1;
  for (const redirect of ALLOWED_REDIRECTS) {
    if (!w.startsWith(redirect, tokenStart)) continue;
    const end = tokenStart + redirect.length;
    if (end === w.length || REDIRECT_END.has(w[end] as string)) return end;
  }
  return -1;
}

function isAllowedHead(segment: string): boolean {
  const end = segment.search(/[ \t]/);
  const head = end === -1 ? segment : segment.slice(0, end);
  return (
    HEAD.test(head) && !RESERVED_HEADS.has(head) && !EXECUTING_HEADS.has(head)
  );
}
