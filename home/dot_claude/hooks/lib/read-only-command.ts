// lib/read-only-command.ts — pure, no I/O, no imports
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

type ReadOnlyCategory = "list" | "read" | "search" | "navigate" | "info";

export type { ReadOnlyCategory };

export const READ_ONLY_VERBS: ReadonlyArray<{
  verb: string;
  category: ReadOnlyCategory;
}> = [
  { verb: "ls", category: "list" },
  { verb: "ll", category: "list" },
  { verb: "la", category: "list" },
  { verb: "cat", category: "read" },
  { verb: "head", category: "read" },
  { verb: "tail", category: "read" },
  { verb: "less", category: "read" },
  { verb: "more", category: "read" },
  { verb: "grep", category: "search" },
  { verb: "find", category: "search" },
  { verb: "locate", category: "search" },
  { verb: "cd", category: "navigate" },
  { verb: "file", category: "info" },
  { verb: "stat", category: "info" },
  { verb: "du", category: "info" },
  { verb: "wc", category: "info" },
];

/**
 * Heads whose arguments are never run or written by the command itself.
 * Listed explicitly (not derived from READ_ONLY_VERBS) so that adding a verb to
 * the table does not silently exempt it; a verb added here must have no option
 * that executes or writes.
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
  const cmd = fullCommand.replace(/[ \t\n]+$/, "");
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

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const BRACED_NAME = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
const UNQUOTED_REJECTED = /[\n`;&|(){}]/;

/**
 * Returns the index after a `$` that is followed by an allowed form, or -1.
 * Anything not listed (`$(`, `$((`, `$[`, `${(`, `${X:-y}`, `$'`, ...) is -1.
 */
function skipDollar(cmd: string, at: number, inDouble: boolean): number {
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

type QuoteState = "outside" | "single" | "double";

/** One left-to-right pass; the state tells which characters are literal. */
function scanArguments(cmd: string): boolean {
  let state: QuoteState = "outside";
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i] as string;
    if (state === "single") {
      if (c === "'") state = "outside";
      i++;
    } else if (state === "double") {
      if (c === "`") return false;
      if (c === '"') {
        state = "outside";
        i++;
      } else if (c === "\\") {
        const next = cmd[i + 1];
        i += next !== undefined && '$`"\\\n'.includes(next) ? 2 : 1;
      } else if (c === "$") {
        const end = skipDollar(cmd, i, true);
        if (end === -1) return false;
        i = end;
      } else {
        i++;
      }
    } else {
      if (c === "\\") {
        if (i + 1 >= cmd.length) return false;
        i += 2;
      } else if (c === "'") {
        state = "single";
        i++;
      } else if (c === '"') {
        state = "double";
        i++;
      } else if (UNQUOTED_REJECTED.test(c)) {
        return false;
      } else if (c === "<" || c === ">") {
        if (cmd[i + 1] === "(") return false;
        i++;
      } else if (c === "$") {
        const end = skipDollar(cmd, i, false);
        if (end === -1) return false;
        i = end;
      } else {
        i++;
      }
    }
  }
  return state === "outside";
}
