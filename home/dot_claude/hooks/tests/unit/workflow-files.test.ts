#!/usr/bin/env node --test
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findRepoToplevel,
  isProseOnlyChange,
  MAX_SCOPE_ENTRIES,
  listsTarget,
  parseFilesPaths,
  parseScope,
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
