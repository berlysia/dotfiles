import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  checkPattern,
  isSafeBuiltinCommand,
  matchAnchoredBashAllow,
  matchGitignorePattern,
  parseBashPattern,
} from "../../lib/pattern-matcher.ts";

const ctx = { cwd: "/repo", home: "/home/u" };

describe("Pattern matching validation", () => {
  it("should reject Bash(**) pattern", async () => {
    const result = await checkPattern(
      "Bash(**)",
      "Bash",
      {
        command: "echo hello",
      },
      ctx,
      "allow",
    );
    strictEqual(result, false, "Bash(**) should be rejected");
  });

  it("should accept valid Bash patterns", async () => {
    const result1 = await checkPattern(
      "Bash(echo *)",
      "Bash",
      {
        command: "echo hello world",
      },
      ctx,
      "allow",
    );
    strictEqual(result1, true, "Bash(echo *) should match echo commands");

    const result2 = await checkPattern(
      "Bash(npm *)",
      "Bash",
      {
        command: "npm install lodash",
      },
      ctx,
      "allow",
    );
    strictEqual(result2, true, "Bash(npm *) should match npm commands");
  });

  it("should accept Read(**) pattern", async () => {
    const result = await checkPattern(
      "Read(**)",
      "Read",
      {
        file_path: "/repo/any/file.txt",
      },
      ctx,
      "allow",
    );
    strictEqual(result, true, "Read(**) should match all files under cwd");
    strictEqual(
      await checkPattern(
        "Read(**)",
        "Read",
        { file_path: "/any/path/file.txt" },
        ctx,
        "allow",
      ),
      false,
      "Read(**) should not match files outside cwd",
    );
  });

  it("should accept Edit(**) pattern", async () => {
    const result = await checkPattern(
      "Edit(**)",
      "Edit",
      {
        file_path: "/repo/any/file.txt",
        old_string: "old",
        new_string: "new",
      },
      ctx,
      "allow",
    );
    strictEqual(result, true, "Edit(**) should match all files under cwd");
    strictEqual(
      await checkPattern(
        "Edit(**)",
        "Edit",
        {
          file_path: "/any/path/file.txt",
          old_string: "old",
          new_string: "new",
        },
        ctx,
        "allow",
      ),
      false,
      "Edit(**) should not match files outside cwd",
    );
  });

  it("should handle gitignore-style patterns correctly", async () => {
    // Test basic ** pattern
    strictEqual(
      matchGitignorePattern("/repo/path/to/file.txt", "**", ctx, "grant"),
      true,
      "** should match everything under cwd",
    );
    strictEqual(
      matchGitignorePattern("/path/to/file.txt", "**", ctx, "grant"),
      false,
      "** should not match outside cwd",
    );

    // Test ./** pattern (should match any relative path)
    strictEqual(
      matchGitignorePattern("src", "./**", ctx, "grant"),
      true,
      "./** should match relative paths without ./ prefix",
    );
    strictEqual(
      matchGitignorePattern("src/scenarios", "./**", ctx, "grant"),
      true,
      "./** should match nested relative paths",
    );
    strictEqual(
      matchGitignorePattern("./src", "./**", ctx, "grant"),
      true,
      "./** should match paths with ./ prefix",
    );

    // Test directory patterns
    strictEqual(
      matchGitignorePattern(
        "/repo/src/components/Button.tsx",
        "src/**",
        ctx,
        "grant",
      ),
      true,
      "src/** should match files in src/",
    );
    strictEqual(
      matchGitignorePattern(
        "/src/components/Button.tsx",
        "src/**",
        ctx,
        "grant",
      ),
      false,
      "src/** as an allow should not match outside cwd",
    );
    strictEqual(
      matchGitignorePattern("/repo/vendor/src/a.ts", "src/**", ctx, "grant"),
      false,
      "src/** as an allow should not match a nested src",
    );
    strictEqual(
      matchGitignorePattern("/repo/vendor/src/a.ts", "src/**", ctx, "restrict"),
      true,
      "src/** as a deny matches a nested src",
    );
    strictEqual(
      matchGitignorePattern("/lib/utils.ts", "src/**", ctx, "grant"),
      false,
      "src/** should not match files outside src/",
    );

    // Test file extension patterns
    strictEqual(
      matchGitignorePattern("/repo/path/file.ts", "*.ts", ctx, "grant"),
      true,
      "*.ts should match TypeScript files",
    );
    strictEqual(
      matchGitignorePattern("/path/file.ts", "*.ts", ctx, "grant"),
      false,
      "*.ts should not match outside cwd",
    );
    strictEqual(
      matchGitignorePattern("/path/file.js", "*.ts", ctx, "grant"),
      false,
      "*.ts should not match JavaScript files",
    );

    // Test negation patterns
    const result = await checkPattern(
      "Edit(!node_modules/**)",
      "Edit",
      {
        file_path: "/project/node_modules/package/index.js",
        old_string: "old",
        new_string: "new",
      },
      ctx,
      "allow",
    );
    strictEqual(
      result,
      false,
      "!node_modules/** should exclude node_modules files",
    );
    strictEqual(
      await checkPattern(
        "Edit(!node_modules/**)",
        "Edit",
        { file_path: "/repo/src/a.ts", old_string: "o", new_string: "n" },
        ctx,
        "allow",
      ),
      false,
      "a negated pattern matches nothing",
    );
  });

  it("should handle tool name exact matching", async () => {
    const result1 = await checkPattern(
      "Read",
      "Read",
      {
        file_path: "/path/file.txt",
      },
      ctx,
      "allow",
    );
    strictEqual(result1, true, "Tool name should match exactly");

    const result2 = await checkPattern(
      "Read",
      "Write",
      {
        file_path: "/path/file.txt",
      },
      ctx,
      "allow",
    );
    strictEqual(result2, false, "Tool name should not match different tool");
  });

  it("should reject parent directory traversal in ./** pattern", async () => {
    // Test directory traversal attempts
    strictEqual(
      matchGitignorePattern("../etc/passwd", "./**", ctx, "grant"),
      false,
      "./** should reject ../ at start",
    );
    strictEqual(
      matchGitignorePattern("../../etc/passwd", "./**", ctx, "grant"),
      false,
      "./** should reject ../../ at start",
    );
    strictEqual(
      matchGitignorePattern("foo/../../../etc/passwd", "./**", ctx, "grant"),
      false,
      "./** should reject /../ in middle",
    );
    strictEqual(
      matchGitignorePattern("~/../../etc/passwd", "./**", ctx, "grant"),
      false,
      "./** should reject traversal with tilde",
    );

    // Test legitimate paths still work
    strictEqual(
      matchGitignorePattern("src", "./**", ctx, "grant"),
      true,
      "./** should allow relative paths",
    );
    strictEqual(
      matchGitignorePattern("./src/foo", "./**", ctx, "grant"),
      true,
      "./** should allow ./ prefixed paths",
    );
  });

  it("should reject parent directory traversal in ** pattern", async () => {
    // Test ** pattern also rejects traversal
    strictEqual(
      matchGitignorePattern("../secret", "**", ctx, "grant"),
      false,
      "** should reject parent directory traversal",
    );
    strictEqual(
      matchGitignorePattern("foo/../../bar", "**", ctx, "grant"),
      false,
      "** should reject traversal in middle",
    );

    // Test legitimate paths still work
    strictEqual(
      matchGitignorePattern("any/path/here", "**", ctx, "grant"),
      true,
      "** should allow normal paths",
    );
  });

  it("should reject directory traversal in checkPattern for tools", async () => {
    // Test that tool patterns also reject traversal
    const grepResult = await checkPattern(
      "Grep(./**)",
      "Grep",
      {
        path: "../etc/passwd",
        pattern: "test",
      },
      ctx,
      "allow",
    );
    strictEqual(
      grepResult,
      false,
      "Grep(./**) should reject parent directory traversal",
    );

    const readResult = await checkPattern(
      "Read(./**)",
      "Read",
      {
        file_path: "../../etc/passwd",
      },
      ctx,
      "allow",
    );
    strictEqual(
      readResult,
      false,
      "Read(./**) should reject parent directory traversal",
    );

    const editResult = await checkPattern(
      "Edit(./**)",
      "Edit",
      {
        file_path: "foo/../../../bar",
        old_string: "a",
        new_string: "b",
      },
      ctx,
      "allow",
    );
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
      await checkPattern(
        "Bash(pnpm *)",
        "Bash",
        {
          command: "evil --x pnpm test",
        },
        ctx,
        "allow",
      ),
      true,
    );
    strictEqual(
      await checkPattern("Bash", "Bash", { command: "anything" }, ctx, "allow"),
      true,
    );
    strictEqual(
      await checkPattern("Bash(**)", "Bash", { command: "ls" }, ctx, "allow"),
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
    ["/abs/src/a.ts", "src/**", false],
    ["/repo/src/a.ts", "src/**", true],
    ["../x", "./**", false],
    // path normalization
    ["/home/u//.ssh/id_rsa", "/home/u/.ssh/id_*", true],
    ["/home/u/./.ssh/id_rsa", "/home/u/.ssh/id_*", true],
    ["/tmp/../etc/passwd", "/tmp/**", false],
    ["/tmp/../etc/passwd", "/etc/**", true],
    ["tmp/x", "/tmp/**", false],
    ["../x", "//**", true],
    ["/x/.env/", "//**/.env", true],
  ];
  for (const [path, pattern, expected] of cases) {
    it(`${JSON.stringify(path)} vs ${JSON.stringify(pattern)} -> ${expected}`, () => {
      strictEqual(matchGitignorePattern(path, pattern, ctx, "grant"), expected);
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
        strictEqual(
          matchGitignorePattern(`${base}/a/b`, pattern, ctx, "grant"),
          true,
        );
        strictEqual(matchGitignorePattern(base, pattern, ctx, "grant"), true);
        strictEqual(
          matchGitignorePattern(`${base}x/a`, pattern, ctx, "grant"),
          false,
        );
      });
    }
  });

  it("stays fast on long paths with stacked ** (no backtracking blowup)", () => {
    const longPath = `/${Array(200).fill("a").join("/")}/b`;
    const start = performance.now();
    strictEqual(
      matchGitignorePattern(longPath, "//**/**/**/**/c", ctx, "grant"),
      false,
    );
    strictEqual(
      matchGitignorePattern(`/repo${longPath}`, ".env", ctx, "restrict"),
      false,
    );
    const elapsed = performance.now() - start;
    strictEqual(elapsed < 50, true, `took ${elapsed}ms`);
  });
});

describe("find start path under temp roots", () => {
  const cases: [string, boolean][] = [
    ["find /tmp -name x", true],
    ["find /tmp/a -name x", true],
    ["find /tmpx/y -name x", false],
    ["find /tmp/../etc -name x", false],
    ["find /var/tmp/a -name x", true],
    ["find /var/tmpx -name x", false],
  ];
  for (const [command, expected] of cases) {
    it(`${command} -> ${expected}`, () => {
      strictEqual(isSafeBuiltinCommand(command), expected);
    });
  }
});

describe("matchGitignorePattern follows the documented Claude Code rules", () => {
  // The four rows of the table in the Claude Code permissions doc.
  const doc: Array<[string, "grant" | "restrict", string, boolean]> = [
    ["src/**", "grant", "/repo/src/app.ts", true],
    ["src/**", "grant", "/repo/vendor/pkg/src/lib.js", false],
    ["src/**", "restrict", "/repo/src/app.ts", true],
    ["src/**", "restrict", "/repo/vendor/pkg/src/lib.js", true],
    ["**/src/**", "grant", "/repo/vendor/pkg/src/lib.js", true],
    ["**/src/**", "restrict", "/repo/src/app.ts", true],
    [".env", "restrict", "/repo/a/.env", true],
    [".env", "restrict", "/repo/a/.env/x", true],
    ["**/.env", "restrict", "/repo/a/.env/x", true],
    [".env", "restrict", "/other/.env", false],
    [".env", "grant", "/repo/a/.env/x", false],
  ];
  for (const [pattern, kind, path, expected] of doc) {
    it(`${pattern} as ${kind} vs ${path} -> ${expected}`, () => {
      strictEqual(matchGitignorePattern(path, pattern, ctx, kind), expected);
    });
  }

  const wf = ".tmp/sessions/*/*.md";
  const wfCases: Array<[string, boolean]> = [
    ["/repo/.tmp/sessions/a/research.md", true],
    ["/repo/.tmp/sessions/../../home/dot_apm/apm.yml", false],
    ["/repo/x.tmp/sessions/a/evil.md", false],
    ["/other/.tmp/sessions/a/plan.md", false],
    ["/repo/.tmp/sessions/a/reviewer-runs.log", false],
    ["/repo/.tmp/sessions/a/sub/x.md", false],
  ];
  for (const [path, expected] of wfCases) {
    it(`${wf} vs ${path} -> ${expected}`, () => {
      strictEqual(matchGitignorePattern(path, wf, ctx, "grant"), expected);
    });
  }

  it("matches the base itself for ./** and nothing above it", () => {
    strictEqual(matchGitignorePattern("/repo", "./**", ctx, "grant"), true);
    strictEqual(matchGitignorePattern(".", "./**", ctx, "grant"), true);
    strictEqual(matchGitignorePattern("/", "./**", ctx, "grant"), false);
  });

  it("matches a wildcard-free absolute or home pattern exactly", () => {
    strictEqual(
      matchGitignorePattern("/etc/passwd", "/etc/passwd", ctx, "restrict"),
      true,
    );
    strictEqual(
      matchGitignorePattern("/etc/passwd/x", "/etc/passwd", ctx, "restrict"),
      false,
    );
    strictEqual(
      matchGitignorePattern("/home/u/.zshrc", "~/.zshrc", ctx, "grant"),
      true,
    );
  });

  it("guards the exact path for an unusable deny pattern", () => {
    strictEqual(matchGitignorePattern("/x", "../x", ctx, "restrict"), true);
    strictEqual(matchGitignorePattern("/x/y", "../x", ctx, "restrict"), false);
    strictEqual(matchGitignorePattern("/x", "../x", ctx, "grant"), false);
  });

  it("does not match a look-alike sibling of the base", () => {
    strictEqual(
      matchGitignorePattern("/repo-evil/x", "./**", ctx, "grant"),
      false,
    );
    strictEqual(
      matchGitignorePattern("/repo-evil/x", "**", ctx, "grant"),
      false,
    );
    strictEqual(
      matchGitignorePattern(
        "/home/u-evil/.config/a",
        "~/.config/**",
        ctx,
        "grant",
      ),
      false,
    );
  });

  it("folds .. before matching, for allow and for deny", () => {
    for (const escaping of ["/repo/../etc/passwd", "~/../../etc/passwd"]) {
      strictEqual(matchGitignorePattern(escaping, "./**", ctx, "grant"), false);
      strictEqual(
        matchGitignorePattern(escaping, "~/.config/**", ctx, "grant"),
        false,
      );
      strictEqual(
        matchGitignorePattern(escaping, "/etc/**", ctx, "restrict"),
        true,
      );
    }
  });

  it("matches a deny when cwd or home is not normalized", () => {
    const dirty = { cwd: "/repo/.", home: "/home//u" };
    strictEqual(
      matchGitignorePattern("/repo/.env", "./.env", dirty, "restrict"),
      true,
    );
    strictEqual(
      matchGitignorePattern("/home/u/.ssh/id", "~/.ssh/**", dirty, "restrict"),
      true,
    );
  });

  it("anchors relative patterns at / when cwd is /", () => {
    // With cwd "/", "./**" covers the whole filesystem; that is what the rule says.
    strictEqual(
      matchGitignorePattern(
        "/etc/x",
        "./**",
        { cwd: "/", home: "/home/u" },
        "grant",
      ),
      true,
    );
  });

  it("never matches an empty target", () => {
    strictEqual(matchGitignorePattern("", "./**", ctx, "grant"), false);
    strictEqual(matchGitignorePattern("", "**", ctx, "restrict"), false);
  });
});

describe("checkPattern rule names and negation", () => {
  const input = { file_path: "/repo/src/a.ts", content: "x" };
  it("judges Write, MultiEdit and NotebookEdit against Edit rules", async () => {
    strictEqual(
      await checkPattern("Edit(./**)", "Write", input, ctx, "allow"),
      true,
    );
    strictEqual(
      await checkPattern("Edit(./**)", "MultiEdit", input, ctx, "allow"),
      true,
    );
    strictEqual(
      await checkPattern(
        "Edit(./**)",
        "NotebookEdit",
        { notebook_path: "/repo/n.ipynb" },
        ctx,
        "allow",
      ),
      true,
    );
    strictEqual(
      await checkPattern(
        "Edit(/etc/**)",
        "Write",
        { file_path: "/etc/hosts", content: "x" },
        ctx,
        "deny",
      ),
      true,
    );
    strictEqual(await checkPattern("Edit", "Write", input, ctx, "allow"), true);
  });
  it("does not judge Edit against Write rules or Grep against Read rules", async () => {
    strictEqual(
      await checkPattern("Write(./**)", "Edit", input, ctx, "allow"),
      false,
    );
    strictEqual(
      await checkPattern(
        "Read(./**)",
        "Grep",
        { path: "/repo/src", pattern: "x" },
        ctx,
        "allow",
      ),
      false,
    );
  });
  it("never matches a pattern that starts with !", async () => {
    strictEqual(
      await checkPattern(
        "Edit(!.git/**)",
        "Edit",
        { file_path: "/etc/hosts" },
        ctx,
        "allow",
      ),
      false,
    );
    strictEqual(
      await checkPattern("Edit(!.git/**)", "Edit", input, ctx, "allow"),
      false,
    );
    strictEqual(
      await checkPattern("Edit(!.git/**)", "Edit", input, ctx, "deny"),
      false,
    );
  });
  it("uses restrict depth for the deny list", async () => {
    const nested = { file_path: "/repo/vendor/secrets/k" };
    strictEqual(
      await checkPattern("Read(secrets/**)", "Read", nested, ctx, "deny"),
      true,
    );
    strictEqual(
      await checkPattern("Read(secrets/**)", "Read", nested, ctx, "allow"),
      false,
    );
  });
  it("keeps reading a rule without a closing parenthesis the way it did", async () => {
    // slice(…, -1) drops the last character whatever it is: "Edit(/etc/**" is read as "/etc/*".
    const rule = "Edit(/etc/**";
    strictEqual(
      await checkPattern(
        rule,
        "Write",
        { file_path: "/etc/hosts" },
        ctx,
        "deny",
      ),
      true,
    );
    strictEqual(
      await checkPattern(
        rule,
        "Write",
        { file_path: "/etc/hosts/x" },
        ctx,
        "deny",
      ),
      false,
    );
  });
});
