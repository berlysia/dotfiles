import { ok, strictEqual, match } from "node:assert";
import { describe, it } from "node:test";
import {
  isValidRepoKey,
  keyToFileName,
  localRepoKey,
  normalizeOriginUrl,
} from "../../lib/agent-learnings/core/repo-key.ts";

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
