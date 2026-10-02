#!/usr/bin/env node --test
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type { Tree } from "web-tree-sitter";
import { parseForCollect } from "../../lib/bash-parser.ts";
import {
  HEREDOC_DATA_CONSUMERS,
  isPlainWriteTarget,
  maskDataHeredocBodies,
  readCommandGap,
  readHeredocOperator,
} from "../../lib/heredoc-data.ts";

const R = "r" + "m -rf";
const P = "node" + "_modules";
const BODY = `${R} ${P}/x\n`;

// [label, input, expected output]. Each row names the K2 condition it pins.
const masked: Array<[string, string, string]> = [
  [
    "A: cat > file",
    `cat <<'EOF' > out.txt\n${BODY}EOF`,
    "cat <<'EOF' > out.txt\nEOF",
  ],
  [
    "A: redirect before heredoc",
    `cat > out.txt <<'EOF'\n${BODY}EOF`,
    "cat > out.txt <<'EOF'\nEOF",
  ],
  [
    "A: append to an absolute path",
    `cat <<'EOF' >> /Users/x/out.txt\n${BODY}EOF`,
    "cat <<'EOF' >> /Users/x/out.txt\nEOF",
  ],
  ["A: terminal", `cat <<'EOF'\n${BODY}EOF`, "cat <<'EOF'\nEOF"],
  [
    "A: tee file",
    `tee out.txt <<'EOF'\n${BODY}EOF`,
    "tee out.txt <<'EOF'\nEOF",
  ],
  [
    "A: tee -a file",
    `tee -a out.txt <<'EOF'\n${BODY}EOF`,
    "tee -a out.txt <<'EOF'\nEOF",
  ],
  // The body of a quoted delimiter has no expansion nodes, so (f) never sees
  // `$` there: the main false positive, `rm -rf $HOME/x` in the body.
  [
    "(f): expansions inside a quoted body",
    `cat <<'EOF' > out.txt\n${R} $HOME/x $(date) \`w\`\nEOF`,
    "cat <<'EOF' > out.txt\nEOF",
  ],
  [
    "(f): inert and external commands around cat",
    `mkdir -p d; git add x; cat <<'EOF' > d/f\n${BODY}EOF\nbun d/f`,
    "mkdir -p d; git add x; cat <<'EOF' > d/f\nEOF\nbun d/f",
  ],
  // Statements after the consumer are not checked.
  [
    "(f): a rejected node after the consumer",
    `cat <<'EOF' > f\n${BODY}EOF\necho $HOME | head`,
    "cat <<'EOF' > f\nEOF\necho $HOME | head",
  ],
  [
    "(f): a later heredoc is judged at its own place",
    `cat <<'A' > a\n${BODY}A\nbash <<'B'\n${BODY}B`,
    `cat <<'A' > a\nA\nbash <<'B'\n${BODY}B`,
  ],
  [
    "(c): list, heredoc on the rightmost cat",
    `mkdir -p d && cat <<'EOF' > d/f\n${BODY}EOF`,
    "mkdir -p d && cat <<'EOF' > d/f\nEOF",
  ],
  [
    "(e): double-quoted delimiter",
    `cat <<"EOF" > out.txt\n${BODY}EOF`,
    `cat <<"EOF" > out.txt\nEOF`,
  ],
  [
    "(e): unquoted, body without $ ` \\",
    `cat <<EOF > out.txt\n${BODY}EOF`,
    "cat <<EOF > out.txt\nEOF",
  ],
  // The tab before the closing EOF stays outside heredoc_body (probed); the
  // shell strips it under <<-, so the emptied heredoc still closes.
  [
    "(e): unquoted <<- with a body without $ ` \\",
    `cat <<-EOF > out.txt\n\t${BODY}\tEOF`,
    "cat <<-EOF > out.txt\n\tEOF",
  ],
  [
    "(e): <<- with a tab-indented end",
    `cat <<-'EOF' > out.txt\n\t${BODY}\tEOF`,
    "cat <<-'EOF' > out.txt\n\tEOF",
  ],
  // tree-sitter drops a lone "-" right before <<; the gap check reads it back.
  [
    "A: cat - (dropped dash)",
    `cat - <<'EOF' > out.txt\n${BODY}EOF`,
    "cat - <<'EOF' > out.txt\nEOF",
  ],
  // tree-sitter folds a "-" written right before << into the operator token.
  [
    "A: cat -<< (dash folded into the operator)",
    `cat -<<'EOF' > out.txt\n${BODY}EOF`,
    "cat -<<'EOF' > out.txt\nEOF",
  ],
  [
    "A: tee -a - (dash kept in the AST)",
    `tee -a - out.txt <<'EOF'\n${BODY}EOF`,
    "tee -a - out.txt <<'EOF'\nEOF",
  ],
  // Ranges are removed from the end backwards, so two bodies do not shift each other.
  [
    "two data heredocs in separate statements",
    `cat <<'A' > a\nx\nA\ncat <<'B' > b\n${BODY}B`,
    "cat <<'A' > a\nA\ncat <<'B' > b\nB",
  ],
  [
    "UTF-16 body",
    `cat <<'EOF' > out.txt\n修正 😀 ${BODY}EOF`,
    "cat <<'EOF' > out.txt\nEOF",
  ],
];

// Inputs returned unchanged: the body runs, or the hook cannot tell.
const kept: Array<[string, string]> = [
  ["(a): shell", `bash <<'EOF'\n${BODY}EOF`],
  ["(a): sh", `sh <<'EOF'\n${BODY}EOF`],
  ["(a): interpreter", `python3 - <<'EOF'\n# ${BODY}EOF`],
  ["(a): backslash head", `\\cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(a): path head", `/bin/cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(a): assignment prefix", `LC_ALL=C cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(a): quoted command name", `"cat" <<'EOF' > out.txt\n${BODY}EOF`],
  ["(a): cat of a process substitution", `cat <(sh x) <<'EOF'\n${BODY}EOF`],
  ["(a): cat of an expansion", `cat $f <<'EOF'\n${BODY}EOF`],
  ["(a)(g): tee to an fd path", `tee //dev/fd/14 <<'EOF'\n${BODY}EOF`],
  ["(a): tee to an expansion", `tee "$f" <<'EOF'\n${BODY}EOF`],
  ["(a): quoted argument", `cat "f" <<'EOF'\n${BODY}EOF`],
  ["(a): backtick argument", `cat \`echo f\` <<'EOF'\n${BODY}EOF`],
  ["(e): $ in the delimiter", `cat <<'E$F' > f\n${BODY}E$F`],
  [
    "(f): brace expansion before cat",
    `touch {a,b}; cat <<'EOF' > out.txt\n${BODY}EOF`,
  ],
  ["(f): negation before cat", `! true; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(b): piped to a shell", `cat <<'EOF' | bash\n${BODY}EOF`],
  ["(b): && on the same line", `cat <<'EOF' > s && bash s\n${BODY}EOF`],
  ["(d): subshell piped to a shell", `(cat <<'EOF'\n${BODY}EOF\n) | bash`],
  ["(d): process substitution input", `bash < <(cat <<'EOF'\n${BODY}EOF\n)`],
  // bash 3.2 cuts $(…) by paren matching before reading the heredoc, so a
  // ")" in the body ends the substitution early (Round 4 security).
  [
    "(d): commit message through $()",
    `git commit -m "$(cat <<'EOF'\n${BODY}EOF\n)"`,
  ],
  [
    "(d): bash 3.2 paren cut",
    `git commit -m "$(cat <<'EOF'\nx)"; ${R} ${P}/x; #\nEOF\n)"`,
  ],
  [
    "(d): gh body through $()",
    `gh pr create --title t --body "$(cat <<'EOF'\n${BODY}EOF\n)"`,
  ],
  ["(d): assignment", `x="$(cat <<'EOF'\n${BODY}EOF\n)"`],
  ["(d): eval", `eval "$(cat <<'EOF'\n${BODY}EOF\n)"`],
  // The commit / PR path is a separate spec: git and gh are not consumers here.
  // git can hand the message to $GIT_EDITOR under -e (Round 5 security).
  ["(a): git commit -F -", `git commit -F - <<'EOF'\n${BODY}EOF`],
  [
    "(a): gh pr create --body-file -",
    `gh pr create --title t --body-file - <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(a): git commit -e with GIT_EDITOR",
    `export GIT_EDITOR=sh\ngit commit --file=- -e<<'EOF'\n${BODY}EOF`,
  ],
  // tree-sitter folds an option written right before << into the operator
  // token (Round 6 security); only a lone "-" is read back.
  ["(a): cat option folded into <<", `cat -n<<'EOF' > out.txt\n${BODY}EOF`],
  ["(a): tee option folded into <<-", `tee -a<<-'EOF' out.txt\n${BODY}EOF`],
  [
    "(a): line continuation in the gap",
    `cat - \\\n<<'EOF' > out.txt\n${BODY}EOF`,
  ],
  ["(g): stderr duplicate", `cat 2>&1 <<'EOF' > out.txt\n${BODY}EOF`],
  ["(e): unquoted, $()", `cat <<EOF > out.txt\n$(${R} ${P}/x)\nEOF`],
  ["(e): unquoted, variable", `cat <<EOF > out.txt\n${R} $D/${P}\nEOF`],
  ["(e): unquoted, backtick", `cat <<EOF > out.txt\n\`${R} ${P}/x\`\nEOF`],
  [
    "(e): unquoted, line continuation in the delimiter",
    `cat <<EOF\nEO\\\nF\n${R} ${P}/x\nEOF`,
  ],
  // The shell strips quotes and closes at EOF; tree-sitter reads E""OF and
  // would hide the middle line (Round 3 security, bash 3.2 and zsh).
  [
    "(e): quotes inside the delimiter",
    `cat <<E""OF > f\nEOF\n${R} ${P}/x\nE""OF`,
  ],
  ["(e): E'O'F", `cat <<E'O'F > f\nEOF\n${R} ${P}/x\nE'O'F`],
  ['(e): "E"OF', `cat <<"E"OF > f\nEOF\n${R} ${P}/x\n"E"OF`],
  ["(e): EO'F'", `cat <<EO'F' > f\nEOF\n${R} ${P}/x\nEO'F'`],
  ["(e): tab inside a quoted delimiter", `cat <<'E\tF' > f\n${BODY}E\tF`],
  ["(e): delimiter outside [A-Za-z0-9_]", `cat <<'E-F' > f\n${BODY}E-F`],
  [
    "(e): tee with quotes inside the delimiter",
    `tee f <<E""OF\nEOF\n${R} ${P}/x\nE""OF`,
  ],
  [
    "(e): git commit -F - with quotes inside the delimiter",
    `git commit -F - <<E""OF\nEOF\n${R} ${P}/x\nE""OF`,
  ],
  ["(e): backslash delimiter", `cat <<\\EOF > out.txt\n${BODY}EOF`],
  ["(f): function definition", `cat() { sh; }; cat <<'EOF'\n${BODY}EOF`],
  ["(f): eval", `eval x; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): hash", `hash -p /bin/sh cat; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): source", `source defs; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): dot", `. ./defs; cat <<'EOF' > out.txt\n${BODY}EOF`],
  // eval reached without being the command name (Round 7 security).
  [
    "(f): builtin eval",
    `builtin eval 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): command eval",
    `command eval 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  ["(f): builtin .", `builtin . ./defs\ncat <<'EOF'\n${BODY}EOF`],
  ["(f): noglob eval", `noglob eval 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`],
  [
    "(f): eval from a variable",
    `f=eval; $f 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): eval from a substitution",
    `$(echo eval) 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): eval through printf -v",
    `printf -v X %s eval; $X 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): quoted eval as a name",
    `"ev"al 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): zsh functions table",
    `functions[cat]=x; cat <<'EOF' > out.txt\n${BODY}EOF`,
  ],
  ["(f): PATH", `PATH=/tmp/x:/bin; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): exec", `exec 3>x; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): coproc", `coproc sed x\ncat <<'EOF' > out.txt\n${BODY}EOF`],
  // Builtins that swap cat without naming eval (Round 8 security).
  ["(f): trap DEBUG", `trap 'cat() { sh; }' DEBUG\ncat <<'EOF'\n${BODY}EOF`],
  [
    "(f): trap DEBUG through eval",
    `trap 'eval "cat() { sh; }"' DEBUG\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): zsh emulate -c",
    `emulate zsh -c 'cat() { sh; }'\ncat <<'EOF'\n${BODY}EOF`,
  ],
  // Any builtin outside the inert set keeps the body, even a harmless one.
  ["(f): command -v", `command -v bun && cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): a non-literal name", `~/bin/x; cat <<'EOF' > out.txt\n${BODY}EOF`],
  // Expansions assign in the current shell even in an external command's
  // arguments (Round 9 security, zsh).
  [
    "(f): assignment in an inert builtin's argument",
    `true \${functions[cat]=sh}\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): assignment in an external command's argument",
    `/bin/echo \${aliases[cat]:=sh}\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): assignment on the right of an assignment",
    `x=\${galiases[cat]=sh}\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): assignment in a case head",
    `case \${functions[cat]=sh} in *) ;; esac\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): assignment inside [[ ]]",
    `[[ -n \${functions[cat]=sh} ]]\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): arithmetic assignment",
    `((PATH=1)); cat <<'EOF' > out.txt\n${BODY}EOF`,
  ],
  ["(f): any expansion", `echo $HOME; cat <<'EOF' > out.txt\n${BODY}EOF`],
  // Arithmetic that assigns without an expansion node (Round 10 security).
  ["(f): arithmetic in [[ ]]", `[[ 1 -eq PATH=0 ]]\ncat <<'EOF'\n${BODY}EOF`],
  ["(f): arithmetic in a subscript", `a[PATH=0]=1\ncat <<'EOF'\n${BODY}EOF`],
  [
    "(f): arithmetic in an array literal",
    `a=([PATH=0]=x)\ncat <<'EOF'\n${BODY}EOF`,
  ],
  ["(f): any assignment", `x=1; cat <<'EOF' > out.txt\n${BODY}EOF`],
  // Assignments the tree reports as neither assignment nor expansion (Round 11 security).
  // A follower on the consumer's own line is a parse error (Round 12 logic).
  [
    "(f): follower after ; on the consumer's line",
    `cat <<'EOF' > f; PATH=x\n${BODY}EOF`,
  ],
  [
    "(f): follower after & on the consumer's line",
    `cat <<'EOF' > f &\n${BODY}EOF\nPATH=x`,
  ],
  // An executable named cat put on PATH right before the consumer (Round 12 security).
  ["(f): ln before cat", `ln -s /bin/sh bin/cat\ncat <<'EOF'\n${BODY}EOF`],
  ["(f): mv before cat", `mv x bin/cat\ncat <<'EOF'\n${BODY}EOF`],
  ["(f): chmod before cat", `chmod 755 bin/cat\ncat <<'EOF'\n${BODY}EOF`],
  [
    "(f): for variable",
    `true\nfor PATH in .; do :; done\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): select variable",
    `select PATH in .; do break; done\ncat <<'EOF'\n${BODY}EOF`,
  ],
  ["(f): zsh named fd", `: {PATH}>/dev/null\ncat <<'EOF'\n${BODY}EOF`],
  [
    "(f): named fd on cat itself",
    `cat {PATH}>out.txt\ncat <<'EOF'\n${BODY}EOF`,
  ],
  [
    "(f): redirect on a non-consumer",
    `echo x > f; cat <<'EOF' > out.txt\n${BODY}EOF`,
  ],
  // Any node type outside the accepted set keeps the body.
  ["(f): test command", `[ -d d ] || mkdir d; cat <<'EOF' > d/f\n${BODY}EOF`],
  [
    "(f): test builtin",
    `test -v 'a[PATH=0]'; cat <<'EOF' > out.txt\n${BODY}EOF`,
  ],
  ["(f): if", `if true; then :; fi; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): pipeline", `ls | head; cat <<'EOF' > out.txt\n${BODY}EOF`],
  ["(f): subshell", `(cd d); cat <<'EOF' > out.txt\n${BODY}EOF`],
  // zsh runs glob qualifier code in the current shell. Kept today because
  // tree-sitter fails to parse it; the row guards a parser upgrade.
  [
    "(f): zsh glob qualifier",
    `: *(e:'functions[cat]=sh':)\ncat <<'EOF'\n${BODY}EOF`,
  ],
  ["(g): process substitution target", `cat > >(sh) <<'EOF'\n${BODY}EOF`],
  ["(g): fd duplicate", `cat >&3 <<'EOF'\n${BODY}EOF`],
  ["(g): //dev/fd", `cat <<'EOF' > //dev/fd/14\n${BODY}EOF`],
  [
    "(g): /DEV/fd on a case-insensitive filesystem",
    `cat <<'EOF' > /DEV/fd/14\n${BODY}EOF`,
  ],
  ["(g): ../dev", `cat <<'EOF' > ../dev/x\n${BODY}EOF`],
  ["(g): /dev/null", `cat <<'EOF' > /dev/null\n${BODY}EOF`],
  [
    "(g): a dev segment in a real path (accepted false positive)",
    `cat <<'EOF' > src/dev/x.ts\n${BODY}EOF`,
  ],
  ["(g): clobber", `cat <<'EOF' >| out.txt\n${BODY}EOF`],
  ["(g): stderr", `cat <<'EOF' 2> out.txt\n${BODY}EOF`],
  ["(g): input redirect", `cat <<'EOF' < in.txt\n${BODY}EOF`],
  ["(g): expansion target", `cat <<'EOF' > "$f"\n${BODY}EOF`],
  ["(g): tilde target", `cat <<'EOF' > ~/x\n${BODY}EOF`],
  [
    "hasError: two heredocs on one line",
    `cat <<A > a; tee b <<B\nx\nA\n${BODY}B`,
  ],
];

describe("maskDataHeredocBodies (spec K2)", () => {
  for (const [label, input, expected] of masked) {
    it(`empties the body: ${label}`, async () => {
      strictEqual(await maskDataHeredocBodies(input), expected);
    });
  }
  for (const [label, input] of kept) {
    it(`keeps the input: ${label}`, async () => {
      strictEqual(await maskDataHeredocBodies(input), input);
    });
  }
});

describe("maskDataHeredocBodies when tree-sitter closes earlier than the shell", () => {
  // Without <<-, the shell does not close at a tab-indented EOF but tree-sitter
  // does. The body tree-sitter sees is shorter, so the later line stays visible.
  it("keeps the line after an indented end in the masked text", async () => {
    const input = `cat <<'EOF' > out.txt\nhello\n\tEOF\n${R} ${P}/x\nEOF`;
    ok((await maskDataHeredocBodies(input)).includes(`${R} ${P}/x`));
  });
  it("keeps the line after an end with trailing blanks in the masked text", async () => {
    const input = `cat <<'EOF' > out.txt\nhello\nEOF \n${R} ${P}/x\nEOF`;
    ok((await maskDataHeredocBodies(input)).includes(`${R} ${P}/x`));
  });
});

describe("maskDataHeredocBodies contract (spec K1)", () => {
  it("is idempotent", async () => {
    for (const [, input] of masked) {
      const once = await maskDataHeredocBodies(input);
      strictEqual(await maskDataHeredocBodies(once), once);
    }
  });
  it("only removes one contiguous range from each single-heredoc input", async () => {
    for (const [, input] of masked.filter(
      ([, raw]) => raw.split("<<").length === 2,
    )) {
      const output = await maskDataHeredocBodies(input);
      const splits = [...Array(output.length + 1).keys()];
      ok(
        output.length < input.length &&
          splits.some(
            (k) =>
              input.startsWith(output.slice(0, k)) &&
              input.endsWith(output.slice(k)),
          ),
        input,
      );
    }
  });
  it("leaves a text that parses without errors when it masks", async () => {
    for (const [, input] of masked) {
      const tree = await parseForCollect(await maskDataHeredocBodies(input));
      ok(tree !== null && !tree.rootNode.hasError, input);
      tree?.delete();
    }
  });
  it("does not parse an input without <<", async () => {
    let calls = 0;
    const spy = async (command: string): Promise<Tree | null> => {
      calls += 1;
      return parseForCollect(command);
    };
    strictEqual(
      await maskDataHeredocBodies("ls -la && pwd", spy),
      "ls -la && pwd",
    );
    strictEqual(calls, 0);
  });
  it("returns the input when the parse returns null or throws", async () => {
    const input = `cat <<'EOF' > out.txt\n${BODY}EOF`;
    strictEqual(await maskDataHeredocBodies(input, async () => null), input);
    strictEqual(
      await maskDataHeredocBodies(input, async () => {
        throw new Error("boom");
      }),
      input,
    );
  });
});

describe("heredoc data lists (spec K2)", () => {
  it("names only cat and tee as consumers", () => {
    deepStrictEqual(
      HEREDOC_DATA_CONSUMERS.map((consumer) => consumer.name).sort(),
      ["cat", "tee"],
    );
  });
  it("gives every entry a reason", () => {
    for (const entry of HEREDOC_DATA_CONSUMERS) {
      ok(entry.reason.trim().length > 0, JSON.stringify(entry));
    }
  });
  it("reads only blanks or one dash from the gap before the redirect", () => {
    deepStrictEqual(readCommandGap(""), []);
    deepStrictEqual(readCommandGap(" "), []);
    deepStrictEqual(readCommandGap(" - "), [{ type: "word", text: "-" }]);
    for (const gap of [" -- ", " x ", " - - ", "-", " \\\n ", " ; "]) {
      strictEqual(readCommandGap(gap), null, JSON.stringify(gap));
    }
  });
  it("reads only a lone dash folded into the heredoc operator", () => {
    deepStrictEqual(readHeredocOperator("<<"), []);
    deepStrictEqual(readHeredocOperator("<<-"), []);
    deepStrictEqual(readHeredocOperator("-<<"), [{ type: "word", text: "-" }]);
    deepStrictEqual(readHeredocOperator("-<<-"), [{ type: "word", text: "-" }]);
    for (const operator of ["-e<<", "-ae<<-", "--edit<<", "x<<", "<<<"]) {
      strictEqual(readHeredocOperator(operator), null, operator);
    }
  });
  it("accepts plain write targets only", () => {
    for (const ok_ of ["out.txt", "d/f", "/Users/x/out.txt", ".tmp/a-b_c.md"]) {
      ok(isPlainWriteTarget(ok_), ok_);
    }
    for (const ng of [
      "/dev/null",
      "//dev/fd/3",
      "/./dev/x",
      "/DEV/fd/3",
      "/Proc/1",
      "../x",
      "src/dev/x",
      "a/proc/b",
      "fd/x",
      "~/x",
      "$f",
      "a b",
      "",
    ]) {
      ok(!isPlainWriteTarget(ng), ng);
    }
  });
});
