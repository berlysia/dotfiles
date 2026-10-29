import type { InboxRead, InboxV1, LastFlushV1 } from "./cache.ts";

// モデルの文脈に入る行なので、固定の文・数・列挙の値だけで組む（issue の title や本文は入れない）。
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function elapsed(fetchedAt: string | null, now: Date): string {
  const age = Math.max(0, now.getTime() - Date.parse(fetchedAt ?? ""));
  return age < HOUR_MS
    ? `${Math.floor(age / MINUTE_MS)} 分前`
    : `${Math.floor(age / HOUR_MS)} 時間前`;
}

function extras(value: InboxV1, lastFlush: LastFlushV1 | null): string {
  return [
    value.heldLocal >= 1
      ? `、新しい版で止まっている ${value.heldLocal} 件（CLI を更新する）`
      : "",
    lastFlush ? `、送れていない（${lastFlush.error}）` : "",
    value.error ? `、前回の更新は失敗（${value.error}）` : "",
  ].join("");
}

export function buildFeedbackNotice(
  input: { inbox: InboxRead; lastFlush: LastFlushV1 | null },
  now: Date,
): string | null {
  const { inbox, lastFlush } = input;
  if (inbox.state === "missing")
    return "dotfiles-feedback: 件数はまだ取れていない → dotfiles-feedback refresh";
  if (inbox.state === "invalid")
    return "dotfiles-feedback: 件数のキャッシュが読めない → dotfiles-feedback refresh";
  const { value } = inbox;
  const local = `未送 ${value.pendingLocal} 件、失敗 ${value.failedLocal} 件`;
  if (inbox.state === "stale" || value.unprocessed === null) {
    const status =
      inbox.state === "stale" && value.fetchedAt !== null
        ? "24 時間以上更新されていない"
        : "まだ取れていない";
    return `dotfiles-feedback: 件数は${status}（${local}${extras(value, lastFlush)}）→ dotfiles-feedback refresh`;
  }
  if (
    value.unprocessed === 0 &&
    value.pendingLocal === 0 &&
    value.failedLocal === 0 &&
    value.heldLocal === 0 &&
    !value.error &&
    !lastFlush
  )
    return null;
  return `dotfiles-feedback: 未処理 ${value.unprocessed} 件（${elapsed(value.fetchedAt, now)}に更新）、${local}${extras(value, lastFlush)} → dotfiles-feedback list`;
}
