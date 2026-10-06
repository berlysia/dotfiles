#!/usr/bin/env node --test
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findRepoToplevel,
  isProseOnlyChange,
  isProtectedPath,
  MAX_SCOPE_ENTRIES,
  listsTarget,
  parseFilesPaths,
  parseScope,
  planFilesWithinScope,
  scopeRowsForOffer,
  targetWithinScope,
} from "../../lib/workflow-files.ts";

const doc = (block: string) =>
  `# Plan\n\n## Files\n\n\`\`\`\n${block}\n\`\`\`\n\n## Tasks\n`;

describe("workflow-files: parseFilesPaths", () => {
  it("returns raw relative paths, skipping # comments and blank lines", () => {
    deepStrictEqual(
      parseFilesPaths(doc("# 編集\na/b.ts\n\n.skills/x/SKILL.md")),
      ["a/b.ts", ".skills/x/SKILL.md"],
    );
  });
  it("drops a block that contains a line with internal whitespace", () => {
    deepStrictEqual(parseFilesPaths(doc("a/b.ts\nfoo bar.md")), []);
  });
  it("returns [] when there is no ## Files section", () => {
    deepStrictEqual(parseFilesPaths("# Spec\n\n## Goal\nx\n"), []);
  });
});

describe("workflow-files: isProseOnlyChange", () => {
  it("true when every path is prose (.md/.mdx/.markdown/.txt/.rst/.adoc)", () => {
    strictEqual(
      isProseOnlyChange(
        doc(".skills/a/SKILL.md\nhome/dot_claude/rules/x.md\nnotes.txt"),
      ),
      true,
    );
  });
  it("strips a trailing .tmpl before judging", () => {
    strictEqual(
      isProseOnlyChange(doc("home/dot_claude/templates/context.md.tmpl")),
      true,
    );
    strictEqual(
      isProseOnlyChange(doc("home/.chezmoiscripts/run.sh.tmpl")),
      false,
    );
  });
  it("false when any path is code", () => {
    strictEqual(
      isProseOnlyChange(doc("a/SKILL.md\nhome/dot_claude/hooks/lib/x.ts")),
      false,
    );
  });
  it("false when Files is missing or empty (falls back to keyword selection)", () => {
    strictEqual(isProseOnlyChange("# Spec\n\n## Goal\nx\n"), false);
    strictEqual(isProseOnlyChange(doc("# only a comment")), false);
  });
});

/**
 * <root>/.git/ (a real git dir), a linked worktree at <root>/.git/worktree/<name>
 * whose .git file points at <root>/.git/worktrees/<name>, as git lays it out.
 */
function repoWithWorktree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-files-")));
  return { root, worktree: addWorktree(root, "b") };
}

function addWorktree(root: string, name: string): string {
  mkdirSync(join(root, ".git", "worktrees", name), { recursive: true });
  const worktree = join(root, ".git", "worktree", name);
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(
    join(worktree, ".git"),
    `gitdir: ${join(root, ".git", "worktrees", name)}\n`,
  );
  return worktree;
}

describe("workflow-files: findRepoToplevel (spec K2)", () => {
  it("returns the project root for a file in the main checkout", () => {
    const { root } = repoWithWorktree();
    strictEqual(findRepoToplevel(join(root, "src", "a.ts"), root), root);
  });

  it("returns a linked worktree of the same repository", () => {
    const { root, worktree } = repoWithWorktree();
    strictEqual(
      findRepoToplevel(join(worktree, "src", "a.ts"), root),
      worktree,
    );
  });

  it("accepts a relative gitdir, resolved from the worktree dir", () => {
    const { root, worktree } = repoWithWorktree();
    writeFileSync(join(worktree, ".git"), "gitdir: ../../worktrees/b\n");
    strictEqual(
      findRepoToplevel(join(worktree, "src", "a.ts"), root),
      worktree,
    );
  });

  it("falls back to the root for a nested clone with its own .git dir", () => {
    const { root } = repoWithWorktree();
    mkdirSync(join(root, "vendor", "x", ".git"), { recursive: true });
    strictEqual(
      findRepoToplevel(join(root, "vendor", "x", "src", "a.ts"), root),
      root,
    );
  });

  it("rejects a sibling worktree when the session root is itself a worktree", () => {
    const { root, worktree: b } = repoWithWorktree();
    const c = addWorktree(root, "c");
    // b is the session root. Its .git is a file, so no gitdir can point under
    // <b>/.git/worktrees/; c's gitdir points under <root>/.git/worktrees/.
    strictEqual(findRepoToplevel(join(c, "src", "a.ts"), b), b);
    strictEqual(listsTarget(doc("src/a.ts"), join(c, "src", "a.ts"), b), false);
  });

  it("does not look above the project root", () => {
    const { root } = repoWithWorktree();
    const inner = join(root, "pkg");
    mkdirSync(inner);
    strictEqual(findRepoToplevel(join(inner, "a.ts"), inner), inner);
  });
});

describe("workflow-files: listsTarget (spec K2)", () => {
  const plan = (block: string) => doc(block);

  it("matches a relative entry against the worktree the target lives in", () => {
    const { root, worktree } = repoWithWorktree();
    strictEqual(
      listsTarget(plan("src/a.ts"), join(worktree, "src", "a.ts"), root),
      true,
    );
    strictEqual(
      listsTarget(plan("src/a.ts"), join(root, "src", "a.ts"), root),
      true,
    );
  });

  it("does not match the same relative path in a nested clone", () => {
    const { root } = repoWithWorktree();
    mkdirSync(join(root, "vendor", "x", ".git"), { recursive: true });
    strictEqual(
      listsTarget(
        plan("src/a.ts"),
        join(root, "vendor", "x", "src", "a.ts"),
        root,
      ),
      false,
    );
  });

  it("compares absolute entries by realpath", () => {
    const { root } = repoWithWorktree();
    strictEqual(
      listsTarget(
        plan(join(root, "src", "a.ts")),
        join(root, "src", "a.ts"),
        root,
      ),
      true,
    );
  });
});

describe("parseScope", () => {
  const spec = (block: string) =>
    `# Spec\n\n## Scope\n\n\`\`\`\n${block}\n\`\`\`\n\n## Key Decisions\n`;

  it("returns the entries of a valid Scope", () => {
    deepStrictEqual(parseScope(spec("src/\nlib/a.ts")), {
      valid: true,
      entries: ["src/", "lib/a.ts"],
    });
  });

  it("is invalid without a Scope section or with no entry", () => {
    deepStrictEqual(parseScope("# Spec\n\n## Key Decisions\n"), {
      valid: false,
      reason: "empty",
    });
    deepStrictEqual(parseScope(spec("# only a comment")), {
      valid: false,
      reason: "empty",
    });
  });

  it("one bad entry invalidates the whole Scope", () => {
    for (const bad of ["/etc/", "~/x/", "src/../lib/", "./", "/"]) {
      deepStrictEqual(parseScope(spec(`src/\n${bad}`)), {
        valid: false,
        reason: "invalid-entry",
      });
    }
  });

  it("rejects entries with characters or lengths that could mislead the question", () => {
    const bad = [
      "src/​hidden/",
      "src/‮txt.exe",
      "ドキュメント/",
      "a,b/",
      "src/（委任の対象外）",
      `${"a".repeat(120)}/`,
    ];
    for (const entry of bad) {
      deepStrictEqual(parseScope(spec(`src/\n${entry}`)), {
        valid: false,
        reason: "invalid-entry",
      });
    }
    strictEqual(parseScope(spec(`${"a".repeat(119)}/`)).valid, true);
    strictEqual(parseScope(spec("pkg/@scope/a+b_c-d.e/")).valid, true);
  });

  it("rejects entries whose segments are empty or a lone dot", () => {
    for (const entry of [
      ".//",
      "././",
      "./src/",
      "src/./a/",
      "src//a/",
      ".",
      "src/.",
    ]) {
      deepStrictEqual(parseScope(spec(`lib/\n${entry}`)), {
        valid: false,
        reason: "invalid-entry",
      });
    }
    strictEqual(
      parseScope(spec(".config/\nsrc/.env.example\na.b/")).valid,
      true,
    );
  });

  it("allows MAX_SCOPE_ENTRIES entries and rejects one more", () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i}/`).join("\n");
    strictEqual(MAX_SCOPE_ENTRIES, 16);
    strictEqual(parseScope(spec(rows(16))).valid, true);
    deepStrictEqual(parseScope(spec(rows(17))), {
      valid: false,
      reason: "too-many",
    });
  });

  it("does not read ## Files as Scope", () => {
    deepStrictEqual(parseScope("## Files\n\n```\nsrc/a.ts\n```\n"), {
      valid: false,
      reason: "empty",
    });
  });
});

describe("isProtectedPath", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-prot-")));
  const file = (rel: string) => isProtectedPath(join(root, rel), root, "file");

  it("classifies file paths by the rules of spec K4", () => {
    const cases: [string, boolean][] = [
      ["docs/decisions/0001-x.md", true],
      ["docs/plans/x.md", false],
      [".skills/foo/SKILL.md", true],
      [".github/workflows/ci.yml", true],
      [".github/CODEOWNERS", false],
      ["home/dot_claude/hooks/lib/a.ts", true],
      ["a/.claude/b.json", true],
      ["HOME/DOT_CLAUDE/x.ts", true],
      ["lib/CLAUDE.md", true],
      ["home/dot_codex/AGENTS.md", true],
      ["CONTEXT.md", true],
      ["templates/context.md.tmpl", true],
      ["src/dot_claude", false],
      ["src/claude.ts", false],
      ["lib2/a.ts", false],
    ];
    for (const [rel, expected] of cases) {
      strictEqual(file(rel), expected, rel);
    }
  });

  it("protects the repository's own state and the workflow dirs", () => {
    strictEqual(file(".git/config"), true);
    strictEqual(file(".git/hooks/pre-commit"), true);
    strictEqual(file(".tmp/sessions/abcd1234/approvals.log"), true);
    strictEqual(file(".tmp/sessions/abcd1234/delegation-uses.log"), true);
    strictEqual(file(".tmp/docs/note.md"), false);
    strictEqual(file("src/.gitkeep"), false);
  });

  it("counts the last segment for a directory entry", () => {
    strictEqual(
      isProtectedPath(join(root, "home/dot_claude"), root, "dir"),
      true,
    );
    strictEqual(isProtectedPath(join(root, "src"), root, "dir"), false);
  });

  it("follows a symlink before judging", () => {
    mkdirSync(join(root, "home", "dot_claude"), { recursive: true });
    symlinkSync(join(root, "home", "dot_claude"), join(root, "home", "x"));
    strictEqual(file("home/x/a.ts"), true);
  });

  it("returns null when the path cannot be resolved", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    strictEqual(file("dangling/a.ts"), null);
  });

  it("returns null, not false, when a symlink leads out of the checkout", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wf-outside-")));
    symlinkSync(outside, join(root, "ext"));
    strictEqual(file("ext/settings.json"), null);
  });

  it("is false for the checkout root itself", () => {
    strictEqual(isProtectedPath(root, root, "dir"), false);
  });
});

describe("planFilesWithinScope", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-scope-")));
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const plan = (block: string) => `## Files\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const verdict = (scope: string, files: string) =>
    planFilesWithinScope(plan(files), spec(scope), root);

  it("accepts files under a directory entry and an exact file entry", () => {
    deepStrictEqual(verdict("src/\nlib/a.ts", "src/x/new.ts\nlib/a.ts"), {
      ok: true,
    });
  });

  it("does not treat lib/ as a prefix of lib2/", () => {
    deepStrictEqual(verdict("lib/", "lib2/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("is case-sensitive for Scope, unlike the protected-path rule", () => {
    deepStrictEqual(verdict("src/", "SRC/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("rejects one file outside the Scope", () => {
    deepStrictEqual(verdict("src/", "src/a.ts\nother/b.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("rejects absolute, ~ and .. entries in Files", () => {
    deepStrictEqual(verdict("src/", `${root}/src/a.ts`), {
      ok: false,
      reason: "outside-scope",
    });
    deepStrictEqual(verdict("src/", "~/src/a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
    deepStrictEqual(verdict("src/", "src/sub/../a.ts"), {
      ok: false,
      reason: "outside-scope",
    });
  });

  it("does not delegate a file reached through a symlink that leaves the checkout", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "wf-outside-")));
    symlinkSync(outside, join(root, "ext"));
    deepStrictEqual(verdict("ext/", "ext/settings.json"), {
      ok: false,
      reason: "unresolvable",
    });
  });

  it("rejects a protected file even when the Scope covers it", () => {
    deepStrictEqual(verdict("home/", "home/dot_claude/hooks/a.ts"), {
      ok: false,
      reason: "protected",
    });
  });

  it("reports an empty Files section and an invalid Scope", () => {
    deepStrictEqual(planFilesWithinScope("# no files\n", spec("src/"), root), {
      ok: false,
      reason: "no-files",
    });
    deepStrictEqual(verdict("/etc/", "src/a.ts"), {
      ok: false,
      reason: "scope-invalid",
    });
  });

  it("reports a Files entry that cannot be resolved", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    deepStrictEqual(verdict("dangling/", "dangling/a.ts"), {
      ok: false,
      reason: "unresolvable",
    });
  });
});

describe("targetWithinScope", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-target-")));
  const spec = "## Scope\n\n```\nsrc/\nhome/\n```\n";

  it("is true inside the Scope and false outside or under a protected path", () => {
    strictEqual(targetWithinScope(spec, join(root, "src", "b.ts"), root), true);
    strictEqual(
      targetWithinScope(spec, join(root, "other", "c.ts"), root),
      false,
    );
    strictEqual(
      targetWithinScope(spec, join(root, "home", "dot_claude", "x.ts"), root),
      false,
    );
  });

  it("resolves the Scope against the worktree the target lives in", () => {
    const worktree = addWorktree(root, "b");
    strictEqual(
      targetWithinScope(spec, join(worktree, "src", "b.ts"), root),
      true,
    );
  });
});

describe("Scope entries that pass through a symlink", () => {
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;
  const plan = (block: string) => `## Files\n\n\`\`\`\n${block}\n\`\`\`\n`;

  it("a link to the checkout root is not a Scope", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-link-")));
    mkdirSync(join(root, "src"));
    symlinkSync(root, join(root, "link"));
    deepStrictEqual(
      planFilesWithinScope(plan("link/src/a.ts"), spec("link/"), root),
      { ok: false, reason: "outside-scope" },
    );
    strictEqual(
      targetWithinScope(spec("link/"), join(root, "src", "a.ts"), root),
      false,
    );
    deepStrictEqual(scopeRowsForOffer(spec("src/\nlink/"), root), [
      { entry: "src/", protected: false },
      { entry: "link/", protected: true },
    ]);
  });

  it("an entry swapped for a symlink after approval stops matching", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-swap-")));
    mkdirSync(join(root, "src"));
    const scope = spec("src/gen/");
    strictEqual(
      targetWithinScope(scope, join(root, "src", "gen", "a.ts"), root),
      true,
    );
    symlinkSync(root, join(root, "src", "gen"));
    strictEqual(
      targetWithinScope(scope, join(root, "other", "x.ts"), root),
      false,
    );
    strictEqual(
      targetWithinScope(scope, join(root, "src", "gen", "a.ts"), root),
      false,
    );
  });
});

describe("scopeRowsForOffer", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-offer-")));
  const spec = (block: string) => `## Scope\n\n\`\`\`\n${block}\n\`\`\`\n`;

  it("marks protected rows and keeps the order", () => {
    deepStrictEqual(
      scopeRowsForOffer(
        spec("src/\nhome/dot_claude/\nCONTEXT.md\nlib/a.ts"),
        root,
      ),
      [
        { entry: "src/", protected: false },
        { entry: "home/dot_claude/", protected: true },
        { entry: "CONTEXT.md", protected: true },
        { entry: "lib/a.ts", protected: false },
      ],
    );
  });

  it("is null when every row is protected or the Scope is invalid", () => {
    strictEqual(
      scopeRowsForOffer(spec("docs/decisions/\n.skills/"), root),
      null,
    );
    strictEqual(scopeRowsForOffer(spec(".tmp/sessions/"), root), null);
    strictEqual(scopeRowsForOffer(spec("/etc/"), root), null);
    strictEqual(scopeRowsForOffer("# no scope\n", root), null);
  });

  it("treats a row that cannot be resolved as protected", () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    deepStrictEqual(scopeRowsForOffer(spec("src/\ndangling/"), root), [
      { entry: "src/", protected: false },
      { entry: "dangling/", protected: true },
    ]);
  });
});
