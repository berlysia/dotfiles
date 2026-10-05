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
  getProjectRoot,
} from "../../lib/project-root.ts";
import { shellSingleQuote } from "../../lib/shell-quote.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

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

describe("createSettingsRoots", () => {
  const clean = {
    CLAUDE_TEST_CWD: undefined,
    CLAUDE_PROJECT_DIR: undefined,
    HOME: "/home/u",
  };
  it("anchors user rules at <home>/.claude", () => {
    withEnv(clean, () => {
      strictEqual(createSettingsRoots("/in").user, "/home/u/.claude");
      strictEqual(createSettingsRoots("/in", "/other").user, "/other/.claude");
    });
  });
  it("prefers CLAUDE_TEST_CWD, then CLAUDE_PROJECT_DIR, then the hook input cwd, then process.cwd()", () => {
    withEnv(
      { ...clean, CLAUDE_TEST_CWD: "/t", CLAUDE_PROJECT_DIR: "/p" },
      () => {
        strictEqual(createSettingsRoots("/in").project, "/t");
      },
    );
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p" }, () => {
      strictEqual(createSettingsRoots("/in").project, "/p");
    });
    withEnv(clean, () => {
      strictEqual(createSettingsRoots("/in").project, "/in");
      strictEqual(createSettingsRoots().project, process.cwd());
    });
  });
  it("skips a candidate that is not absolute", () => {
    withEnv(
      { ...clean, CLAUDE_TEST_CWD: "rel", CLAUDE_PROJECT_DIR: "." },
      () => {
        strictEqual(createSettingsRoots("/in").project, "/in");
        strictEqual(createSettingsRoots().project, process.cwd());
      },
    );
    withEnv({ ...clean, CLAUDE_TEST_CWD: "", CLAUDE_PROJECT_DIR: "" }, () => {
      strictEqual(createSettingsRoots("repo").project, process.cwd());
      strictEqual(createSettingsRoots("/in").project, "/in");
    });
  });
  it("returns an absolute candidate as written; the resolver normalizes it", () => {
    withEnv({ ...clean, CLAUDE_PROJECT_DIR: "/p/" }, () => {
      strictEqual(createSettingsRoots("/in").project, "/p/");
    });
  });
  it("does not check the home it is given, like ~/ rules", () => {
    withEnv(clean, () => {
      strictEqual(createSettingsRoots("/in", "rel").user, "rel/.claude");
    });
  });
});
