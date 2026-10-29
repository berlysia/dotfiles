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
  readInbox,
  readLastFlush,
  writeInbox,
  writeLastFlush,
  type InboxV1,
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

const inboxNow = new Date("2026-10-29T12:00:00Z");
const inbox: InboxV1 = {
  v: 1,
  fetchedAt: "2026-10-29T11:00:00Z",
  unprocessed: 3,
  pendingLocal: 1,
  failedLocal: 0,
  heldLocal: 2,
};
function inboxFixture(
  run: (path: string, raw: (value: unknown) => void) => void,
): void {
  fixture((path) => {
    const inboxPath = join(resolve(path, ".."), "inbox.json");
    run(inboxPath, (value) => writeFileSync(inboxPath, JSON.stringify(value)));
  });
}
const secondsFrom = (seconds: number) =>
  new Date(inboxNow.getTime() + seconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

it("inbox: round trips with private permissions", () =>
  inboxFixture((path) => {
    writeInbox(path, inbox);
    const read = readInbox(path, inboxNow);
    strictEqual(read.state, "ok");
    if (read.state !== "ok") return;
    deepStrictEqual(read.value, inbox);
    strictEqual(read.ageMs, 3600 * 1000);
    strictEqual(statSync(path).mode & 0o777, 0o600);
    deepStrictEqual(readdirSync(resolve(path, "..")), ["inbox.json"]);
  }));
it("inbox: missing file and malformed JSON", () =>
  inboxFixture((path) => {
    strictEqual(readInbox(path, inboxNow).state, "missing");
    writeFileSync(path, "{");
    strictEqual(readInbox(path, inboxNow).state, "invalid");
  }));
it("inbox: null fetchedAt and unprocessed are stale with null age", () =>
  inboxFixture((path) => {
    writeInbox(path, { ...inbox, fetchedAt: null, unprocessed: null });
    const read = readInbox(path, inboxNow);
    strictEqual(read.state, "stale");
    if (read.state === "stale") strictEqual(read.ageMs, null);
  }));
it("inbox: keeps error on a valid value", () =>
  inboxFixture((path) => {
    writeInbox(path, { ...inbox, error: "network" });
    const read = readInbox(path, inboxNow);
    strictEqual(read.state, "ok");
    if (read.state === "ok") strictEqual(read.value.error, "network");
  }));
for (const [name, seconds, state] of [
  ["exactly 24 hours old", -24 * 3600, "ok"],
  ["24 hours and 1 second old", -24 * 3600 - 1, "stale"],
  ["25 hours old", -25 * 3600, "stale"],
  ["same instant", 0, "ok"],
  ["4 minutes ahead", 240, "ok"],
  ["exactly 5 minutes ahead", 300, "ok"],
  ["6 minutes ahead", 360, "invalid"],
] as const) {
  it(`inbox: fetchedAt ${name} is ${state}`, () =>
    inboxFixture((path, raw) => {
      raw({ ...inbox, fetchedAt: secondsFrom(seconds) });
      strictEqual(readInbox(path, inboxNow).state, state);
    }));
}
for (const [name, patch] of [
  ["negative unprocessed", { unprocessed: -1 }],
  ["fractional unprocessed", { unprocessed: 1.5 }],
  ["string unprocessed", { unprocessed: "3" }],
  ["missing heldLocal", { heldLocal: undefined }],
  ["negative pendingLocal", { pendingLocal: -1 }],
  ["unknown error", { error: "x" }],
  ["version 2", { v: 2 }],
  ["non-UTC fetchedAt", { fetchedAt: "2026-10-29" }],
  ["unparsable calendar fetchedAt", { fetchedAt: "2026-13-29T00:00:00Z" }],
] as const) {
  it(`inbox: ${name} is invalid`, () =>
    inboxFixture((path, raw) => {
      raw({ ...inbox, ...patch });
      strictEqual(readInbox(path, inboxNow).state, "invalid");
    }));
}
it("inbox: null and arrays are invalid", () =>
  inboxFixture((path, raw) => {
    raw(null);
    strictEqual(readInbox(path, inboxNow).state, "invalid");
    raw([]);
    strictEqual(readInbox(path, inboxNow).state, "invalid");
  }));
