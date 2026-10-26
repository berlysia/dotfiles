import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReviewEntries,
  calques,
  check,
  lint,
  newFacts,
  outline,
  terms,
} from "./analyze.ts";
import type { ReviewEntry } from "./analyze.ts";
import { AnalyzerOutputError, makeTokenizer } from "./contract.ts";
import { checkDependencies, DependencyMissingError } from "./deps.ts";
import type { DependencyGroup } from "./deps.ts";
import { matchKeeps } from "./keep.ts";
import { keepComments, paragraphs, proseLines } from "./markdown.ts";
import { describeResolved, loadProfiles, resolveModules } from "./profiles.ts";
import { recordCheck, recordDecision, verify } from "./receipts.ts";
import { readFileBounded } from "./safe-read.ts";
import { MAX_SECRETS_BYTES, scanSecrets } from "./secrets.ts";
import { defaultStateDir, digest, StateDirError } from "./state.ts";
import { track } from "./tracking.ts";
import { MAX_LIST_BYTES, parseWordList } from "./words.ts";
import { GENRES, READERS } from "./types.ts";
import type { Genre, Reader } from "./types.ts";

// The adapter is imported only on the paths that need it (see loadTokenizer), so
// the type is taken from analyze.ts instead of importing it here.
type Tokenizer = Parameters<typeof calques>[1];

// A failure whose message is fixed text written in this file. Only these (and
// StateDirError and DependencyMissingError) may print their message; any other
// error can carry a piece of the document, so only its name is printed.
class CliError extends Error {}

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
  "secrets",
]);
const usage =
  "node cli.ts <check|lint|calques|outline|terms|paragraphs|newfacts|verify|review|defer|exclude|track|secrets> <file> [--source original.md] [--genre tech|business|essay] [--profile ID [--reader adhd]] [--artifact document.pdf] [--hash SHA256 --reason TEXT] [--session ID] [--no-record]";

export function parseArguments(args: string[]) {
  const [command, ...rest] = args;
  if (!command || !commands.has(command)) throw new CliError(usage);
  let file: string | undefined;
  let source: string | undefined;
  let genre: Genre | undefined;
  let profile: string | undefined;
  let reader: Reader | undefined;
  const extra: Record<string, string> = {};
  let noRecord = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg === "--no-record") {
      if (noRecord)
        throw new CliError("--no-record は1回だけ指定してください。");
      noRecord = true;
    } else if (
      ["--artifact", "--hash", "--reason", "--session"].includes(arg)
    ) {
      const value = rest[++i];
      if (!value || value.startsWith("--") || extra[arg] !== undefined)
        throw new CliError(`${arg} の指定が不正です。`);
      extra[arg] = value;
    } else if (arg === "--source" || arg === "--genre") {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new CliError(`${arg} の値が必要です。`);
      if (arg === "--source") {
        if (source !== undefined)
          throw new CliError("--source は1回だけ指定してください。");
        source = value;
      } else {
        if (genre !== undefined)
          throw new CliError("--genre は1回だけ指定してください。");
        if (!(GENRES as readonly string[]).includes(value))
          throw new CliError("--genre の値が不正です。");
        genre = value as Genre;
      }
    } else if (arg === "--profile" || arg === "--reader") {
      const value = rest[++i];
      if (!value || value.startsWith("--"))
        throw new CliError(`${arg} の値が必要です。`);
      if (arg === "--profile") {
        if (profile !== undefined)
          throw new CliError("--profile は1回だけ指定してください。");
        profile = value;
      } else {
        if (reader !== undefined)
          throw new CliError("--reader は1回だけ指定してください。");
        if (!(READERS as readonly string[]).includes(value))
          throw new CliError("--reader の値が不正です。");
        reader = value as Reader;
      }
    } else if (arg.startsWith("--") || file !== undefined) {
      throw new CliError("不明な引数があります。");
    } else file = arg;
  }
  if (!file) throw new CliError("入力ファイルを指定してください。");
  if (command === "newfacts" && !source)
    throw new CliError("newfacts には --source が必要です。");
  if (source && command !== "check" && command !== "newfacts")
    throw new CliError("--source は check/newfacts で使います。");
  if (genre && command !== "check" && command !== "lint")
    throw new CliError("--genre は check/lint で使います。");
  if ((profile !== undefined || reader !== undefined) && command !== "check")
    throw new CliError("--profile/--reader は check で使います。");
  if (reader !== undefined && profile === undefined)
    throw new CliError("--reader には --profile が必要です。");
  if (source && resolve(source) === resolve(file))
    throw new CliError("原文と最終稿は別ファイルにしてください。");
  if ((noRecord || extra["--artifact"]) && command !== "check")
    throw new CliError("--no-record/--artifact は check で使います。");
  const decision = ["review", "defer", "exclude"].includes(command);
  if (
    decision &&
    (!/^[0-9a-f]{64}$/u.test(extra["--hash"] ?? "") ||
      !extra["--reason"]?.trim())
  )
    throw new CliError("判断には --hash と --reason が必要です。");
  if (!decision && (extra["--hash"] || extra["--reason"]))
    throw new CliError("--hash/--reason は review/defer/exclude で使います。");
  if (command === "track" && !extra["--session"])
    throw new CliError("track には --session が必要です。");
  if (extra["--session"] && command !== "check" && command !== "track")
    throw new CliError("--session は check/track で使います。");
  if (noRecord && extra["--session"])
    throw new CliError("--no-record と --session は併用できません。");
  return { command, file, source, genre, extra, noRecord, profile, reader };
}

function selectProfile(id: string, reader: Reader | undefined) {
  const table = loadProfiles();
  if (!table.ok) throw new CliError(`${table.reason}。`);
  const row = table.rows.find((item) => item.id === id);
  // The id is not echoed: it came from the command line and may hold anything.
  if (!row) throw new CliError("種類の表に無い id が指定されました。");
  return { id: row.id, resolved: resolveModules(row, reader) };
}

// The dependency check and the import use the same resolved file, and the
// dictionary package is loaded only by the commands that tokenize.
async function loadTokenizer(
  groups: readonly DependencyGroup[],
): Promise<Tokenizer> {
  // A literal dynamic import: only the commands that tokenize load the adapter
  // (and through it the dictionary package).
  const adapter = await import("./adapter-sudachi-wasm.ts");
  const found = checkDependencies(groups, adapter.ANALYZER_DEPENDENCIES);
  const analyzer = found.found.find((item) => item.group === "analyzer");
  if (!found.ok || !analyzer)
    throw new DependencyMissingError(
      found.missing.length > 0 ? found.missing : ["analyzer"],
    );
  const tokenize = makeTokenizer(await adapter.createAnalyzer(analyzer.entry));
  // The class check, not error.name: the analyzer package can throw an error
  // with any name, and its message may carry a piece of the document.
  return (text) => {
    try {
      return tokenize(text);
    } catch (error) {
      if (error instanceof AnalyzerOutputError)
        throw new CliError(error.message);
      throw error;
    }
  };
}

const READ_FAILURES = {
  missing: "ファイルが無い",
  "not-file": "通常のファイルでない",
  "too-large": `${MAX_LIST_BYTES / 1024} KB を超える`,
  error: "読み込みに失敗した",
} as const;

// The review entries of the word list, in list order. `problems` is empty only
// when the file was read and every entry passed validation: a check made with
// less than the whole list must not be recorded as a complete one.
function loadReview(path: string): {
  review: ReviewEntry[];
  problems: string[];
} {
  const read = readFileBounded(path, MAX_LIST_BYTES);
  if (!read.ok) return { review: [], problems: [READ_FAILURES[read.reason]] };
  const parsed = parseWordList(read.bytes.toString("utf8"));
  if (!parsed.ok) return { review: [], problems: [parsed.reason] };
  const built = buildReviewEntries(parsed.entries);
  return {
    review: built.review,
    problems: [...parsed.notices, ...built.notices],
  };
}

const defaultWordListPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), "data/words.json");

export async function main(
  args: string[],
  options: { stateDir?: string; wordListPath?: string } = {},
): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const { command, file, source, genre, extra, noRecord, profile, reader } =
    parseArguments(args);
  if (command === "secrets") {
    // No dependency, no state: the scan runs before anything is copied or recorded.
    const read = readFileBounded(file, MAX_SECRETS_BYTES);
    if (!read.ok) throw new CliError("secrets の入力を読めません。");
    console.log(
      JSON.stringify(
        { secrets: scanSecrets(read.bytes.toString("utf8")) },
        null,
        2,
      ),
    );
    return;
  }
  const stateDir = options.stateDir ?? defaultStateDir();
  const selected =
    profile === undefined ? undefined : selectProfile(profile, reader);
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
      throw new CliError("原文と最終稿が同じ実体を指しています。");
    }
  }
  const lines = proseLines(markdown);
  // A row's own genre wins; --genre only fills in when the row has none.
  const effectiveGenre = selected?.resolved.genre ?? genre;
  let result: unknown;
  if (command === "outline") result = outline(lines);
  else if (command === "paragraphs") result = paragraphs(lines);
  else if (command === "lint") result = lint(lines, genre);
  else {
    const tokenize = await loadTokenizer(
      selected ? ["analyzer", "grammar"] : ["analyzer"],
    );
    const { review, problems } = loadReview(
      options.wordListPath ?? defaultWordListPath(),
    );
    if (command === "check") {
      const report = check(
        markdown,
        tokenize,
        review,
        effectiveGenre,
        original,
      );
      if (problems.length > 0)
        report.limitations.push(
          `語の一覧を読めなかった（${problems.join("、")}）。読めた項目だけで照合した。`,
        );
      const keeps = matchKeeps(keepComments(markdown), [
        ...report.findings,
        ...report.calques,
      ]);
      const keepOutput = { kept: keeps.kept, keepIssues: keeps.keepIssues };
      const profileOutput = selected
        ? { profile: { id: selected.id, ...(reader ? { reader } : {}) } }
        : {};
      if (noRecord || problems.length > 0)
        result = {
          ...report,
          ...keepOutput,
          ...profileOutput,
          verification: null,
        };
      else {
        // A receipt is minted only by a completed full check, never by lint.
        if (digest(readFileSync(file, "utf8")) !== digest(markdown))
          throw new CliError("検査中に本文が変更されました。");
        const verification = recordCheck({
          file: target,
          expectedHash: targetHash,
          body: markdown,
          // newFacts cannot be kept: whether a new fact stays is a per-document
          // call against the original.
          candidates:
            [...report.findings, ...report.calques].filter(
              (item) => !keeps.keptCandidates.has(item),
            ).length +
            (report.newFacts?.length ?? 0) +
            keeps.keepIssues.length,
          stateDir,
          comparisonHash: original === undefined ? null : digest(original),
          profile: selected
            ? {
                id: selected.id,
                ...(reader ? { reader } : {}),
                hash: digest(
                  describeResolved(selected.resolved, effectiveGenre),
                ),
              }
            : undefined,
        });
        if (extra["--session"]) track(target, extra["--session"], stateDir);
        result = { ...report, ...keepOutput, ...profileOutput, verification };
      }
    } else if (command === "calques") {
      if (problems.length > 0)
        console.error(`語の一覧を読めなかった（${problems.join("、")}）。`);
      result = calques(lines, tokenize, review);
    } else if (command === "terms") result = terms(lines, tokenize);
    else {
      if (original === undefined)
        throw new CliError("比較する原文がありません。");
      result = newFacts(proseLines(original), lines, tokenize);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

const PRINTABLE_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "StateDirError",
];

// Reading `name` can itself throw (a getter or a Proxy), so it is guarded.
function errorName(error: unknown): string {
  try {
    if (error instanceof Error && PRINTABLE_ERROR_NAMES.includes(error.name))
      return error.name;
  } catch {
    // fall through to the generic name
  }
  return "Error";
}

function describeFailure(error: unknown): string {
  try {
    if (error instanceof StateDirError)
      return `[japanese-check] 置き場を使えない（${error.kind}）: ${error.message}`;
    if (error instanceof DependencyMissingError)
      return `japanese-check: 依存 ${error.names.join(", ")} が見つかりません。引数なしの chezmoi apply で配り直してください。`;
    if (error instanceof CliError) return `japanese-check: ${error.message}`;
  } catch {
    // fall through to the generic message
  }
  return `japanese-check: 失敗しました（${errorName(error)}）`;
}

// Never prints error.message or the stack: they can carry a piece of the
// document (a JSON.parse error, a tokenizer error).
function die(error: unknown): never {
  try {
    console.error(describeFailure(error));
  } catch {
    // stderr is gone; the exit code still reports the failure
  }
  process.exit(2);
}

// argv[1] と import.meta.url の比較は使わない: Node はエントリの URL を realpath に
// するので、symlink を通した起動（macOS の /var → /private/var）で一致せず、
// 何もせずに 0 で終わる。
if (import.meta.main) {
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
  main(process.argv.slice(2)).catch(die);
}
