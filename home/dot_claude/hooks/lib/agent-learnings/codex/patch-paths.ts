// Codex の apply_patch の本文から、書き換え対象のパスと追加行の本文を取り出す。純粋関数。
// 葉のモジュール: import は `node:` だけ。ゲート、translationese-scan、シーンの注入が
// 同じ見出しの規則（scanHeaders）を使うので、CRLF や行末の空白の扱いが食い違わない。
//
// 行頭がちょうど `*** ` の行だけを見出しにする: 差分の本文の行は前に `+`・`-`・空白が付くので、
// 本文に書かれた見出し風の文字列で場面を偽れない。toplevel の外の判定と重複の除去は呼び出し側
const PATH_HEADERS = {
  add: "*** Add File: ",
  update: "*** Update File: ",
  delete: "*** Delete File: ",
  move: "*** Move to: ",
} as const;
const MAX_LINE_BYTES = 4096;
export const MAX_PATCH_PATHS = 64;
export const MAX_PATCH_BODY_CHARS = 256 * 1024;

export type PathHeaderKind = keyof typeof PATH_HEADERS;

// state の行を壊しうる値を持ち込まないための判定。scene-state.ts の hasControlChars と
// 同じ結果を返す（葉に保つためここに持つ。test で同値を確かめる）
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type LineClass =
  | { type: "body"; raw: string }
  // `*** ` で始まるがパスを持たない見出し（Begin / End Patch、End of File など）
  | { type: "header"; raw: string; kind: "other" | "end-of-file" }
  // 採ったパスを持つ見出し
  | { type: "path"; raw: string; kind: PathHeaderKind; path: string }
  // 捨てた見出し（長すぎる、制御文字を含む）と、65 件目以降の見出し
  | { type: "dropped"; raw: string };

const PATH_HEADER_KINDS = Object.keys(PATH_HEADERS) as PathHeaderKind[];

function classifyLine(raw: string): LineClass {
  // 末尾の `\r` を 1 つ、続けて末尾の半角空白とタブを除く。先頭は何も除かない
  const line = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).replace(
    /[ \t]+$/,
    "",
  );
  if (!line.startsWith("*** ")) return { type: "body", raw };
  const kind = PATH_HEADER_KINDS.find((k) => line.startsWith(PATH_HEADERS[k]));
  if (kind === undefined) {
    return {
      type: "header",
      raw,
      kind: line === "*** End of File" ? "end-of-file" : "other",
    };
  }
  if (Buffer.byteLength(raw) > MAX_LINE_BYTES || hasControlChars(line)) {
    return { type: "dropped", raw };
  }
  return {
    type: "path",
    raw,
    kind,
    path: line.slice(PATH_HEADERS[kind].length),
  };
}

/**
 * 全行を分類する。パスを持つ見出しは先頭の 64 件まで採り、65 件目以降は `dropped`。
 * 捨てた見出しは 64 件に数えない。
 */
export function scanHeaders(text: string): LineClass[] {
  const result: LineClass[] = [];
  let adopted = 0;
  for (const raw of text.split("\n")) {
    const c = classifyLine(raw);
    if (c.type === "path") {
      if (adopted >= MAX_PATCH_PATHS) {
        result.push({ type: "dropped", raw });
        continue;
      }
      adopted += 1;
    }
    result.push(c);
  }
  return result;
}

export function patchTargetPaths(text: string): string[] {
  const paths: string[] = [];
  for (const c of scanHeaders(text)) {
    if (c.type === "path") paths.push(c.path);
  }
  return paths;
}

export interface PatchSection {
  path: string;
  body: string;
}

export interface PatchSections {
  sections: PatchSection[];
  /** 本文の合計が予算に達して、収集を止めたとき真 */
  truncated: boolean;
}

/**
 * `Add File` と `Update File` の節を組む。`Update File` のすぐ次の行が採った `Move to` の
 * ときだけ、節のパスを移動先に置き換える。節の本文は `+` で始まる行から先頭の `+` と末尾の
 * `\r` を 1 つ除いたもの。`include(path)` が真の節だけが本文を集め、予算に数える。
 */
export function patchSections(
  text: string,
  options: { include: (path: string) => boolean },
): PatchSections {
  const sections: PatchSection[] = [];
  let truncated = false;
  let budget = 0;
  let open: { path: string; collect: boolean; lines: string[] } | null = null;
  let updateJustOpened = false;
  const close = (): void => {
    if (open?.collect) {
      sections.push({ path: open.path, body: open.lines.join("\n") });
    }
    open = null;
  };
  for (const c of scanHeaders(text)) {
    const afterUpdate = updateJustOpened;
    updateJustOpened = false;
    if (c.type === "body") {
      if (open === null || !open.collect || truncated) continue;
      if (!c.raw.startsWith("+")) continue;
      const line = c.raw.slice(1).replace(/\r$/, "");
      budget += line.length + 1;
      if (budget > MAX_PATCH_BODY_CHARS) {
        truncated = true;
        continue;
      }
      open.lines.push(line);
      continue;
    }
    if (c.type === "header" && c.kind === "end-of-file") continue;
    if (
      c.type === "path" &&
      c.kind === "move" &&
      afterUpdate &&
      open !== null
    ) {
      open.path = c.path;
      open.collect = options.include(c.path);
      continue;
    }
    close();
    if (c.type === "path" && (c.kind === "add" || c.kind === "update")) {
      open = { path: c.path, collect: options.include(c.path), lines: [] };
      updateJustOpened = c.kind === "update";
    }
  }
  close();
  return { sections, truncated };
}
