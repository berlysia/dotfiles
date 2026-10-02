// lib/heredoc-data.ts — which heredoc bodies the deny side may read as data
//
// A heredoc body is data when cat or tee only copies it to a plain file or the
// terminal (spec K2). Anything this module cannot prove is kept, so the deny
// side still reads it. The allow side never uses this module.
//
// The parser is trusted for structure and the body's range only. Every token
// next to the heredoc (the gap after the command, the operator, the
// delimiters, the targets) is compared by spelling against an allowlist: each
// hole found in review was a place where tree-sitter and the shell read those
// tokens differently. Heredocs inside $(…) are never data: bash 3.2 cuts $(…)
// by paren matching before it reads the heredoc.
//
// isPlainWriteTarget, readCommandGap and readHeredocOperator are exported for
// the table tests only; other modules reach this file through prepareDenyInput.

import type { Node as TsNode } from "web-tree-sitter";
import { type ParseForCollect, parseForCollect } from "./bash-parser.ts";

// Every entry carries the reason it has no path that runs its input or
// arguments as code, with the version that was checked. Adding one also adds
// it to the ADR-0020 addendum (spec K2). If false positives on plain arguments
// (not heredoc bodies) are observed, revisit the word-role model in spec
// "Alternative Approaches" instead of growing these lists.

interface DataConsumer {
  name: string;
  reason: string;
}

/** Commands that copy a heredoc body as data. */
export const HEREDOC_DATA_CONSUMERS: ReadonlyArray<DataConsumer> = [
  {
    name: "cat",
    reason:
      "Reads its operands as files and writes them out; no option runs code.",
  },
  {
    name: "tee",
    reason:
      "Writes stdin to its file operands and stdout; no option runs code.",
  },
];

// (f) Only the current shell can swap cat / tee's shell state within one
// input: an external command's process cannot change the shell's functions,
// aliases, options, traps, hash table or variables. The shell does so through
// builtins, assignments, expansions (even in an external command's arguments),
// arithmetic, loop variables and redirects. Listing those kept missing some
// (builtin eval, trap DEBUG, emulate -c, ${functions[cat]=sh},
// [[ 1 -eq PATH=0 ]], for PATH in .; Rounds 7-11 security), so the checks
// below accept closed sets instead. Only the consumer's top-level statement
// and the ones before it are checked: a later statement runs after the
// consumer has started, and a follower on the consumer's own line makes
// tree-sitter report an error, which keeps every body.
//
// Taken from `compgen -b` and `compgen -k` of bash 3.2.57, the bash 4+
// additions (coproc, mapfile, readarray, compopt), and `${(k)builtins}` and
// `${(k)reswords}` of zsh 5.9 with every bundled module loaded. tree-sitter
// parses the bash reserved words as syntax, not as command_name, so they never
// match here; the zsh-only ones (foreach, repeat, end, …) do appear as
// command_name and keep the body.
const SHELL_WORDS = new Set([
  "!",
  ".",
  ":",
  "[",
  "[[",
  "]]",
  "{",
  "}",
  "alias",
  "autoload",
  "bg",
  "bind",
  "bindkey",
  "break",
  "builtin",
  "bye",
  "caller",
  "cap",
  "case",
  "cd",
  "chdir",
  "chgrp",
  "chmod",
  "chown",
  "clone",
  "command",
  "compadd",
  "comparguments",
  "compcall",
  "compctl",
  "compdescribe",
  "compfiles",
  "compgen",
  "compgroups",
  "complete",
  "compopt",
  "compquote",
  "compset",
  "comptags",
  "comptry",
  "compvalues",
  "continue",
  "coproc",
  "declare",
  "dirs",
  "disable",
  "disown",
  "do",
  "done",
  "echo",
  "echotc",
  "echoti",
  "elif",
  "else",
  "emulate",
  "enable",
  "end",
  "esac",
  "eval",
  "example",
  "exec",
  "exit",
  "export",
  "false",
  "fc",
  "fg",
  "fi",
  "float",
  "for",
  "foreach",
  "function",
  "functions",
  "getcap",
  "getln",
  "getopts",
  "hash",
  "help",
  "history",
  "if",
  "in",
  "integer",
  "jobs",
  "kill",
  "let",
  "limit",
  "ln",
  "local",
  "log",
  "logout",
  "mapfile",
  "mkdir",
  "mv",
  "nocorrect",
  "noglob",
  "pcre_compile",
  "pcre_match",
  "pcre_study",
  "popd",
  "print",
  "printf",
  "private",
  "pushd",
  "pushln",
  "pwd",
  "r",
  "read",
  "readarray",
  "readonly",
  "rehash",
  "repeat",
  "return",
  "rm",
  "rmdir",
  "sched",
  "select",
  "set",
  "setcap",
  "setopt",
  "shift",
  "shopt",
  "source",
  "stat",
  "strftime",
  "suspend",
  "sync",
  "syserror",
  "sysopen",
  "sysread",
  "sysseek",
  "syswrite",
  "test",
  "then",
  "time",
  "times",
  "trap",
  "true",
  "ttyctl",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unfunction",
  "unhash",
  "unlimit",
  "unset",
  "unsetopt",
  "until",
  "vared",
  "wait",
  "whence",
  "where",
  "which",
  "while",
  "zcompile",
  "zcurses",
  "zdelattr",
  "zf_chgrp",
  "zf_chmod",
  "zf_chown",
  "zf_ln",
  "zf_mkdir",
  "zf_mv",
  "zf_rm",
  "zf_rmdir",
  "zf_sync",
  "zformat",
  "zftp",
  "zgetattr",
  "zle",
  "zlistattr",
  "zmodload",
  "zparseopts",
  "zprof",
  "zpty",
  "zregexparse",
  "zselect",
  "zsetattr",
  "zsocket",
  "zstat",
  "zstyle",
  "zsystem",
  "ztcp",
]);
// Builtins that change nothing cat / tee's lookup depends on: no function,
// alias, option, trap, hash entry, fd or variable. The file commands are
// builtins only when zsh/files is loaded and then act like the external ones.
// `test` and `[` are left out: bash 4.3+ evaluates the subscript of
// `test -v 'a[…]'` as arithmetic (Round 11 scope; not run here). `ln`, `mv`
// and `chmod` are left out too: they can put an executable named cat on PATH
// right before the consumer (`ln -s /bin/sh ~/.local/bin/cat`, bash 3.2,
// Round 12 security). An external command can still write one (`cp`); that
// is accepted as spec R1.
const INERT_SHELL_WORDS = new Set([
  ":",
  "cd",
  "chdir",
  "echo",
  "false",
  "pwd",
  "true",
  "chgrp",
  "chown",
  "mkdir",
  "rm",
  "rmdir",
  "sync",
]);
// A command name the shell runs as written. `$f`, `$(echo eval)`, quotes and
// escapes can turn into a builtin at run time, so they keep every body.
const LITERAL_COMMAND_NAME = /^[A-Za-z0-9_./:-]+$/;
// The only node types an input may contain. Listing the kinds the shell
// evaluates kept missing some: expansions in an external command's arguments
// (zsh `true ${functions[cat]=sh}`, Round 9), arithmetic in `[[ ]]` and
// subscripts (`a[PATH=0]=1`, Round 10), a for variable and zsh's named fd
// (`for PATH in .`, `: {PATH}>/dev/null`, Round 11). So the input is accepted
// only when it is built from plain commands with literal words: any other
// node type (assignment, expansion, test, loop, if, subshell, pipeline,
// function, …) keeps every body.
const ACCEPTED_NODE_TYPES = new Set([
  "program",
  "list",
  "command",
  "command_name",
  "word",
  "raw_string",
  "string",
  "string_content",
  "concatenation",
  "number",
  "comment",
  "redirected_statement",
  "heredoc_redirect",
  "heredoc_start",
  "heredoc_body",
  "heredoc_end",
  "file_redirect",
]);
// zsh and bash 4+ read `{name}>file` as "open a fd and store its number in
// name" (`: {PATH}>/dev/null`, Round 11); tree-sitter reports `{PATH}` as a
// word. Brace expansion `{a,b}` is rejected by the same check.
const BRACED_WORD = /[{}]/;

const HEREDOC_PARTS = new Set([
  "heredoc_start",
  "file_redirect",
  "heredoc_body",
  "heredoc_end",
]);
const PLAIN_TARGET = /^[A-Za-z0-9_./-]+$/;
const DEVICE_SEGMENTS = new Set(["dev", "proc", "fd", ".."]);
const EXPANDING = /[$`]/;

/** (g) A write target that names an ordinary file. */
export function isPlainWriteTarget(target: string): boolean {
  return (
    PLAIN_TARGET.test(target) &&
    // macOS resolves /DEV/fd to /dev/fd, so segments compare case-insensitively.
    !target
      .split("/")
      .some((segment) => DEVICE_SEGMENTS.has(segment.toLowerCase()))
  );
}

/** (f) The consumer of a redirected statement: the command or a list's rightmost one. */
function redirectedConsumerName(statement: TsNode): string | null {
  const body = statement.namedChildren[0] ?? null;
  return rightmostCommand(body)?.namedChildren[0]?.text ?? null;
}

function hasSwapping(root: TsNode): boolean {
  const pending: TsNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!ACCEPTED_NODE_TYPES.has(node.type)) return true;
    if (node.type === "word" && BRACED_WORD.test(node.text)) return true;
    if (node.type === "command_name") {
      if (!LITERAL_COMMAND_NAME.test(node.text)) return true;
      if (SHELL_WORDS.has(node.text) && !INERT_SHELL_WORDS.has(node.text))
        return true;
    }
    // Redirects run in the current shell for builtins; only a consumer's own
    // statement may carry them, and (b)(g) check those.
    if (node.type === "redirected_statement") {
      const name = redirectedConsumerName(node);
      if (!HEREDOC_DATA_CONSUMERS.some((consumer) => consumer.name === name))
        return true;
    }
    pending.push(...node.namedChildren);
  }
  return false;
}

function rightmostCommand(node: TsNode | null): TsNode | null {
  if (node === null) return null;
  if (node.type === "command") return node;
  if (node.type === "list")
    return rightmostCommand(node.namedChildren.at(-1) ?? null);
  return null;
}

/** An argument as the consumer checks see it: a node, or a dash read from the gap. */
interface Argument {
  type: string;
  text: string;
}

/**
 * (a) tree-sitter drops a lone "-" right before `<<` from the command's
 * children. Read the source between the command and the next redirect: only
 * blanks, or blanks around one "-", are understood; anything else is null so
 * a word the tree left out never slips past the checks.
 */
export function readCommandGap(gap: string): readonly Argument[] | null {
  if (/^[ \t]*$/.test(gap)) return [];
  if (/^[ \t]+-[ \t]+$/.test(gap)) return [{ type: "word", text: "-" }];
  return null;
}

/**
 * (a) tree-sitter also folds an option written right before the operator into
 * the `<<` token: `-e<<` is one anonymous child with the text "-e<<", so the
 * option is in neither the command nor the gap (Round 6 security ran a body
 * this way). Accept only the four spellings whose folded part is a lone "-",
 * and hand that "-" back as an argument.
 */
export function readHeredocOperator(
  operator: string,
): readonly Argument[] | null {
  if (operator === "<<" || operator === "<<-") return [];
  if (operator === "-<<" || operator === "-<<-")
    return [{ type: "word", text: "-" }];
  return null;
}

/** (a) cat / tee with plain word arguments; tee's file operands pass (g). */
function isCopyConsumer(name: string, args: readonly Argument[]): boolean {
  if (!HEREDOC_DATA_CONSUMERS.some((consumer) => consumer.name === name))
    return false;
  for (const arg of args) {
    if (arg.type !== "word" || EXPANDING.test(arg.text)) return false;
    if (
      name === "tee" &&
      !arg.text.startsWith("-") &&
      !isPlainWriteTarget(arg.text)
    ) {
      return false;
    }
  }
  return true;
}

/** (a) The command that receives the heredoc reads it only as data. */
function isConsumer(command: TsNode, gap: readonly Argument[]): boolean {
  const [name, ...nodes] = command.namedChildren;
  if (name?.type !== "command_name") return false;
  const args: Argument[] = [
    ...nodes.map(({ type, text }) => ({ type, text })),
    ...gap,
  ];
  return isCopyConsumer(name.text, args);
}

/** (g) `>` or `>>`, no fd number, one plain word target. */
function isPlainOutputRedirect(redirect: TsNode): boolean {
  // Compared by spelling, not node type, so a token that folded in a
  // neighbouring word (as `-e<<` does for heredocs) never passes.
  const operator = redirect.children.find((child) => !child.isNamed)?.text;
  const named = redirect.namedChildren;
  return (
    (operator === ">" || operator === ">>") &&
    named.length === 1 &&
    named[0]?.type === "word" &&
    isPlainWriteTarget(named[0].text)
  );
}

function onlyUnderLists(node: TsNode): boolean {
  let parent = node.parent;
  while (parent !== null) {
    if (parent.type === "program") return true;
    if (parent.type !== "list") return false;
    parent = parent.parent;
  }
  return false;
}

/** (d) Output goes to a plain file or the terminal, never into $(…). */
function isDataDestination(statement: TsNode): boolean {
  return onlyUnderLists(statement);
}

// (e) Delimiters the shell and tree-sitter close at the same line: a bare
// word, or one wholly in single or double quotes. Quotes inside the word
// (E""OF) make the shell close at EOF while tree-sitter waits for E""OF.
const DELIMITER = /^(?:'([A-Za-z0-9_]+)'|"([A-Za-z0-9_]+)"|([A-Za-z0-9_]+))$/;

/** (e) Both read the same end, and the shell neither expands nor joins the body. */
function isLiteralBody(start: TsNode, body: TsNode, end: TsNode): boolean {
  const match = DELIMITER.exec(start.text);
  if (match === null) return false;
  const word = match[1] ?? match[2] ?? match[3];
  if (end.text !== word) return false;
  const quoted = match[3] === undefined;
  return quoted || !/[$`\\]/.test(body.text);
}

function dataBody(heredoc: TsNode, source: string): TsNode | null {
  const parts = heredoc.namedChildren;
  if (parts.some((part) => !HEREDOC_PARTS.has(part.type))) return null; // (b)
  const start = parts.find((part) => part.type === "heredoc_start");
  const body = parts.find((part) => part.type === "heredoc_body");
  const end = parts.find((part) => part.type === "heredoc_end");
  const statement = heredoc.parent;
  if (!start || !body || !end || statement?.type !== "redirected_statement")
    return null;
  const statementBody = statement.childForFieldName("body");
  const consumer = rightmostCommand(statementBody); // (c)
  if (consumer === null || statementBody === null) return null;
  const nextRedirect = statement.namedChildren.find(
    (child) => child.startIndex >= statementBody.endIndex,
  );
  if (nextRedirect === undefined) return null;
  const gap = readCommandGap(
    source.slice(consumer.endIndex, nextRedirect.startIndex),
  );
  const operator = heredoc.children.find((child) => !child.isNamed);
  const folded =
    operator === undefined ? null : readHeredocOperator(operator.text);
  if (
    gap === null ||
    folded === null ||
    !isConsumer(consumer, [...gap, ...folded])
  )
    return null;
  const redirects = [
    ...statement.namedChildren.filter(
      (child) => child.type === "file_redirect",
    ),
    ...parts.filter((part) => part.type === "file_redirect"),
  ];
  if (!redirects.every(isPlainOutputRedirect)) return null;
  if (!isDataDestination(statement)) return null;
  return isLiteralBody(start, body, end) ? body : null;
}

/**
 * The command with the body of every heredoc that only feeds data emptied
 * (spec K1, K2). For deny-side checks only: never run, show, or allow on the
 * result, and never hand it to the LLM evaluator. Deny-side hooks get it
 * through prepareDenyInput (lib/deny-input.ts). When nothing is emptied the
 * input comes back unchanged, including on a parse failure.
 */
export async function maskDataHeredocBodies(
  command: string,
  parse: ParseForCollect = parseForCollect,
): Promise<string> {
  if (!command.includes("<<")) return command;
  let tree: Awaited<ReturnType<ParseForCollect>> = null;
  try {
    tree = await parse(command);
    if (tree === null || tree.rootNode.hasError) return command;
    const statements = tree.rootNode.namedChildren;
    const bodies: TsNode[] = [];
    for (const heredoc of tree.rootNode.descendantsOfType("heredoc_redirect")) {
      const body = dataBody(heredoc, command);
      if (body === null) continue;
      // (f) Only what runs before the consumer can swap it: a later statement,
      // even one started while the consumer runs in the background with `&`,
      // changes a shell the consumer's process has already left. So the
      // statements up to and including the consumer's are checked.
      const own = statements.find(
        (statement) => statement.endIndex >= heredoc.endIndex,
      );
      if (own === undefined) return command;
      if (
        statements.some(
          (statement) =>
            statement.startIndex <= own.startIndex && hasSwapping(statement),
        )
      ) {
        continue;
      }
      // Indices are UTF-16 offsets today; a mismatch means they no longer are.
      if (command.slice(body.startIndex, body.endIndex) !== body.text)
        return command;
      bodies.push(body);
    }
    let masked = command;
    for (const body of bodies.sort((a, b) => b.startIndex - a.startIndex)) {
      masked = masked.slice(0, body.startIndex) + masked.slice(body.endIndex);
    }
    return masked;
  } catch (error) {
    console.error(
      `[heredoc-data] maskDataHeredocBodies failed: ${error instanceof Error ? error.name : typeof error}`,
    );
    return command;
  } finally {
    tree?.delete();
  }
}
