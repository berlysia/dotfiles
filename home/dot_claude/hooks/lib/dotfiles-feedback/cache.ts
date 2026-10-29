import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  CACHE_TEMP_RANDOM_BYTES,
  DAY_MS,
  FEEDBACK_ERRORS,
  INBOX_FUTURE_SKEW_MS,
  LAST_FLUSH_MAX_AGE_MS,
  UTC_TIMESTAMP_PATTERN,
} from "./constants.ts";

export type FeedbackError = (typeof FEEDBACK_ERRORS)[number];
export type LastFlushV1 = { v: 1; at: string; error: FeedbackError };

export function readLastFlush(
  path: string,
  now: Date,
  hasPending: boolean,
): LastFlushV1 | null {
  if (!hasPending) return null;
  try {
    const value = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<LastFlushV1> | null;
    if (
      !value ||
      value.v !== 1 ||
      typeof value.at !== "string" ||
      !FEEDBACK_ERRORS.includes(value.error as FeedbackError)
    )
      return null;
    const at = Date.parse(value.at);
    const age = now.getTime() - at;
    if (!Number.isFinite(age) || age <= 0 || age > LAST_FLUSH_MAX_AGE_MS)
      return null;
    return { v: 1, at: value.at, error: value.error as FeedbackError };
  } catch {
    // 読めないキャッシュは未取得として扱う。
    return null;
  }
}

export function writeLastFlush(path: string, value: LastFlushV1): void {
  writeAtomic(path, value);
}

function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(CACHE_TEMP_RANDOM_BYTES).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } finally {
    clearLastFlush(temporary);
  }
}

export function clearLastFlush(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      console.error("dotfiles-feedback: キャッシュを削除できませんでした");
      throw error;
    }
  }
}

export type InboxV1 = {
  v: 1;
  fetchedAt: string | null;
  unprocessed: number | null;
  pendingLocal: number;
  failedLocal: number;
  heldLocal: number;
  error?: FeedbackError;
};
export type InboxRead =
  | { state: "ok"; value: InboxV1; ageMs: number }
  | { state: "stale"; value: InboxV1; ageMs: number | null }
  | { state: "missing" }
  | { state: "invalid" };

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function readInbox(path: string, now: Date): InboxRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
  try {
    const raw = JSON.parse(text) as Partial<
      Record<keyof InboxV1, unknown>
    > | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.v !== 1)
      return { state: "invalid" };
    const { fetchedAt, unprocessed, error } = raw;
    if (
      !isCount(raw.pendingLocal) ||
      !isCount(raw.failedLocal) ||
      !isCount(raw.heldLocal) ||
      !(unprocessed === null || isCount(unprocessed)) ||
      !(error === undefined || FEEDBACK_ERRORS.includes(error as FeedbackError))
    )
      return { state: "invalid" };
    let age: number | null = null;
    if (fetchedAt !== null) {
      if (
        typeof fetchedAt !== "string" ||
        !UTC_TIMESTAMP_PATTERN.test(fetchedAt)
      )
        return { state: "invalid" };
      const parsed = Date.parse(fetchedAt);
      if (!Number.isFinite(parsed)) return { state: "invalid" };
      age = now.getTime() - parsed;
      if (age < -INBOX_FUTURE_SKEW_MS) return { state: "invalid" };
    }
    const value: InboxV1 = {
      v: 1,
      fetchedAt,
      unprocessed,
      pendingLocal: raw.pendingLocal,
      failedLocal: raw.failedLocal,
      heldLocal: raw.heldLocal,
      ...(error === undefined ? {} : { error: error as FeedbackError }),
    };
    return age === null || age > DAY_MS
      ? { state: "stale", value, ageMs: age }
      : { state: "ok", value, ageMs: age };
  } catch {
    return { state: "invalid" };
  }
}

export function writeInbox(path: string, value: InboxV1): void {
  writeAtomic(path, value);
}
