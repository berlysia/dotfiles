import { strictEqual } from "node:assert";
import { it } from "node:test";
import type {
  InboxRead,
  InboxV1,
  LastFlushV1,
} from "../../lib/dotfiles-feedback/cache.ts";
import { buildFeedbackNotice } from "../../lib/dotfiles-feedback/notice.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const MIN = 60 * 1000;
const at = (offsetMs: number) =>
  new Date(NOW.getTime() - offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

function value(patch: Partial<InboxV1> = {}): InboxV1 {
  return {
    v: 1,
    fetchedAt: at(12 * MIN),
    unprocessed: 0,
    pendingLocal: 0,
    failedLocal: 0,
    heldLocal: 0,
    ...patch,
  };
}
const ok = (patch: Partial<InboxV1> = {}): InboxRead => {
  const v = value(patch);
  return { state: "ok", value: v, ageMs: 0 };
};
const stale = (patch: Partial<InboxV1> = {}): InboxRead => ({
  state: "stale",
  value: value({ fetchedAt: at(30 * 60 * MIN), ...patch }),
  ageMs: null,
});
const flushed = (error: LastFlushV1["error"]): LastFlushV1 => ({
  v: 1,
  at: at(MIN),
  error,
});
const build = (inbox: InboxRead, lastFlush: LastFlushV1 | null = null) =>
  buildFeedbackNotice({ inbox, lastFlush }, NOW);

it("says nothing when every count is 0 and nothing failed", () =>
  strictEqual(build(ok()), null));

it("reports counts with the elapsed time and the next command", () =>
  strictEqual(
    build(ok({ unprocessed: 3 })),
    "dotfiles-feedback: 未処理 3 件（12 分前に更新）、未送 0 件、失敗 0 件 → dotfiles-feedback list",
  ));

it("switches the elapsed unit at the 60 minute boundary and floors", () => {
  const age = (ms: number) => build(ok({ unprocessed: 1, fetchedAt: at(ms) }));
  const sentence = (text: string) => text?.match(/（(.+?)に更新）/)?.[1];
  strictEqual(sentence(age(59 * MIN + 59_000)!), "59 分前");
  strictEqual(sentence(age(60 * MIN)!), "1 時間前");
  strictEqual(sentence(age((23 * 60 + 59) * MIN)!), "23 時間前");
  strictEqual(sentence(age(-2 * MIN)!), "0 分前");
});

it("appends held, last flush and inbox error in that order before the arrow", () => {
  strictEqual(
    build(ok({ heldLocal: 2 })),
    "dotfiles-feedback: 未処理 0 件（12 分前に更新）、未送 0 件、失敗 0 件、新しい版で止まっている 2 件（CLI を更新する） → dotfiles-feedback list",
  );
  strictEqual(
    build(ok({ pendingLocal: 1 }), flushed("auth")),
    "dotfiles-feedback: 未処理 0 件（12 分前に更新）、未送 1 件、失敗 0 件、送れていない（auth） → dotfiles-feedback list",
  );
  strictEqual(
    build(ok({ error: "network" })),
    "dotfiles-feedback: 未処理 0 件（12 分前に更新）、未送 0 件、失敗 0 件、前回の更新は失敗（network） → dotfiles-feedback list",
  );
  strictEqual(
    build(ok({ heldLocal: 1, error: "other" }), flushed("network")),
    "dotfiles-feedback: 未処理 0 件（12 分前に更新）、未送 0 件、失敗 0 件、新しい版で止まっている 1 件（CLI を更新する）、送れていない（network）、前回の更新は失敗（other） → dotfiles-feedback list",
  );
});

it("a last flush failure alone is enough to speak", () =>
  strictEqual(typeof build(ok(), flushed("auth")), "string"));

it("stale: reports counts as old and points at refresh", () => {
  strictEqual(
    build(stale({ failedLocal: 1, heldLocal: 1 })),
    "dotfiles-feedback: 件数は24 時間以上更新されていない（未送 0 件、失敗 1 件、新しい版で止まっている 1 件（CLI を更新する））→ dotfiles-feedback refresh",
  );
});

it("stale with no fetchedAt, and ok with unprocessed null, say not fetched yet", () => {
  const notYet =
    "dotfiles-feedback: 件数はまだ取れていない（未送 0 件、失敗 0 件）→ dotfiles-feedback refresh";
  strictEqual(
    build({
      state: "stale",
      value: value({ fetchedAt: null, unprocessed: null }),
      ageMs: null,
    }),
    notYet,
  );
  strictEqual(build(ok({ unprocessed: null })), notYet);
});

it("missing and invalid have their own lines", () => {
  strictEqual(
    build({ state: "missing" }),
    "dotfiles-feedback: 件数はまだ取れていない → dotfiles-feedback refresh",
  );
  strictEqual(
    build({ state: "invalid" }),
    "dotfiles-feedback: 件数のキャッシュが読めない → dotfiles-feedback refresh",
  );
});

it("never returns a newline, whatever the input", () => {
  const inputs: InboxRead[] = [
    ok({ unprocessed: 1, heldLocal: 1, error: "auth" }),
    stale({ error: "other" }),
    { state: "missing" },
    { state: "invalid" },
  ];
  for (const inbox of inputs) {
    const line = build(inbox, flushed("not-private"));
    strictEqual(typeof line, "string");
    strictEqual(/[\r\n]/.test(line ?? ""), false);
  }
});
