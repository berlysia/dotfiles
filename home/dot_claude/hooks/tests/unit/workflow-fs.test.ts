#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  isStrictlyUnderProjectSubdir,
  realpathInsideWorkflowDir,
} from "../../lib/workflow-fs.ts";

describe("workflow-fs.ts", () => {
  describe("realpathInsideWorkflowDir", () => {
    it("returns null for symlink that escapes the workflow dir", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      const outsideTarget = join(tmpRoot, "outside.md");
      writeFileSync(outsideTarget, "outside");
      const linkInside = join(wfDir, "spec.md");
      symlinkSync(outsideTarget, linkInside);
      strictEqual(realpathInsideWorkflowDir(linkInside, wfDir), null);
    });

    it("returns the resolved path for a legitimate file inside workflow dir", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      const insideFile = join(wfDir, "spec.md");
      writeFileSync(insideFile, "content");
      strictEqual(realpathInsideWorkflowDir(insideFile, wfDir), insideFile);
    });

    it("returns null when the path does not exist", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      strictEqual(
        realpathInsideWorkflowDir(join(wfDir, "nonexistent.md"), wfDir),
        null,
      );
    });

    it("accepts the workflow dir itself", () => {
      const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "wf-")));
      const wfDir = join(tmpRoot, "session");
      mkdirSync(wfDir, { recursive: true });
      strictEqual(realpathInsideWorkflowDir(wfDir, wfDir), wfDir);
    });
  });
});

describe("isStrictlyUnderProjectSubdir", () => {
  function makeProject(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cont-")));
    mkdirSync(join(root, ".tmp", "sessions", "abcd1234"), { recursive: true });
    return root;
  }

  it("accepts a child of the subdir", () => {
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/abcd1234",
      ),
      true,
    );
  });

  it("accepts an absolute candidate under the subdir", () => {
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        join(root, ".tmp", "sessions", "abcd1234"),
      ),
      true,
    );
  });

  it("accepts a child that does not exist yet", () => {
    // The dir is created on first write, so a pin naming a fresh session must
    // not be rejected merely because nothing has been written to it.
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/not-yet",
      ),
      true,
    );
  });

  it("rejects the subdir itself, which every session would share", () => {
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(root, ".tmp/sessions", ".tmp/sessions"),
      false,
    );
  });

  it("rejects a sibling whose name merely starts with the subdir", () => {
    const root = makeProject();
    mkdirSync(join(root, ".tmp", "sessions-evil"), { recursive: true });
    strictEqual(
      isStrictlyUnderProjectSubdir(root, ".tmp/sessions", ".tmp/sessions-evil"),
      false,
    );
  });

  it("rejects a path outside the project", () => {
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(root, ".tmp/sessions", tmpdir()),
      false,
    );
  });

  it("rejects a traversal that lands elsewhere inside the project", () => {
    // `<root>/etc` -- still inside the project, but outside the sessions root.
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/abcd1234/../../../etc",
      ),
      false,
    );
  });

  it("rejects a traversal that climbs out of the project entirely", () => {
    const root = makeProject();
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/abcd1234/../../../../../../etc",
      ),
      false,
    );
  });

  it("rejects a symlink under the subdir that escapes the project", () => {
    const root = makeProject();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cont-out-")));
    symlinkSync(outside, join(root, ".tmp", "sessions", "linked"));
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/linked",
      ),
      false,
    );
  });

  it("rejects everything when the subdir is a symlink out of the project", () => {
    // A cloned repo can ship .tmp/sessions as a tracked symlink (mode 120000);
    // .gitignore does not apply to tracked files. Symlinking .tmp to a scratch
    // volume reaches the same state benignly.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cont-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cont-evil-")));
    mkdirSync(join(outside, "sess1"), { recursive: true });
    mkdirSync(join(root, ".tmp"), { recursive: true });
    symlinkSync(outside, join(root, ".tmp", "sessions"));
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/sess1",
      ),
      false,
    );
  });

  it("rejects everything when the subdir is a symlink to another dir inside the project", () => {
    // Anchoring only "the base stays inside the project" passes this: docs/ is
    // inside. The basis has still moved, and any approved spec+plan committed
    // under docs/ then satisfies containment. The base must be the literal
    // <root>/<subdir>, not merely something under the root.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cont-")));
    mkdirSync(join(root, "docs", "sess1"), { recursive: true });
    mkdirSync(join(root, ".tmp"), { recursive: true });
    symlinkSync(join(root, "docs"), join(root, ".tmp", "sessions"));
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/sess1",
      ),
      false,
    );
  });

  it("rejects a candidate whose resolution fails for a reason other than absence", () => {
    // A symlink loop is lexically under the subdir but realpath never ran, so
    // the verification this predicate exists to perform did not happen.
    // Falling back to lexical comparison here would report "contained" for a
    // path that cannot be opened at all.
    const root = makeProject();
    const a = join(root, ".tmp", "sessions", "loopA");
    const b = join(root, ".tmp", "sessions", "loopB");
    symlinkSync(b, a);
    symlinkSync(a, b);
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/loopA",
      ),
      false,
    );
  });

  it("rejects a missing leaf whose existing ancestor leaves the project", () => {
    // realpathSync throws ENOENT for the whole path whether nothing on it
    // exists or only the leaf is missing. Falling back to a lexical comparison
    // on that signal accepts a path whose real location is outside the project.
    const root = makeProject();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cont-out-")));
    symlinkSync(outside, join(root, ".tmp", "sessions", "linked"));
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/linked/not-yet",
      ),
      false,
    );
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/linked/a/b/c",
      ),
      false,
    );
  });

  it("rejects a dangling symlink under the subdir", () => {
    // The entry exists; only its target does not. Accepting it produces the
    // worst shape: containment reports success and the startup summary shows a
    // concrete dir, while every existsSync through it is false, so the workflow
    // is silently inactive.
    const root = makeProject();
    symlinkSync(
      "/nonexistent/target",
      join(root, ".tmp", "sessions", "dangling"),
    );
    strictEqual(
      isStrictlyUnderProjectSubdir(
        root,
        ".tmp/sessions",
        ".tmp/sessions/dangling",
      ),
      false,
    );
  });

  it("accepts a child when the project root itself is reached through a symlink", () => {
    // Resolving only one side would reject this legitimate pin.
    const real = realpathSync(mkdtempSync(join(tmpdir(), "cont-real-")));
    mkdirSync(join(real, ".tmp", "sessions", "abcd1234"), { recursive: true });
    const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "cont-link-")));
    const linked = join(linkDir, "proj");
    symlinkSync(real, linked);
    strictEqual(
      isStrictlyUnderProjectSubdir(
        linked,
        ".tmp/sessions",
        ".tmp/sessions/abcd1234",
      ),
      true,
    );
  });
});
