// A ccstatusline Custom Command: reads Claude Code's status line JSON on stdin,
// adds the forecasts the usage-line mod left in a file, and prints one line.
// It must always exit 0 with a quiet stderr (ccstatusline draws any other exit
// as `[Exit: N]`), so the hooks modules are imported inside `try` and every
// failure ends in silence. Run by bun; keep to APIs Node has too.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_STDIN_BYTES) return "";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// O_NOFOLLOW and an fstat on the opened descriptor, not lstat then read: a
// path swapped between the check and the read cannot change what is read.
function readForecastFile(
  path: string,
  isReadable: (
    stat: { isFile: boolean; uid: number; size: number },
    uid: number,
  ) => boolean,
): unknown {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !isReadable(
        { isFile: stat.isFile(), uid: stat.uid, size: stat.size },
        uid,
      )
    )
      return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
    }
    return parseJson(buffer.subarray(0, filled).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do about a failed close.
      }
    }
  }
}

async function main(): Promise<void> {
  const [
    { lineFilePath },
    { buildStatusInput, isForecastFileReadable },
    { formatLine },
  ] = await Promise.all([
    import("./hooks/line-file"),
    import("./hooks/status-input"),
    import("./hooks/format"),
  ]);
  const stdin = parseJson(await readStdin());
  const now = Date.now();
  const sessionId =
    typeof stdin === "object" && stdin !== null && !Array.isArray(stdin)
      ? (stdin as { session_id?: unknown }).session_id
      : undefined;
  const path =
    typeof sessionId === "string"
      ? lineFilePath(
          {
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
            TMPDIR: process.env.TMPDIR,
          },
          sessionId,
        )
      : null;
  const file =
    path === null ? undefined : readForecastFile(path, isForecastFileReadable);
  const line = formatLine(buildStatusInput(stdin, file, now), now);
  if (line !== undefined) process.stdout.write(`${line}\n`);
}

try {
  await main();
} catch {
  // Silence is the answer: ccstatusline then draws no line.
}
process.exitCode = 0;
