<!-- spec-ref: spec.md -->

# Plan 1: heredoc の本文を空にする関数と deny 側の入口（lib）

spec K1・K2 の実装。hook はまだ変えない（plan-2）。

## Files

```
# 新規作成
home/dot_claude/hooks/lib/heredoc-data.ts
home/dot_claude/hooks/lib/deny-input.ts
home/dot_claude/hooks/tests/unit/heredoc-data.test.ts
home/dot_claude/hooks/tests/unit/deny-input.test.ts

# 編集
home/dot_claude/hooks/lib/bash-parser.ts
```

## Tasks

### T1: `parseForCollect` を export する

**Files:**

- 編集: `home/dot_claude/hooks/lib/bash-parser.ts:945-947`（`type ParseForCollect` と `parseForCollect`）
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:993-1037`（`collectExecutableTexts` の第 3 引数 `parse` と同じ型 `ParseForCollect` を使う）

- [ ] **Step 1**: `type ParseForCollect` と `const parseForCollect` に `export` を付ける。コメントに「deny 側のポリシー（`heredoc-data.ts`）が同じ parse を使うために export する」と書く。挙動は変えない
- [ ] **Step 2**: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/bash-parser.test.ts` が変更前と同じ件数で PASS することを確かめる

### T2: `maskDataHeredocBodies` の受け付ける形と受け付けない形を表で書く（Red）

**Files:**

- テスト: `home/dot_claude/hooks/tests/unit/heredoc-data.test.ts`（新規）
- 参照: `home/dot_claude/hooks/tests/unit/bash-parser.test.ts:3-4, 35-40`（`node:assert` と `node:test` の書き方、`import type { Tree } from "web-tree-sitter"` で parse を差し替える型）

- [ ] **Step 1: 失敗するテストを書く**

削除語と `node_modules` を本文に含む入力は、テストファイル自身が deny-node-modules に拒否されないよう、`R`・`P` の定数を連結して作る（F2・F3a のテストと同じ書き方）。

```ts
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
```

- [ ] **Step 2: テストを実行して失敗を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/heredoc-data.test.ts`
期待: FAIL（`Cannot find module '../../lib/heredoc-data.ts'`）

### T3: `lib/heredoc-data.ts` を実装する（Green）

**Files:**

- 新規: `home/dot_claude/hooks/lib/heredoc-data.ts`
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:961-969`（`redirected_statement` の body の型で分岐する `isCoveredRedirect` の読み方）
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:993-1037`（parse・`hasError`・throw の fail-closed、`finally` での `tree.delete()`）

- [ ] **Step 1: 最小実装を書く**

```ts
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
```

- [ ] **Step 2: テストを実行して通過を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/heredoc-data.test.ts`
期待: PASS（全行）。AST の形が research §3 と違って表の行が落ちる場合（例: `coproc` や `functions[cat]=x` の parse が `hasError` になる）は、その行が「keeps the input」側のまま PASS するかを確かめる。masked 側の行が落ちたら実装を AST に合わせ、条件を緩める変更は spec の K2 と突き合わせてから行う

- [ ] **Step 3: コミット**

```bash
git add home/dot_claude/hooks/lib/bash-parser.ts home/dot_claude/hooks/lib/heredoc-data.ts home/dot_claude/hooks/tests/unit/heredoc-data.test.ts
git commit  # /commit で作る。件名: feat(hooks): mask heredoc bodies that only feed data, for deny-side checks。本文に intent（spec K2）、decision（(f) はノードの種類の閉じた許可リスト）、rejected（危険なものの列挙）の action 行
```

### T4: `prepareDenyInput` を書く（Red → Green）

**Files:**

- 新規: `home/dot_claude/hooks/lib/deny-input.ts`
- テスト: `home/dot_claude/hooks/tests/unit/deny-input.test.ts`（新規）
- 参照: `home/dot_claude/hooks/lib/bash-parser.ts:1039-1052`（`extractCommandsStructured` の戻り値 `ExtractedCommands` の `individualCommands` / `parsingMethod`）

- [ ] **Step 1: 失敗するテストを書く**

```ts
#!/usr/bin/env node --test
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { extractCommandsStructured } from "../../lib/bash-parser.ts";
import { prepareDenyInput } from "../../lib/deny-input.ts";

const R = "r" + "m -rf";
const P = "node" + "_modules";

describe("prepareDenyInput (spec K1)", () => {
  it("returns the masked text and its fragments", async () => {
    const raw = `cat <<'EOF' > out.txt\n${R} ${P}/x\nEOF`;
    const input = await prepareDenyInput(raw);
    strictEqual(input.maskedText, "cat <<'EOF' > out.txt\nEOF");
    ok(input.individualCommands.every((fragment) => !fragment.includes(P)));
    strictEqual(input.parsingMethod, "tree-sitter");
  });
  it("matches extractCommandsStructured on an input without a data heredoc", async () => {
    // The last one fails to parse: maskedText stays raw.
    for (const raw of [
      "ls -la && pwd",
      `bash <<'EOF'\n${R} ${P}/x\nEOF`,
      `cat <<'EOF' > f; x\n${R} ${P}/x\nEOF`,
    ]) {
      const input = await prepareDenyInput(raw);
      const base = await extractCommandsStructured(raw);
      strictEqual(input.maskedText, raw);
      deepStrictEqual(input.individualCommands, base.individualCommands);
      strictEqual(input.parsingMethod, base.parsingMethod);
    }
  });
});
```

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deny-input.test.ts` → 期待: FAIL（`Cannot find module '../../lib/deny-input.ts'`）

- [ ] **Step 2: 最小実装を書く**

```ts
// lib/deny-input.ts — the one entry for deny-side reads of a Bash command
//
// Deny-side checks read the command with data-only heredoc bodies emptied
// (spec K1). They take both the whole text and the fragments from here, so
// a check cannot read the raw body by mistake. The allow side keeps reading
// the raw command through scanSafeList.

import {
  type ExtractedCommands,
  extractCommandsStructured,
} from "./bash-parser.ts";
import { maskDataHeredocBodies } from "./heredoc-data.ts";

export interface DenyInput {
  /**
   * For deny-side checks only; the shell runs the raw command. Never run,
   * show, allow on, or hand this to the LLM evaluator.
   */
  maskedText: string;
  individualCommands: string[];
  parsingMethod: ExtractedCommands["parsingMethod"];
}

/**
 * The command as deny-side checks read it. Deny-side hooks use this instead
 * of calling extractCommandsStructured on the raw command (the comment at
 * pattern-matcher.ts:79 is about the allow side and stays).
 *
 * When a body was emptied, `maskedText` reparses without errors and differs
 * from `raw` only by the removed body ranges. Otherwise `maskedText === raw`,
 * including when `raw` itself fails to parse. Masking is idempotent.
 */
export async function prepareDenyInput(raw: string): Promise<DenyInput> {
  const maskedText = await maskDataHeredocBodies(raw);
  const { individualCommands, parsingMethod } =
    await extractCommandsStructured(maskedText);
  return { maskedText, individualCommands, parsingMethod };
}
```

- [ ] **Step 3: テストを実行して通過を確認**

実行: `node --import ./home/dot_claude/hooks/tests/preload-test-env.mjs --test home/dot_claude/hooks/tests/unit/deny-input.test.ts` → 期待: PASS

- [ ] **Step 4: 全体の確認とコミット**

実行: `bun run typecheck && bun run test && bun run lint:oxlint`
期待: すべて PASS。既存テストは変更していない（hook はまだ `prepareDenyInput` を使わない）

```bash
git add home/dot_claude/hooks/lib/deny-input.ts home/dot_claude/hooks/tests/unit/deny-input.test.ts
git commit  # /commit で作る。件名: feat(hooks): add prepareDenyInput as the deny-side entry。本文に intent（spec K1）と constraint（maskedText は判定専用）の action 行
```

## ISO 25010 具体テストケース

### 機能適合性（機能正確性）

- **入力**: `cat <<'EOF' > out.txt` ⏎ `rm -rf node_modules/x` ⏎ `EOF` → **期待**: `cat <<'EOF' > out.txt` ⏎ `EOF` を返す
- **入力**: `tee .tmp/msg.txt <<'EOF'` ⏎ `fix: rm -rf node_modules/x` ⏎ `EOF` → **期待**: 本文の行だけが消えた文字列を返す
- **入力**: `cat -<<'EOF' > out.txt` ⏎ 本文 ⏎ `EOF`（`-` が演算子に取り込まれる形） → **期待**: 本文の行だけが消えた文字列を返す
- **入力**: `mkdir -p d && cat <<'EOF' > d/f` ⏎ 本文 ⏎ `EOF` → **期待**: 本文が消える（list の右端の cat）
- **入力**: 日本語と絵文字を含む本文 → **期待**: 本文が消え、前後の文字が欠けない

### セキュリティ（完全性）

- **入力**: T2 の `kept` 表の全行（シェル・インタプリタ・パイプ・同じ行の後続・展開・行の連結・区切りの途中の引用符とタブ・差し替え・プロセス置換・fd・`//dev/fd/14`・`/DEV/fd/14`・`/dev/null`・`>|`・`2>`・展開と `~` の宛先・1 行 2 heredoc・`$(cat <<…)` の引数形すべて（bash 3.2 の括弧の切り出しの再現入力を含む）・git / gh に渡す形（`-F -`、`--body-file -`、`-e<<`）・演算子に取り込まれた選択肢（`cat -n<<`）・隙間の行の連結） → **期待**: すべて入力と同じ文字列を返す
- **入力**: parse が null を返す / throw する → **期待**: 入力と同じ文字列を返す

### 保守性（修正性）

- **入力**: `HEREDOC_DATA_CONSUMERS` → **期待**: cat・tee に一致し、全エントリの `reason` が空でない（足したらテストが落ち、根拠の記述を促す）
- **入力**: `readHeredocOperator` に `<<`・`<<-`・`-<<`・`-<<-`・`-e<<`・`-ae<<-`・`--edit<<`・`x<<`・`<<<` → **期待**: 前 2 つは `[]`、次の 2 つは `[-]`、残りは null
- **入力**: `readCommandGap` に `""`・`" "`・`" - "`・`" -- "`・`" x "`・`" - - "` → **期待**: 前 3 つは `[]`・`[]`・`[-]`、残りは null（AST が落とした語を読み飛ばさない）
- **入力**: `<<` を含まない `ls -la && pwd` → **期待**: parse を 1 回も呼ばない

## Approval

- Plan Status: complete
- Review Status: pass
- Approval Status: approved

## Reviewer Outputs (Round 1)

### logic-validator

- verdict: pass
- 主指摘: spec の K1・K2 と一致し、TDD の順序も正しい。軽微: `ExtractedCommands` の export 分岐と bash-parser.ts の add は不要、`bun run test <file>` は全件が走るので単一ファイルの node コマンドにする、`prepareDenyInput` の JSDoc に spec K1 の契約を書く、コミットの件名だけで本文が未定（反映済み）

### scope-justification-reviewer

- verdict: pass
- 主指摘: 各タスクは spec から導け、範囲外の作業は無い。軽微: JSDoc の契約、`deny-input.test.ts` に raw が `hasError` の行、K2 の受け付けない形の行（引用符・バッククォートの引数、`$` の区切り、ブレース、`!`）、行番号のずれ（反映済み。表は 139 件 PASS）

<!-- auto-review: pending -->
<!-- intent-triage: pending -->

<!-- auto-review: verdict=pass; hash=b64707b613e76cf82909ffb6d2c3ef881bbaa8f9beb78d57d70aa6613e07c0bf; design-hash=f89d5fccd2bb82f01af7269be2043cdf2ec83f34a4f7ed0b1e9bbcae35467eb1; round=1; parent-spec-hash=6da0539b31f531a826332124d7c73cb6d4cec43e82b58e039287450f29b87c82; at=2026-10-02T07:17:07.766Z; reviewers=logic-validator+scope-justification-reviewer -->
<!-- intent-triage: adopted=10; excluded=0; at=2026-10-02T07:17:07.788Z -->
