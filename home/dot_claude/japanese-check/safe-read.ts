// 検査器が自分の部品や入力を読むときの共通の読み方。import は `node:` だけ。
//
// symlink をたどらず（O_NOFOLLOW）、FIFO で止まらず（O_NONBLOCK）、開いた fd を
// fstat して通常のファイルだけを、上限 + 1 バイトまで読む。パスで確かめてから
// 開く形にしないのは、確かめと開くまでの間に差し替えられるのを避けるため。

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export type ReadFailure = "missing" | "not-file" | "too-large" | "error";
export type SafeReadResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ReadFailure };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function readFileBounded(
  path: string,
  maxBytes: number,
): SafeReadResult {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    if (code === "ELOOP" || code === "ENXIO" || code === "ENOTDIR")
      return { ok: false, reason: "not-file" };
    return { ok: false, reason: "error" };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, reason: "not-file" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) return { ok: false, reason: "too-large" };
    return { ok: true, bytes: buffer.subarray(0, length) };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    closeSync(fd);
  }
}
