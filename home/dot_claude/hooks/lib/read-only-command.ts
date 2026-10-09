// lib/read-only-command.ts — pure, no I/O; imports only shell-lex.ts, itself pure
//
// Decides whether a whole Bash command is a single simple invocation of a
// read-only command whose arguments are only text (`grep -e "rm -rf /" spec.md`).
// Both deny-node-modules (classifyDeletion) and auto-approve
// (checkDangerousCommand) use this one predicate to skip their argument-spelling
// checks, so ARGUMENT_SCAN_EXEMPT_HEADS and the predicate affect both hooks.
//
// Every form this scanner cannot judge returns false, and the predicate never
// throws: callers treat false as "apply the normal checks", while an exception
// would surface as a deny of an innocent command. When widening the scanner,
// only add allowed forms; never grow a list of rejected forms.

import { lexStep, type QuoteState, trimTrailingBlanks } from "./shell-lex.ts";

/**
 * Heads whose arguments are never run or written by the command itself.
 * Listed explicitly, so a head is exempt only by a deliberate entry; a head
 * added here must have no option that executes or writes.
 *
 * Left out on purpose: `find` (`-exec` and friends, which `-ex$'e'c` or a
 * globbed file name can hide from the spelling), `less` / `more` (`+<cmd>` and
 * the `!` command invoke a shell; non-interactive behavior is unverified, so
 * excluded as a precaution), `ll` / `la` (not real binaries here, so their
 * options cannot be checked).
 */
export const ARGUMENT_SCAN_EXEMPT_HEADS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "locate",
  "cd",
  "file",
  "stat",
  "du",
  "wc",
]);

// Only directories the system owns: `./grep` or `/tmp/x/grep` may be a file the
// agent created.
const SYSTEM_BIN_DIRS = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

type ParsingMethod = "tree-sitter" | "fallback";

/**
 * `fullCommand` is the whole string handed to the Bash tool, not a fragment the
 * parser split off: the shell reads that text, so that is what must be judged.
 * Deny-side hooks pass the `maskedText` of `prepareDenyInput` (the whole text
 * with data-only heredoc bodies emptied). Emptying a body does not make an
 * input containing a heredoc exempt.
 * True only when it is a single simple command whose head is an exempt
 * read-only command and whose arguments contain no way to run anything.
 */
export function isExemptReadOnlyCommand(
  fullCommand: string,
  opts: { parsingMethod: ParsingMethod },
): boolean {
  try {
    if (opts.parsingMethod !== "tree-sitter") return false;
    return scanWholeCommand(fullCommand);
  } catch {
    return false;
  }
}

function scanWholeCommand(fullCommand: string): boolean {
  // Trailing blanks never change where a word ends. Leading ones are kept so a
  // leading space (or NBSP) fails the head check.
  const cmd = trimTrailingBlanks(fullCommand);
  if (cmd === "") return false;
  // Whitespace other than space/tab/newline and control characters are read by
  // the shell as word characters or dropped, so hook and shell can disagree on
  // where words end.
  if (/[^\S \t\n]/.test(cmd) || /[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) {
    return false;
  }
  if (!isExemptHead(rawHead(cmd))) return false;
  return scanArguments(cmd);
}

/** Raw spelling up to the first space or tab; quotes and backslashes stay in it so they fail the exact match. */
function rawHead(cmd: string): string {
  const end = cmd.search(/[ \t]/);
  return end === -1 ? cmd : cmd.slice(0, end);
}

function isExemptHead(head: string): boolean {
  if (ARGUMENT_SCAN_EXEMPT_HEADS.has(head)) return true;
  for (const dir of SYSTEM_BIN_DIRS) {
    if (head.startsWith(`${dir}/`)) {
      return ARGUMENT_SCAN_EXEMPT_HEADS.has(head.slice(dir.length + 1));
    }
  }
  return false;
}

/** One left-to-right pass; shell-lex says what each character is, this decides what to allow. */
function scanArguments(cmd: string): boolean {
  let state: QuoteState = "outside";
  let i = 0;
  while (i < cmd.length) {
    const step = lexStep(cmd, i, state);
    switch (step.kind) {
      case "reject":
        return false;
      case "quote":
        state = step.state;
        break;
      case "operator":
        // A redirect is plain text to a read-only head unless it opens a
        // process substitution; every other operator means more than one command.
        if (step.char !== "<" && step.char !== ">") return false;
        if (cmd[i + 1] === "(") return false;
        break;
      case "escape":
      // An escape (including backslash-newline, a line continuation inside
      // this one command) is literal text here.
      case "literal":
        break;
      default: {
        const unhandled: never = step;
        void unhandled;
        return false;
      }
    }
    i = step.next;
  }
  return state === "outside";
}
