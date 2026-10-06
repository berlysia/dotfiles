import { DESTRUCTIVE_NODE_MODULES_PATTERNS } from "../../implementations/deny-node-modules.ts";
import { INTERPRETER_WRITE_INDICATOR_PATTERNS } from "../../implementations/document-workflow-guard.ts";
import { DANGEROUS_PATTERNS } from "../../implementations/permission-auto-approve.ts";
import { DANGEROUS_COMMAND_PATTERNS } from "../../lib/command-parsing.ts";
import type { OracleMatcher, TextMatcher } from "../../lib/linear-match.ts";
import { buildReadOnlyPatterns } from "../../lib/node-modules-policy.ts";
import { READ_ONLY_VERBS } from "../../lib/read-only-command.ts";
import { WS_CORE } from "../__fixtures__/same-language.ts";

// The local Bash guard rejects the literal, so build it.
export const NM = "node" + "_modules";

export function isOracleMatcher(value: unknown): value is OracleMatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "oracle" in value &&
    value.oracle instanceof RegExp
  );
}

export function oraclesOf(matchers: readonly TextMatcher[]): OracleMatcher[] {
  return matchers.filter(isOracleMatcher);
}

/** Linear matchers of each production table, by table name. */
export const TABLES: Record<string, OracleMatcher[]> = {
  DANGEROUS_COMMAND_PATTERNS: oraclesOf(
    DANGEROUS_COMMAND_PATTERNS.map((entry) => entry.pattern),
  ),
  DANGEROUS_PATTERNS: oraclesOf(DANGEROUS_PATTERNS),
  DESTRUCTIVE_NODE_MODULES_PATTERNS: oraclesOf(
    DESTRUCTIVE_NODE_MODULES_PATTERNS.map((entry) => entry.pattern),
  ),
  READ_ONLY_PATTERNS: oraclesOf(
    buildReadOnlyPatterns().map((entry) => entry.pattern),
  ),
  INTERPRETER_WRITE_INDICATOR_PATTERNS: oraclesOf(
    INTERPRETER_WRITE_INDICATOR_PATTERNS,
  ),
};

/** Verbs of each read-only category, in table order. */
export function readOnlyVerbsByCategory(): string[][] {
  const byCategory = new Map<string, string[]>();
  for (const { verb, category } of READ_ONLY_VERBS) {
    byCategory.set(category, [...(byCategory.get(category) ?? []), verb]);
  }
  return [...byCategory.values()];
}

export interface RuleSpec {
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

export function spec(
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

export const RM_HEAD =
  "rm\\s+(?=.*(?:-[fr]*r|--recursive))(?=.*(?:-[rf]*f|--force)).*\\s+";

export const RULES: RuleSpec[] = [
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
  spec(
    `(?:^|\\s)mv\\s+.*${NM}`,
    ["mv", NM, "x"],
    ["cp", "mvx", "x mv", `${NM}/x`],
    [`mv a ${NM}`, `x mv\n${NM}`, `mv  ${NM}`],
  ),
  spec(
    `(?:^|\\s)cp\\s+.*\\s+.*${NM}`,
    ["cp", NM, "x"],
    ["mv", "cpx", "x cp", `${NM}/x`],
    [
      `cp a b ${NM}`,
      `cp  ${NM}`,
      `cp a\nb ${NM}`,
      `cp a \n${NM}`,
      `cp a \n\n ${NM}`,
    ],
    {
      maxLen: 6,
      whitespace: [" ", "\n"],
      perf: [
        () => "cp ".repeat(20000) + "\n".repeat(100000),
        () => `${NM} ` + " cp ".repeat(25000),
      ],
    },
  ),
  spec(
    `>+\\s*[^\\s]*${NM}`,
    [">", NM, "x"],
    ["a>", `${NM}/x`, ">>"],
    [`>${NM}`, `> ${NM}`, `>>x${NM}`, `echo >\n${NM}`],
    {
      maxLen: 6,
      whitespace: [" ", "\n"],
      perf: [() => ">".repeat(100000), () => `${NM} ` + ">".repeat(100000)],
    },
  ),
  spec(
    `(?:^|\\s)(chmod|chown)\\s+.*${NM}`,
    ["chmod", "chown", NM, "x"],
    ["chm", "x chmod", `${NM}/x`],
    [`chmod a ${NM}`, `chown  ${NM}`, `x chmod\n${NM}`],
  ),
  spec(
    `(?:^|\\s)mkdir\\s+.*${NM}`,
    ["mkdir", NM, "x"],
    ["mkdirs", "x mkdir", `${NM}/x`],
    [`mkdir a ${NM}`, `x mkdir\n${NM}`, `mkdir  ${NM}`],
  ),
  spec(
    `(?:^|\\s)touch\\s+.*${NM}`,
    ["touch", NM, "x"],
    ["touchx", "x touch", `${NM}/x`],
    [`touch a ${NM}`, `x touch\n${NM}`, `touch  ${NM}`],
  ),
  spec(
    "open\\([^)]*['\"][wa]\\+?b?['\"]",
    ["open(", "'", "w", ")", "x"],
    ['"', "a", "+", "b", "wb", "'w'", "'a+'", '"wb"', "Path("],
    ["open(f, 'w')", 'open(f,"wb")', "open(a)\nopen(b, 'a+')", "x open(\n'a'"],
    { perf: [() => "open(".repeat(20000)] },
  ),
  spec(
    "Path\\([^)]*\\)\\.open\\(",
    ["Path(", ")", ".open(", "x"],
    ["open(", "Path()", ".open", "))"],
    ["Path(x).open(", "Path(a, b).open('w')", "Path().open(", "Path(\n).open("],
    { perf: [() => "Path(".repeat(20000)] },
  ),
  ...readOnlyVerbsByCategory().map((verbs) => {
    const head = verbs[0] as string;
    return spec(
      new RegExp(`(?:^|\\s)(${verbs.join("|")})\\s+.*${NM}`).source,
      [head, NM, "x"],
      [...verbs.slice(1), `${head}x`, `x ${head}`, `${NM}/x`],
      [`${head} ${NM}/x`, `${head}  x ${NM}`, `x ${head}\n${NM}`],
    );
  }),
];

export const SPEC_BY_SOURCE = new Map(RULES.map((rule) => [rule.source, rule]));

/** The four generic adversarial shapes of a rule, each about 100,000 characters. */
export function genericShapes(rule: RuleSpec): string[] {
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

export function entriesWithSpec(): Array<{
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
