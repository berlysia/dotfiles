#!/usr/bin/env node --test

import { strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveWorkflowDir } from "../../lib/workflow-resolve.ts";
import { EnvironmentHelper } from "./test-helpers.ts";

describe("workflow-resolve.ts", () => {
  const env = new EnvironmentHelper();
  afterEach(() => env.restore());

  const SID = "abcd1234-0000-0000-0000-000000000000";

  function makeProject(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rwd-")));
    mkdirSync(join(root, ".tmp", "sessions", "abcd1234"), { recursive: true });
    return root;
  }

  it("derives from the session id when env is unset", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "derived");
    strictEqual(r.relative, ".tmp/sessions/abcd1234");
    strictEqual(r.dir, resolve(cwd, ".tmp/sessions/abcd1234"));
  });

  it("treats an empty env value as unset", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", "");
    strictEqual(resolveWorkflowDir({ cwd, sessionId: SID }).source, "derived");
  });

  it("treats a whitespace-only env value as unset", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", "   ");
    strictEqual(resolveWorkflowDir({ cwd, sessionId: SID }).source, "derived");
  });

  it("accepts an env pin under the sessions root", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".tmp", "sessions", "pinned01"), { recursive: true });
    env.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/pinned01");
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "env");
    strictEqual(r.dir, resolve(cwd, ".tmp/sessions/pinned01"));
  });

  it("normalizes relative so display cannot diverge from the decision", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".tmp", "sessions", "pinned01"), { recursive: true });
    env.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions//pinned01");
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "env");
    strictEqual(r.relative, ".tmp/sessions/pinned01");
    strictEqual(r.dir, resolve(cwd, ".tmp/sessions/pinned01"));
  });

  it("rejects an env value outside the project", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", tmpdir());
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "env-rejected");
    strictEqual(r.dir, resolve(cwd, ".tmp/sessions/abcd1234"));
    strictEqual(r.relative, ".tmp/sessions/abcd1234");
  });

  it("rejects an env value inside the project but outside the sessions root", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, "elsewhere"), { recursive: true });
    env.set("DOCUMENT_WORKFLOW_DIR", "elsewhere");
    strictEqual(
      resolveWorkflowDir({ cwd, sessionId: SID }).source,
      "env-rejected",
    );
  });

  it("expands a tilde env value and accepts it when it lands under the sessions root", () => {
    // The pin must start with "~/" for expandTilde to do anything, and the
    // expansion has to change the verdict for the case to mean something:
    // unexpanded, "~/.tmp/sessions/pinned01" resolves to <cwd>/~/.tmp/... and
    // would be rejected. os.homedir() reads process.env.HOME on POSIX, so
    // pointing HOME at the fixture is what makes the accepting branch
    // reachable without touching the real home directory.
    const cwd = makeProject();
    mkdirSync(join(cwd, ".tmp", "sessions", "pinned01"), { recursive: true });
    env.set("HOME", cwd);
    env.set("DOCUMENT_WORKFLOW_DIR", "~/.tmp/sessions/pinned01");
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "env");
    strictEqual(r.dir, resolve(cwd, ".tmp/sessions/pinned01"));
    strictEqual(r.relative, ".tmp/sessions/pinned01");
  });

  it("rejects a tilde env value that expands outside the project", () => {
    const cwd = makeProject();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "rwd-home-")));
    mkdirSync(join(home, ".tmp", "sessions", "pinned01"), { recursive: true });
    env.set("HOME", home);
    env.set("DOCUMENT_WORKFLOW_DIR", "~/.tmp/sessions/pinned01");
    strictEqual(
      resolveWorkflowDir({ cwd, sessionId: SID }).source,
      "env-rejected",
    );
  });

  it("does not treat a bare tilde as a home reference", () => {
    // HOME points at a dir that WOULD be accepted if a bare "~" expanded, so
    // this case fails the moment the boundary moves. Pointing HOME anywhere
    // that is rejected either way would make the assertion vacuous.
    const cwd = makeProject();
    const wouldBeAccepted = join(cwd, ".tmp", "sessions", "pinned01");
    mkdirSync(wouldBeAccepted, { recursive: true });
    env.set("HOME", wouldBeAccepted);
    env.set("DOCUMENT_WORKFLOW_DIR", "~");
    strictEqual(
      resolveWorkflowDir({ cwd, sessionId: SID }).source,
      "env-rejected",
    );
  });

  it("rejects a traversal string in the env value", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/abcd1234/../../../etc");
    strictEqual(
      resolveWorkflowDir({ cwd, sessionId: SID }).source,
      "env-rejected",
    );
  });

  it("rejects a pin written through a different alias of the project root", () => {
    // process.cwd() is canonical on POSIX, but a pin can be spelled through a
    // symlink. Containment passes because both sides resolve, and the result
    // is the worst shape: source "env" with a concrete dir whose lexical form
    // matches nothing the tools hand us, and a `relative` that starts with "..".
    const real = realpathSync(mkdtempSync(join(tmpdir(), "rwd-real-")));
    mkdirSync(join(real, ".tmp", "sessions", "abcd1234"), { recursive: true });
    const linkDir = realpathSync(mkdtempSync(join(tmpdir(), "rwd-link-")));
    const alias = join(linkDir, "proj");
    symlinkSync(real, alias);
    env.set(
      "DOCUMENT_WORKFLOW_DIR",
      join(alias, ".tmp", "sessions", "abcd1234"),
    );
    const r = resolveWorkflowDir({ cwd: real, sessionId: SID });
    strictEqual(r.source, "env-rejected");
    strictEqual(r.dir, resolve(real, ".tmp/sessions/abcd1234"));
  });

  it("never returns a relative that escapes cwd", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".tmp", "sessions", "pinned01"), { recursive: true });
    for (const value of [undefined, ".tmp/sessions/pinned01", tmpdir()]) {
      env.set("DOCUMENT_WORKFLOW_DIR", value);
      const r = resolveWorkflowDir({ cwd, sessionId: SID });
      strictEqual(r.relative?.startsWith("..") ?? false, false, String(value));
    }
  });

  it("returns unresolvable for a malformed session id, discarding a valid pin", () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".tmp", "sessions", "pinned01"), { recursive: true });
    env.set("DOCUMENT_WORKFLOW_DIR", ".tmp/sessions/pinned01");
    const r = resolveWorkflowDir({ cwd, sessionId: "" });
    strictEqual(r.source, "unresolvable");
    strictEqual(r.reason, "invalid-session-id");
    strictEqual(r.dir, null);
    strictEqual(r.relative, null);
  });

  it("returns unresolvable when the sessions root does not resolve to itself", () => {
    // A cloned repo can ship .tmp/sessions as a tracked symlink. The env branch
    // already rejects pins under it; without this check the derived branch
    // would quietly hand back a dir under the redirected base instead.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rwd-")));
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, ".tmp"), { recursive: true });
    symlinkSync(join(cwd, "docs"), join(cwd, ".tmp", "sessions"));
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    const r = resolveWorkflowDir({ cwd, sessionId: SID });
    strictEqual(r.source, "unresolvable");
    strictEqual(r.reason, "containment-unverifiable");
    strictEqual(r.dir, null);
    strictEqual(r.relative, null);
  });

  it("returns unresolvable for a traversal session id", () => {
    const cwd = makeProject();
    env.set("DOCUMENT_WORKFLOW_DIR", undefined);
    strictEqual(
      resolveWorkflowDir({ cwd, sessionId: "../../x" }).source,
      "unresolvable",
    );
  });
});
