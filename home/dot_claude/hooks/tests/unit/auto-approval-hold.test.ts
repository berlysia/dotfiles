#!/usr/bin/env node --test
import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  it("holds a Read of a file the ask rules name", async () => {
    for (const file_path of [
      "/w/p/.env",
      "/w/p/apps/web/.env.local",
      "/etc/app/.env.production",
      "/w/p/.env.prod.local",
      "/w/p/.env.development",
      "/w/p/.env.dev",
      "/w/p/.env.prod",
      "/w/p/.env.staging",
      "/w/p/.env.preview",
      "/w/p/.env.test",
      ".env",
      // a directory with one of the names
      "/w/p/.env/secret.txt",
    ]) {
      strictEqual(
        (await assessAutoApprovalHold("Read", { file_path }, ctx("/w/p"))).hold,
        true,
        file_path,
      );
    }
  });
  it("holds a Read through a symlink to a file the ask rules name", async () => {
    mkdirSync(join(home, "real"));
    writeFileSync(join(home, "real/.env"), "PROBE_KEY=dummy-not-a-secret\n");
    symlinkSync(join(home, "real/.env"), join(home, "link.txt"));
    symlinkSync(join(home, "real"), join(home, "linkdir"));
    for (const file_path of [
      join(home, "link.txt"),
      // a symlinked parent directory; the last segment is still .env
      join(home, "linkdir/.env"),
    ]) {
      strictEqual(
        (await assessAutoApprovalHold("Read", { file_path }, ctx("/w/p"))).hold,
        true,
        file_path,
      );
    }
  });
  it("holds a Read whose path it cannot judge as written", async () => {
    for (const file_path of ["~/link.txt", "/w/p/a/../b.txt", "../b.txt"]) {
      strictEqual(
        (await assessAutoApprovalHold("Read", { file_path }, ctx("/w/p"))).hold,
        true,
        file_path,
      );
    }
  });
  it("does not hold a Read under a path that is not a directory", async () => {
    writeFileSync(join(home, "a.txt"), "x\n");
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Read",
          { file_path: join(home, "a.txt/x") },
          ctx("/w/p"),
        )
      ).hold,
      false,
    );
  });
  it("does not hold a Read of a name outside the ask rules", async () => {
    for (const file_path of [
      "/w/p/.env.example",
      "/w/p/.env.sample",
      "/w/p/.env.local.bak",
      "/w/p/ai.env.sh",
      "/w/p/.envrc",
      "/w/p/env",
      "/w/p/.env.d/readme.md",
    ]) {
      strictEqual(
        (await assessAutoApprovalHold("Read", { file_path }, ctx("/w/p"))).hold,
        false,
        file_path,
      );
    }
    strictEqual(
      (await assessAutoApprovalHold("Read", {}, ctx("/w/p"))).hold,
      false,
    );
  });
  it("holds a write tool without a path", async () => {
    strictEqual(
      (await assessAutoApprovalHold("Write", {}, ctx("/w/p"))).hold,
      true,
    );
  });
  it("reads the field each write tool writes and holds ambiguous inputs", async () => {
    const holds = async (tool: string, input: unknown) =>
      (await assessAutoApprovalHold(tool, input, ctx("/w/p"))).hold;
    // NotebookEdit writes notebook_path; the harmless file_path must not mask it.
    strictEqual(
      await holds("NotebookEdit", {
        file_path: "/w/p/src/a.ts",
        notebook_path: "/w/p/.vscode/a.ipynb",
      }),
      true,
    );
    strictEqual(
      await holds("Edit", {
        file_path: "/w/p/src/a.ts",
        notebook_path: "/w/p/src/b.ipynb",
      }),
      true,
    );
    strictEqual(
      await holds("Edit", { file_path: "/w/p/src/a.ts", path: "/w/p/x" }),
      true,
    );
    // The field the tool does not write is not a substitute for the missing one.
    strictEqual(await holds("Edit", { notebook_path: "/w/p/src/a.ts" }), true);
    strictEqual(await holds("NotebookEdit", { file_path: "/w/p/a.ts" }), true);
    strictEqual(await holds("Edit", { file_path: 42 }), true);
    strictEqual(
      await holds("NotebookEdit", { notebook_path: "/w/p/src/a.ipynb" }),
      false,
    );
  });
  it("holds a write path that starts with ~", async () => {
    strictEqual(
      (
        await assessAutoApprovalHold(
          "Edit",
          { file_path: "~/notes.txt" },
          ctx("/w/p"),
        )
      ).hold,
      true,
    );
  });
  it("holds a relative path with an inner .. segment only", async () => {
    const holds = async (file_path: string) =>
      (await assessAutoApprovalHold("Edit", { file_path }, ctx("/w/p"))).hold;
    strictEqual(await holds("sub/link/../x.txt"), true);
    strictEqual(await holds("../x.txt"), false);
    strictEqual(await holds("src/a.ts"), false);
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
