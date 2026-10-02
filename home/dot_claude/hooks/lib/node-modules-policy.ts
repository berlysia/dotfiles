// lib/node-modules-policy.ts — pure, no I/O
import {
  DELETE_VERBS,
  FIND_EXEC_FLAGS,
  MOVE_VERBS,
} from "./destructive-verbs.ts";
import { READ_ONLY_VERBS, type ReadOnlyCategory } from "./read-only-command.ts";
import {
  createLineIndex,
  createRunEnds,
  createStartIndex,
  isWhitespace,
  onLine,
  type OracleMatcher,
  prefixThenOnLine,
  type TextMatcher,
} from "./linear-match.ts";
import { trimSpaces } from "./shell-lex.ts";

const NODE_MODULES = /node_modules/;

/**
 * One matcher per category, linearly equivalent to
 * `(?:^|\s)(<verbs>)\s+.*node_modules`. This is the allow side, so a matcher
 * wider than that regex would let a command through that was denied. Do not
 * add a regex of the form `X\s+.*Y` / `X.*Y` here; use prefixThenOnLine
 * (see Issue #219).
 */
export function buildReadOnlyPatterns(): ReadonlyArray<{
  readonly pattern: TextMatcher;
  readonly operation: ReadOnlyCategory;
}> {
  const byCategory = new Map<ReadOnlyCategory, string[]>();
  for (const { verb, category } of READ_ONLY_VERBS) {
    byCategory.set(category, [...(byCategory.get(category) ?? []), verb]);
  }
  return [...byCategory].map(([category, verbs]) => ({
    pattern: prefixThenOnLine(
      new RegExp(`(?:^|\\s)(${verbs.join("|")})\\s+`),
      NODE_MODULES,
    ),
    operation: category,
  }));
}

/**
 * Linear equivalent of `(?:^|\s)cp\s+.*\s+.*node_modules`, where the second
 * blank run is the first thing after `cp\s+` that the pattern can use.
 * For a `cp` at the start of the text or after a blank, let [q, r) be the
 * blank run after it (the first `\s+`), then the pattern matches when
 * node_modules starts on a line at or after:
 * - r, if the run has two or more blanks (the second `\s+` ends at r);
 * - the end of the first later blank run on the line of r (`.*` then `\s+`);
 * - the end of the blank run that starts at the line terminator ending the
 *   line of r (a terminator is a blank, and the run may continue on the next
 *   line).
 * Later blank runs on the same line only shrink what is left to search, so
 * the first one is the best. The oracle is test-only (the super-linear
 * original); see linear-match.ts.
 */
export function cpThenNodeModules(): OracleMatcher {
  return {
    oracle: /(?:^|\s)cp\s+.*\s+.*node_modules/,
    test(text) {
      let at = text.indexOf("cp");
      if (at === -1) return false;
      const lines = createLineIndex(text);
      const modules = createStartIndex(text, NODE_MODULES);
      const blanks = createStartIndex(text, /\s/);
      const runEnds = createRunEnds(text);
      for (; at !== -1; at = text.indexOf("cp", at + 1)) {
        if (at > 0 && !isWhitespace(text[at - 1])) continue;
        const q = at + 2;
        if (!isWhitespace(text[q])) continue;
        const r = runEnds[q] as number;
        if (r - q >= 2 && onLine(lines, modules, r)) return true;
        const lineEnd = lines.lineEnd(r);
        const laterBlank = blanks.firstAtOrAfter(r);
        if (
          laterBlank <= lineEnd &&
          onLine(lines, modules, runEnds[laterBlank] as number)
        ) {
          return true;
        }
        if (
          lineEnd < text.length &&
          onLine(lines, modules, runEnds[lineEnd] as number)
        ) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Linear equivalent of `>+\s*[^\s]*node_modules`: node_modules starts in a
 * non-blank token that either contains a `>` before it, or follows (after a
 * blank run) a `>` that ends the previous token. One left-to-right pass.
 * The oracle is test-only (the super-linear original); see linear-match.ts.
 */
export function redirectToNodeModules(): OracleMatcher {
  return {
    oracle: />+\s*[^\s]*node_modules/,
    test(text) {
      let tokenStart = 0;
      let lastGreaterThan = -1;
      let greaterThanBeforeRun = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (isWhitespace(c)) {
          if (!isWhitespace(text[i - 1])) {
            greaterThanBeforeRun = i > 0 && text[i - 1] === ">";
          }
          tokenStart = i + 1;
        } else if (c === ">") {
          lastGreaterThan = i;
        } else if (c === "n" && text.startsWith("node_modules", i)) {
          if (
            lastGreaterThan >= tokenStart ||
            (tokenStart > 0 && greaterThanBeforeRun)
          ) {
            return true;
          }
        }
      }
      return false;
    },
  };
}

const BEFORE = "(?:^|[\\s'\"`(;|&{!\\\\/<>])";
const AFTER = "(?=$|[\\s'\"`);|&<>])";
const DELETE_WORD = new RegExp(
  `${BEFORE}(?:${[...DELETE_VERBS].join("|")})${AFTER}`,
);
// Spec K2 lists newline / $( / backtick / <( / >(; ; & | ( ) { } are added so that a compound
// command the parser failed to split never gets the read-only head exemption.
const NOT_SIMPLE = /\n|\$\(|`|<\(|>\(|[;&|(){}]/;

/**
 * Whether the hook may apply its read-only allow patterns to this individual command.
 * In fallback parsing the "individual command" may still be a compound fragment
 * (`ls x; python3 -c '…rmtree…'`), so a read-only verb anywhere in it proves nothing.
 */
export function mayAllowAsReadOnly(
  cmd: string,
  opts: { fallback: boolean },
): boolean {
  return !(opts.fallback && NOT_SIMPLE.test(cmd.toLowerCase()));
}

/** Drops every quote and backslash so `-ex''ec`, `"-exec"` and `\rm` compare as the bare word, then takes the basename. */
function baseName(word: string): string {
  const bare = word.replace(/['"\\]/g, "");
  return bare.slice(bare.lastIndexOf("/") + 1);
}

/** For the words after `find`: does it delete (-delete) or run a delete/move verb anywhere after an exec flag? */
function findIsDestructive(findArgs: string[]): boolean {
  if (findArgs.includes("-delete")) return true;
  const execAt = findArgs.findIndex((w) => FIND_EXEC_FLAGS.has(w));
  if (execAt === -1) return false;
  return findArgs
    .slice(execAt + 1)
    .some((w) => DELETE_VERBS.has(w) || MOVE_VERBS.has(w));
}

/**
 * `cmd` is one fragment the parser produced. `opts.readOnlyExempt` is a
 * property of the whole Bash command (see isExemptReadOnlyCommand), not of
 * `cmd`: when true, deletion words in the arguments do not count.
 */
export function classifyDeletion(
  cmd: string,
  opts: { readOnlyExempt: boolean },
): "deny-delete" | "deny-find" | "ask-find" | null {
  const lower = cmd.toLowerCase();
  if (!lower.includes("node_modules")) return null;
  // Split on shell punctuation as well as whitespace so `$(find`, `-delete;` and `'true;mv` yield bare words.
  const words = lower
    .split(/[\s;&|(){}`$<>]+/)
    .filter(Boolean)
    .map(baseName);
  // find may sit behind a wrapper or assignment (`sudo find …`, `foo=1 find …`), so look for it anywhere.
  const findAt = words.indexOf("find");
  const findArgs = findAt === -1 ? [] : words.slice(findAt + 1);
  const findWithExec = findArgs.some(
    (w) => w === "-delete" || FIND_EXEC_FLAGS.has(w),
  );
  if (findWithExec && findIsDestructive(findArgs)) return "deny-find";
  if (DELETE_WORD.test(lower) && !opts.readOnlyExempt) return "deny-delete";
  return findWithExec ? "ask-find" : null;
}

const ALLOWED_COMMAND = /^[A-Za-z0-9_\/.@+=:,\- ]+$/;

/** K3 conditions 1-3. Returns the operands only when the hook and the shell cannot read the command differently. */
export function standaloneSymlinkRemovalOperands(
  command: string,
): string[] | null {
  // Trim ASCII spaces only: String#trim also strips Unicode spaces the shell keeps as part of a filename.
  const trimmed = trimSpaces(command);
  if (!ALLOWED_COMMAND.test(trimmed)) return null;
  const [verb, ...rest] = trimmed.split(/ +/);
  let i = 0;
  if (verb === "rm") {
    while (rest[i] === "-f") i++;
  } else if (verb !== "unlink") {
    return null;
  }
  const operands = rest.slice(i);
  if (operands.length === 0 || operands.some((w) => w.startsWith("-")))
    return null;
  if (verb === "unlink" && operands.length !== 1) return null;
  return operands.every(isNodeModulesLinkPath) ? operands : null;
}

function isNodeModulesLinkPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return (
    segments.filter((s) => s === "node_modules").length === 1 &&
    segments.at(-1) === "node_modules"
  );
}
