import { ok, strictEqual } from "node:assert";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getParseBudgetMs } from "../../lib/bash-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, "..");
const claudeDir = join(here, "..", "..", "..");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const self = fileURLToPath(import.meta.url);

// Built by concatenation so this file does not match its own searches.
const SETTER = "setParse" + "BudgetMs";
const ELAPSED = new RegExp("performance" + "\\.now\\(\\)\\s*-");

function walk(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    // lstat: do not follow symlinks, so a link loop cannot hang the walk.
    if (lstatSync(path).isDirectory()) out.push(...walk(path, skip));
    else out.push(path);
  }
  return out;
}

describe("test layout (spec K9)", () => {
  it("keeps every *.test.ts directly under tests/unit or tests/perf", () => {
    const misplaced = walk(testsDir, () => false)
      .filter((path) => path.endsWith(".test.ts"))
      .map((path) => relative(testsDir, path))
      .filter((rel) => !/^(unit|perf|heavy)\/[^/]+\.test\.ts$/.test(rel));
    strictEqual(misplaced.join("\n"), "");
  });

  it("has at least one perf test", () => {
    ok(readdirSync(join(testsDir, "perf")).some((n) => n.endsWith(".test.ts")));
  });

  it("keeps wall-clock elapsed assertions out of tests/unit", () => {
    const offenders = readdirSync(here)
      .filter((n) => n.endsWith(".test.ts"))
      .map((n) => join(here, n))
      .filter((path) => path !== self)
      .filter((path) => ELAPSED.test(readFileSync(path, "utf8")))
      .map((path) => relative(testsDir, path));
    strictEqual(offenders.join("\n"), "");
  });

  it("runs every test process with the patient parse budget from the preload", () => {
    strictEqual(getParseBudgetMs(), 10_000);
  });

  it("keeps tests/support and tests/perf independent of tests/unit (spec K5)", () => {
    const offenders = ["support", "perf"]
      .flatMap((sub) => walk(join(testsDir, sub), () => false))
      .filter((path) => /\.(m?[jt]s|c[jt]s|tsx)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes("../unit/"))
      .map((path) => relative(testsDir, path));
    strictEqual(offenders.join("\n"), "");
  });
});

describe("parse budget setter stays test-only (spec R7)", () => {
  it("is referenced outside tests only by its definition", () => {
    const hits: string[] = [];
    // Skip by path prefix, not substring, so a production dir that merely
    // contains "tests" in its name is still scanned.
    const skip = (path: string) => {
      const rel = relative(claudeDir, path);
      return (
        rel === join("hooks", "tests") ||
        rel.startsWith(join("hooks", "tests") + "/") ||
        rel.split("/").includes("node_modules")
      );
    };
    const files = walk(claudeDir, skip).filter((path) =>
      /\.(m?[jt]s|c[jt]s|tsx)$/.test(path),
    );
    for (const path of files) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes(SETTER)) {
            hits.push(
              `${relative(claudeDir, path)}:${index + 1}: ${line.trim()}`,
            );
          }
        });
    }
    strictEqual(hits.length, 1, hits.join("\n"));
    ok(
      hits[0]?.startsWith(join("hooks", "lib", "bash-parser.ts")) &&
        hits[0].includes(`export function ${SETTER}(`),
      hits.join("\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// Heavy suite wiring. Each check is a pure function over text so that a broken
// copy of the real input can be fed to it and must be reported.
// ---------------------------------------------------------------------------

const HEAVY_REMOVE_TEST = "tests/heavy/chezmoiremove-coverage.test.mjs";
const SUITES = ["unit", "perf", "heavy"] as const;

function hasTestFiles(names: readonly string[], extension: string): boolean {
  return names.some((n) => n.endsWith(extension));
}

// A suite directory must not import a sibling suite directory.
function crossImports(
  suite: string,
  files: ReadonlyArray<{ path: string; text: string }>,
): string[] {
  const others = SUITES.filter((s) => s !== suite);
  return files
    .filter(({ text }) => others.some((o) => text.includes(`../${o}/`)))
    .map(({ path }) => path);
}

// tests/heavy/*.mjs may share tests/lib/ but not the unit tests/*.test.mjs.
function repoHeavyImports(
  files: ReadonlyArray<{ path: string; text: string }>,
): string[] {
  return files
    .filter(({ text }) => /["']\.\.\/[^/"']+\.test\.mjs["']/.test(text))
    .map(({ path }) => path);
}

function packageScriptProblems(pkg: {
  scripts: Record<string, string>;
}): string[] {
  const problems: string[] = [];
  const { scripts } = pkg;
  const want: Array<[string, readonly string[]]> = [
    ["test", ["tests/unit/*.test.ts"]],
    ["test:perf", ["tests/perf/*.test.ts"]],
    ["test:heavy", ["tests/heavy/*.test.ts", "tests/heavy/*.test.mjs"]],
  ];
  for (const [name, globs] of want) {
    for (const glob of globs) {
      if (!scripts[name]?.includes(glob)) problems.push(`${name}: ${glob}`);
    }
  }
  const steps = (scripts["check"] ?? "").split("&&").map((s) => s.trim());
  const order = [
    "npm run test",
    "npm run test:perf",
    "npm run test:heavy",
    "npm run typecheck",
    "npm run lint",
  ].map((step) => steps.indexOf(step));
  if (order.some((i, n) => i < 0 || (n > 0 && i <= (order[n - 1] ?? 0)))) {
    problems.push(`check order: ${steps.join(" && ")}`);
  }
  return problems;
}

function workflowPaths(yml: string, event: string, next: string): string[] {
  const start = yml.indexOf(`\n  ${event}:`);
  const end = yml.indexOf(`\n  ${next}:`);
  if (start < 0 || end < start) return [];
  return [...yml.slice(start, end).matchAll(/^\s+- "([^"]+)"\s*$/gm)].map(
    (m) => m[1] ?? "",
  );
}

function workflowProblems(yml: string): string[] {
  const problems: string[] = [];
  const runs = ["test", "test:perf", "test:heavy"].map((name) =>
    yml.search(new RegExp(`^\\s+run: bun run ${name}$`, "m")),
  );
  if (runs.some((i, n) => i < 0 || (n > 0 && i <= (runs[n - 1] ?? 0)))) {
    problems.push("run steps for test, test:perf, test:heavy in this order");
  }
  const required = [
    "tests/heavy/**",
    "tests/lib/**",
    "tests/tailnet-ssh.test.mjs",
    "tests/install-chezmoi.test.mjs",
    "tests/chezmoiremove-coverage.test.mjs",
  ];
  for (const [event, next] of [
    ["push", "pull_request"],
    ["pull_request", "workflow_dispatch"],
  ] as const) {
    const paths = workflowPaths(yml, event, next);
    for (const path of required) {
      if (!paths.includes(path)) problems.push(`${event} paths: ${path}`);
    }
  }
  return problems;
}

function preCommitProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
  const runs = lines.filter(
    (l) => l.includes(`--test ${HEAVY_REMOVE_TEST}`) && l.includes("node "),
  );
  if (runs.length === 0)
    problems.push("does not run the heavy chezmoiremove test");
  if (!runs.some((l) => l.includes("CLAUDE_TEST_FORBID_GIT="))) {
    problems.push("heavy run does not clear CLAUDE_TEST_FORBID_GIT");
  }
  const triggers = lines.filter(
    (l) => l.includes(HEAVY_REMOVE_TEST) && !l.includes("--test"),
  );
  if (triggers.length === 0) {
    problems.push("trigger list does not name the heavy chezmoiremove test");
  }
  return problems;
}

function readTextFiles(dir: string, extension: string) {
  return readdirSync(dir)
    .filter((n) => n.endsWith(extension))
    .map((n) => ({
      path: join(dir, n),
      text: readFileSync(join(dir, n), "utf8"),
    }))
    .filter(({ path }) => path !== self);
}

describe("heavy suite wiring (spec K5)", () => {
  it("has at least one test in tests/heavy of both roots", () => {
    const hooksHeavy = readdirSync(join(testsDir, "heavy"));
    const repoHeavy = readdirSync(join(repoRoot, "tests", "heavy"));
    ok(hasTestFiles(hooksHeavy, ".test.ts"), "hooks tests/heavy");
    ok(hasTestFiles(repoHeavy, ".test.mjs"), "repo tests/heavy");
    strictEqual(hasTestFiles([], ".test.ts"), false);
    strictEqual(hasTestFiles(["README.md"], ".test.mjs"), false);
  });

  it("keeps unit, perf and heavy from importing one another", () => {
    for (const suite of SUITES) {
      const files = readTextFiles(join(testsDir, suite), ".ts");
      strictEqual(crossImports(suite, files).join("\n"), "", suite);
    }
    const bad = `import { x } from "../${"unit"}/a.ts";`;
    const badUnit = `import { x } from "../${"heavy"}/a.ts";`;
    ok(crossImports("heavy", [{ path: "h.ts", text: bad }]).length > 0);
    ok(crossImports("unit", [{ path: "u.ts", text: badUnit }]).length > 0);
    ok(crossImports("perf", [{ path: "p.ts", text: bad }]).length > 0);
  });

  it("keeps repo tests/heavy off the unit tests/*.test.mjs (tests/lib is shared)", () => {
    const files = readTextFiles(join(repoRoot, "tests", "heavy"), ".mjs");
    strictEqual(repoHeavyImports(files).join("\n"), "");
    ok(
      repoHeavyImports([
        { path: "x.mjs", text: 'import "../chezmoiremove-coverage.test.mjs";' },
      ]).length > 0,
    );
    strictEqual(
      repoHeavyImports([
        { path: "x.mjs", text: 'import "../lib/chezmoiremove-coverage.mjs";' },
      ]).length,
      0,
    );
  });

  it("wires test, test:perf and test:heavy in package.json, and check runs them in order", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    strictEqual(packageScriptProblems(pkg).join("\n"), "");

    const swapped = {
      scripts: {
        ...pkg.scripts,
        check:
          "npm run test && npm run test:heavy && npm run test:perf && npm run typecheck && npm run lint",
      },
    };
    ok(packageScriptProblems(swapped).length > 0);
    const noGlob = {
      scripts: { ...pkg.scripts, "test:heavy": "node --test" },
    };
    ok(packageScriptProblems(noGlob).length > 0);
  });

  it("runs the three suites in CI and watches tests/heavy in both path lists", () => {
    const yml = readFileSync(
      join(repoRoot, ".github", "workflows", "ci-typescript.yml"),
      "utf8",
    );
    strictEqual(workflowProblems(yml).join("\n"), "");

    // Drop tests/heavy/** from the pull_request list only.
    const cut = yml.indexOf("\n  pull_request:");
    const broken =
      yml.slice(0, cut) +
      yml.slice(cut).replace('      - "tests/heavy/**"\n', "");
    ok(
      workflowProblems(broken).some((p) => p.startsWith("pull_request paths")),
    );
  });

  it("runs the heavy chezmoiremove test from pre-commit and lists it as a trigger", () => {
    const text = readFileSync(
      join(repoRoot, "scripts", "hooks", "pre-commit"),
      "utf8",
    );
    strictEqual(preCommitProblems(text).join("\n"), "");

    const withoutTrigger = text
      .split("\n")
      .filter((l) => !(l.includes(HEAVY_REMOVE_TEST) && !l.includes("--test")))
      .join("\n");
    ok(preCommitProblems(withoutTrigger).length > 0);
    const withoutRun = text.replaceAll(`--test ${HEAVY_REMOVE_TEST}`, "--test");
    ok(preCommitProblems(withoutRun).length > 0);
  });
});
