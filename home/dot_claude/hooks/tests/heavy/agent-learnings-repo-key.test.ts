import { strictEqual, match } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveRepoKey } from "../../lib/repo-key.ts";
import { runGit } from "../../lib/run-git.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "agent-learnings-repo-key-")),
  );
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveRepoKey", () => {
  it("returns null outside a git repo", () => {
    withTempDir((dir) => {
      strictEqual(resolveRepoKey(dir, runGit), null);
    });
  });
  it("uses origin when present, the same key from a subdirectory", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", [
        "-C",
        dir,
        "remote",
        "add",
        "origin",
        "git@github.com:Foo/Bar.git",
      ]);
      mkdirSync(join(dir, "sub"));
      strictEqual(resolveRepoKey(dir, runGit), "github.com/foo/bar");
      strictEqual(
        resolveRepoKey(join(dir, "sub"), runGit),
        "github.com/foo/bar",
      );
    });
  });
  it("uses a local key when origin is missing, the same from a subdirectory", () => {
    withTempDir((dir) => {
      execFileSync("git", ["init", "-q", dir]);
      mkdirSync(join(dir, "sub"));
      const key = resolveRepoKey(dir, runGit) ?? "";
      match(key, /^local\/agent-learnings-repo-key-[a-z0-9]+-[0-9a-f]{8}$/);
      strictEqual(resolveRepoKey(join(dir, "sub"), runGit), key);
    });
  });
});
