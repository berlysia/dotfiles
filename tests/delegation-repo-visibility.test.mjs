import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  parseGithubOrigin,
  repoIsPublic,
} from "../home/dot_local/share/delegation/repo-visibility.ts";

// git and gh are fakes first on PATH / DELEGATION_GH_BIN, so no real git
// or network is touched (the unit suite forbids starting git).
let root;
let env;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-vis-")));
  mkdirSync(join(root, "bin"));
  env = {
    HOME: root,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    DELEGATION_GH_BIN: join(root, "bin", "gh"),
  };
});
afterEach(() => rmSync(root, { recursive: true }));

const script = (name, body) => {
  const path = join(root, "bin", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};
const fakeGit = (origin, status = 0) =>
  script("git", `printf '%s\\n' '${origin}'\nexit ${status}`);
const fakeGh = (body) => script("gh", body);
const GH_CALLS = () => join(root, "gh-args");

describe("repoIsPublic: true", () => {
  const origins = [
    "git@github.com:o/r.git",
    "git@github.com:o/r",
    "ssh://git@github.com/o/r.git",
    "ssh://git@github.com:22/o/r",
    "https://github.com/o/r.git",
    "https://github.com/o/r",
    "https://user:token@github.com/o/r.git",
  ];
  for (const origin of origins) {
    it(origin.replace(/:[^@/]*@/, ":***@"), () => {
      fakeGit(origin);
      fakeGh(`echo "$@" > '${GH_CALLS()}'\necho public`);
      assert.equal(repoIsPublic(env, root), true);
      assert.equal(
        readFileSync(GH_CALLS(), "utf8").trim(),
        "api repos/o/r --jq .visibility",
      );
    });
  }
});

describe("repoIsPublic: false", () => {
  const notGithub = [
    "https://gitlab.com/o/r",
    "git@ghe.example.com:o/r.git",
    "https://github.example.com/o/r",
    "https://github.com@evil.com/o/r",
    "https://github.com/o/r/extra",
    "https://github.com/o",
    "http://github.com/o/r",
    "git@github.com:../r",
    "git@github.com:o/..",
    "git@github.com:o/r/extra",
    "https://github.com/o%2f/r",
    "https://github.com/o/.git",
    "not a url",
    "",
  ];
  for (const origin of notGithub) {
    it(`origin ${JSON.stringify(origin)} is rejected before gh runs`, () => {
      fakeGit(origin);
      fakeGh(`echo called > '${GH_CALLS()}'\necho public`);
      assert.equal(repoIsPublic(env, root), false);
      assert.throws(() => readFileSync(GH_CALLS()), /ENOENT/);
    });
  }

  it("no origin or not a repository: git fails", () => {
    for (const status of [2, 128]) {
      fakeGit("", status);
      fakeGh("echo public");
      assert.equal(repoIsPublic(env, root), false, String(status));
    }
  });

  it("gh failure, empty, and near-miss outputs", () => {
    fakeGit("git@github.com:o/r.git");
    for (const body of [
      "exit 1",
      "echo public; exit 1",
      "true",
      "echo Public",
      "echo internal",
      "echo private",
      "echo 'public extra'",
      "echo '\"public\"'",
    ]) {
      fakeGh(body);
      assert.equal(repoIsPublic(env, root), false, body);
    }
  });

  it("gh that does not exist", () => {
    fakeGit("git@github.com:o/r.git");
    assert.equal(
      repoIsPublic(
        { ...env, DELEGATION_GH_BIN: join(root, "bin", "nope") },
        root,
      ),
      false,
    );
  });

  it("gh that outlives the timeout is cut off", () => {
    fakeGit("git@github.com:o/r.git");
    fakeGh("exec sleep 5");
    const started = Date.now();
    assert.equal(repoIsPublic(env, root, 300), false);
    assert.ok(Date.now() - started < 3000);
  });
});

describe("repoIsPublic: environment handed to gh", () => {
  it("drops GH_HOST and GH_REPO, sets GH_PROMPT_DISABLED=1", () => {
    fakeGit("git@github.com:o/r.git");
    fakeGh(`env > '${join(root, "gh-env")}'\necho public`);
    assert.equal(
      repoIsPublic(
        { ...env, GH_HOST: "ghe.example.com", GH_REPO: "x/y" },
        root,
      ),
      true,
    );
    const seen = readFileSync(join(root, "gh-env"), "utf8").split("\n");
    assert.equal(
      seen.some((l) => l.startsWith("GH_HOST=")),
      false,
    );
    assert.equal(
      seen.some((l) => l.startsWith("GH_REPO=")),
      false,
    );
    assert.ok(seen.includes("GH_PROMPT_DISABLED=1"));
  });

  it("git runs without GIT_DIR so another repository cannot answer", () => {
    fakeGit("x");
    script(
      "git",
      `env > '${join(root, "git-env")}'\necho 'git@github.com:o/r.git'`,
    );
    fakeGh("echo public");
    repoIsPublic({ ...env, GIT_DIR: "/elsewhere/.git" }, root);
    const seen = readFileSync(join(root, "git-env"), "utf8");
    assert.doesNotMatch(seen, /^GIT_DIR=/m);
  });
});

describe("parseGithubOrigin", () => {
  it("returns owner and repo; strips .git once", () => {
    assert.deepEqual(parseGithubOrigin("https://github.com/o/r.git.git"), {
      owner: "o",
      repo: "r.git",
    });
    assert.deepEqual(parseGithubOrigin("git@github.com:o-1/r_2.x"), {
      owner: "o-1",
      repo: "r_2.x",
    });
  });
  it("never returns credentials", () => {
    const parsed = parseGithubOrigin("https://u:secret@github.com/o/r");
    assert.deepEqual(parsed, { owner: "o", repo: "r" });
  });
});
