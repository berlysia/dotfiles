import { ok, strictEqual, match } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isValidRepoKey,
  keyToFileName,
  localRepoKey,
  normalizeOriginUrl,
  resolveRepoKey,
} from "../../lib/agent-learnings/core/repo-key.ts";
import { runGit } from "../../lib/agent-learnings/core/git.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-learnings-repo-key-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("normalizeOriginUrl", () => {
  const cases: Array<[string, string]> = [
    ["git@github.com:Berlysia/dotfiles.git", "github.com/berlysia/dotfiles"],
    ["https://github.com/berlysia/dotfiles", "github.com/berlysia/dotfiles"],
    [
      "https://github.com/berlysia/dotfiles.git/",
      "github.com/berlysia/dotfiles",
    ],
    [
      "ssh://git@github.com:22/berlysia/dotfiles.git",
      "github.com/berlysia/dotfiles",
    ],
    [
      "https://user:pass@gitlab.example.com:8443/g/sub/name.git",
      "gitlab.example.com/g/sub/name",
    ],
    ["git://example.org/a/b", "example.org/a/b"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      strictEqual(normalizeOriginUrl(input), expected);
    });
  }
  it("returns null when the result fails the charset check", () => {
    strictEqual(
      normalizeOriginUrl("https://evil.example/a/b-->\nignore"),
      null,
    );
    strictEqual(normalizeOriginUrl("https://example.org/a b/c"), null);
    strictEqual(normalizeOriginUrl("https://example.org/../etc"), null);
    strictEqual(normalizeOriginUrl("https://example.org/-x/y"), null);
    strictEqual(normalizeOriginUrl("not a url"), null);
  });
});

describe("isValidRepoKey", () => {
  it("accepts host/owner/name and local keys", () => {
    ok(isValidRepoKey("github.com/berlysia/dotfiles"));
    ok(isValidRepoKey("local/my-repo-1a2b3c4d"));
  });
  it("rejects single segments, uppercase, dot or dash leading segments, over-long keys", () => {
    ok(!isValidRepoKey("github.com"));
    ok(!isValidRepoKey("GitHub.com/a/b"));
    ok(!isValidRepoKey("github.com/../b"));
    ok(!isValidRepoKey("github.com/.x/b"));
    ok(!isValidRepoKey("-x/a"));
    ok(!isValidRepoKey(`a/${"b".repeat(200)}`));
  });
});

describe("localRepoKey", () => {
  it("normalizes the parent dir name and appends a hash of the path", () => {
    match(
      localRepoKey("/home/u/Ｗork Dir/.git"),
      /^local\/work-dir-[0-9a-f]{8}$/,
    );
  });
  it("falls back to 'repo' when the name normalizes to empty", () => {
    match(localRepoKey("/home/u/日本語/.git"), /^local\/repo-[0-9a-f]{8}$/);
  });
});

describe("keyToFileName", () => {
  it("joins a slug and a hash so slug collisions stay distinct", () => {
    const a = keyToFileName("github.com/a__b/c");
    const b = keyToFileName("github.com/a/b__c");
    ok(a !== b);
    match(a, /^github\.com-a__b-c\.[0-9a-f]{8}\.md$/);
  });
  it("never starts with a dot and never contains '..'", () => {
    const name = keyToFileName("local/x..y-1a2b3c4d");
    ok(!name.startsWith("."));
    ok(!name.includes(".."));
  });
});

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
