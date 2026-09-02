#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  GUARDED_TOOLS,
  matcherCoversGuardedTools,
} from "../../lib/guarded-tools.ts";

describe("guarded-tools.ts", () => {
  const ALL = ["Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"];

  it("enumerates the tools the guard evaluates", () => {
    deepStrictEqual([...GUARDED_TOOLS].sort(), ALL);
  });

  it("reports the members a matcher does not list", () => {
    deepStrictEqual(matcherCoversGuardedTools("Write|Edit|NotebookEdit|Bash"), {
      covered: false,
      missing: ["MultiEdit"],
    });
  });

  it("reports full coverage once MultiEdit is listed", () => {
    deepStrictEqual(
      matcherCoversGuardedTools("Write|Edit|MultiEdit|NotebookEdit|Bash"),
      { covered: true, missing: [] },
    );
  });

  it("compares literal alternatives, not regex matches", () => {
    // A regex test would report MultiEdit as covered because "Edit" matches it
    // as a substring. Literal set comparison must not.
    strictEqual(
      new RegExp("Write|Edit|NotebookEdit|Bash").test("MultiEdit"),
      true,
    );
    strictEqual(
      matcherCoversGuardedTools("Write|Edit|NotebookEdit|Bash").covered,
      false,
    );
  });

  it("treats wildcard matchers as covering everything", () => {
    // "" and "*" and ".*" are legitimate matchers meaning every tool.
    // Reporting them as covering nothing would emit a warning that is correct
    // to ignore, which trains the reader to ignore all of them.
    deepStrictEqual(matcherCoversGuardedTools(""), {
      covered: true,
      missing: [],
    });
    deepStrictEqual(matcherCoversGuardedTools("*"), {
      covered: true,
      missing: [],
    });
    deepStrictEqual(matcherCoversGuardedTools(".*"), {
      covered: true,
      missing: [],
    });
  });

  it("reports non-coverage for a matcher this check cannot interpret", () => {
    // Anything other than a wildcard or a literal alternation is outside the
    // contract. Report it rather than guess: a wrong "covered" is silent, a
    // wrong "not covered" is visible.
    strictEqual(matcherCoversGuardedTools("(Write|Edit)").covered, false);
  });
});
