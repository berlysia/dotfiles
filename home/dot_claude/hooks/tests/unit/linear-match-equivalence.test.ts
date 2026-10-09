#!/usr/bin/env node --test

// Differential test over the production tables (Issue #219): every linear
// matcher in a deny/ask table must accept exactly the language of the regex
// it replaced. The tables are iterated directly, so a pattern added to a
// table without a rule spec below fails on the counts and on ORIGINAL_SOURCES.

import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import {
  hasTopLevelAlternation,
  type OracleMatcher,
  type PrefixThenOnLineMatcher,
} from "../../lib/linear-match.ts";
import {
  assertAgrees,
  enumerate,
  mutations,
  randomStrings,
  WS_ALL,
  WS_CORE,
} from "../__fixtures__/same-language.ts";
import {
  entriesWithSpec,
  NM,
  RM_HEAD,
  RULES,
  SPEC_BY_SOURCE,
  TABLES,
} from "../support/linear-match-rules.ts";

function isPrefixThenOnLine(
  matcher: OracleMatcher,
): matcher is PrefixThenOnLineMatcher {
  return "prefix" in matcher && "needle" in matcher;
}

/** Regex sources copied verbatim from the literals on origin/master (`git show origin/master:<file>`), `.source` form. */
const ORIGINAL_SOURCES: Record<string, string[]> = {
  DANGEROUS_COMMAND_PATTERNS: [
    "rm\\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\\s+[{$]",
    "rm\\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\\s+\\/",
    "dd\\s+.*\\/dev\\/",
    "(curl|wget).*\\|\\s*(sh|bash|zsh|fish|dash)",
    "git\\s+push\\s+.*--force\\b",
    "git\\s+push\\s+.*-f\\b",
    "git\\s+clean\\s+.*-[fd]",
    "git\\s+branch\\s+.*-D\\b",
    "git\\s+.*--no-verify",
    "git\\s+.*--no-gpg-sign",
  ],
  DANGEROUS_PATTERNS: [
    "\\bdd\\s+.*if=",
    "curl.*\\|\\s*(sh|bash|zsh)",
    "wget.*\\|\\s*(sh|bash|zsh)",
  ],
  DESTRUCTIVE_NODE_MODULES_PATTERNS: [
    `(?:^|\\s)mv\\s+.*${NM}`,
    `(?:^|\\s)cp\\s+.*\\s+.*${NM}`,
    `>+\\s*[^\\s]*${NM}`,
    `(?:^|\\s)(chmod|chown)\\s+.*${NM}`,
    `(?:^|\\s)mkdir\\s+.*${NM}`,
    `(?:^|\\s)touch\\s+.*${NM}`,
    `(?:^|\\s)tee\\s+.*${NM}`,
    `(?:^|\\s)uniq\\s+.*${NM}`,
  ],
  INTERPRETER_WRITE_INDICATOR_PATTERNS: [
    "open\\([^)]*['\"][wa]\\+?b?['\"]",
    "Path\\([^)]*\\)\\.open\\(",
  ],
};

const EXPECTED_TOTAL = 23;

describe("production tables", () => {
  it("loads each owner module", async () => {
    await import("../../lib/command-parsing.ts");
    await import("../../implementations/permission-auto-approve.ts");
    await import("../../implementations/deny-node-modules.ts");
    await import("../../lib/node-modules-policy.ts");
    await import("../../implementations/document-workflow-guard.ts");
  });

  it("holds the expected number of linear matchers", () => {
    const total = Object.values(TABLES).reduce((n, list) => n + list.length, 0);
    strictEqual(total, EXPECTED_TOTAL);
    strictEqual(RULES.length, EXPECTED_TOTAL);
    strictEqual(SPEC_BY_SOURCE.size, RULES.length);
  });

  for (const [table, matchers] of Object.entries(TABLES)) {
    it(`${table}: oracle sources equal the original sources`, () => {
      const actual = matchers.map((m) => m.oracle.source).sort();
      const expected = [...(ORIGINAL_SOURCES[table] ?? [])].sort();
      strictEqual(JSON.stringify(actual), JSON.stringify(expected));
    });

    it(`${table}: oracles have no flags`, () => {
      for (const matcher of matchers) strictEqual(matcher.oracle.flags, "");
    });
  }

  it("keeps prefix and needle free of a top-level alternation", () => {
    for (const { matcher } of entriesWithSpec()) {
      if (!isPrefixThenOnLine(matcher)) continue;
      strictEqual(hasTopLevelAlternation(matcher.prefix.source), false);
      strictEqual(hasTopLevelAlternation(matcher.needle.source), false);
    }
  });
});

describe("differential against the original regexes", () => {
  for (const { matcher, rule } of entriesWithSpec()) {
    it(`agrees: ${rule.source}`, () => {
      for (const seed of rule.seeds) ok(matcher.oracle.test(seed), seed);
      assertAgrees(
        matcher,
        enumerate([...rule.tokens, ...rule.whitespace], rule.maxLen),
      );
      const wide = [...rule.tokens, ...rule.extra, ...WS_ALL];
      assertAgrees(matcher, randomStrings(wide, 3000, 219));
      assertAgrees(matcher, mutations(rule.seeds, wide, 300, 219));
    });
  }
});

describe("branch boundary cases", () => {
  const byName = (source: string): OracleMatcher => {
    const found = Object.values(TABLES)
      .flat()
      .find((m) => m.oracle.source === source);
    if (!found) throw new Error(`no matcher for ${source}`);
    return found;
  };

  it("rm ... [{$]", () => {
    const matcher = byName(`${RM_HEAD}[{$]`);
    strictEqual(matcher.test("rm  -rf $x"), true);
    for (const input of [
      "rm  -rf $x",
      "rm -rf $x",
      "rm \n -rf $x",
      "rm \u2028-rf $x",
      "farm  -rf $x",
    ]) {
      strictEqual(matcher.test(input), matcher.oracle.test(input), input);
    }
  });

  // [input, what the original regex answers]
  const cases: Array<[string, Array<[string, boolean]>]> = [
    [
      `(?:^|\\s)cp\\s+.*\\s+.*${NM}`,
      [
        [`cp  ${NM}`, true],
        [`cp ${NM}`, false],
        [`cp a\nb ${NM}`, true],
        [`cp a \n${NM}`, true],
        [`cp a\n${NM}`, true],
        [`cp a\n\n${NM}`, true],
        [`xcp a b ${NM}`, false],
      ],
    ],
    [
      `>+\\s*[^\\s]*${NM}`,
      [
        [`>${NM}`, true],
        [`> \n${NM}`, true],
        [`a>${NM}`, true],
        [`\u00a0> ${NM}`, true],
        [`> a ${NM}`, false],
        [`>a${NM}`, true],
      ],
    ],
    [
      "open\\([^)]*['\"][wa]\\+?b?['\"]",
      [
        ["open(f, 'w')", true],
        ["open(f) 'w'", false],
        ["open(f, 'r')", false],
        ["open(f, 'w+b')", true],
        ["open(f, 'wb')", true],
        ['x open(a) open(b, "a")', true],
      ],
    ],
    [
      "Path\\([^)]*\\)\\.open\\(",
      [
        ["Path(x).open(", true],
        ["Path(x)).open(", false],
        ["Path(x) .open(", false],
        ["Path(a\nb).open(", true],
      ],
    ],
  ];
  for (const [source, inputs] of cases) {
    it(`${source}`, () => {
      const matcher = byName(source);
      for (const [input, expected] of inputs) {
        strictEqual(matcher.oracle.test(input), expected, input);
        strictEqual(matcher.test(input), expected, input);
      }
    });
  }
});

describe("preconditions of prefixThenOnLine", () => {
  for (const { matcher, rule } of entriesWithSpec()) {
    if (!isPrefixThenOnLine(matcher)) continue;
    const inputs = [...enumerate([...rule.tokens, ...WS_CORE], 4)];

    it(`P1: the needle never starts at whitespace: ${rule.source}`, () => {
      const probe = new RegExp(matcher.needle.source, "y");
      for (const s of inputs) {
        for (let at = 0; at < s.length; at++) {
          if (!/\s/.test(s[at] as string)) continue;
          probe.lastIndex = at;
          strictEqual(probe.test(s), false, `${JSON.stringify(s)} at ${at}`);
        }
      }
    });

    it(`P2: every prefix end lies in the whitespace before the greedy end: ${rule.source}`, () => {
      const greedy = new RegExp(matcher.prefix.source, "y");
      for (const s of inputs) {
        for (let from = 0; from < s.length; from++) {
          greedy.lastIndex = from;
          const best = greedy.exec(s);
          if (!best) continue;
          const greedyEnd = from + best[0].length;
          for (let k = 0; k <= s.length - from; k++) {
            const forced = new RegExp(
              `(?:${matcher.prefix.source})(?=[\\s\\S]{${k}}$)`,
              "y",
            );
            forced.lastIndex = from;
            const hit = forced.exec(s);
            if (!hit) continue;
            const end = from + hit[0].length;
            ok(end <= greedyEnd, `${JSON.stringify(s)} start ${from}`);
            ok(
              /^\s*$/.test(s.slice(end, greedyEnd)),
              `${JSON.stringify(s)} start ${from}`,
            );
          }
        }
      }
    });
  }
});

describe("matchers keep no state between calls", () => {
  for (const { matcher, rule } of entriesWithSpec()) {
    it(`reuse: ${rule.source}`, () => {
      const positive = rule.seeds[0] as string;
      strictEqual(matcher.test(positive), true);
      strictEqual(matcher.test("x"), false);
      strictEqual(matcher.test(positive), true);
      strictEqual(matcher.test("x"), false);
    });
  }
});
