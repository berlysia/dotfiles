#!/usr/bin/env node --test
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isProseOnlyChange,
  parseFilesPaths,
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
