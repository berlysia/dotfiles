import { createReadStream } from "fs";
import { createInterface } from "readline";
import { Readable } from "stream";
import { ReadableStream as WebReadableStream } from "stream/web";

const DEFAULT_PATH = `${process.env.HOME}/.claude/logs/decisions.jsonl`;

// --- 小さな道具 (utilities) ---

// 1) ファイルから行を非同期にイテレートする
export async function* lineIterator(
  filePath: string,
): AsyncGenerator<string, void, void> {
  const rs = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: rs, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield String(line);
    }
  } finally {
    try {
      rl.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// 2) 行を安全に JSON にパースする（失敗したら null を返す）
export function parseJsonSafe(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    console.error("Failed to parse JSONL line:", trimmed, e);
    return null;
  }
}

// 3) AsyncIterator<string> -> AsyncIterator<object> に変換する小さな mapper
export async function* mapLinesToObjects(lines: AsyncIterable<string>) {
  for await (const line of lines) {
    const obj = parseJsonSafe(line);
    if (obj !== null) yield obj;
  }
}

// 4) AsyncIterable<object> -> Node Readable (object mode)
export function nodeReadableFromObjects(objects: AsyncIterable<unknown>) {
  return Readable.from(objects as AsyncIterable<any>, { objectMode: true });
}

// 5) AsyncIterable<object> -> WHATWG ReadableStream
export function webReadableFromObjects(objects: AsyncIterable<unknown>) {
  return new WebReadableStream({
    async start(controller) {
      try {
        for await (const obj of objects) {
          controller.enqueue(obj);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      /* nothing special to do */
    },
  });
}

// --- 高レベル API: 小さな道具を組み合わせて目的を達成 ---

export function jsonlToObjectStream(filePath = DEFAULT_PATH) {
  const lines = lineIterator(filePath);
  const objs = mapLinesToObjects(lines);
  const nodeStream = nodeReadableFromObjects(objs);

  // forward fs errors: createReadStream 内でエラーが起きた場合、consumer に伝えたい。
  // lineIterator の実装では readline を閉じるため、ここでは createReadStream をもう一度作る代わりに
  // Node 側の consumer は stream 'error' を listen することを推奨します。
  return nodeStream;
}

export function jsonlToWebStream(filePath = DEFAULT_PATH) {
  const lines = lineIterator(filePath);
  const objs = mapLinesToObjects(lines);
  return webReadableFromObjects(objs);
}

async function main() {
  const stream = jsonlToWebStream();

  /*
  Task:
  1. tool_name と reason の組み合わせに対して件数を集計
  */

  const counts: Map<string, number> = new Map();

  for await (const obj of stream) {
    if (obj.session_id === "test-session") continue;

    const { input, ...rest } = obj; // input は無視
    console.log(rest);

    if (obj.decision !== "ask") continue;

    const key = JSON.stringify({
      tool_name: obj.tool_name,
      reason: obj.reason,
    });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  console.log("Aggregated counts:");
  for (const [key, count] of counts) {
    console.log(`${key} => ${count}`);
  }
}

// CLI helper: when run directly, print parsed objects to stdout using Web Streams
if (import.meta.main) {
  await main();
}
