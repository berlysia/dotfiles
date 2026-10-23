import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  gitDocumentCandidates,
  spawnGit,
} from "../../lib/japanese-document-gate/discovery.ts";

describe("gitDocumentCandidates with the real git", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "japanese-document-gate-git-")),
  );
  after(() => rmSync(root, { recursive: true, force: true }));

  it("lists a changed Japanese document as an absolute path from a subdirectory", () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "docs.md"), "日本語の文書です。\n");
    writeFileSync(join(repo, "english.md"), "English only.\n");
    const result = gitDocumentCandidates(join(repo, "sub"), spawnGit);
    assert.deepEqual(result, { ok: true, paths: [join(repo, "docs.md")] });
  });

  it("returns no candidates outside a repository", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.deepEqual(gitDocumentCandidates(plain, spawnGit), {
      ok: true,
      paths: [],
    });
  });
});
