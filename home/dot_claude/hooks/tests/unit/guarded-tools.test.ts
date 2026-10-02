#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  GUARDED_TOOLS,
  matcherCoversGuardedTools,
  matcherCoversTools,
} from "../../lib/guarded-tools.ts";

describe("guarded-tools.ts", () => {
  const ALL = [
    "AskUserQuestion",
    "Bash",
    "CronCreate",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "ScheduleWakeup",
    "Write",
  ];

  it("enumerates the tools the guard evaluates", () => {
    deepStrictEqual([...GUARDED_TOOLS].sort(), ALL);
  });

  it("reports the members a matcher does not list", () => {
    deepStrictEqual(matcherCoversGuardedTools("Write|Edit|NotebookEdit|Bash"), {
      covered: false,
      missing: ["AskUserQuestion", "CronCreate", "MultiEdit", "ScheduleWakeup"],
    });
  });

  it("reports full coverage once every guarded tool is listed", () => {
    deepStrictEqual(
      matcherCoversGuardedTools(
        "Write|Edit|MultiEdit|NotebookEdit|Bash|CronCreate|ScheduleWakeup|AskUserQuestion",
      ),
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

  describe("matcherCoversTools", () => {
    it("covers a tool the matcher lists, and treats wildcards as covering all", () => {
      deepStrictEqual(
        matcherCoversTools("AskUserQuestion", ["AskUserQuestion"]),
        { covered: true, missing: [] },
      );
      deepStrictEqual(matcherCoversTools("", ["AskUserQuestion"]), {
        covered: true,
        missing: [],
      });
      deepStrictEqual(matcherCoversTools("*", ["AskUserQuestion"]), {
        covered: true,
        missing: [],
      });
    });

    it("reports a near-miss name and does not read a matcher as a regex", () => {
      deepStrictEqual(
        matcherCoversTools("AskUserQuestions", ["AskUserQuestion"]),
        { covered: false, missing: ["AskUserQuestion"] },
      );
      deepStrictEqual(matcherCoversTools("Ask.*", ["AskUserQuestion"]), {
        covered: false,
        missing: ["AskUserQuestion"],
      });
    });

    it("agrees with matcherCoversGuardedTools for the guarded set", () => {
      for (const m of ["Write|Edit", "", "AskUserQuestion", "Bash|Write"]) {
        deepStrictEqual(
          matcherCoversGuardedTools(m),
          matcherCoversTools(m, [...GUARDED_TOOLS]),
        );
      }
    });
  });
});
