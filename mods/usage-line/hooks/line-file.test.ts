import { expect, test } from "claude-code/testing";
import { lineFilePath } from "./line-file";

const ID = "8f44b3b4-d81d-40e7-9431-220587d54528";

test("XDG_RUNTIME_DIR is used first", async () => {
  expect(lineFilePath({ XDG_RUNTIME_DIR: "/run/user/1000" }, ID)).toBe(
    `/run/user/1000/usage-line/${ID}.json`,
  );
  expect(
    lineFilePath(
      { XDG_RUNTIME_DIR: "/run/user/1000", TMPDIR: "/var/folders/x/T" },
      "s-1",
    ),
  ).toBe("/run/user/1000/usage-line/s-1.json");
});

test("macOS per-user TMPDIR is the fallback; trailing slashes collapse", async () => {
  expect(lineFilePath({ TMPDIR: "/var/folders/ab/T/" }, "s-1")).toBe(
    "/var/folders/ab/T/usage-line/s-1.json",
  );
  expect(
    lineFilePath({ XDG_RUNTIME_DIR: "", TMPDIR: "/var/folders/x/T" }, "s-1"),
  ).toBe("/var/folders/x/T/usage-line/s-1.json");
  expect(lineFilePath({}, "s-1")).toBeNull();
});

test("shared TMPDIR locations are not used", async () => {
  expect(lineFilePath({ TMPDIR: "/tmp" }, "s-1")).toBeNull();
  expect(lineFilePath({ TMPDIR: "/var/tmp/" }, "s-1")).toBeNull();
});

test("relative or dot-dot variables count as unset", async () => {
  for (const bad of [".", "run/user", "/run/../tmp"]) {
    expect(lineFilePath({ XDG_RUNTIME_DIR: bad }, "s-1")).toBeNull();
    expect(
      lineFilePath({ XDG_RUNTIME_DIR: bad, TMPDIR: "/var/folders/x/T" }, "s-1"),
    ).toBe("/var/folders/x/T/usage-line/s-1.json");
  }
});

test("invalid session ids give null; 128 characters are fine", async () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  for (const bad of [
    "../x",
    "",
    "a/b",
    "a b",
    "a\n",
    "a\u0000",
    "a".repeat(129),
  ])
    expect(lineFilePath(env, bad)).toBeNull();
  expect(lineFilePath(env, "a".repeat(128))).toBe(
    `/run/user/1000/usage-line/${"a".repeat(128)}.json`,
  );
});
