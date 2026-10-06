import { ok, strictEqual } from "node:assert";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getParseBudgetMs } from "../../lib/bash-parser.ts";

const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, "..");
const claudeDir = join(here, "..", "..", "..");
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
      .filter((rel) => !/^(unit|perf)\/[^/]+\.test\.ts$/.test(rel));
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
