import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  CACHE_TEMP_RANDOM_BYTES,
  FEEDBACK_ERRORS,
  LAST_FLUSH_MAX_AGE_MS,
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
