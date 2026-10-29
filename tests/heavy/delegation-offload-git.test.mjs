// Tests of checkLaunchDir that start git. They live under tests/heavy because
// the default test script forbids launching git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkLaunchDir } from "../../home/dot_local/share/delegation/offload.ts";
import { withHome } from "../lib/delegation-offload-home.mjs";

const GIT_ENV = (root) => ({ PATH: process.env.PATH, HOME: root });
function initRepo(root, path) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path, env: GIT_ENV(root) });
  return realpathSync(path);
}
const launch = (root, dir, over = {}) =>
  checkLaunchDir({ dir, write: false, home: root, ...over });

test("checkLaunchDir: toplevel, home and hidden directories", () => {
  withHome(({ root, dir }) => {
    const proj = initRepo(root, join(root, "src", "x"));
    assert.equal(launch(root, proj).ok, true);
    mkdirSync(join(proj, "sub"));
    assert.equal(launch(root, join(proj, "sub")).ok, false);
    initRepo(root, root);
    assert.equal(launch(root, root).ok, false);
    assert.equal(launch(root, "/").ok, false);
    for (const hidden of [
      join(root, ".ssh"),
      join(root, ".config", "gh"),
      dir,
    ]) {
      initRepo(root, hidden);
      assert.equal(launch(root, hidden).ok, false, hidden);
    }
    const chez = initRepo(root, join(root, ".local", "share", "chezmoi"));
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "x",
      ],
      { cwd: chez, env: GIT_ENV(root) },
    );
    assert.equal(launch(root, chez).ok, true);
    const wt = join(chez, ".git", "worktree", "x");
    execFileSync("git", ["worktree", "add", "-q", "-b", "wt", wt], {
      cwd: chez,
      env: GIT_ENV(root),
    });
    assert.equal(launch(root, wt).ok, true);
  });
});

test("checkLaunchDir: an opencode config in the directory or an ancestor", () => {
  withHome(({ root }) => {
    const proj = initRepo(root, join(root, "p", "q"));
    writeFileSync(join(root, "opencode.jsonc"), "{}");
    assert.equal(launch(root, proj).ok, false);
    rmSync(join(root, "opencode.jsonc"));
    mkdirSync(join(proj, ".opencode"));
    assert.equal(launch(root, proj).ok, false);
  });
});

test("checkLaunchDir: symlinks", () => {
  withHome(({ root }) => {
    const proj = initRepo(root, join(root, "p"));
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "x");
    writeFileSync(join(proj, "CLAUDE.md"), "x");
    writeFileSync(join(proj, ".env"), "x");
    mkdirSync(join(proj, "sub"));
    writeFileSync(join(proj, "sub", ".npmrc"), "x");
    mkdirSync(join(proj, "secrets"));
    mkdirSync(join(proj, ".tmp"));
    mkdirSync(join(proj, ".husky"));
    writeFileSync(join(proj, ".husky", "pre-commit"), "x");
    const withLink = (name, target, over) => {
      const link = join(proj, name);
      symlinkSync(target, link);
      try {
        return launch(root, proj, over).ok;
      } finally {
        rmSync(link);
      }
    };
    assert.equal(withLink("AGENTS.md", "CLAUDE.md"), true);
    assert.equal(withLink("link", ".env"), false);
    assert.equal(withLink("link", "sub/.npmrc"), false);
    assert.equal(withLink("d", "secrets"), false);
    assert.equal(withLink("d", ".tmp"), false);
    assert.equal(withLink("d", outside), false);
    assert.equal(withLink("d", "missing-target"), false);
    assert.equal(withLink("x", ".husky/pre-commit"), true);
    assert.equal(withLink("x", ".husky/pre-commit", { write: true }), false);
    // A loop.
    symlinkSync("b", join(proj, "a"));
    symlinkSync("a", join(proj, "b"));
    assert.equal(launch(root, proj).ok, false);
    rmSync(join(proj, "a"));
    rmSync(join(proj, "b"));
    assert.equal(launch(root, proj).ok, true);
    // node_modules, .git and .tmp are not entered.
    mkdirSync(join(proj, "node_modules"));
    symlinkSync(outside, join(proj, "node_modules", "pkg"));
    assert.equal(launch(root, proj).ok, true);
    assert.equal(launch(root, proj, { budgetMs: 0 }).ok, false);
  });
});

test("checkLaunchDir: GIT_* variables do not change the toplevel", () => {
  withHome(({ root }) => {
    const proj = initRepo(root, join(root, "p"));
    process.env.GIT_DIR = "/elsewhere/.git";
    try {
      assert.equal(launch(root, proj).ok, true);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
