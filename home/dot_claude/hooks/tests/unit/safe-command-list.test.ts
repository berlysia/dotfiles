#!/usr/bin/env node --test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { scanSafeList } from "../../lib/safe-command-list.ts";
import { trimTrailingBlanks } from "../../lib/shell-lex.ts";

// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter is loaded dynamically, as in bash-parser.ts
let parser: any = null;
async function treeSitterHeads(
  cmd: string,
): Promise<{ hasError: boolean; heads: string[] }> {
  if (parser === null) {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import
    const mod: any = await import("web-tree-sitter");
    const Parser = mod.Parser || mod;
    if (typeof Parser.init === "function") await Parser.init();
    const wasm = createRequire(import.meta.url).resolve(
      "tree-sitter-bash/tree-sitter-bash.wasm",
    );
    const Language = mod.Language || Parser.Language;
    parser = new Parser();
    parser.setLanguage(await Language.load(wasm));
  }
  const tree = parser.parse(cmd);
  try {
    const heads = tree.rootNode
      .descendantsOfType("command")
      // biome-ignore lint/suspicious/noExplicitAny: tree-sitter node
      .map((n: any) => n.childForFieldName("name")?.text ?? "");
    return { hasError: tree.rootNode.hasError, heads };
  } finally {
    tree.delete();
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Property (1): everything between and around the S_i is blanks and at most one separator. */
function coversWholeText(w: string, list: string[]): boolean {
  const gap = /^[ \t\n]*(?:(?:&&|\|\||;|\|)[ \t\n]*)?$/;
  let at = 0;
  for (const [index, s] of list.entries()) {
    const found = w.indexOf(s, at);
    if (found === -1) return false;
    const between = w.slice(at, found);
    if (index === 0 ? !/^[ \t\n]*$/.test(between) : !gap.test(between)) {
      return false;
    }
    at = found + s.length;
  }
  return /^[ \t\n]*$/.test(w.slice(at));
}

const SPLITS: Array<[string, string[]]> = [
  ["ls -la", ["ls -la"]],
  ["cd x && pnpm test", ["cd x", "pnpm test"]],
  ["grep -rn foo src | head -20", ["grep -rn foo src", "head -20"]],
  ["git log --oneline -5 2>/dev/null", ["git log --oneline -5 2>/dev/null"]],
  ["pnpm test 2>&1 | tail -20", ["pnpm test 2>&1", "tail -20"]],
  ["ls >/dev/null 2>&1", ["ls >/dev/null 2>&1"]],
  ["ls </dev/null", ["ls </dev/null"]],
  ["ls\npwd", ["ls", "pwd"]],
  ["ls &&\npwd", ["ls", "pwd"]],
  ["ls && \npwd", ["ls", "pwd"]],
  ["ls;\npwd", ["ls", "pwd"]],
  ["ls |\nhead", ["ls", "head"]],
  ["ls\n\npwd", ["ls", "pwd"]],
  ["ls\n  \npwd", ["ls", "pwd"]],
  ["\nls", ["ls"]],
  ["ls || pwd; git status", ["ls", "pwd", "git status"]],
  ["ls \\; zz", ["ls \\; zz"]],
  ["ls \\\\; zz a", ["ls \\\\", "zz a"]],
  ["grep a#b f", ["grep a#b f"]],
  ["grep '# x;y' f", ["grep '# x;y' f"]],
  ['echo "$HOME/x"', ['echo "$HOME/x"']],
  ["echo $HOME", ["echo $HOME"]],
  ['git commit -m "a\nb"', ['git commit -m "a\nb"']],
  ["cd $X && ls", ["cd $X", "ls"]],
  ["sleep 5", ["sleep 5"]],
];

const NULLS: Array<[string, string]> = [
  ["empty", ""],
  ["blanks only", " \t\n"],
  ["command substitution", "git push --force origin main $(pwd)"],
  ["time head", "time ls\nzz a"],
  ["heredoc", "git push --force origin main <<EOF\nhi\nEOF\nls yy"],
  ["substitution inside", "zz $(echo hi)"],
  ["nested backticks", "echo `ls \\`zz a\\` pwd`"],
  ["backtick in dq", 'echo "`zz`"'],
  ["comment sq", "ls # '\nzz a\n#'"],
  ["comment dq", 'ls # "\nzz a\n#"'],
  ["comment then echo quote", "ls # '\nzz a\necho '"],
  ["trailing comment", "ls # note"],
  ["backslash newline", "ls \\\nzz"],
  ["trailing backslash", "ls \\"],
  ["herestring", "cat <<<'x'"],
  ["process substitution", "cat <(ls)"],
  ["output process substitution", "tee >(ls)"],
  ["subshell", "ls; (cd x && ls)"],
  ["brace group", "{ ls; }"],
  ["background", "ls &"],
  ["pipe and", "ls |& cat"],
  ["redirect to file", "ls > out.txt"],
  ["append", "ls >> out.txt"],
  ["both redirect", "ls &> /dev/null"],
  ["spaced devnull", "ls > /dev/null"],
  ["redirect glued after", "ls 2>&1x"],
  ["redirect glued before", "ls a2>&1"],
  ["fd 12", "ls 12>&1"],
  ["empty after semicolon", "ls ;"],
  ["double semicolon", "ls;;pwd"],
  ["leading pipe", "| head"],
  ["dangling and", "ls &&"],
  ["operator after newline", "ls\n&& pwd"],
  ["unclosed sq", "ls 'x"],
  ["unclosed dq", 'ls "x'],
  ["ansi-c quote", "ls $'x'"],
  ["arith", "echo $((1+2))"],
  ["param default", 'echo "${X:-y}"'],
  ["brace param outside dq", "echo ${X}"],
  ["NBSP", "ls x"],
  ["CR", "ls\rzz"],
  ["NUL", "ls\u0000"],
  ["dollar head", "$X a"],
  ["relative head", "./x.sh"],
  ["absolute head", "/usr/bin/ls"],
  ["quoted head", "'ls' x"],
  ["assignment prefix", "FOO=1 pnpm test"],
  ["bang head", "! ls"],
  ["colon head", ": x"],
  ["for loop", "for f in a; do ls; done"],
  ["done alone", "done"],
  ["timeout", "timeout 15 pnpm test"],
  ["bash -c", "bash -c 'ls'"],
  ["xargs", "ls | xargs zz"],
  ["find", "find . -name x"],
  ["env", "env zz a"],
  ["sudo", "sudo ls"],
  ["export", "export FOO=bar && pnpm test"],
  ["unset", "unset FOO; ls"],
  ["declare", "declare -x A=1; ls"],
  ["heredoc commit", "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\""],
];

describe("scanSafeList", () => {
  for (const [input, expected] of SPLITS) {
    it(`splits ${JSON.stringify(input)}`, () => {
      deepStrictEqual(scanSafeList(input), expected);
    });
  }

  for (const [name, input] of NULLS) {
    it(`null: ${name}`, () => {
      strictEqual(scanSafeList(input), null);
    });
  }

  it("returns null and logs only length and error kind when the scan throws", (t) => {
    const errorLog = t.mock.method(console, "error", () => {});
    // A non-string input reaches the catch path; the double cast only hides it from the type checker.
    strictEqual(scanSafeList(123 as unknown as string), null);
    strictEqual(errorLog.mock.callCount(), 1);
    ok(!String(errorLog.mock.calls[0]?.arguments[0]).includes("123"));
  });

  it("never throws and keeps property (1) on generated inputs", (t) => {
    // The catch in scanSafeList would hide a throw as null, so count its log.
    const errorLog = t.mock.method(console, "error", () => {});
    const tokens = [
      "ls",
      "git",
      "status",
      "a",
      "x#y",
      "#",
      "'",
      '"',
      "\\",
      ";",
      "&&",
      "||",
      "|",
      "&",
      "\n",
      " ",
      "\t",
      "2>&1",
      ">/dev/null",
      "$HOME",
      "$(",
      ")",
      "`",
      " ",
      "\u0000",
    ];
    const random = mulberry32(20261002);
    for (let n = 0; n < 3000; n++) {
      let input = "";
      const length = 1 + Math.floor(random() * 10);
      for (let k = 0; k < length; k++) {
        input += tokens[Math.floor(random() * tokens.length)];
      }
      const list = scanSafeList(input);
      if (list !== null) {
        ok(
          coversWholeText(trimTrailingBlanks(input), list),
          JSON.stringify(input),
        );
      }
    }
    strictEqual(errorLog.mock.callCount(), 0);
  });

  it("agrees with tree-sitter on command count and heads (property 2)", async () => {
    const tokens = [
      "ls",
      "git status",
      "pwd",
      "a",
      "x#y",
      " #c",
      "'q;r'",
      '"s|t"',
      "\\;",
      ";",
      " && ",
      " || ",
      " | ",
      "\n",
      " ",
      " 2>&1",
      " >/dev/null",
      " $HOME",
    ];
    const random = mulberry32(1002);
    let checked = 0;
    for (let n = 0; n < 1500; n++) {
      let input = "";
      const length = 1 + Math.floor(random() * 8);
      for (let k = 0; k < length; k++) {
        input += tokens[Math.floor(random() * tokens.length)];
      }
      const list = scanSafeList(input);
      if (list === null) continue;
      const { hasError, heads } = await treeSitterHeads(input);
      strictEqual(hasError, false, JSON.stringify(input));
      deepStrictEqual(
        heads,
        list.map((s) => s.split(/[ \t]/)[0]),
        JSON.stringify(input),
      );
      checked++;
    }
    // Round 1 measured 120 split inputs for this seed and token table.
    ok(checked > 50, `only ${checked} generated inputs were split`);
  });

  it("scans 100,000 characters in linear time", () => {
    const start = performance.now();
    deepStrictEqual(scanSafeList(`ls ${"a".repeat(100000)}`)?.length, 1);
    deepStrictEqual(scanSafeList(`ls${" ".repeat(100000)}b`)?.length, 1);
    deepStrictEqual(scanSafeList(`ls ;${" ;".repeat(50000)}`), null);
    ok(performance.now() - start < 1000);
  });
});
