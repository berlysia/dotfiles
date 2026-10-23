import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { calques, check, lint, newFacts, outline, terms } from "./analyze.ts";
import type { Genre } from "./analyze.ts";
import { paragraphs, proseLines } from "./markdown.ts";
import { createTokenizer } from "./tokenizer.ts";
import { defaultStateDir, digest } from "./state.ts";
import { recordCheck, recordDecision, verify } from "./receipts.ts";
import { track } from "./tracking.ts";

const commands = new Set([
  "check",
  "lint",
  "calques",
  "outline",
  "terms",
  "paragraphs",
  "newfacts",
  "verify",
  "review",
  "defer",
  "exclude",
  "track",
]);
const usage =
  "node cli.ts <check|lint|calques|outline|terms|paragraphs|newfacts|verify|review|defer|exclude|track> <file> [--source original.md] [--genre tech|business|essay] [--artifact document.pdf] [--hash SHA256 --reason TEXT] [--session ID] [--no-record]";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!command || !commands.has(command)) throw new Error(usage);
  let file: string | undefined;
  let source: string | undefined;
  let genre: Genre | undefined;
  const extra: Record<string, string> = {};
  let noRecord = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--no-record") {
      if (noRecord) throw new Error("--no-record は1回だけ指定してください。");
      noRecord = true;
    } else if (
      ["--artifact", "--hash", "--reason", "--session"].includes(arg)
    ) {
      const value = rest[++i];
      if (!value || value.startsWith("--") || extra[arg] !== undefined)
        throw new Error(`${arg} の指定が不正です。`);
      extra[arg] = value;
    } else if (arg === "--source" || arg === "--genre") {
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
  if ((noRecord || extra["--artifact"]) && command !== "check")
    throw new Error("--no-record/--artifact は check で使います。");
  const decision = ["review", "defer", "exclude"].includes(command);
  if (
    decision &&
    (!/^[0-9a-f]{64}$/u.test(extra["--hash"] ?? "") ||
      !extra["--reason"]?.trim())
  )
    throw new Error("判断には --hash と --reason が必要です。");
  if (!decision && (extra["--hash"] || extra["--reason"]))
    throw new Error("--hash/--reason は review/defer/exclude で使います。");
  if (command === "track" && !extra["--session"])
    throw new Error("track には --session が必要です。");
  if (extra["--session"] && command !== "check" && command !== "track")
    throw new Error("--session は check/track で使います。");
  if (noRecord && extra["--session"])
    throw new Error("--no-record と --session は併用できません。");
  return { command, file, source, genre, extra, noRecord };
}

export async function main(
  args: string[],
  options: { stateDir?: string } = {},
): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const { command, file, source, genre, extra, noRecord } =
    parseArguments(args);
  const stateDir = options.stateDir ?? defaultStateDir();
  if (["verify", "review", "defer", "exclude", "track"].includes(command)) {
    if (command === "track") track(file, extra["--session"] ?? "", stateDir);
    const result = ["review", "defer", "exclude"].includes(command)
      ? recordDecision(
          file,
          extra["--hash"] ?? "",
          extra["--reason"] ?? "",
          command === "review"
            ? "checked"
            : command === "defer"
              ? "draft"
              : "excluded",
          stateDir,
        )
      : verify(file, stateDir);
    console.log(JSON.stringify(result, null, 2));
    if (
      command === "verify" &&
      result.status !== "ready" &&
      result.status !== "excluded"
    )
      process.exitCode = 1;
    return;
  }
  // Read inputs before loading the dictionary so invalid paths fail promptly.
  const markdown = readFileSync(file, "utf8");
  const original =
    source === undefined ? undefined : readFileSync(source, "utf8");
  const target = extra["--artifact"] ?? file;
  const targetHash = digest(readFileSync(target));
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
    if (command === "check") {
      const report = check(markdown, tokenize, genre, original);
      if (noRecord) result = { ...report, verification: null };
      else {
        // A receipt is minted only by a completed full check, never by lint.
        if (digest(readFileSync(file, "utf8")) !== digest(markdown))
          throw new Error("検査中に本文が変更されました。");
        const verification = recordCheck(
          target,
          targetHash,
          markdown,
          report.findings.length +
            report.calques.length +
            (report.newFacts?.length ?? 0),
          stateDir,
          original === undefined ? null : digest(original),
        );
        if (extra["--session"]) track(target, extra["--session"], stateDir);
        result = { ...report, verification };
      }
    } else if (command === "calques") result = calques(lines, tokenize);
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
