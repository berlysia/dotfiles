import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildReadOnlyPatterns,
  classifyDeletion,
  describeDeletionMatch,
  findDeleteWord,
  isNonModifyingShape,
  mayAllowAsReadOnly,
  standaloneSymlinkRemovalOperands as ops,
} from "../../lib/node-modules-policy.ts";
import {
  ARGUMENT_SCAN_EXEMPT_HEADS,
  isExemptReadOnlyCommand,
  READ_ONLY_VERBS,
} from "../../lib/read-only-command.ts";

// `cmd` is the whole Bash command, as in the hook.
const classify = (cmd: string, fallback: boolean) =>
  classifyDeletion(cmd, {
    readOnlyExempt: isExemptReadOnlyCommand(cmd, {
      parsingMethod: fallback ? "fallback" : "tree-sitter",
    }),
  });

const DENY_DELETE: Array<[string, boolean]> = [
  ["ls x\nrm -rf node_modules", true],
  ["ls $(rm -rf node_modules)", true],
  ["cat x <(rm -rf node_modules)", true],
  ["ls node_modules rm", true],
  ["ls node_modules $(rm -rf node_modules)", false],
  ["cat `rm -rf node_modules`", false],
  ["cat x `rm` node_modules", false],
  ["grep() { rm -rf node_modules; }", false],
  ["foo=1 ls node_modules rm", false],
  ["lsx node_modules/rm", false],
  ["ls node_modules; rm -rf node_modules", false],
  ["if ls node_modules; then rm -rf node_modules; fi", false],
  ["unlink node_modules/x", false],
  ["shred node_modules/x", false],
  ["truncate -s 0 node_modules/x", false],
  ["rmdir node_modules", false],
  ["bash -lc 'rm -rf node_modules'", false],
  ["sudo -u root rm -rf node_modules", false],
  ["timeout 5 rm -rf node_modules", false],
  ["/bin/rm -rf node_modules", false],
  ["\\rm -rf node_modules", false],
  ["git rm -r node_modules", false],
  ["rm -rf NODE_MODULES", false],
  ["unlink Node_Modules/x", false],
  // K5(b): heads that are no longer exempt
  ["\\grep rm node_modules/x", false],
  ["find x -name rm node_modules", false],
  // K5(c): a read-only fragment inside a compound command loses the exemption
  ["ls node_modules; grep rm node_modules/x", false],
  ['cd "${(e)${:-x}} rm -rf node_modules"', false],
  ["find node_modules -ex$'e'c rm -rf node_modules $'\\073'", false],
  ['grep -e "rm -rf ${X}" node_modules/x', true],
];
const DENY_FIND: string[] = [
  "find node_modules -delete",
  "find node_modules -type f -exec rm {} +",
  "find node_modules -exec mv {} /tmp \\;",
  "find node_modules -ok rm {} \\;",
  "find node_modules -exec env mv {} /tmp \\;",
  "find node_modules -exec sudo mv {} /tmp \\;",
  "find node_modules -exec sh -c 'mv \"$1\" /tmp' _ {} \\;",
  "find node_modules -exec sh -c 'rm -rf \"$1\"' _ {} \\;",
  "find node_modules -exec echo {} \\; -exec rm {} \\;",
  "env find node_modules -exec mv {} /tmp \\;",
  "foo=1 find node_modules -delete",
  "nice find node_modules -delete",
  "sudo find node_modules -exec mv {} /tmp \\;",
  'find node_modules "-exec" mv {} /tmp +',
  "find node_modules -ex''ec mv {} /tmp +",
  "find node_modules -exec r''m {} +",
  "ls node_modules $(find node_modules -delete)",
  "find node_modules -delete;",
  "find node_modules -delete&&echo",
  "find node_modules -exec sh -c 'true;mv \"$1\" /tmp' _ {} \\;",
  "find node_modules -exec sh -c 'cd /tmp&&mv \"$1\" .' _ {} \\;",
  "find node_modules -exec${IFS}rm {} +",
  "find node_modules -exec sh -c 'rm -rf ${x}' _ {} \\;",
];
const ASK_FIND: string[] = [
  'find node_modules -exec python3 -c "import shutil,sys;shutil.rmtree(sys.argv[1])" {} \\;',
  "find node_modules -exec echo {} \\;",
];
const NOT_DELETION: string[] = [
  "grep -rn unlink node_modules/x",
  "grep rm node_modules/x",
  "/bin/grep rm node_modules/x",
  "find node_modules -name '*.js'",
  "ls node_modules",
  'grep "a|rm" node_modules/x',
  'grep -e "rm -rf ${X}" node_modules/x',
];

describe("classifyDeletion", () => {
  for (const [cmd, fallback] of DENY_DELETE) {
    it(`deny-delete: ${JSON.stringify(cmd)} fallback=${fallback}`, () => {
      strictEqual(classify(cmd, fallback), "deny-delete");
    });
  }
  for (const cmd of DENY_FIND) {
    it(`deny-find: ${cmd}`, () =>
      strictEqual(classify(cmd, false), "deny-find"));
  }
  for (const cmd of ASK_FIND) {
    it(`ask-find: ${cmd}`, () => strictEqual(classify(cmd, false), "ask-find"));
  }
  for (const cmd of NOT_DELETION) {
    it(`null: ${cmd}`, () => strictEqual(classify(cmd, false), null));
  }
  it("false positive accepted (fail-closed): a non-find command carrying find/-delete words", () => {
    strictEqual(
      classify('git commit -m "find -delete" node_modules', false),
      "deny-find",
    );
  });
  it("mayAllowAsReadOnly refuses compound fragments only under fallback", () => {
    strictEqual(
      mayAllowAsReadOnly("ls x; python3 -c 'shutil.rmtree(\"node_modules\")'", {
        fallback: true,
      }),
      false,
    );
    strictEqual(
      mayAllowAsReadOnly("ls node_modules", { fallback: true }),
      true,
    );
    strictEqual(
      mayAllowAsReadOnly("ls x; ls node_modules", { fallback: false }),
      true,
    );
  });
  for (const { verb } of READ_ONLY_VERBS) {
    it(`read-only head exemption covers only exempt heads: ${verb}`, () => {
      strictEqual(
        classify(`${verb} node_modules/rm`, false),
        ARGUMENT_SCAN_EXEMPT_HEADS.has(verb) ? null : "deny-delete",
      );
    });
    it(`generated read-only regex matches ${verb}`, () => {
      ok(
        buildReadOnlyPatterns().some((p) =>
          p.pattern.test(`${verb} node_modules/x`),
        ),
      );
    });
  }
  it("generates exactly the five existing categories", () => {
    strictEqual(
      new Set(buildReadOnlyPatterns().map((p) => p.operation)).size,
      5,
    );
  });
});

describe("standaloneSymlinkRemovalOperands", () => {
  const accepted: Array<[string, string[]]> = [
    ["rm /t/a/node_modules", ["/t/a/node_modules"]],
    ["rm -f /t/a/node_modules", ["/t/a/node_modules"]],
    ["rm -f -f /t/a/node_modules", ["/t/a/node_modules"]],
    ["unlink /t/a/node_modules", ["/t/a/node_modules"]],
    [
      "rm /t/a/node_modules /t/c/node_modules",
      ["/t/a/node_modules", "/t/c/node_modules"],
    ],
    ["  rm /t/a/node_modules  ", ["/t/a/node_modules"]],
  ];
  for (const [cmd, expected] of accepted)
    it(`operands: ${JSON.stringify(cmd)}`, () =>
      deepStrictEqual(ops(cmd), expected));

  const rejected = [
    "rm /t/a/node_modules/",
    "rm /t/a/node_modules/.",
    "rm /t/a/../node_modules",
    "rm //t/a/node_modules",
    "rm -rf /t/a/node_modules",
    "rm -f -r /t/a/node_modules",
    "rm -- /t/a/node_modules",
    "rm --force /t/a/node_modules",
    "rm /t/a/node_modules -f",
    "unlink /t/a/node_modules /t/b/node_modules",
    "unlink -f /t/a/node_modules",
    'rm "/t/a/node_modules"',
    "rm /t/a/node_modules;",
    "rm $W/node_modules",
    "W=/t/a; rm $W/node_modules",
    "rm t/a/node_modules",
    "rm /t/node_modules/a/node_modules",
    "rm /t/a/node_modules/.bin/x",
    "rm\t/t/a/node_modules",
    "shred /t/a/node_modules",
    "rm /t/a/NODE_MODULES",
    "rm /t/a/node_modules" + String.fromCharCode(0xa0),
  ];
  for (const cmd of rejected)
    it(`null: ${JSON.stringify(cmd)}`, () => strictEqual(ops(cmd), null));
});

describe("findDeleteWord", () => {
  it("returns the delete word classifyDeletion reacts to", () => {
    strictEqual(findDeleteWord("rm -rf node_modules"), "rm");
    strictEqual(
      findDeleteWord('git commit -m "unlink node_modules"'),
      "unlink",
    );
    strictEqual(findDeleteWord("RM -rf NODE_MODULES"), "rm");
  });
  it("returns null when no delete word stands as a word", () => {
    strictEqual(findDeleteWord("ls node_modules/form"), null);
    strictEqual(findDeleteWord(""), null);
  });
  // Holds for commands that mention node_modules and have no find: without
  // node_modules classifyDeletion returns null whatever the words are.
  it("agrees with classifyDeletion on deny-delete for commands that mention node_modules", () => {
    const inputs = [
      "rm node_modules",
      "grep rm node_modules/x",
      'echo "shred" node_modules',
      "truncate -s0 node_modules/x",
      "rmdir node_modules",
      "ls node_modules/form",
      "cat node_modules/x",
      "confirm node_modules",
    ];
    for (const cmd of inputs) {
      strictEqual(
        findDeleteWord(cmd) !== null,
        classifyDeletion(cmd, { readOnlyExempt: false }) === "deny-delete",
        cmd,
      );
    }
  });
});

describe("describeDeletionMatch", () => {
  it("names the delete word for deny-delete", () => {
    strictEqual(
      describeDeletionMatch("grep rm node_modules/x", "deny-delete"),
      'the word "rm" in a command that mentions node_modules, quoted text included',
    );
  });
  it("states the find condition for deny-find", () => {
    strictEqual(
      describeDeletionMatch("find node_modules -delete", "deny-find"),
      "find with -delete, or with an exec flag followed by a delete or move word, in a command that mentions node_modules",
    );
  });
});

describe("isNonModifyingShape", () => {
  const YES = [
    "sed -n 400,450p node_modules/nodemon/lib/monitor/run.js",
    "sed -n 7p node_modules/a.js",
    "sed -n '1,200p' node_modules/@notionhq/client/build/src/Client.d.ts",
    'sed -n "3,4p" node_modules/a.js node_modules/b.js',
    "sed -n 1,5p node_modules/.pnpm/a@1.0.0/node_modules/a/index.js",
    "  sed -n 1,5p node_modules/a.js  ",
    "node_modules/.bin/tsc",
    "node_modules/.bin/tsc --noEmit -p tsconfig.json",
    "./node_modules/.bin/oxfmt --check a.md 2>&1",
    "node_modules/.bin/tsc --outDir dist > out.log",
    'node_modules/.bin/eslint "src/**/*.ts"',
  ];
  const NO = [
    // sed: anything but `-n <lines>p <plain paths>` keeps the ask
    "sed -n '1w node_modules/x' a.js",
    "sed -n '1,5p;1w x' node_modules/a.js",
    "sed -n 1,5p -i node_modules/a.js",
    "sed -n -i 1,5p node_modules/a.js",
    "sed -i 1d node_modules/a.js",
    "sed 1,5p node_modules/a.js",
    "sed -n 1,5p",
    "sed -n 1,5p node_modules/a.js > out",
    "sed -n 1,5p node_modules/a.js | tee x",
    "sed -n 1,5p 'node_modules/a b.js'",
    "sed -n 1,5p $D/node_modules/a.js",
    "sed -n 1,5p\tnode_modules/a.js",
    "sed -n 1,5p node_modules/a.js\nrm x",
    "/bin/sed -n 1,5p node_modules/a.js",
    // local tool: a second mention, or any head but a relative .bin/<name>, keeps the ask
    "node_modules/.bin/prettier --write node_modules/a.js",
    "node_modules/.bin/tsc --outDir node_modules/x",
    "node_modules/.bin/tsc > node_modules/out.txt",
    "/w/node_modules/.bin/tsc --noEmit",
    "../node_modules/.bin/tsc --noEmit",
    "packages/a/node_modules/.bin/tsc --noEmit",
    "node_modules/.bin/",
    "node_modules/.bin/../../evil",
    "node_modules/.bin/a/../../evil",
    "node_modules/.bin/.hidden",
    '"node_modules/.bin/tsc" --noEmit',
    "node_modules/.bin/tsc\t--noEmit",
    "node_modules/.bin/tsc\nrm x",
    "node_modules/.pnpm/a/node_modules/.bin/tsc",
    "X=1 node_modules/.bin/tsc",
    "xargs node_modules/.bin/prettier --check",
    // only the five tools that have an allow rule; the later mention is compared in lower case
    "node_modules/.bin/rimraf dist",
    "./node_modules/.bin/esbuild",
    "node_modules/.bin/tscx --noEmit",
    "node_modules/.bin/tsc --outDir NODE_MODULES/x",
    // echo / printf are not a shape: printf -v evaluates a subscript, echo can feed a later command
    'echo "=== node_modules ==="',
    "echo node_modules",
    "printf -v 'a[$(ln -sf x node_modules/y)]' z",
  ];
  for (const cmd of YES) {
    it(`true: ${JSON.stringify(cmd)}`, () => {
      strictEqual(isNonModifyingShape(cmd), true);
    });
  }
  for (const cmd of NO) {
    it(`false: ${JSON.stringify(cmd)}`, () => {
      strictEqual(isNonModifyingShape(cmd), false);
    });
  }
});
