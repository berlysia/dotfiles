import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  buildReadOnlyPatterns,
  classifyDeletion,
  mayAllowAsReadOnly,
  READ_ONLY_VERBS,
  standaloneSymlinkRemovalOperands as ops,
} from "../../lib/node-modules-policy.ts";

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
  "\\grep rm node_modules/x",
  "find x -name rm node_modules",
  "find node_modules -name '*.js'",
  "ls node_modules",
];

describe("classifyDeletion", () => {
  for (const [cmd, fallback] of DENY_DELETE) {
    it(`deny-delete: ${JSON.stringify(cmd)} fallback=${fallback}`, () => {
      strictEqual(classifyDeletion(cmd, { fallback }), "deny-delete");
    });
  }
  for (const cmd of DENY_FIND) {
    it(`deny-find: ${cmd}`, () =>
      strictEqual(classifyDeletion(cmd, { fallback: false }), "deny-find"));
  }
  for (const cmd of ASK_FIND) {
    it(`ask-find: ${cmd}`, () =>
      strictEqual(classifyDeletion(cmd, { fallback: false }), "ask-find"));
  }
  for (const cmd of NOT_DELETION) {
    it(`null: ${cmd}`, () =>
      strictEqual(classifyDeletion(cmd, { fallback: false }), null));
  }
  it("false positive accepted (fail-closed): a non-find command carrying find/-delete words", () => {
    strictEqual(
      classifyDeletion('git commit -m "find -delete" node_modules', {
        fallback: false,
      }),
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
    it(`read-only head exemption covers ${verb}`, () => {
      strictEqual(
        classifyDeletion(`${verb} node_modules/rm`, { fallback: false }),
        null,
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
