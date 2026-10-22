import { hasControlChars } from "../core/scene-state.ts";

// Codex の apply_patch の本文から、書き換え対象のパスを取り出す。純粋関数。
// 行頭がちょうどヘッダの行だけを拾う: 差分の本文の行は前に `+`・`-`・空白が付くので、
// 本文に書かれたヘッダ風の文字列で場面を偽れない。toplevel の外の判定と重複の除去は呼び出し側
const HEADERS = [
  "*** Add File: ",
  "*** Update File: ",
  "*** Delete File: ",
  "*** Move to: ",
] as const;
const MAX_LINE_BYTES = 4096;
export const MAX_PATCH_PATHS = 64;

export function patchTargetPaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    if (paths.length >= MAX_PATCH_PATHS) break;
    const header = HEADERS.find((h) => line.startsWith(h));
    if (header === undefined) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    // `\r` もここで落ちる（制御文字）。state の行を壊しうる値を持ち込まない
    if (hasControlChars(line)) continue;
    const path = line.slice(header.length);
    if (path === "") continue;
    paths.push(path);
  }
  return paths;
}
