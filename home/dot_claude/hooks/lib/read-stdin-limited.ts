// hook の入口が使う stdin の読み取り。maxBytes 超過・エラー・watchdog は null（何も出さない）。
// timer は unref し、終わったら必ず消す。テストのために stream を差し替えられる
export type ReadableLike = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
  removeAllListeners(event: "data" | "end" | "error"): unknown;
  destroy(): unknown;
};

export function readStdinLimited(
  maxBytes: number,
  watchdogMs: number,
  stream: ReadableLike = process.stdin,
): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners("data");
      stream.removeAllListeners("end");
      stream.removeAllListeners("error");
      if (value === null) stream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), watchdogMs);
    timer.unref();
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return finish(null);
      chunks.push(chunk);
    });
    stream.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => finish(null));
  });
}
