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
    // This test puts secret-named files in the tree as symlink targets.
    const launchS = (r, d, over = {}) =>
      launch(r, d, { allowSecretFiles: true, ...over });
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
        return launchS(root, proj, over).ok;
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
    assert.equal(launchS(root, proj).ok, false);
    rmSync(join(proj, "a"));
    rmSync(join(proj, "b"));
    assert.equal(launchS(root, proj).ok, true);
    // node_modules, .git and .tmp are not entered.
    mkdirSync(join(proj, "node_modules"));
    symlinkSync(outside, join(proj, "node_modules", "pkg"));
    assert.equal(launchS(root, proj).ok, true);
    assert.equal(launchS(root, proj, { budgetMs: 0 }).ok, false);
  });
});

test("checkLaunchDir: files that may hold secrets", () => {
  withHome(({ root }) => {
    const proj = initRepo(root, join(root, "p"));
    assert.equal(launch(root, proj).ok, true);
    // Plain files under .tmp and node_modules pass.
    mkdirSync(join(proj, ".tmp", "deep"), { recursive: true });
    writeFileSync(join(proj, ".tmp", "notes.txt"), "x");
    mkdirSync(join(proj, "node_modules"));
    writeFileSync(join(proj, "node_modules", "x"), "x");
    assert.equal(launch(root, proj).ok, true);
    // .tmp is still scanned for secret names (node_modules is not).
    writeFileSync(join(proj, ".tmp", "deep", ".env"), "x");
    const inTmp = launch(root, proj);
    assert.equal(inTmp.ok, false);
    assert.match(inTmp.reason, /\.tmp\/deep\/\.env/);
    rmSync(join(proj, ".tmp", "deep", ".env"));
    writeFileSync(join(proj, "node_modules", ".env"), "x");
    assert.equal(launch(root, proj).ok, true);
    rmSync(join(proj, "node_modules", ".env"));

    writeFileSync(join(proj, ".env"), "x");
    const root1 = launch(root, proj);
    assert.equal(root1.ok, false);
    assert.match(root1.reason, /秘密を含みうるファイルがある: .*\.env/);
    assert.equal(launch(root, proj, { allowSecretFiles: true }).ok, true);
    rmSync(join(proj, ".env"));

    mkdirSync(join(proj, "sub"));
    writeFileSync(join(proj, "sub", ".npmrc"), "x");
    const nested = launch(root, proj);
    assert.equal(nested.ok, false);
    assert.match(nested.reason, /sub\/\.npmrc/);
    rmSync(join(proj, "sub", ".npmrc"));

    mkdirSync(join(proj, "secrets"));
    writeFileSync(join(proj, "secrets", "x"), "x");
    const sec = launch(root, proj);
    assert.equal(sec.ok, false);
    assert.match(sec.reason, /secrets/);
    rmSync(join(proj, "secrets"), { recursive: true });
    assert.equal(launch(root, proj).ok, true);

    // A symlink is matched by its own name, not followed.
    writeFileSync(join(proj, "a.txt"), "x");
    symlinkSync("a.txt", join(proj, "credentials.json"));
    assert.match(launch(root, proj).reason ?? "", /credentials\.json/);
    rmSync(join(proj, "credentials.json"));

    // At most five paths are listed.
    for (let i = 0; i < 8; i++) writeFileSync(join(proj, `k${i}.pem`), "x");
    const many = launch(root, proj);
    assert.equal(many.ok, false);
    const listed = many.reason.split("ファイルがある: ")[1].split("（")[0];
    assert.equal(listed.split(", ").length, 5);
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
