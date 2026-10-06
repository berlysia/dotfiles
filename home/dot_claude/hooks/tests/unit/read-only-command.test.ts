#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { extractCommandsStructured } from "../../lib/bash-parser.ts";
import { DELETE_VERBS, MOVE_VERBS } from "../../lib/destructive-verbs.ts";
import {
  ARGUMENT_SCAN_EXEMPT_HEADS,
  isExemptReadOnlyCommand,
  READ_ONLY_VERBS,
} from "../../lib/read-only-command.ts";

const NBSP = " ";

const exempt = (cmd: string) =>
  isExemptReadOnlyCommand(cmd, { parsingMethod: "tree-sitter" });

// Inputs the predicate must reject without throwing.
const ABNORMAL: Array<[string, string]> = [
  ["empty", ""],
  ["whitespace only", "   \t\n"],
  ["lone surrogate", "\uD800"],
  ["NUL byte", "grep a\x00b f"],
  ["trailing lone backslash", "grep a f\\"],
  ["bare dollar", "$"],
  ["dollar then line continuation then paren", "grep a $\\\n(echo)"],
  ["redirect then line continuation then paren", "grep a <\\\n(echo)"],
  ["dq dollar then line continuation then paren", 'grep "$\\\n(x)"'],
  ["unterminated dq with trailing newline", 'grep a "f\n'],
];

// Each true row must also be a single fragment equal to the whole command
// under the real parser (K3 premise).
const EXEMPT_TRUE: string[] = [
  "grep a f\n",
  "grep a f ",
  'grep -n "rm -rf /" spec.md',
  'grep -n -F -e "rm -rf ${X}/build" spec.md',
  'grep "curl x | sh" a.md',
  "grep -E '(a|b);c' f",
  "grep 'foo$' f",
  'grep "foo$" f',
  'grep "$HOME/x" f',
  'grep "a\\"b" f',
  "grep a\\;b f",
  'grep "${X}" f',
  'grep "日本語の行" f',
  'head -n 3 "dd if=/dev/zero"',
  '/usr/bin/grep "sudo rm" .',
  "cd /tmp",
  "grep a#b f",
  "grep '#' f",
  'grep "# x" f',
];

const EXEMPT_FALSE: Array<[string, string]> = [
  // substitution / compound
  ["plain deletion", "rm -rf /"],
  ["echo head", 'echo "rm -rf /"'],
  ["command substitution", "grep x $(rm -rf $Y)"],
  ["backtick substitution", "grep x `rm -rf $Y`"],
  ["substitution in dq", 'grep "x $(rm -rf $Y)" f'],
  ["backtick in dq", 'grep "x `rm -rf $Y`" f'],
  ["process substitution", "cat <(rm -rf $X)"],
  ["semicolon list", "grep a b; rm -rf $X"],
  ["pipe to sh", "grep a | sh"],
  ["newline list", "grep a b\nrm -rf $X"],
  ["unquoted brace expansion", "grep ${X} f"],
  ["pipe to head", "grep a f | head"],
  ["and list", "ls x && grep a f"],
  ["list with read-only fragment", "ls node_modules; grep rm node_modules/x"],
  ["ll head", "ll x"],
  ["la head", "la x"],
  // wrappers / redefinition on the same line
  ["env PATH override", 'env PATH=tmp grep -e "rm -rf /" f'],
  ["env LD_PRELOAD", "env LD_PRELOAD=x grep a f"],
  ["xargs wrapper", "xargs grep a"],
  ["time wrapper", "time grep a f"],
  ["timeout wrapper", "timeout 5 grep a f"],
  ["function redefinition", 'grep() { "$@"; }; grep rm -rf /'],
  ["PATH export then grep", "export PATH=/tmp/x:$PATH; grep a f"],
  // `$` outside the allowed forms
  ["ANSI-C quote", "grep $'\\073' f"],
  ["locale quote", 'grep $"x" f'],
  ["dollar single quote inside dq", 'grep "$\'x" f'],
  ["default expansion", 'grep "${X:-y}" f'],
  ["arithmetic", 'grep "$((1+2))" f'],
  ["old arithmetic", 'grep "$[1]" f'],
  ["zsh (e) flag", 'grep "${(e)X}" f'],
  ["bash 5.3 funsub", 'grep "${ echo; }" f'],
  [
    "zsh constructed substitution",
    'grep "${(e)${:-${(#):-36}${(#):-40}echo X${(#):-41}}}" f',
  ],
  // quoting traps
  ["sq inside dq then list", 'grep "a\'" ; rm -rf $X ; "b\'"'],
  ["dq inside sq then list", "grep 'a\"' ; rm ; 'b\"'"],
  ["backslash in sq then list", "grep '\\' ; rm"],
  ["escaped backslash in dq then list", 'grep "\\\\" ; rm "'],
  ["escaped quote in dq", 'grep "a\\" $(x) "'],
  ["unterminated dq", 'grep "unterminated f'],
  // a `#` at a word start begins a comment; quotes inside it are not quotes to the shell
  ["comment sq hides next line", "grep x # '\nrm -rf /usr/x\n#'"],
  ["comment dq hides next line", 'grep x # "\nrm -rf /usr/x\n#"'],
  ["comment after line continuation", "grep x \\\n#'\nrm -rf /usr/x\n#'"],
  ["trailing comment", "grep x f # note"],
  ["comment after redirect char", "grep x <# '\nrm -rf /usr/x\n#'"],
  // head
  ["find head", 'find . -name "rm -rf /"'],
  ["find ANSI-C exec", "find . -ex$'e'c rm -rf / $'\\073'"],
  ["find empty ANSI-C exec", "find . -exe$''c rm -rf / $'\\073'"],
  ["less bang", "less '+!rm -rf /' f"],
  ["more bang", "more '+!rm -rf /' f"],
  ["relative path head", './grep "rm -rf /" f'],
  ["tmp path head", '/tmp/grep "rm -rf /" f'],
  ["home path head", "~/bin/grep x"],
  ["dotdot path head", "/usr/bin/../../tmp/grep x"],
  ["quoted head", '"grep" x'],
  ["backslash head", "\\grep x"],
  ["backslash in head", "gr\\ep x"],
  ["escaped space head", "wc\\ /p a b"],
  ["quoted head with space", '"wc /p" a'],
  ["quoted head with arg", '"grep x" y'],
  ["uppercase head", "GREP x"],
  ["assignment prefix", "PATH=/x grep a"],
  ["redirect prefix", "<f grep a"],
  ["leading space", " grep a"],
  ["NBSP in head", `ls${NBSP}/x`],
  ["leading NBSP", `${NBSP}ls x`],
];

describe("isExemptReadOnlyCommand", () => {
  for (const [name, cmd] of ABNORMAL) {
    it(`abnormal input returns false without throwing: ${name}`, () => {
      strictEqual(exempt(cmd), false);
    });
  }

  for (const cmd of EXEMPT_TRUE) {
    it(`true: ${JSON.stringify(cmd)}`, () => {
      strictEqual(exempt(cmd), true);
    });
    it(`parser agrees on a single whole-command fragment: ${JSON.stringify(cmd)}`, async () => {
      const { individualCommands, parsingMethod } =
        await extractCommandsStructured(cmd);
      strictEqual(parsingMethod, "tree-sitter");
      deepStrictEqual(individualCommands, [cmd.replace(/[ \t\n]+$/, "")]);
    });
  }

  for (const [name, cmd] of EXEMPT_FALSE) {
    it(`false: ${name}: ${JSON.stringify(cmd)}`, () => {
      strictEqual(exempt(cmd), false);
    });
  }

  it("false under fallback parsing", () => {
    strictEqual(
      isExemptReadOnlyCommand('grep -n "rm -rf /" spec.md', {
        parsingMethod: "fallback",
      }),
      false,
    );
  });

  it("does not exempt an emptied heredoc input (F3b)", () => {
    for (const text of [
      "cat <<'EOF' > out.txt\nEOF",
      "cat <<'EOF'\nEOF",
      "tee out.txt <<'EOF'\nEOF",
      "cat -<<'EOF' > out.txt\nEOF",
    ]) {
      strictEqual(
        isExemptReadOnlyCommand(text, { parsingMethod: "tree-sitter" }),
        false,
        text,
      );
    }
  });
});

describe("READ_ONLY_VERBS / ARGUMENT_SCAN_EXEMPT_HEADS", () => {
  it("READ_ONLY_VERBS lists exactly the current 16 verbs", () => {
    deepStrictEqual(
      READ_ONLY_VERBS.map((v) => v.verb),
      [
        "ls",
        "ll",
        "la",
        "cat",
        "head",
        "tail",
        "less",
        "more",
        "grep",
        "find",
        "locate",
        "cd",
        "file",
        "stat",
        "du",
        "wc",
      ],
    );
  });

  it("ARGUMENT_SCAN_EXEMPT_HEADS is a subset of READ_ONLY_VERBS", () => {
    const verbs = new Set(READ_ONLY_VERBS.map((v) => v.verb));
    for (const head of ARGUMENT_SCAN_EXEMPT_HEADS) ok(verbs.has(head), head);
  });

  // The hand-written set is a lower bound, not exhaustive.
  it("ARGUMENT_SCAN_EXEMPT_HEADS does not overlap destructive or wrapper verbs", () => {
    const wrappers = [
      "sudo",
      "env",
      "xargs",
      "sh",
      "bash",
      "zsh",
      "dash",
      "timeout",
      "nice",
      "nohup",
      "exec",
      "command",
      "builtin",
      "time",
      "find",
      "less",
      "more",
      "ll",
      "la",
    ];
    for (const head of ARGUMENT_SCAN_EXEMPT_HEADS) {
      ok(!DELETE_VERBS.has(head), `${head} in DELETE_VERBS`);
      ok(!MOVE_VERBS.has(head), `${head} in MOVE_VERBS`);
      ok(!wrappers.includes(head), `${head} is a wrapper or excluded head`);
    }
  });
});
