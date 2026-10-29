import { deepStrictEqual, strictEqual, throws } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import {
  clearLastFlush,
  readLastFlush,
  writeLastFlush,
} from "../../lib/dotfiles-feedback/cache.ts";

function fixture(run: (path: string) => void): void {
  const dir = realpathSync(
    mkdtempSync(
      join(
        resolve(import.meta.dirname, "../../../../.."),
        ".tmp-feedback-cache-",
      ),
    ),
  );
  try {
    run(join(dir, "last-flush.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("writes atomically with private permissions, reads, and clears the cache", () =>
  fixture((path) => {
    const value = { v: 1, at: "2026-10-29T00:00:00Z", error: "auth" } as const;
    writeLastFlush(path, value);
    deepStrictEqual(
      readLastFlush(path, new Date("2026-10-29T01:00:00Z"), true),
      value,
    );
    deepStrictEqual(JSON.parse(readFileSync(path, "utf8")), value);
    strictEqual(statSync(path).mode & 0o777, 0o600);
    deepStrictEqual(readdirSync(resolve(path, "..")), ["last-flush.json"]);
    writeLastFlush(path, { ...value, error: "network" });
    strictEqual(
      readLastFlush(path, new Date("2026-10-29T01:00:00Z"), true)?.error,
      "network",
    );
    clearLastFlush(path);
    clearLastFlush(path);
    strictEqual(readLastFlush(path, new Date(), true), null);
  }));

for (const [name, raw, hasPending] of [
  ["future", { v: 1, at: "2026-10-30T00:00:00Z", error: "auth" }, true],
  ["same instant", { v: 1, at: "2026-10-29T01:00:00Z", error: "auth" }, true],
  ["expired", { v: 1, at: "2026-10-28T00:00:00Z", error: "auth" }, true],
  ["bad error", { v: 1, at: "2026-10-29T00:00:00Z", error: "x" }, true],
  ["new version", { v: 2, at: "2026-10-29T00:00:00Z", error: "auth" }, true],
  ["no pending", { v: 1, at: "2026-10-29T00:00:00Z", error: "auth" }, false],
  ["invalid date", { v: 1, at: "invalid", error: "auth" }, true],
  ["null", null, true],
  ["array", [], true],
] as const) {
  it(`ignores ${name}`, () =>
    fixture((path) => {
      writeFileSync(path, JSON.stringify(raw));
      strictEqual(
        readLastFlush(path, new Date("2026-10-29T01:00:00Z"), hasPending),
        null,
      );
    }));
}
it("ignores malformed JSON", () =>
  fixture((path) => {
    writeFileSync(path, "{");
    strictEqual(readLastFlush(path, new Date(), true), null);
  }));
it("accepts exactly 24 hours", () =>
  fixture((path) => {
    writeLastFlush(path, { v: 1, at: "2026-10-28T01:00:00Z", error: "other" });
    strictEqual(
      readLastFlush(path, new Date("2026-10-29T01:00:00Z"), true)?.error,
      "other",
    );
  }));
it("propagates write failures", () =>
  fixture((path) => {
    throws(() =>
      writeLastFlush(join(path, "missing"), {
        v: 1,
        at: "2026-10-29T00:00:00Z",
        error: "other",
      }),
    );
  }));
