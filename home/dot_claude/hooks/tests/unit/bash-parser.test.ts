#!/usr/bin/env -S bun test

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";

// expect関数のヘルパー（node:assertのラッパー）
const expect = (value: unknown) => ({
  toBe: (expected: unknown) => strictEqual(value, expected),
  toEqual: (expected: unknown) => deepStrictEqual(value, expected),
  toBeTruthy: () => ok(value),
  toBeFalsy: () => ok(!value),
  toBeDefined: () => ok(value !== undefined),
  toHaveLength: (expected: number) =>
    strictEqual((value as { length: number }).length, expected),
  toBeGreaterThanOrEqual: (expected: number) =>
    ok((value as number) >= expected),
  toBeLessThanOrEqual: (expected: number) => ok((value as number) <= expected),
  toContain: (expected: unknown) => ok((value as unknown[]).includes(expected)),
  not: {
    toBe: (expected: unknown) => ok(value !== expected),
    toEqual: (expected: unknown) => {
      try {
        deepStrictEqual(value, expected);
        ok(false); // Should not reach here
      } catch {
        // Expected to fail
      }
    },
    toBeTruthy: () => ok(!value),
    toBeFalsy: () => ok(!!value),
    toContain: (expected: any) => ok(!value.includes(expected)),
  },
});

import type { Tree } from "web-tree-sitter";
import {
  collectExecutableTexts,
  type ExtractedCommands,
  extractBaseCommands,
  extractCommandsStructured,
  parseBashCommand,
} from "../../lib/bash-parser.ts";

describe("bash-parser", () => {
  describe("extractCommandsStructured", () => {
    // The read-only exemption tests rely on these inputs reaching the
    // fallback path (xargs with no command word after it).
    it("returns fallback for grep with an xargs-named argument (node_modules)", async () => {
      const result = await extractCommandsStructured(
        'grep -e "rm" -e "xargs" node_modules/x',
      );
      expect(result.parsingMethod).toBe("fallback");
    });

    it("returns fallback for grep with an xargs-named argument (auto-approve)", async () => {
      const result = await extractCommandsStructured(
        'grep -e "rm -rf /" -e "xargs" spec.md',
      );
      expect(result.parsingMethod).toBe("fallback");
    });

    it("should separate individual commands from original command", async () => {
      const result = await extractCommandsStructured(
        "echo hello && echo world",
      );
      expect(result.individualCommands).toEqual(["echo hello", "echo world"]);
      expect(result.originalCommand).toBe("echo hello && echo world");
      expect(result.parsingMethod).toBe("tree-sitter");
    });

    it("should handle single commands", async () => {
      const result = await extractCommandsStructured("echo hello");
      expect(result.individualCommands).toEqual(["echo hello"]);
      expect(result.originalCommand).toBe(null);
      expect(result.parsingMethod).toBe("tree-sitter");
    });

    it("should handle complex commands with pipes", async () => {
      const result = await extractCommandsStructured(
        "ls -la | grep test | head -5",
      );
      expect(result.individualCommands).toHaveLength(3);
      expect(result.individualCommands).toContain("ls -la");
      expect(result.individualCommands).toContain("grep test");
      expect(result.individualCommands).toContain("head -5");
      expect(result.originalCommand).toBe("ls -la | grep test | head -5");
    });
  });

  describe("parseBashCommand", () => {
    it("should return tree-sitter parsing method when available", async () => {
      const result = await parseBashCommand("echo hello");
      expect(result.parsingMethod).toBe("tree-sitter");
    });

    it("should parse simple command", async () => {
      const result = await parseBashCommand("echo hello");
      expect(result.errors).toHaveLength(0);
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(["hello"]);
    });

    it("should handle empty command", async () => {
      const result = await parseBashCommand("");
      expect(result.commands).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle compound commands with semicolons", async () => {
      const result = await parseBashCommand("echo hello; echo world");
      expect(result.commands).toHaveLength(3); // 2 individual + 1 original
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(["hello"]);
      expect(result.commands[1]?.name).toBe("echo");
      expect(result.commands[1]?.args).toEqual(["world"]);
    });

    it("should handle compound commands with &&", async () => {
      const result = await parseBashCommand("echo hello && echo world");
      expect(result.commands).toHaveLength(3); // 2 individual + 1 original
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo world");
    });

    it("should handle pipe commands", async () => {
      const result = await parseBashCommand("ls -la | grep test");
      expect(result.commands).toHaveLength(3); // 2 individual + 1 original
      expect(result.commands[0]?.name).toBe("ls");
      expect(result.commands[0]?.args).toEqual(["-la"]);
      expect(result.commands[1]?.name).toBe("grep");
      expect(result.commands[1]?.args).toEqual(["test"]);
    });

    it("should handle variable assignments", async () => {
      const result = await parseBashCommand("VAR=value echo hello");
      expect(result.commands).toHaveLength(1);
      const cmd = result.commands[0];
      expect(cmd?.name).toBe("echo");
      expect(cmd?.args).toEqual(["hello"]);
      expect(cmd?.assignments).toEqual(["VAR=value"]);
    });

    it("should handle redirections", async () => {
      const result = await parseBashCommand("echo hello > output.txt");
      expect(result.commands).toHaveLength(1); // Single command with redirection
      const cmd = result.commands[0];
      expect(cmd?.name).toBe("echo");
      expect(cmd?.args).toEqual(["hello"]);
      expect(cmd?.redirections).toEqual([">output.txt"]);
    });

    it("should handle complex redirections", async () => {
      const result = await parseBashCommand("echo hello 2>&1 | grep error");
      expect(result.commands).toHaveLength(2);
      // Commands can be in any order, just verify both are present
      const cmdNames = result.commands.map((cmd) => cmd.name);
      expect(cmdNames).toContain("echo");
      expect(cmdNames).toContain("grep");
    });
  });

  describe("meta command parsing", () => {
    // TODO: Fix tree-sitter-bash WASM loading in CI environment
    // These tests fail because tree-sitter falls back to regex-based parsing
    it.skip("should extract commands from sh -c", async () => {
      const result = await parseBashCommand('sh -c "echo hello && echo world"');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo world");
    });

    it.skip("should extract commands from bash -c", async () => {
      const result = await parseBashCommand('bash -c "ls -la; grep test"');
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0]?.text).toBe("ls -la");
      expect(result.commands[1]?.text).toBe("grep test");
    });

    it.skip("should extract commands from timeout", async () => {
      const result = await parseBashCommand("timeout 30 echo hello");
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.text).toBe("echo hello");
    });

    // TODO: Fix tree-sitter-bash WASM loading in CI environment
    // These tests fail because tree-sitter falls back to regex-based parsing
    // which has different command extraction behavior
    it.skip("should extract commands from xargs", async () => {
      const result = await parseBashCommand(
        'git diff --name-only | xargs -I {} sh -c "echo {}; wc -l {}"',
      );
      expect(result.commands).toHaveLength(3);
      expect(result.commands[0]?.text).toBe("git diff --name-only");
      expect(result.commands[1]?.text).toBe("echo {}");
      expect(result.commands[2]?.text).toBe("wc -l {}");
    });

    it.skip("should handle nested meta commands", async () => {
      const result = await parseBashCommand(
        "timeout 60 bash -c \"xargs -I {} sh -c 'echo {}'\"",
      );
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.text).toBe("echo {}");
    });
  });

  describe("control structure parsing", () => {
    // TODO: Fix tree-sitter-bash WASM loading in CI environment
    it.skip("should extract commands from for loops", async () => {
      const result = await parseBashCommand(
        "for f in *.ts; do echo $f; wc -l $f; done",
      );
      expect(result.commands).toHaveLength(3); // 2 individual + 1 original
      expect(result.commands[0]?.text).toBe("echo $f");
      expect(result.commands[1]?.text).toBe("wc -l $f");
    });

    // TODO: Fix tree-sitter-bash WASM loading in CI environment
    it.skip("should handle simple for loop", async () => {
      const result = await parseBashCommand("for f in *; do echo $f; done");
      expect(result.commands).toHaveLength(2); // 1 individual + 1 original
      expect(result.commands[0]?.text).toBe("echo $f");
    });
  });

  describe("edge cases", () => {
    it("should handle commands with quotes", async () => {
      const result = await parseBashCommand('echo "hello world"');
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]?.name).toBe("echo");
      expect(result.commands[0]?.args).toEqual(['"hello world"']);
    });

    // TODO: Fix tree-sitter-bash WASM loading in CI environment
    it.skip("should filter out control keywords", async () => {
      const result = await parseBashCommand(
        "if echo hello; then echo world; fi",
      );
      // Should extract individual commands but may include original compound command
      const cmdNames = result.commands.map((cmd) => cmd.name).filter(Boolean);
      expect(cmdNames).toContain("echo"); // Should include the actual commands
      // Note: may include 'if' as part of the original command text
    });

    it("should handle malformed commands gracefully", async () => {
      const result = await parseBashCommand("echo hello &&");
      // Should not crash and should provide some reasonable output
      expect(result.errors).toHaveLength(0); // Fallback should be forgiving
      expect(result.commands.length).toBeGreaterThanOrEqual(1);
    });

    it("should deduplicate commands", async () => {
      const result = await parseBashCommand("echo hello; echo hello");
      // Should have 3 commands: 2 individual + 1 original
      expect(result.commands).toHaveLength(3);
      expect(result.commands[0]?.text).toBe("echo hello");
      expect(result.commands[1]?.text).toBe("echo hello");
    });
  });

  // Legacy compatibility tests removed - use extractCommandsStructured instead

  describe("SimpleCommand structure", () => {
    it("should include range information", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      if (cmd?.range.start === undefined || cmd?.range.end === undefined) {
        throw new Error("Range start or end is undefined");
      }
      expect(cmd.range).toBeDefined();
      expect(typeof cmd.range.start).toBe("number");
      expect(typeof cmd.range.end).toBe("number");
      expect(cmd.range.start).toBeLessThanOrEqual(cmd.range.end);
    });

    it("should include path information", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      expect(cmd?.path).toBeDefined();
      expect(Array.isArray(cmd?.path)).toBe(true);
      expect(cmd?.path[0]).toContain("tree-sitter");
    });

    it("should include original text", async () => {
      const result = await parseBashCommand("echo hello");
      const cmd = result.commands[0];
      expect(cmd?.text).toBe("echo hello");
    });
  });
});

describe("extractCommandsStructured: superset for the deny side (spec K3)", () => {
  // Outputs of extractCommandsStructured before K3 (recorded at d29a171).
  // extractBaseCommands must keep returning exactly these.
  const BASE_GOLDEN: Array<[string, ExtractedCommands]> = [
    [
      "ls -la",
      {
        individualCommands: ["ls -la"],
        originalCommand: null,
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "cd x && pnpm test",
      {
        individualCommands: ["cd x", "pnpm test"],
        originalCommand: "cd x && pnpm test",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "git push --force origin main $(pwd)",
      {
        individualCommands: ["pwd"],
        originalCommand: "git push --force origin main $(pwd)",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "time ls\nzz a",
      {
        individualCommands: ["ls"],
        originalCommand: "time ls\nzz a",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "git push --force origin main <<EOF\nhi\nEOF\nls yy",
      {
        individualCommands: ["ls yy"],
        originalCommand: "git push --force origin main <<EOF\nhi\nEOF\nls yy",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "bash <<EOF\ntouch zz\nEOF",
      {
        individualCommands: ["<<EOF"],
        originalCommand: "bash <<EOF\ntouch zz\nEOF",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "bash -c 'ls; pwd'",
      {
        individualCommands: ["ls", "pwd"],
        originalCommand: "bash -c 'ls; pwd'",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "echo `ls \\`zz a\\` pwd`",
      {
        individualCommands: ["ls \\", "pwd"],
        originalCommand: "echo `ls \\`zz a\\` pwd`",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "for f in a b; do echo $f; done",
      {
        individualCommands: ["echo $f"],
        originalCommand: "for f in a b; do echo $f; done",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "ls; (cd x && ls)",
      {
        individualCommands: ["ls", "cd x", "ls"],
        originalCommand: "ls; (cd x && ls)",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
      {
        individualCommands: ["cat <<'EOF'\nmsg\nEOF"],
        originalCommand: "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
        parsingMethod: "tree-sitter",
      },
    ],
    [
      "if [ -f x ]; then ls; fi",
      {
        individualCommands: ["ls"],
        originalCommand: "if [ -f x ]; then ls; fi",
        parsingMethod: "tree-sitter",
      },
    ],
  ];

  for (const [cmd, expected] of BASE_GOLDEN) {
    it(`extractBaseCommands keeps the pre-K3 fragments: ${JSON.stringify(cmd)}`, async () => {
      deepStrictEqual(await extractBaseCommands(cmd), expected);
    });
    it(`extractCommandsStructured keeps them as a prefix: ${JSON.stringify(cmd)}`, async () => {
      const full = await extractCommandsStructured(cmd);
      deepStrictEqual(
        full.individualCommands.slice(0, expected.individualCommands.length),
        expected.individualCommands,
      );
      strictEqual(full.parsingMethod, expected.parsingMethod);
      strictEqual(full.originalCommand, expected.originalCommand);
    });
  }

  const texts = async (cmd: string) =>
    (await extractCommandsStructured(cmd)).individualCommands;

  it("adds the outer command around a substitution", async () => {
    ok(
      (await texts("git push --force origin main $(pwd)")).includes(
        "git push --force origin main $(pwd)",
      ),
    );
  });

  it("adds the lines after a meta-command head", async () => {
    ok((await texts("time ls\nzz a")).includes("zz a"));
    ok(
      (await texts(`time ls ${"a".repeat(100001)}\ncp x y`)).includes("cp x y"),
    );
  });

  it("adds a heredoc statement whole, and the whole text, when a heredoc is present", async () => {
    const cmd = "git push --force origin main <<EOF\nhi\nEOF\nls yy";
    const got = await texts(cmd);
    ok(got.includes("git push --force origin main <<EOF\nhi\nEOF"));
    ok(got.includes(cmd));
  });

  it("adds the whole text for a shell fed by a heredoc, equal to originalCommand", async () => {
    const cmd = "bash <<EOF\ntouch zz\nEOF";
    const full = await extractCommandsStructured(cmd);
    ok(full.individualCommands.includes(cmd));
    strictEqual(full.originalCommand, cmd);
  });

  it("adds the whole text for backticks and for a parse error", async () => {
    const backticks = "echo `ls \\`zz a\\` pwd`";
    ok((await texts(backticks)).includes(backticks));
    const unclosed = "ls 'x && zz a";
    ok((await texts(unclosed)).includes(unclosed));
  });

  it("does not add the whole text or a compound statement when the AST covers the input", async () => {
    const plain = await texts("ls && rm foo && pwd");
    ok(!plain.includes("ls && rm foo && pwd"));
    // The base fragmentation already returns these compound statements whole
    // (measured at d29a171; a pre-existing deny-node-modules false positive left
    // to F3b). What K3 must not do is add them whole again from the AST, while
    // it does add their inner commands.
    for (const cmd of [
      "(rm foo; ls bar) 2>&1",
      "{ rm foo; ls bar; } > out",
      "while true; do rm foo; ls bar; done > log",
    ]) {
      const added = await collectExecutableTexts(cmd, "tree-sitter");
      ok(!added.includes(cmd), `${JSON.stringify(cmd)} was added whole`);
      ok(
        added.includes("rm foo") && added.includes("ls bar"),
        JSON.stringify(added),
      );
    }
  });
});

describe("collectExecutableTexts (spec K3 (a)(b))", () => {
  it("falls back to the whole text and coarse pieces when the parse returns null", async () => {
    deepStrictEqual(
      await collectExecutableTexts(
        "time ls\ncp x y",
        "tree-sitter",
        async () => null,
      ),
      ["time ls\ncp x y", "time ls", "cp x y"],
    );
  });

  it("falls back the same way when the parse throws", async () => {
    deepStrictEqual(
      await collectExecutableTexts("ls && pwd", "tree-sitter", async () => {
        throw new Error("boom");
      }),
      ["ls && pwd", "ls", "pwd"],
    );
  });

  it("adds the whole text under fallback parsing", async () => {
    ok(
      (await collectExecutableTexts("ls && pwd", "fallback")).includes(
        "ls && pwd",
      ),
    );
  });

  it("returns plain command statements, outer redirect first, for a covered input", async () => {
    deepStrictEqual(
      await collectExecutableTexts("ls 2>&1 && pwd", "tree-sitter"),
      ["ls 2>&1", "ls", "pwd"],
    );
  });

  it("adds the whole text and coarse pieces when only hasError is set", async () => {
    const fakeTree = {
      rootNode: { hasError: true, descendantsOfType: () => [] },
      delete: () => {},
    } as unknown as Tree;
    deepStrictEqual(
      await collectExecutableTexts(
        "ls && pwd",
        "tree-sitter",
        async () => fakeTree,
      ),
      ["ls && pwd", "ls", "pwd"],
    );
  });

  it("adds only the redirect target of a compound or empty-body statement", async () => {
    const compound = await collectExecutableTexts(
      "ls; ( echo x ) > plan.md",
      "tree-sitter",
    );
    ok(compound.includes("> plan.md"), JSON.stringify(compound));
    ok(!compound.includes("( echo x ) > plan.md"), JSON.stringify(compound));
    const empty = await collectExecutableTexts("ls; > out.ts", "tree-sitter");
    ok(empty.includes("> out.ts"), JSON.stringify(empty));
    const fn = await collectExecutableTexts(
      "f() { echo x; } > plan.md; f",
      "tree-sitter",
    );
    ok(fn.includes("> plan.md"), JSON.stringify(fn));
    for (const [cmd, target] of [
      ["cat <<EOF > plan.md\nx\nEOF", "> plan.md"],
      ["echo a | tee b > plan.md", "> plan.md"],
      ["{ echo; } > a.md 2> b.md", "2> b.md"],
    ]) {
      const got = await collectExecutableTexts(cmd as string, "tree-sitter");
      ok(
        got.includes(target as string),
        `${JSON.stringify(cmd)}: ${JSON.stringify(got)}`,
      );
    }
    const covered = await collectExecutableTexts(
      "ls 2>&1 > out",
      "tree-sitter",
    );
    ok(
      !covered.includes("2>&1") && !covered.includes("> out"),
      JSON.stringify(covered),
    );
  });

  it("is the only parser entry permission-analyzer uses, and no deny-side module imports extractBaseCommands", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const hooksDir = join(import.meta.dirname, "..", "..");
    const users: string[] = [];
    for (const dir of ["lib", "implementations"]) {
      for (const file of readdirSync(join(hooksDir, dir))) {
        if (!file.endsWith(".ts") || file === "bash-parser.ts") continue;
        if (
          readFileSync(join(hooksDir, dir, file), "utf8").includes(
            "extractBaseCommands",
          )
        ) {
          users.push(`${dir}/${file}`);
        }
      }
    }
    deepStrictEqual(users, ["lib/permission-analyzer.ts"]);
  });

  it("returns nothing for blank input", async () => {
    deepStrictEqual(await collectExecutableTexts("  \n", "tree-sitter"), []);
    deepStrictEqual(
      await collectExecutableTexts("  \n", "tree-sitter", async () => null),
      [],
    );
  });
});

describe("for-loop body splitting (Issue #219 H)", () => {
  it("keeps the command list for a body with padded and doubled semicolons", async () => {
    const command = 'bash -c "for x in a; do echo y ; ls ;; done"';
    deepStrictEqual(await extractCommandsStructured(command), {
      individualCommands: ["echo y", "ls", command],
      originalCommand: command,
      parsingMethod: "tree-sitter",
    });
  });

  it("splits a body with a long blank run in linear time", async () => {
    const command = `bash -c "for x in a; do echo${" ".repeat(100000)}y; done"`;
    const start = Date.now();
    await extractCommandsStructured(command);
    ok(Date.now() - start < 1000);
  });
});
