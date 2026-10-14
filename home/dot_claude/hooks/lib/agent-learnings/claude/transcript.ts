import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { sep } from "node:path";
import { preprocessText } from "../core/entry-text.ts";

// worker と将来の Codex アダプタの境界
export type ReducedTranscript = {
  text: string; // 縮約と redaction 済み、末尾 60,000 字以内
  userTurns: number; // 範囲内の利用者の発言の数
  endOffset: number; // 読み終えたバイト位置（最後の改行の直後）
  firstLineHash: string; // ファイル 1 行目（改行を除く）の sha256。空ファイルは空文字列の sha256
  restarted: boolean; // fromOffset が使えず 0 から読んだ
};
export type TranscriptResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export const TRANSCRIPT_MAX_BYTES = 20 * 1024 * 1024;
export const TRANSCRIPT_MAX_CHARS = 60_000;
const USER_MAX = 2_000;
const ASSISTANT_MAX = 1_000;
const ERROR_MAX = 200;

const fail = (reason: string): { ok: false; reason: string } => ({
  ok: false,
  reason,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const truncateChars = (text: string, max: number): string => {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
};

type Opened = { fd: number; size: number };

// 差し替えに強い順序: lstat → realpath の配下確認 → O_NOFOLLOW で open → fd と realpath の dev/ino 照合
function openTranscript(
  transcriptPath: string,
  projectsDir: string,
): TranscriptResult<Opened> {
  let real: string;
  try {
    const lst = lstatSync(transcriptPath);
    if (!lst.isFile() || lst.isSymbolicLink())
      return fail("not a regular file");
    if (!transcriptPath.endsWith(".jsonl")) return fail("not a .jsonl file");
    real = realpathSync(transcriptPath);
    const root = realpathSync(projectsDir);
    if (!real.startsWith(root + sep)) return fail("outside projects");
  } catch {
    return fail("unreadable");
  }
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("unreadable");
  }
  try {
    const opened = fstatSync(fd);
    const now = statSync(real);
    if (!opened.isFile() || opened.dev !== now.dev || opened.ino !== now.ino)
      throw new Error("replaced");
    if (opened.size > TRANSCRIPT_MAX_BYTES) throw new Error("too large");
    return { ok: true, value: { fd, size: opened.size } };
  } catch (error) {
    closeSync(fd);
    return fail((error as Error).message);
  }
}

// 読まずに許可だけ確かめる。サイズは fd の fstat の値
export function checkTranscript(
  transcriptPath: string,
  projectsDir: string,
): TranscriptResult<{ size: number }> {
  const opened = openTranscript(transcriptPath, projectsDir);
  if (!opened.ok) return opened;
  closeSync(opened.value.fd);
  return { ok: true, value: { size: opened.value.size } };
}

function readAll(fd: number, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const n = readSync(fd, buffer, read, size - read, read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

// compaction-testament と同じ判定。利用者が打った発言だけを返す
function typedUtterance(entry: Record<string, unknown>): string | null {
  if (entry["isCompactSummary"] === true || entry["isMeta"] === true)
    return null;
  const message = entry["message"];
  if (!isRecord(message)) return null;
  const content = message["content"];
  let utterance: string | null = null;
  if (typeof content === "string") {
    utterance = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (
        !isRecord(block) ||
        block["type"] !== "text" ||
        typeof block["text"] !== "string"
      )
        return null;
      parts.push(block["text"]);
    }
    utterance = parts.join("\n");
  }
  if (utterance === null) return null;
  const trimmed = utterance.trim();
  if (
    trimmed === "" ||
    trimmed.startsWith("<") ||
    trimmed.startsWith("Caveat:") ||
    trimmed.startsWith("[compaction-testament]")
  )
    return null;
  return trimmed;
}

function errorResults(entry: Record<string, unknown>): string[] {
  const message = entry["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) return [];
  const found: string[] = [];
  for (const block of message["content"]) {
    if (
      !isRecord(block) ||
      block["type"] !== "tool_result" ||
      block["is_error"] !== true
    )
      continue;
    const content = block["content"];
    if (typeof content === "string") found.push(content);
    else if (Array.isArray(content))
      found.push(
        content
          .map((part) =>
            isRecord(part) && typeof part["text"] === "string"
              ? part["text"]
              : "",
          )
          .join(" "),
      );
  }
  return found;
}

function assistantTexts(entry: Record<string, unknown>): string[] {
  const message = entry["message"];
  if (!isRecord(message)) return [];
  const content = message["content"];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) &&
    block["type"] === "text" &&
    typeof block["text"] === "string"
      ? [block["text"]]
      : [],
  );
}

export function reduceTranscript(opts: {
  transcriptPath: string;
  projectsDir: string;
  fromOffset: number;
  extraRedact: readonly RegExp[];
}): TranscriptResult<ReducedTranscript> {
  const opened = openTranscript(opts.transcriptPath, opts.projectsDir);
  if (!opened.ok) return opened;
  let buffer: Buffer;
  try {
    buffer = readAll(opened.value.fd, opened.value.size);
  } finally {
    closeSync(opened.value.fd);
  }

  const firstNewline = buffer.indexOf(0x0a);
  const firstLine = buffer.subarray(
    0,
    firstNewline < 0 ? buffer.length : firstNewline,
  );
  const firstLineHash = createHash("sha256").update(firstLine).digest("hex");
  // 最後の改行より後ろ（書きかけの行）は読まない
  const endOffset = buffer.lastIndexOf(0x0a) + 1;

  let start = opts.fromOffset;
  let restarted = false;
  if (
    !Number.isInteger(start) ||
    start < 0 ||
    start > buffer.length ||
    (start > 0 && buffer[start - 1] !== 0x0a)
  ) {
    start = 0;
    restarted = true;
  }
  const region =
    start >= endOffset
      ? ""
      : buffer.subarray(start, endOffset).toString("utf8");

  const fragments: string[] = [];
  let userTurns = 0;
  const push = (label: string, raw: string, max: number): boolean => {
    const cleaned = truncateChars(preprocessText(raw, opts.extraRedact), max);
    if (cleaned === "") return false;
    fragments.push(`[${label}] ${cleaned}`);
    return true;
  };
  for (const line of region.split("\n")) {
    if (line === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry["isSidechain"] === true) continue;
    if (entry["type"] === "user") {
      const utterance = typedUtterance(entry);
      if (utterance !== null) {
        if (push("user", utterance, USER_MAX)) userTurns += 1;
      } else {
        for (const error of errorResults(entry))
          push("error", error, ERROR_MAX);
      }
    } else if (entry["type"] === "assistant") {
      for (const text of assistantTexts(entry))
        push("assistant", text, ASSISTANT_MAX);
    }
  }

  let text = fragments.join("\n");
  if (text.length > TRANSCRIPT_MAX_CHARS) {
    // 先頭から削る。途中で切れた断片は残さず、次の断片の先頭から始める
    text = text.slice(-TRANSCRIPT_MAX_CHARS);
    const boundary = text.indexOf("\n");
    text = boundary < 0 ? "" : text.slice(boundary + 1);
  }
  return {
    ok: true,
    value: {
      text,
      userTurns,
      endOffset: Math.max(endOffset, start),
      firstLineHash,
      restarted,
    },
  };
}
