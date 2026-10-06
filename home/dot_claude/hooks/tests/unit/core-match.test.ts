#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
import { coreDecision, coreMatch } from "../support/core-match.ts";

const env = {
  home: "/home/u",
  cwd: "/home/u/proj",
  settingsDir: "/home/u/.claude",
};

describe("coreMatch (emulation of Claude Code's gitignore-style rules)", () => {
  it("treats a bare name like **/name (docs example)", () => {
    strictEqual(coreMatch("Read(.env)", "/home/u/proj/a/.env", env), true);
    strictEqual(coreMatch("Read(**/.env)", "/home/u/proj/a/.env", env), true);
  });
  it("anchors // at the filesystem root and ~/ at home", () => {
    strictEqual(coreMatch("Edit(//tmp/**)", "/tmp/x/y", env), true);
    strictEqual(coreMatch("Read(~/.zshrc)", "/home/u/.zshrc", env), true);
  });
  it("anchors /path in user settings at ~/.claude (docs example)", () => {
    strictEqual(
      coreMatch("Read(/secrets/**)", "/home/u/.claude/secrets/a", env),
      true,
    );
    strictEqual(
      coreMatch("Read(/secrets/**)", "/home/u/proj/secrets/a", env),
      false,
    );
  });
  it("extends a matched directory to its contents", () => {
    strictEqual(
      coreMatch("Edit(//**/.git)", "/r/.git/worktree/x/src/a.ts", env),
      true,
    );
  });
  it("does not match outside the anchor", () => {
    strictEqual(coreMatch("Edit(~/workspace/**)", "/tmp/a", env), false);
  });
  it("anchors a slash-free ~/ pattern at home, not at any depth", () => {
    strictEqual(
      coreMatch("Edit(~/.gitconfig*)", "/home/u/.gitconfig", env),
      true,
    );
    strictEqual(
      coreMatch("Edit(~/.gitconfig*)", "/home/u/proj/.gitconfig", env),
      false,
    );
  });
});

describe("coreDecision (deny > ask > allow)", () => {
  it("prefers deny, then ask, then allow", () => {
    const rules = {
      deny: ["Edit(//**/.git/config)"],
      ask: ["Edit(~/.gitconfig*)"],
      allow: ["Edit(//**)"],
    };
    strictEqual(coreDecision("Edit", "/r/.git/config", rules, env), "deny");
    strictEqual(coreDecision("Edit", "/home/u/.gitconfig", rules, env), "ask");
    strictEqual(coreDecision("Edit", "/r/src/a.ts", rules, env), "allow");
  });
});
