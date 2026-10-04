#!/usr/bin/env node --test

import { deepStrictEqual, strictEqual } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  checkParentSegments,
  resolvePhysicalPath,
  resolveWithMissingTail,
} from "../../lib/path-containment.ts";

describe("checkParentSegments", () => {
  const cases: [string, ReturnType<typeof checkParentSegments>][] = [
    ["/a/b", { ok: true }],
    ["/a/../b", { ok: false, kind: "absolute" }],
    ["/a/..//b", { ok: false, kind: "absolute" }],
    ["/a/b/..", { ok: false, kind: "absolute" }],
    ["/a/b..c/d", { ok: true }],
    ["/a/.../b", { ok: true }],
    ["../x", { ok: true }],
    ["../../x", { ok: true }],
    ["./../x", { ok: true }],
    ["a/../b", { ok: false, kind: "relative" }],
    ["../a/../b", { ok: false, kind: "relative" }],
    ["a/b", { ok: true }],
    ["", { ok: true }],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      deepStrictEqual(checkParentSegments(input), expected);
    });
  }
});

describe("resolvePhysicalPath", () => {
  // process.cwd() is the repository; its .tmp/ is gitignored. realpathSync so
  // that the expectations hold when the checkout is reached through a symlink.
  let base = "";
  beforeEach(() => {
    mkdirSync(join(process.cwd(), ".tmp"), { recursive: true });
    base = realpathSync(mkdtempSync(join(process.cwd(), ".tmp", "pc-")));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    symlinkSync(join(base, "nowhere"), join(base, "dangling"));
    symlinkSync(join(base, "loop"), join(base, "loop"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("returns an existing path unchanged", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "real")), {
      ok: true,
      path: join(base, "real"),
    });
  });
  it("resolves a symlink", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "link", "x")), {
      ok: true,
      path: join(base, "real", "x"),
    });
  });
  it("re-attaches a missing tail", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "real", "new", "f")), {
      ok: true,
      path: join(base, "real", "new", "f"),
    });
  });
  it("reports a dangling symlink", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "dangling")), {
      ok: false,
      code: "EDANGLING",
    });
  });
  it("reports a symlink loop", () => {
    deepStrictEqual(resolvePhysicalPath(join(base, "loop", "x")), {
      ok: false,
      code: "ELOOP",
    });
  });
  it("rejects a path with a .. segment", () => {
    deepStrictEqual(resolvePhysicalPath(`${base}/real/../x`), {
      ok: false,
      code: "EPARENT",
    });
  });
  it("rejects a relative path and a NUL byte", () => {
    deepStrictEqual(resolvePhysicalPath("a/b"), { ok: false, code: "EINVAL" });
    deepStrictEqual(resolvePhysicalPath("/a\0b"), {
      ok: false,
      code: "EINVAL",
    });
  });
  it("reports the errno of an injected realpath failure", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      lstat: () => ({}),
    };
    deepStrictEqual(resolvePhysicalPath("/x/y", fs), {
      ok: false,
      code: "EACCES",
    });
  });
  it("fails when lstat fails with something other than ENOENT", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      lstat: (): unknown => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    };
    deepStrictEqual(resolvePhysicalPath("/x/y", fs), {
      ok: false,
      code: "EACCES",
    });
  });
  it("treats ENOTDIR as unresolvable, not as missing", () => {
    const fs = {
      realpath: (): string => {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      },
      lstat: () => ({}),
    };
    deepStrictEqual(resolvePhysicalPath("/x/file/y", fs), {
      ok: false,
      code: "ENOTDIR",
    });
  });
});

describe("resolveWithMissingTail on top of resolvePhysicalPath", () => {
  it("returns the path for a resolvable input and null otherwise", () => {
    const here = realpathSync(process.cwd());
    strictEqual(
      resolveWithMissingTail(join(here, "no-such-dir", "f")),
      join(here, "no-such-dir", "f"),
    );
    strictEqual(resolveWithMissingTail(`${here}/a/../b`), null);
    strictEqual(resolveWithMissingTail("relative/path"), null);
  });
});
