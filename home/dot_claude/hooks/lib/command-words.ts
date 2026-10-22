// lib/command-words.ts
//
// Cheap, quote-aware decomposition of a Bash command into the first words of
// each simple command. lib/command-parsing.ts and lib/bash-parser.ts are not
// used: they serve permission decisions (no function there returns just the
// leading two words) and the tree-sitter parser is too heavy to start on every
// Bash call. No expansion is attempted, so `bash -c "…"`, `$(…)` and subshell
// bodies are deliberately not looked into.

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_SIMPLE_COMMANDS = 64;
const WRAPPER_COMMANDS = new Set(["env", "command", "sudo"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits at unquoted `&&` `||` `;` `|` `&` and newlines, then each part into
 * words with quotes removed. Quote-aware so that `echo "a; git commit"` is one
 * part; no expansion is attempted.
 */
export function splitCommand(command: string): string[][] {
  const parts: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endPart = () => {
    endWord();
    if (words.length > 0) parts.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        word += command[++i];
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      endPart();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endPart();
  return parts;
}

/** Index of the git subcommand in `words` (words[0] is `git`), skipping `-C x`, `-c k=v` and other global flags. */
function gitSubcommandIndex(words: readonly string[]): number {
  let i = 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === "-C" || w === "-c") i += 2;
    else if (w.startsWith("-")) i += 1;
    else return i;
  }
  return -1;
}

export function gitSubcommand(words: readonly string[]): string | undefined {
  if (words[0] !== "git") return undefined;
  const at = gitSubcommandIndex(words);
  return at < 0 ? undefined : words[at];
}

/**
 * The first two words of each simple command, after leading `VAR=value`
 * assignments and `env` / `command` / `sudo` wrappers, and (for git) after
 * global options. Words are not lower-cased: the `cmd:` grammar is lower-case,
 * so `Git` must not match. Oversized input yields nothing rather than a
 * partial answer.
 */
export function leadingWords(command: string): string[][] {
  if (command.length === 0 || Buffer.byteLength(command) > MAX_COMMAND_BYTES)
    return [];
  const result: string[][] = [];
  for (const parts of splitCommand(command).slice(0, MAX_SIMPLE_COMMANDS)) {
    let start = 0;
    while (start < parts.length) {
      const w = parts[start] as string;
      if (ASSIGNMENT.test(w) || WRAPPER_COMMANDS.has(w)) start += 1;
      else break;
    }
    const words = parts.slice(start);
    if (words.length === 0) continue;
    if (words[0] === "git") {
      const at = gitSubcommandIndex(words);
      result.push(at < 0 ? ["git"] : ["git", words[at] as string]);
    } else {
      result.push(words.slice(0, 2));
    }
  }
  return result;
}
