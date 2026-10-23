import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { calques, check, lint, newFacts, outline, terms } from "./analyze.ts";
import type { Genre } from "./analyze.ts";
import { paragraphs, proseLines } from "./markdown.ts";
import { createTokenizer } from "./tokenizer.ts";

const commands = new Set([
  "check",
  "lint",
  "calques",
  "outline",
  "terms",
  "paragraphs",
  "newfacts",
]);
const usage =
  "node cli.ts <check|lint|calques|outline|terms|paragraphs|newfacts> <file.md> [--source original.md] [--genre tech|business|essay]";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!command || !commands.has(command)) throw new Error(usage);
  let file: string | undefined;
  let source: string | undefined;
  let genre: Genre | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--source" || arg === "--genre") {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} の値が必要です。`);
      if (arg === "--source") {
        if (source !== undefined)
          throw new Error("--source は1回だけ指定してください。");
        source = value;
      } else {
        if (genre !== undefined)
          throw new Error("--genre は1回だけ指定してください。");
        if (!["tech", "business", "essay"].includes(value))
          throw new Error("--genre の値が不正です。");
        genre = value as Genre;
      }
    } else if (arg.startsWith("--") || file !== undefined) {
      throw new Error(`不明な引数: ${arg}`);
    } else file = arg;
  }
  if (!file) throw new Error("入力ファイルを指定してください。");
  if (command === "newfacts" && !source)
    throw new Error("newfacts には --source が必要です。");
  if (source && command !== "check" && command !== "newfacts")
    throw new Error("--source は check/newfacts で使います。");
  if (genre && command !== "check" && command !== "lint")
    throw new Error("--genre は check/lint で使います。");
  if (source && resolve(source) === resolve(file))
    throw new Error("原文と最終稿は別ファイルにしてください。");
  return { command, file, source, genre };
}

export async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const { command, file, source, genre } = parseArguments(args);
  // Read inputs before loading the dictionary so invalid paths fail promptly.
  const markdown = readFileSync(file, "utf8");
  const original =
    source === undefined ? undefined : readFileSync(source, "utf8");
  if (source) {
    const sourceStat = statSync(source);
    const finalStat = statSync(file);
    if (sourceStat.dev === finalStat.dev && sourceStat.ino === finalStat.ino) {
      throw new Error("原文と最終稿が同じ実体を指しています。");
    }
  }
  const lines = proseLines(markdown);
  let result: unknown;
  if (command === "outline") result = outline(lines);
  else if (command === "paragraphs") result = paragraphs(lines);
  else if (command === "lint") result = lint(lines, genre);
  else {
    const tokenize = await createTokenizer();
    if (command === "check")
      result = check(markdown, tokenize, genre, original);
    else if (command === "calques") result = calques(lines, tokenize);
    else if (command === "terms") result = terms(lines, tokenize);
    else {
      if (original === undefined) throw new Error("比較する原文がありません。");
      result = newFacts(proseLines(original), lines, tokenize);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `japanese-check: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  });
}
