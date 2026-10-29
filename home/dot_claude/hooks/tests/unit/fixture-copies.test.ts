#!/usr/bin/env node --test

// Keeps the fixture copies under mods/<name>/tests/fixtures/ in step with their
// masters under home/dot_claude/hooks/tests/fixtures/.
//
// A Mod runs in a sandbox that cannot read the masters, so it carries copies.
// Each Mod lists them in mods/<name>/tests/fixtures/.fixture-source, one line
// per copy: `<copy path> <master path>`. The copy path is relative to
// mods/<name>/tests/fixtures/, the master path to home/dot_claude/hooks/tests/fixtures/.
// Blank lines and lines starting with `#` are ignored. A path with `..`, a
// leading `/` or whitespace is a format violation.

import { deepStrictEqual, ok, strictEqual } from "node:assert";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MASTER_DIR = "home/dot_claude/hooks/tests/fixtures";
const MANIFEST = ".fixture-source";

/** Every entry under `dir` as a posix relative path. Symlinks are listed, never followed. */
function walk(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

const kindOf = (path: string): "missing" | "symlink" | "file" | "other" => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return "symlink";
  return stat.isFile() ? "file" : "other";
};

const badPath = (path: string): boolean =>
  path.startsWith("/") || path.includes("..") || /\s/.test(path);

type Entry = { copy: string; master: string };

function parseManifest(text: string): { entries: Entry[]; errors: string[] } {
  const entries: Entry[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const parts = trimmed.split(/\s+/);
    const [copy, master] = parts;
    if (
      parts.length !== 2 ||
      copy === undefined ||
      master === undefined ||
      badPath(copy) ||
      badPath(master)
    ) {
      errors.push(
        `${MANIFEST} line ${index + 1}: expected "<copy> <master>" with no "..", leading "/" or whitespace in a path`,
      );
      return;
    }
    entries.push({ copy, master });
  });
  return { entries, errors };
}

/** Returns one message per problem; an empty list means every copy matches its master. */
export function scanFixtureCopies(repoRoot: string): string[] {
  const problems: string[] = [];
  const modsDir = join(repoRoot, "mods");
  let mods: string[];
  try {
    mods = readdirSync(modsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  for (const mod of mods) {
    const fixturesRel = `mods/${mod}/tests/fixtures`;
    const fixturesDir = join(repoRoot, fixturesRel);
    if (kindOf(fixturesDir) === "missing") continue;
    const files = walk(fixturesDir);
    const copies = files.filter((file) => file !== MANIFEST);
    const cp = (master: string, copy: string): string =>
      `fix: cp ${MASTER_DIR}/${master} ${fixturesRel}/${copy}`;

    const manifestPath = join(fixturesDir, MANIFEST);
    const manifestKind = kindOf(manifestPath);
    if (manifestKind !== "file") {
      if (copies.length > 0 || manifestKind !== "missing") {
        problems.push(
          `${fixturesRel}: ${MANIFEST} is ${manifestKind === "missing" ? "missing" : `not a regular file (${manifestKind})`} but copies exist`,
        );
      }
      continue;
    }
    const { entries, errors } = parseManifest(
      readFileSync(manifestPath, "utf8"),
    );
    problems.push(...errors.map((error) => `${fixturesRel}/${error}`));

    for (const copy of copies) {
      if (kindOf(join(fixturesDir, copy)) === "symlink") {
        problems.push(
          `${fixturesRel}/${copy}: is a symlink; the Mod sandbox cannot follow it, so copy the bytes`,
        );
      }
    }
    const listed = new Set(entries.map((entry) => entry.copy));
    for (const copy of copies) {
      if (!listed.has(copy)) {
        problems.push(`${fixturesRel}/${copy}: not listed in ${MANIFEST}`);
      }
    }
    for (const { copy, master } of entries) {
      const copyPath = join(fixturesDir, copy);
      const masterPath = join(repoRoot, MASTER_DIR, master);
      const copyKind = kindOf(copyPath);
      const masterKind = kindOf(masterPath);
      if (masterKind !== "file") {
        problems.push(
          `${fixturesRel}/${copy}: master ${MASTER_DIR}/${master} is ${masterKind === "missing" ? "missing" : "not a regular file"}`,
        );
        continue;
      }
      if (copyKind === "missing") {
        problems.push(`${fixturesRel}/${copy}: missing. ${cp(master, copy)}`);
        continue;
      }
      if (copyKind !== "file") continue; // symlinks are reported above
      if (!readFileSync(copyPath).equals(readFileSync(masterPath))) {
        problems.push(
          `${fixturesRel}/${copy}: differs from ${MASTER_DIR}/${master}. ${cp(master, copy)}`,
        );
      }
    }
  }
  return problems;
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fixture-copies-")));
  roots.push(root);
  mkdirSync(join(root, MASTER_DIR), { recursive: true });
  return root;
}

function put(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A repo with one Mod holding one correct copy of one master. */
function makeValidRepo(): string {
  const root = makeRepo();
  put(root, `${MASTER_DIR}/sessions/a.json`, '{"a":1}\n');
  put(root, "mods/m/tests/fixtures/a.json", '{"a":1}\n');
  put(root, `mods/m/tests/fixtures/${MANIFEST}`, "a.json sessions/a.json\n");
  return root;
}

describe("fixture copies", () => {
  it("passes when a copy equals its master", () => {
    deepStrictEqual(scanFixtureCopies(makeValidRepo()), []);
  });

  it("ignores comment and blank lines in the manifest", () => {
    const root = makeValidRepo();
    put(
      root,
      `mods/m/tests/fixtures/${MANIFEST}`,
      "# why\n\na.json sessions/a.json\n",
    );
    deepStrictEqual(scanFixtureCopies(root), []);
  });

  it("fails with a cp command when one byte differs", () => {
    const root = makeValidRepo();
    put(root, "mods/m/tests/fixtures/a.json", '{"a":2}\n');
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(
      problems[0]?.includes(
        `cp ${MASTER_DIR}/sessions/a.json mods/m/tests/fixtures/a.json`,
      ),
      problems[0],
    );
  });

  it("fails for a copy missing from the manifest", () => {
    const root = makeValidRepo();
    put(root, "mods/m/tests/fixtures/extra.json", "{}\n");
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes("extra.json: not listed"), problems[0]);
  });

  it("fails for a listed copy that does not exist, with a cp command", () => {
    const root = makeValidRepo();
    rmSync(join(root, "mods/m/tests/fixtures/a.json"));
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes("missing. fix: cp "), problems[0]);
  });

  it("fails when the master is gone", () => {
    const root = makeValidRepo();
    rmSync(join(root, MASTER_DIR, "sessions/a.json"));
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes("master"), problems[0]);
  });

  it("fails for copies in a fixtures directory with no manifest", () => {
    const root = makeRepo();
    put(root, "mods/m/tests/fixtures/a.json", "{}\n");
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes(`${MANIFEST} is missing`), problems[0]);
  });

  it("counts dotfiles other than the manifest as copies", () => {
    const root = makeValidRepo();
    put(root, "mods/m/tests/fixtures/.hidden", "x");
    const problems = scanFixtureCopies(root);
    strictEqual(problems.length, 1);
    ok(problems[0]?.includes(".hidden: not listed"), problems[0]);
  });

  for (const line of [
    "a.json ../x",
    "../a.json sessions/a.json",
    "a.json /etc/passwd",
    "a.json sessions/a.json extra",
    "only-one-token",
  ]) {
    it(`fails for the manifest line "${line}"`, () => {
      const root = makeValidRepo();
      put(root, `mods/m/tests/fixtures/${MANIFEST}`, `${line}\n`);
      const problems = scanFixtureCopies(root);
      ok(
        problems.some((problem) => problem.includes("line 1")),
        problems.join("\n"),
      );
    });
  }

  it("fails when a copy is a symlink to its master", () => {
    const root = makeValidRepo();
    const copy = join(root, "mods/m/tests/fixtures/a.json");
    rmSync(copy);
    symlinkSync(join(root, MASTER_DIR, "sessions/a.json"), copy);
    const problems = scanFixtureCopies(root);
    ok(
      problems.some((problem) => problem.includes("is a symlink")),
      problems.join("\n"),
    );
  });

  it("passes on the real repository, which has no copies yet", () => {
    const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
    deepStrictEqual(scanFixtureCopies(repoRoot), []);
  });
});
