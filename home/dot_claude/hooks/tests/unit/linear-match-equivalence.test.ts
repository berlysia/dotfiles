#!/usr/bin/env node --test

// Differential test over the production tables (Issue #219): every linear
// matcher in a deny/ask table must accept exactly the language of the regex
// it replaced. The tables are iterated directly, so a pattern added to a
// table without a rule spec below fails on the counts and on ORIGINAL_SOURCES.

import { ok, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { DANGEROUS_PATTERNS } from "../../implementations/permission-auto-approve.ts";
import { DANGEROUS_COMMAND_PATTERNS } from "../../lib/command-parsing.ts";
import {
  hasTopLevelAlternation,
  type OracleMatcher,
  type PrefixThenOnLineMatcher,
  type TextMatcher,
} from "../../lib/linear-match.ts";
import {
  assertAgrees,
  enumerate,
  mutations,
  randomStrings,
  WS_ALL,
  WS_CORE,
} from "../__fixtures__/same-language.ts";

// The local Bash guard rejects the literal, so build it.
const NM = "node" + "_modules";

function isOracleMatcher(value: unknown): value is OracleMatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "oracle" in value &&
    value.oracle instanceof RegExp
  );
}

function isPrefixThenOnLine(
  matcher: OracleMatcher,
): matcher is PrefixThenOnLineMatcher {
  return "prefix" in matcher && "needle" in matcher;
}

function oraclesOf(matchers: readonly TextMatcher[]): OracleMatcher[] {
  return matchers.filter(isOracleMatcher);
}

/** Linear matchers of each production table, by table name. */
const TABLES: Record<string, OracleMatcher[]> = {
  DANGEROUS_COMMAND_PATTERNS: oraclesOf(
    DANGEROUS_COMMAND_PATTERNS.map((entry) => entry.pattern),
  ),
  DANGEROUS_PATTERNS: oraclesOf(DANGEROUS_PATTERNS),
};

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
};

const EXPECTED_TOTAL = 13;

interface RuleSpec {
  source: string;
  /** Exhaustive alphabet (with the whitespace below). */
  tokens: string[];
  /** Extra tokens for random strings and mutations only. */
  extra: string[];
  /** Hand-written positives: mutation seeds and the reuse check. */
  seeds: string[];
  /** Exhaustive depth and whitespace; the rules with two lookaheads or a run-in-run shape use a deeper walk over a smaller alphabet. */
  maxLen: number;
  whitespace: string[];
  /** Named adversarial inputs beyond the generic shapes. */
  perf: Array<() => string>;
}

function spec(
  source: string,
  tokens: string[],
  extra: string[],
  seeds: string[],
  options: {
    maxLen?: number;
    whitespace?: string[];
    perf?: Array<() => string>;
  } = {},
): RuleSpec {
  return {
    source,
    tokens,
    extra,
    seeds,
    maxLen: options.maxLen ?? 5,
    whitespace: options.whitespace ?? WS_CORE,
    perf: options.perf ?? [],
  };
}

const RM_HEAD =
  "rm\\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\\s+";

const RULES: RuleSpec[] = [
  spec(
    `${RM_HEAD}[{$]`,
    ["rm", "-r", "-f", "$", "x"],
    ["-rf", "--force", "--recursive", "{", "/", "-fr", "-rff"],
    ["rm -rf $x", "rm  -rf $x", "rm -r -f {a}", "rm \n-rf $x", "farm  -rf $x"],
    {
      maxLen: 6,
      whitespace: [" ", "\n"],
      perf: [() => "rm -r -f x ".repeat(20000)],
    },
  ),
  spec(
    `${RM_HEAD}\\/`,
    ["rm", "-r", "-f", "/", "x"],
    ["-rf", "--force", "--recursive", "$", "-fr", "-rff"],
    ["rm -rf /", "rm  -rf /tmp", "rm -r -f /a", "rm \n-rf /x", "farm  -rf /"],
    {
      maxLen: 6,
      whitespace: [" ", "\n"],
      perf: [() => "rm -r -f x ".repeat(20000)],
    },
  ),
  spec(
    "dd\\s+.*\\/dev\\/",
    ["dd", "/dev/", "x"],
    ["if=", "dd if=/dev/zero", "/dev"],
    ["dd if=/dev/zero", "dd  of=/dev/sda", "ldd x /dev/y", "dd \n/dev/"],
    { perf: [() => "dd if ".repeat(16667)] },
  ),
  spec(
    "(curl|wget).*\\|\\s*(sh|bash|zsh|fish|dash)",
    ["curl", "wget", "|", "sh", "x"],
    ["bash", "zsh", "fish", "dash", "| sh", "shx"],
    ["curl x | sh", "wget x |bash", "curl x |\nsh", "curl x |  zsh"],
    { perf: [() => "curl x ".repeat(14286)] },
  ),
  spec(
    "git\\s+push\\s+.*--force\\b",
    ["git", "push", "--force", "x"],
    ["-f", "--forced", "--force-with-lease", "git push "],
    ["git push --force", "git push origin --force", "git  push  x --force"],
    { perf: [() => "git push " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "git\\s+push\\s+.*-f\\b",
    ["git", "push", "-f", "x"],
    ["--force", "-force", "-fx", "git push "],
    ["git push -f", "git push origin -f", "git  push  x -f"],
    { perf: [() => "git push " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "git\\s+clean\\s+.*-[fd]",
    ["git", "clean", "-f", "x"],
    ["-d", "-x", "-fd", "git clean "],
    ["git clean -f", "git clean -fd", "git  clean  x -d"],
    { perf: [() => "git clean " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "git\\s+branch\\s+.*-D\\b",
    ["git", "branch", "-D", "x"],
    ["-d", "-DD", "-Dx", "git branch "],
    ["git branch -D x", "git branch x -D", "git  branch  x -D"],
    { perf: [() => "git branch " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "git\\s+.*--no-verify",
    ["git", "--no-verify", "commit", "x"],
    ["--no-verif", "git commit ", "-n"],
    ["git commit --no-verify", "git  commit  x --no-verify", "git --no-verify"],
    { perf: [() => "git " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "git\\s+.*--no-gpg-sign",
    ["git", "--no-gpg-sign", "commit", "x"],
    ["--no-gpg", "git commit ", "-n"],
    ["git commit --no-gpg-sign", "git  commit  x --no-gpg-sign"],
    { perf: [() => "git " + " ".repeat(100000) + "x"] },
  ),
  spec(
    "\\bdd\\s+.*if=",
    ["dd", "if=", "x"],
    ["if", "dd if=", "ddd", "-dd"],
    ["dd if=x", "dd  of=x if=y", "x dd \nif=", "dd \nif="],
    {
      perf: [
        () => "dd " + " ".repeat(100000) + "x",
        () => "dd if ".repeat(16667),
      ],
    },
  ),
  spec(
    "curl.*\\|\\s*(sh|bash|zsh)",
    ["curl", "|", "sh", "x"],
    ["bash", "zsh", "| sh", "shx", "fish"],
    ["curl x | sh", "curl x |bash", "curl x |\nzsh", "curl|  zsh"],
    { perf: [() => "curl x ".repeat(14286)] },
  ),
  spec(
    "wget.*\\|\\s*(sh|bash|zsh)",
    ["wget", "|", "sh", "x"],
    ["bash", "zsh", "| sh", "shx", "fish"],
    ["wget x | sh", "wget x |bash", "wget x |\nzsh", "wget|  zsh"],
    { perf: [() => "wget x ".repeat(14286)] },
  ),
];

const SPEC_BY_SOURCE = new Map(RULES.map((rule) => [rule.source, rule]));

/** The four generic adversarial shapes of a rule, each about 100,000 characters. */
function genericShapes(rule: RuleSpec): string[] {
  const [first = "x", ...rest] = rule.tokens;
  const repeatTo = (unit: string) =>
    unit.repeat(Math.ceil(100000 / unit.length));
  const shapes = [
    first + " ".repeat(100000) + rest.join(" "),
    repeatTo(rule.tokens.join(" ") + " "),
    repeatTo(first + " "),
    first + " " + "\n".repeat(100000),
  ];
  if (rule.tokens.includes(NM))
    return [...shapes, ...shapes.map((s) => `${NM} ${s}`)];
  return shapes;
}

function entriesWithSpec(): Array<{
  table: string;
  matcher: OracleMatcher;
  rule: RuleSpec;
}> {
  return Object.entries(TABLES).flatMap(([table, matchers]) =>
    matchers.map((matcher) => {
      const rule = SPEC_BY_SOURCE.get(matcher.oracle.source);
      if (!rule) throw new Error(`no rule spec for ${matcher.oracle.source}`);
      return { table, matcher, rule };
    }),
  );
}

describe("production tables", () => {
  it("loads each owner module", async () => {
    await import("../../lib/command-parsing.ts");
    await import("../../implementations/permission-auto-approve.ts");
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

describe("adversarial inputs run in linear time", () => {
  for (const { matcher, rule } of entriesWithSpec()) {
    it(`generic shapes: ${rule.source}`, () => {
      for (const shape of [
        ...genericShapes(rule),
        ...rule.perf.map((make) => make()),
      ]) {
        const start = Date.now();
        matcher.test(shape);
        const elapsed = Date.now() - start;
        ok(
          elapsed < 1000,
          `${elapsed} ms for ${JSON.stringify(shape.slice(0, 40))}`,
        );
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
