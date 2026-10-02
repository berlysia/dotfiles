import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  checkPattern,
  matchAnchoredBashAllow,
  matchGitignorePattern,
  parseBashPattern,
} from "../../lib/pattern-matcher.ts";

describe("Pattern matching validation", () => {
  it("should reject Bash(**) pattern", async () => {
    const result = await checkPattern("Bash(**)", "Bash", {
      command: "echo hello",
    });
    strictEqual(result, false, "Bash(**) should be rejected");
  });

  it("should accept valid Bash patterns", async () => {
    const result1 = await checkPattern("Bash(echo *)", "Bash", {
      command: "echo hello world",
    });
    strictEqual(result1, true, "Bash(echo *) should match echo commands");

    const result2 = await checkPattern("Bash(npm *)", "Bash", {
      command: "npm install lodash",
    });
    strictEqual(result2, true, "Bash(npm *) should match npm commands");
  });

  it("should accept Read(**) pattern", async () => {
    const result = await checkPattern("Read(**)", "Read", {
      file_path: "/any/path/file.txt",
    });
    strictEqual(result, true, "Read(**) should match all files");
  });

  it("should accept Edit(**) pattern", async () => {
    const result = await checkPattern("Edit(**)", "Edit", {
      file_path: "/any/path/file.txt",
      old_string: "old",
      new_string: "new",
    });
    strictEqual(result, true, "Edit(**) should match all files");
  });

  it("should handle gitignore-style patterns correctly", async () => {
    // Test basic ** pattern
    strictEqual(
      matchGitignorePattern("/path/to/file.txt", "**"),
      true,
      "** should match everything",
    );

    // Test ./** pattern (should match any relative path)
    strictEqual(
      matchGitignorePattern("src", "./**"),
      true,
      "./** should match relative paths without ./ prefix",
    );
    strictEqual(
      matchGitignorePattern("src/scenarios", "./**"),
      true,
      "./** should match nested relative paths",
    );
    strictEqual(
      matchGitignorePattern("./src", "./**"),
      true,
      "./** should match paths with ./ prefix",
    );

    // Test directory patterns
    strictEqual(
      matchGitignorePattern("/src/components/Button.tsx", "src/**"),
      true,
      "src/** should match files in src/",
    );
    strictEqual(
      matchGitignorePattern("/lib/utils.ts", "src/**"),
      false,
      "src/** should not match files outside src/",
    );

    // Test file extension patterns
    strictEqual(
      matchGitignorePattern("/path/file.ts", "*.ts"),
      true,
      "*.ts should match TypeScript files",
    );
    strictEqual(
      matchGitignorePattern("/path/file.js", "*.ts"),
      false,
      "*.ts should not match JavaScript files",
    );

    // Test negation patterns
    const result = await checkPattern("Edit(!node_modules/**)", "Edit", {
      file_path: "/project/node_modules/package/index.js",
      old_string: "old",
      new_string: "new",
    });
    strictEqual(
      result,
      false,
      "!node_modules/** should exclude node_modules files",
    );
  });

  it("should handle tool name exact matching", async () => {
    const result1 = await checkPattern("Read", "Read", {
      file_path: "/path/file.txt",
    });
    strictEqual(result1, true, "Tool name should match exactly");

    const result2 = await checkPattern("Read", "Write", {
      file_path: "/path/file.txt",
    });
    strictEqual(result2, false, "Tool name should not match different tool");
  });

  it("should reject parent directory traversal in ./** pattern", async () => {
    // Test directory traversal attempts
    strictEqual(
      matchGitignorePattern("../etc/passwd", "./**"),
      false,
      "./** should reject ../ at start",
    );
    strictEqual(
      matchGitignorePattern("../../etc/passwd", "./**"),
      false,
      "./** should reject ../../ at start",
    );
    strictEqual(
      matchGitignorePattern("foo/../../../etc/passwd", "./**"),
      false,
      "./** should reject /../ in middle",
    );
    strictEqual(
      matchGitignorePattern("~/../../etc/passwd", "./**"),
      false,
      "./** should reject traversal with tilde",
    );

    // Test legitimate paths still work
    strictEqual(
      matchGitignorePattern("src", "./**"),
      true,
      "./** should allow relative paths",
    );
    strictEqual(
      matchGitignorePattern("./src/foo", "./**"),
      true,
      "./** should allow ./ prefixed paths",
    );
  });

  it("should reject parent directory traversal in ** pattern", async () => {
    // Test ** pattern also rejects traversal
    strictEqual(
      matchGitignorePattern("../secret", "**"),
      false,
      "** should reject parent directory traversal",
    );
    strictEqual(
      matchGitignorePattern("foo/../../bar", "**"),
      false,
      "** should reject traversal in middle",
    );

    // Test legitimate paths still work
    strictEqual(
      matchGitignorePattern("any/path/here", "**"),
      true,
      "** should allow normal paths",
    );
  });

  it("should reject directory traversal in checkPattern for tools", async () => {
    // Test that tool patterns also reject traversal
    const grepResult = await checkPattern("Grep(./**)", "Grep", {
      path: "../etc/passwd",
      pattern: "test",
    });
    strictEqual(
      grepResult,
      false,
      "Grep(./**) should reject parent directory traversal",
    );

    const readResult = await checkPattern("Read(./**)", "Read", {
      file_path: "../../etc/passwd",
    });
    strictEqual(
      readResult,
      false,
      "Read(./**) should reject parent directory traversal",
    );

    const editResult = await checkPattern("Edit(./**)", "Edit", {
      file_path: "foo/../../../bar",
      old_string: "a",
      new_string: "b",
    });
    strictEqual(
      editResult,
      false,
      "Edit(./**) should reject directory traversal in path",
    );
  });
});

describe("parseBashPattern / matchAnchoredBashAllow (spec K4)", () => {
  it("parses prefix and exact forms and rejects the rest", () => {
    deepStrictEqual(parseBashPattern("Bash(pnpm test *)"), {
      kind: "prefix",
      value: "pnpm test",
    });
    deepStrictEqual(parseBashPattern("Bash(git status)"), {
      kind: "exact",
      value: "git status",
    });
    strictEqual(parseBashPattern("Bash(**)"), null);
    strictEqual(parseBashPattern("Bash( *)"), null);
    strictEqual(parseBashPattern("Bash"), null);
    strictEqual(parseBashPattern("Read(**)"), null);
  });

  it("matches only at the start of the simple command", () => {
    const allow = ["Bash(pnpm *)", "Bash(git status)"];
    strictEqual(matchAnchoredBashAllow("pnpm test", allow), "Bash(pnpm *)");
    strictEqual(matchAnchoredBashAllow("pnpm", allow), "Bash(pnpm *)");
    strictEqual(
      matchAnchoredBashAllow("git status", allow),
      "Bash(git status)",
    );
    strictEqual(matchAnchoredBashAllow("evil --x pnpm test", allow), null);
    strictEqual(matchAnchoredBashAllow("pnpmx test", allow), null);
    strictEqual(matchAnchoredBashAllow("git status -s", allow), null);
    strictEqual(matchAnchoredBashAllow("ls", ["Bash"]), null);
    strictEqual(matchAnchoredBashAllow("pnpm test", ["Bash(pnpm *) "]), null);
  });

  it("leaves checkPattern's deny-side matching as before", async () => {
    strictEqual(
      await checkPattern("Bash(pnpm *)", "Bash", {
        command: "evil --x pnpm test",
      }),
      true,
    );
    strictEqual(
      await checkPattern("Bash", "Bash", { command: "anything" }),
      true,
    );
    strictEqual(
      await checkPattern("Bash(**)", "Bash", { command: "ls" }),
      false,
    );
  });
});

describe("matchGitignorePattern: absolute wildcard patterns", () => {
  const cases: Array<[string, string, boolean]> = [
    // matches
    ["/.env", "//**/.env", true],
    ["/x/.env", "//**/.env", true],
    ["/x/a/b/.env.production", "//**/.env.production", true],
    ["/x/.env.prod.local", "//**/.env.*.local", true],
    ["/mnt/c/.Trash-1000/files/a", "//**/.Trash-*/**", true],
    ["/home/u/.ssh/id_rsa", "/home/u/.ssh/id_*", true],
    ["/home/u/.ssh/id_rsa.pub", "/home/u/.ssh/id_*", true],
    ["/x/.hidden/y", "/x/*/y", true],
    // non-matches
    ["/x/ai.env.sh", "//**/.env", false],
    ["/x/env.sh.tmpl", "//**/.env", false],
    ["/x/.env.example", "//**/.env", false],
    ["/x/.env.sample", "//**/.env.*.local", false],
    ["/x/.env.local.bak", "//**/.env.*.local", false],
    ["/x/y/z", "/x/*", false],
    // unchanged behavior
    ["/tmp", "/tmp/**", true],
    ["/tmp/a/b", "/tmp/**", true],
    ["/tmpx/a", "/tmp/**", false],
    ["/abs/src/a.ts", "src/**", true],
    ["../x", "./**", false],
    // path normalization
    ["/home/u//.ssh/id_rsa", "/home/u/.ssh/id_*", true],
    ["/home/u/./.ssh/id_rsa", "/home/u/.ssh/id_*", true],
    ["/tmp/../etc/passwd", "/tmp/**", false],
    ["/tmp/../etc/passwd", "/etc/**", true],
    ["tmp/x", "/tmp/**", false],
    ["../x", "//**", false],
    ["/x/.env/", "//**/.env", true],
  ];
  for (const [path, pattern, expected] of cases) {
    it(`${JSON.stringify(path)} vs ${JSON.stringify(pattern)} -> ${expected}`, () => {
      strictEqual(matchGitignorePattern(path, pattern), expected);
    });
  }

  // Expected values captured from the implementation before the fix.
  describe("real trailing /** patterns keep their previous results", () => {
    const bases = [
      "/home/u/.claude",
      "/home/u/.local",
      "/home/u/workspace",
      "/home/u/.ssh",
      "/tmp",
    ];
    for (const base of bases) {
      const pattern = `${base}/**`;
      it(pattern, () => {
        strictEqual(matchGitignorePattern(`${base}/a/b`, pattern), true);
        strictEqual(matchGitignorePattern(base, pattern), true);
        strictEqual(matchGitignorePattern(`${base}x/a`, pattern), false);
      });
    }
  });

  it("stays fast on long paths with stacked ** (no backtracking blowup)", () => {
    const longPath = `/${Array(200).fill("a").join("/")}/b`;
    const start = performance.now();
    strictEqual(matchGitignorePattern(longPath, "//**/**/**/**/c"), false);
    const elapsed = performance.now() - start;
    strictEqual(elapsed < 50, true, `took ${elapsed}ms`);
  });
});
