#!/usr/bin/env node --test

import { deepStrictEqual, strict as assert, strictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createMatchContext,
  createSettingsRoots,
  encodeSessionDirName,
  findSessionRoot,
  getProjectRoot,
} from "../../lib/project-root.ts";
import { shellSingleQuote } from "../../lib/shell-quote.ts";
import { EnvironmentHelper } from "../support/test-helpers.ts";

describe("getProjectRoot", () => {
  const envHelper = new EnvironmentHelper();
  afterEach(() => envHelper.restore());

  it("prefers CLAUDE_TEST_CWD, then CLAUDE_PROJECT_DIR, then inputCwd, then process.cwd()", () => {
    envHelper.set("CLAUDE_TEST_CWD", "/t");
    envHelper.set("CLAUDE_PROJECT_DIR", "/p");
    assert.equal(getProjectRoot("/i"), "/t");
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    assert.equal(getProjectRoot("/i"), "/p");
    envHelper.set("CLAUDE_PROJECT_DIR", undefined);
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(), process.cwd());
  });

  it("treats an empty CLAUDE_PROJECT_DIR or inputCwd as unset", () => {
    envHelper.set("CLAUDE_TEST_CWD", undefined);
    envHelper.set("CLAUDE_PROJECT_DIR", "");
    assert.equal(getProjectRoot("/i"), "/i");
    assert.equal(getProjectRoot(""), process.cwd());
  });
});

describe("shellSingleQuote", () => {
  for (const value of [
    "plain",
    "it's",
    'say "hi"',
    "$(touch /tmp/pwned)",
    "`id`",
    "back\\slash",
    "line1\nline2",
    "",
  ]) {
    it(`round-trips ${JSON.stringify(value)} through bash source`, () => {
      const dir = mkdtempSync(join(tmpdir(), "shell-quote-"));
      const envFile = join(dir, "env");
      writeFileSync(envFile, `export V=${shellSingleQuote(value)}\n`);
      const result = spawnSync(
        "bash",
        ["-c", `. "$1"; printf %s "$V"`, "_", envFile],
        {
          encoding: "utf-8",
        },
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout, value);
    });
  }
});

const withEnv = (vars: Record<string, string | undefined>, run: () => void) => {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe("createMatchContext", () => {
  it("prefers CLAUDE_TEST_CWD, then the hook input cwd, then process.cwd()", () => {
    withEnv({ CLAUDE_TEST_CWD: "/t", HOME: "/home/u" }, () => {
      deepStrictEqual(createMatchContext("/in"), {
        cwd: "/t",
        home: "/home/u",
      });
    });
    withEnv({ CLAUDE_TEST_CWD: undefined, HOME: "/home/u" }, () => {
      deepStrictEqual(createMatchContext("/in"), {
        cwd: "/in",
        home: "/home/u",
      });
      deepStrictEqual(createMatchContext(), {
        cwd: process.cwd(),
        home: "/home/u",
      });
    });
  });

  it("skips a cwd that is not absolute", () => {
    withEnv({ CLAUDE_TEST_CWD: undefined, HOME: "/home/u" }, () => {
      deepStrictEqual(createMatchContext("repo"), {
        cwd: process.cwd(),
        home: "/home/u",
      });
      deepStrictEqual(createMatchContext(""), {
        cwd: process.cwd(),
        home: "/home/u",
      });
    });
    withEnv({ CLAUDE_TEST_CWD: "rel", HOME: "/home/u" }, () => {
      deepStrictEqual(createMatchContext("/in"), {
        cwd: "/in",
        home: "/home/u",
      });
    });
  });

  it("does not follow CLAUDE_PROJECT_DIR", () => {
    withEnv(
      {
        CLAUDE_TEST_CWD: undefined,
        CLAUDE_PROJECT_DIR: "/proj",
        HOME: "/home/u",
      },
      () => {
        deepStrictEqual(createMatchContext("/in"), {
          cwd: "/in",
          home: "/home/u",
        });
      },
    );
  });
});

describe("encodeSessionDirName", () => {
  it("replaces every UTF-16 unit that is not an ASCII letter or digit with -", () => {
    strictEqual(encodeSessionDirName("/home/u/proj"), "-home-u-proj");
    strictEqual(
      encodeSessionDirName("/p/.claude/worktrees/wt_1"),
      "-p--claude-worktrees-wt-1",
    );
    strictEqual(encodeSessionDirName("/a/b c"), "-a-b-c");
    strictEqual(encodeSessionDirName("/a/日本"), "-a---");
    // One emoji is two UTF-16 units, so it becomes two dashes.
    strictEqual(encodeSessionDirName("/a/😀"), "-a---");
    strictEqual(encodeSessionDirName("/"), "-");
  });
});

describe("findSessionRoot", () => {
  const transcriptFor = (root: string) =>
    `/home/u/.claude/projects/${encodeSessionDirName(root)}/s.jsonl`;
  const W = "/p/.claude/worktrees/w";

  it("picks the directory the session started in, also after a Bash cd", () => {
    strictEqual(findSessionRoot(transcriptFor("/p"), "/p", "/p"), "/p");
    strictEqual(findSessionRoot(transcriptFor("/p"), "/p", "/p/inner"), "/p");
  });
  it("picks a worktree the session was started in with -w", () => {
    strictEqual(findSessionRoot(transcriptFor(W), W, W), W);
  });
  it("picks the worktree after EnterWorktree, also after a Bash cd inside it", () => {
    strictEqual(findSessionRoot(transcriptFor(W), "/p", W), W);
    strictEqual(findSessionRoot(transcriptFor(W), "/p", `${W}/src/x`), W);
  });
  it("picks the starting directory again after ExitWorktree", () => {
    strictEqual(findSessionRoot(transcriptFor("/p"), "/p", "/p"), "/p");
  });
  it("finds nothing when the cwd has left the session root", () => {
    strictEqual(
      findSessionRoot(transcriptFor(W), "/p", "/other/dir"),
      undefined,
    );
  });
  it("compares the project dir before the cwd", () => {
    // "/a/b" and "/a-b" encode to the same name.
    strictEqual(findSessionRoot(transcriptFor("/a/b"), "/a/b", "/a-b"), "/a/b");
  });
  it("picks a cwd whose name collides with the session root", () => {
    const sibling = "/p/.claude/worktrees-w";
    strictEqual(findSessionRoot(transcriptFor(W), "/p", sibling), sibling);
  });
  it("does not walk up to the filesystem root", () => {
    strictEqual(findSessionRoot(transcriptFor("/"), "/p", "/x/y"), undefined);
  });
  it("skips candidates that are not absolute", () => {
    strictEqual(findSessionRoot(transcriptFor("/p"), "p", "/p"), "/p");
    strictEqual(
      findSessionRoot("/h/projects/p/s.jsonl", undefined, "p"),
      undefined,
    );
  });
  it("finds nothing without an absolute transcript path", () => {
    strictEqual(findSessionRoot(undefined, "/p", "/p"), undefined);
    strictEqual(findSessionRoot("", "/p", "/p"), undefined);
    strictEqual(findSessionRoot("projects/-p/s.jsonl", "/p", "/p"), undefined);
  });
  it("compares the folded cwd, the form the pattern resolver uses", () => {
    // "/p/a/../.." folds to "/", but its raw text has its own encoded name.
    const name = encodeSessionDirName("/p/a/../..");
    const transcript = `/h/.claude/projects/${name}/s.jsonl`;
    strictEqual(
      findSessionRoot(transcript, undefined, "/p/a/../../etc"),
      undefined,
    );
  });
  it("finds the root through a trailing slash on a candidate", () => {
    strictEqual(
      findSessionRoot(transcriptFor("/p/w"), undefined, "/p/w/"),
      "/p/w",
    );
    strictEqual(findSessionRoot(transcriptFor("/p"), "/p/", "/x"), "/p");
  });
  it("returns the folded path, never one with .. in it", () => {
    strictEqual(
      findSessionRoot(transcriptFor("/p/w"), undefined, "/p/x/../w"),
      "/p/w",
    );
  });
  it("never matches a transcript directory name that is empty or has no leading dash", () => {
    strictEqual(findSessionRoot("/s.jsonl", "/p", "/p"), undefined);
    strictEqual(
      findSessionRoot("/h/projects/p/s.jsonl", "/p", "/p"),
      undefined,
    );
    strictEqual(findSessionRoot("/x/./s.jsonl", "/p", "/p"), undefined);
  });
  it("matches the filesystem root only when it is itself a candidate", () => {
    strictEqual(findSessionRoot(transcriptFor("/"), undefined, "/"), "/");
    strictEqual(findSessionRoot(transcriptFor("/"), "/", "/x/y"), "/");
  });
});

describe("createSettingsRoots", () => {
  const clean = {
    CLAUDE_TEST_CWD: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    HOME: "/home/u",
  };
  const input = (cwd?: string, transcriptPath?: string) => ({
    cwd,
    transcriptPath,
  });
  it("anchors user rules at <home>/.claude", () => {
    withEnv(clean, () => {
      strictEqual(createSettingsRoots(input("/in")).user, "/home/u/.claude");
      strictEqual(
        createSettingsRoots(input("/in"), "/other").user,
        "/other/.claude",
      );
    });
  });
  it("prefers CLAUDE_TEST_CWD, then CLAUDE_PROJECT_DIR, then the hook input cwd, then process.cwd()", () => {
    withEnv(
      { ...clean, CLAUDE_TEST_CWD: "/t", CLAUDE_PROJECT_DIR: "/p" },
      () => {
        strictEqual(createSettingsRoots(input("/in")).project, "/t");
      },
    );
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p" }, () => {
      strictEqual(createSettingsRoots(input("/in")).project, "/p");
    });
    withEnv(clean, () => {
      strictEqual(createSettingsRoots(input("/in")).project, "/in");
      strictEqual(createSettingsRoots(input()).project, process.cwd());
    });
  });
  it("skips a candidate that is not absolute", () => {
    withEnv(
      { ...clean, CLAUDE_TEST_CWD: "rel", CLAUDE_PROJECT_DIR: "." },
      () => {
        strictEqual(createSettingsRoots(input("/in")).project, "/in");
        strictEqual(createSettingsRoots(input()).project, process.cwd());
      },
    );
    withEnv({ ...clean, CLAUDE_TEST_CWD: "", CLAUDE_PROJECT_DIR: "" }, () => {
      strictEqual(createSettingsRoots(input("repo")).project, process.cwd());
      strictEqual(createSettingsRoots(input("/in")).project, "/in");
    });
  });
  it("returns an absolute candidate as written; the resolver normalizes it", () => {
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p/" }, () => {
      strictEqual(createSettingsRoots(input("/in")).project, "/p/");
    });
  });
  it("does not check the home it is given, like ~/ rules", () => {
    withEnv(clean, () => {
      strictEqual(createSettingsRoots(input("/in"), "rel").user, "rel/.claude");
    });
  });
  it("anchors project rules at the candidate the transcript directory names", () => {
    const W = "/p/.claude/worktrees/w";
    const transcriptPath = `/home/u/.claude/projects/${encodeSessionDirName(W)}/s.jsonl`;
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p" }, () => {
      strictEqual(createSettingsRoots({ cwd: W, transcriptPath }).project, W);
      strictEqual(
        createSettingsRoots({ cwd: `${W}/src`, transcriptPath }).project,
        W,
      );
    });
  });
  it("falls back to CLAUDE_PROJECT_DIR when no candidate matches the name", () => {
    const transcriptPath = "/home/u/.claude/projects/-somewhere-else/s.jsonl";
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p" }, () => {
      strictEqual(
        createSettingsRoots({ cwd: "/in", transcriptPath }).project,
        "/p",
      );
    });
  });
  it("ignores a transcript path that is not absolute", () => {
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p" }, () => {
      strictEqual(
        createSettingsRoots({
          cwd: "/in",
          transcriptPath: "projects/-in/s.jsonl",
        }).project,
        "/p",
      );
    });
  });
  it("lets CLAUDE_TEST_CWD win over a matching candidate", () => {
    const transcriptPath = "/home/u/.claude/projects/-in/s.jsonl";
    withEnv(
      { ...clean, CLAUDE_TEST_CWD: "/t", CLAUDE_PROJECT_DIR: "/p" },
      () => {
        strictEqual(
          createSettingsRoots({ cwd: "/in", transcriptPath }).project,
          "/t",
        );
      },
    );
  });
});
