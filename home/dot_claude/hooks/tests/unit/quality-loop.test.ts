#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  detectFormatters,
  findLocalBin,
  formatArgs,
  isInsideRepo,
  runFormat,
} from "../../implementations/quality-loop.ts";
import {
  cleanupTempDirs,
  installBin,
  makeDir,
  setupFormatRepo,
  writeFile,
} from "../support/quality-loop-helpers.ts";

after(cleanupTempDirs);

describe("detectFormatters", () => {
  it("detects oxfmt from .oxfmtrc.json", () => {
    const root = makeDir();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    deepStrictEqual(detectFormatters(root), ["oxfmt"]);
  });

  it("detects oxfmt from .oxfmtrc.jsonc", () => {
    const root = makeDir();
    writeFile(join(root, ".oxfmtrc.jsonc"), "{}");
    deepStrictEqual(detectFormatters(root), ["oxfmt"]);
  });

  it("detects biome from biome.json", () => {
    const root = makeDir();
    writeFile(join(root, "biome.json"), "{}");
    deepStrictEqual(detectFormatters(root), ["biome"]);
  });

  it("detects prettier from .prettierrc", () => {
    const root = makeDir();
    writeFile(join(root, ".prettierrc"), "{}");
    deepStrictEqual(detectFormatters(root), ["prettier"]);
  });

  it("detects prettier from the package.json key", () => {
    const root = makeDir();
    writeFile(join(root, "package.json"), '{"prettier": {}}');
    deepStrictEqual(detectFormatters(root), ["prettier"]);
  });

  it("returns [] for a broken package.json", () => {
    const root = makeDir();
    writeFile(join(root, "package.json"), "{ not json");
    deepStrictEqual(detectFormatters(root), []);
  });

  it("orders coexisting configs oxfmt before prettier", () => {
    const root = makeDir();
    writeFile(join(root, ".oxfmtrc.json"), "{}");
    writeFile(join(root, ".prettierrc"), "{}");
    deepStrictEqual(detectFormatters(root), ["oxfmt", "prettier"]);
  });

  it("returns [] when nothing is configured", () => {
    deepStrictEqual(detectFormatters(makeDir()), []);
  });
});

describe("formatArgs", () => {
  it("builds oxfmt args without .oxfmtignore", () => {
    const root = makeDir();
    deepStrictEqual(formatArgs("oxfmt", "/x/a.ts", root), [
      "--write",
      "/x/a.ts",
    ]);
  });

  it("adds --ignore-path when .oxfmtignore exists", () => {
    const root = makeDir();
    writeFile(join(root, ".oxfmtignore"), "");
    deepStrictEqual(formatArgs("oxfmt", "/x/a.ts", root), [
      "--write",
      "--ignore-path",
      ".oxfmtignore",
      "/x/a.ts",
    ]);
  });

  it("builds prettier args", () => {
    deepStrictEqual(formatArgs("prettier", "/x/a.ts", makeDir()), [
      "--write",
      "--ignore-unknown",
      "/x/a.ts",
    ]);
  });

  it("builds biome args", () => {
    deepStrictEqual(formatArgs("biome", "/x/a.ts", makeDir()), [
      "format",
      "--write",
      "--no-errors-on-unmatched",
      "/x/a.ts",
    ]);
  });
});

describe("findLocalBin", () => {
  it("finds the bin in the second root only", () => {
    const worktree = makeDir();
    const parent = makeDir();
    const bin = installBin(parent, "oxfmt", "exit 0");
    strictEqual(findLocalBin([worktree, parent], "oxfmt"), bin);
  });

  it("does not look above the given roots", () => {
    const outer = makeDir();
    installBin(outer, "oxfmt", "exit 0");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    strictEqual(findLocalBin([inner], "oxfmt"), null);
  });

  it("returns null when no root has it", () => {
    strictEqual(findLocalBin([makeDir(), makeDir()], "oxfmt"), null);
  });
});

describe("isInsideRepo", () => {
  it("rejects a sibling directory sharing the root as a prefix", () => {
    const base = makeDir();
    const root = join(base, "repo");
    writeFile(join(root, "keep"), "");
    writeFile(join(base, "repo-evil", "x.ts"), "");
    strictEqual(isInsideRepo(join(base, "repo-evil", "x.ts"), root), false);
  });

  it("accepts a file inside the root", () => {
    const base = makeDir();
    const root = join(base, "repo");
    writeFile(join(root, "x.ts"), "");
    strictEqual(isInsideRepo(join(root, "x.ts"), root), true);
  });

  it("rejects a symlink that points outside the root", () => {
    const base = makeDir();
    const root = join(base, "repo");
    mkdirSync(root);
    writeFile(join(base, "outside.ts"), "");
    symlinkSync(join(base, "outside.ts"), join(root, "link.ts"));
    strictEqual(isInsideRepo(join(root, "link.ts"), root), false);
  });
});

describe("runFormat", () => {
  it("returns null when no formatter is configured", () => {
    const { root, file } = setupFormatRepo();
    strictEqual(runFormat(file, root), null);
  });
});
