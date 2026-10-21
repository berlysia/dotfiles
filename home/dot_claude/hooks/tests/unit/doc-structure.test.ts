#!/usr/bin/env node --test

import { deepEqual, equal, ok } from "node:assert";
import { test } from "node:test";
import {
  checkAdrHeadings,
  checkSessionPaths,
  checkAdrLineRefs,
  checkSourceLineRefs,
  isPathCheckTarget,
  createPathExists,
  checkMissingPaths,
  checkExceptionSet,
} from "../support/doc-structure-checks.ts";

// Structural checks for the docs in this repo (spec K9):
//   (a) ADR headings are the fixed set, and Status / Context / Decision exist
//   (b) ADRs do not point into `.tmp/sessions/` (GC'd after 7 days)
//   (c) nothing points into an ADR by line number
//   (d) repo-relative paths written in backticks exist in the tracked tree
//   (e) ADRs do not point into source files by line number
//
// Each check is a pure function (path + text -> violations). Reading files and
// `git ls-files` stay at the edge so the checks can be unit-tested in memory.
//
// A line number goes stale at the next edit of the target. The checks therefore
// forbid it; the target is named by ID, section or symbol instead.

// ---------------------------------------------------------------------------
// Unit tests (in-memory inputs)
// ---------------------------------------------------------------------------

test("(a) Status, Context and Decision only: no violation", () => {
  deepEqual(checkAdrHeadings("## Status\n\n## Context\n\n## Decision\n"), []);
});

test("(a) missing Status is reported", () => {
  const violations = checkAdrHeadings("## Context\n\n## Decision\n");
  deepEqual(violations, ["missing heading: ## Status"]);
});

test("(a) a heading inside a code fence is ignored", () => {
  const text = [
    "## Status",
    "## Context",
    "## Decision",
    "```md",
    "## Foo",
    "```",
    "~~~",
    "## Bar",
    "~~~",
  ].join("\n");
  deepEqual(checkAdrHeadings(text), []);
});

test("(a) a heading that is not an exact match is a violation", () => {
  const violations = checkAdrHeadings(
    "## Status\n## Context\n## Decision\n## Rejected alternatives\n",
  );
  equal(violations.length, 1);
  ok(violations[0]?.includes("## Rejected alternatives"));
});

test("(a) the other allowed headings are accepted; ### is not a heading here", () => {
  const text = [
    "## Status",
    "## Context",
    "## Decision",
    "## 却下した代替案",
    "## Consequences",
    "## Amendments",
    "## References",
    "### Anything",
  ].join("\n");
  deepEqual(checkAdrHeadings(text), []);
});

test("(b) .tmp/sessions/ is reported with its line", () => {
  deepEqual(checkSessionPaths("a\nsee .tmp/sessions/abcd1234/spec.md\n"), [
    "line 2: references .tmp/sessions/",
  ]);
  deepEqual(checkSessionPaths("see .tmp/docs/CONTEXT.md\n"), []);
});

test("(c) an ADR file name followed by a line suffix is a violation", () => {
  const adr = "0029-workflow-records-move-into-adr.md";
  equal(checkAdrLineRefs(`see ${adr}${"#L"}12`).length, 1);
  equal(checkAdrLineRefs(`see ${adr}${":"}12-14`).length, 1);
  deepEqual(checkAdrLineRefs(`see ${adr} and ${adr}#section`), []);
  deepEqual(checkAdrLineRefs("see foo.md:12"), []);
});

test("(e) source file line references are violations; markdown ones are not", () => {
  const violations = checkSourceLineRefs(
    "a foo.ts:12 and bar.yml#L3 and foo.md:12",
  );
  equal(violations.length, 2);
  deepEqual(checkSourceLineRefs("run foo.ts or bar.yml"), []);
});

test("(d) only the missing concrete path is reported", () => {
  const exists = createPathExists(["docs/real.md", "tests/other/run.sh"]);
  const text = [
    "`docs/no-such.md`",
    "`docs/*.md`",
    "`tests/<name>/run.sh`",
    "`docs/real.md#anchor`",
    "`docs/ with space.md`",
    "```",
    "`docs/in-fence.md`",
    "```",
  ].join("\n");
  deepEqual(checkMissingPaths("README.md", text, exists), [
    "missing path: docs/no-such.md",
  ]);
});

test("(d) a path is also resolved relative to the doc's own directory", () => {
  const exists = createPathExists([
    "tests/pkg/scripts/run.sh",
    "docs/dir/x.md",
  ]);
  deepEqual(
    checkMissingPaths("tests/pkg/README.md", "`scripts/run.sh`", exists),
    [],
  );
  // Not under PATH_PREFIXES, so never checked.
  deepEqual(checkMissingPaths("README.md", "`lib/none.ts`", exists), []);
  // A directory counts, with or without a trailing slash.
  deepEqual(
    checkMissingPaths("README.md", "`docs/dir/` `docs/dir`", exists),
    [],
  );
});

test("(d) target selection", () => {
  ok(isPathCheckTarget("docs/decisions/0001-x.md"));
  ok(isPathCheckTarget("docs/guide.md"));
  ok(isPathCheckTarget("CONTEXT.md"));
  ok(isPathCheckTarget("home/dot_claude/hooks/README.md"));
  ok(!isPathCheckTarget("docs/plans/x.md"));
  ok(!isPathCheckTarget("home/dot_claude/rules/workflow.md"));
  ok(!isPathCheckTarget("docs/data.json"));
});

test("exception set: an entry that no longer violates is reported", () => {
  const problems = checkExceptionSet(
    new Set(["a.md", "b.md"]),
    new Set(["a.md"]),
    new Set(["a.md", "b.md"]),
  );
  deepEqual(problems, ["exception no longer violates, remove it: b.md"]);
});

test("exception set: an entry naming a missing file is reported", () => {
  const problems = checkExceptionSet(
    new Set(["gone.md"]),
    new Set(),
    new Set(["a.md"]),
  );
  deepEqual(problems, ["exception names a file that does not exist: gone.md"]);
});

test("exception set: a violation outside the set is reported", () => {
  const problems = checkExceptionSet(
    new Set(),
    new Set(["new.md"]),
    new Set(["new.md"]),
  );
  deepEqual(problems, ["unexpected violation: new.md"]);
});
