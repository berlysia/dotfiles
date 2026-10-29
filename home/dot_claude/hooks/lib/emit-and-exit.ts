import { writeSync } from "node:fs";

export type EmitResult = { code: number; stdout: string; stderr: string };

export type EmitOptions = {
  /** Give up on a stalled receiver after this long. */
  timeoutMs?: number;
  /** Wait between retries on EAGAIN. */
  retryWaitMs?: number;
  writeSync?: (fd: number, buffer: Uint8Array, offset: number) => number;
  exit?: (code: number) => never;
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorCode = (error: unknown): unknown =>
  (error as { code?: unknown } | null)?.code;

/** Returns false when writing must stop (receiver gone, stalled, or failed). */
function writeAll(
  fd: number,
  text: string,
  write: NonNullable<EmitOptions["writeSync"]>,
  deadline: number,
  retryWaitMs: number,
): boolean {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += write(fd, bytes, offset);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EAGAIN") {
        if (Date.now() >= deadline) return false;
        sleepSync(retryWaitMs);
        continue;
      }
      // EPIPE: the reader closed first (`| head -c 10`). Anything else: nothing
      // useful left to do. Either way the rest is not written.
      return false;
    }
  }
  return true;
}

/**
 * Writes the result with synchronous fd writes and then exits.
 *
 * Why not process.stdout.write + process.exit: on a pipe the write is queued
 * and process.exit drops what the pipe has not yet taken (observed: 600000
 * bytes written, 131072 received). Exiting through process.exit at all is
 * wanted because a hung stat or git must not keep the process alive.
 */
export function emitAndExit(
  result: EmitResult,
  options: EmitOptions = {},
): never {
  const write =
    options.writeSync ??
    ((fd, buffer, offset) => writeSync(fd, buffer, offset));
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const retryWaitMs = options.retryWaitMs ?? 5;
  const exit =
    options.exit ??
    ((code: number): never => {
      // oxlint-disable-next-line custom-lint/no-process-exit -- exitCode would wait for hung stat or git
      return process.exit(code);
    });
  if (writeAll(1, result.stdout, write, deadline, retryWaitMs)) {
    writeAll(2, result.stderr, write, deadline, retryWaitMs);
  }
  return exit(result.code);
}
