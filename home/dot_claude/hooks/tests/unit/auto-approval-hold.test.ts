#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assessAutoApprovalHold,
  buildHoldContext,
} from "../../lib/auto-approval-hold.ts";

describe("assessAutoApprovalHold", () => {
  let home = "";
  beforeEach(() => {
    // A mkdtemp home, not the real HOME.
    home = realpathSync(mkdtempSync(join(tmpdir(), "aah-home-")));
    mkdirSync(join(home, ".local/share/chezmoi"), { recursive: true });
    writeFileSync(join(home, ".local/share/chezmoi/.chezmoiroot"), "home\n");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const ctx = (cwd: string) => buildHoldContext({ cwd, home });

  it("reads and trims .chezmoiroot", () => {
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/home"),
    );
  });
  it("follows .chezmoiroot when it names another directory", () => {
    writeFileSync(join(home, ".local/share/chezmoi/.chezmoiroot"), "other\n");
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/other"),
    );
  });
  it("falls back to the ask-rule path when .chezmoiroot is missing", () => {
    rmSync(join(home, ".local/share/chezmoi/.chezmoiroot"));
    strictEqual(
      ctx("/w/p").chezmoiSource,
      join(home, ".local/share/chezmoi/home"),
    );
  });
  it("drops a project root that cannot serve as a base", () => {
    for (const projectRoot of ["/", "relative/dir", home, `${home}/`]) {
      strictEqual(
        buildHoldContext({ cwd: "/w/p", home, projectRoot }).projectRoot,
        "",
        projectRoot,
      );
    }
    strictEqual(
      buildHoldContext({ cwd: "/w/p", home, projectRoot: "/w/p/" }).projectRoot,
      "/w/p",
    );
  });
  it("resolves a relative Edit path against cwd", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: ".claude/x.json" },
          ctx("/w/p"),
        )
      ).hold,
      true,
    );
  });
  it("covers Write, MultiEdit and NotebookEdit", async () => {
    for (const [tool, input] of [
      ["Write", { file_path: "/w/p/.vscode/a.json" }],
      ["MultiEdit", { file_path: "/w/p/.vscode/a.json" }],
      ["NotebookEdit", { notebook_path: "/w/p/.vscode/a.ipynb" }],
    ] as const) {
      strictEqual(
        (await assessAutoApprovalHold(tool, input, ctx("/w/p"))).hold,
        true,
        tool,
      );
    }
  });
  it("does not hold a plain path or a read tool", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: "/w/p/src/a.ts" },
          ctx("/w/p"),
        )
      ).hold,
      false,
    );
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Read",
          { file_path: "/w/p/.claude/x" },
          ctx("/w/p"),
        )
      ).hold,
      false,
    );
  });
  it("holds a write tool without a path", async () => {
    strictEqual(
      (await assessAutoApprovalHold("Write", {}, ctx("/w/p"))).hold,
      true,
    );
  });
  it("routes Bash to the command check", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Bash",
          { command: "tee .claude/x" },
          ctx("/w/p"),
        )
      ).hold,
      true,
    );
    strictEqual(
      (await assessAutoApprovalHold("Bash", { command: "ls src" }, ctx("/w/p")))
        .hold,
      false,
    );
  });
});
