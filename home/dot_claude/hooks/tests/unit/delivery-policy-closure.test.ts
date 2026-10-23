#!/usr/bin/env node --test

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { isProtectedPath } from "../../lib/delivery-policy.ts";

// The wrapper merges a PR only when none of its files is in PROTECTED_PATHS.
// This test keeps that list covering everything the guard, the recorder and
// the CLI run on: a new import that is not listed fails here instead of
// silently becoming a file a PR can change and still be auto-merged. The
// measured size of the closure is recorded in the ADR, not here.

const HOOKS_DIR = resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = resolve(HOOKS_DIR, "..", "..", "..");

const ENTRY_POINTS = [
  "implementations/document-workflow-guard.ts",
  "implementations/delivery-policy-recorder.ts",
  "cli/delivery-policy.ts",
].map((p) => join(HOOKS_DIR, p));

const STATIC_IMPORT =
  /(?:import|export)\s[^"';]*?from\s+["'](\.[^"']+)["']|(?:^|\n)\s*import\s+["'](\.[^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const FS_READ =
  /\b(?:readFileSync|readFile|readdirSync|existsSync|createReadStream|openSync)\(([^)]*)\)/g;
const FS_ANCHOR = /import\.meta\.(?:dirname|dir|url)|__dirname/;

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split("\\").join("/");
}

interface Closure {
  files: Set<string>;
  /** Files that are read or imported by a computed path inside the repo. */
  reads: Array<{ from: string; path: string }>;
}

function collectClosure(): Closure {
  const files = new Set<string>();
  const reads: Closure["reads"] = [];
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf-8");
    const dir = dirname(file);
    for (const m of text.matchAll(STATIC_IMPORT)) {
      visit(resolve(dir, (m[1] ?? m[2]) as string));
    }
    for (const m of text.matchAll(DYNAMIC_IMPORT)) {
      const specifier = m[1] as string;
      if (specifier.startsWith(".")) visit(resolve(dir, specifier));
    }
    for (const m of text.matchAll(FS_READ)) {
      const args = m[1] as string;
      if (!FS_ANCHOR.test(args)) continue;
      const literals = [...args.matchAll(/["']([^"']+)["']/g)].map(
        (l) => l[1] as string,
      );
      const target = resolve(dir, ...literals);
      if (!target.startsWith(`${REPO_ROOT}/`)) continue;
      reads.push({ from: repoPath(file), path: repoPath(target) });
    }
  };
  for (const entry of ENTRY_POINTS) visit(entry);
  return { files, reads };
}

describe("delivery-policy import closure", () => {
  it("every entry point exists", () => {
    for (const entry of ENTRY_POINTS) assert.ok(existsSync(entry), entry);
  });

  it("every file reachable by relative import from the three entry points is a protected path", () => {
    const { files } = collectClosure();
    const unprotected = [...files]
      .map(repoPath)
      .filter((p) => !isProtectedPath(p))
      .sort();
    assert.deepEqual(
      unprotected,
      [],
      "add these to PROTECTED_PATHS in lib/delivery-policy.ts",
    );
  });

  it("every in-repo path read from a closure file by import.meta-relative fs call is protected", () => {
    const { reads } = collectClosure();
    const unprotected = reads.filter((r) => !isProtectedPath(r.path));
    assert.deepEqual(
      unprotected,
      [],
      "add these to PROTECTED_PATHS in lib/delivery-policy.ts",
    );
  });
});
