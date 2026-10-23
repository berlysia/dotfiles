import { resolve } from "node:path";
import { gitSubcommand, splitCommand } from "../command-words.ts";

const JAPANESE = /[぀-ヿ㐀-鿿]/u;
const WRAPPERS = new Set(["env", "command", "sudo"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

interface FlagSpec {
  // Short flags that take a value; a bundle ends at the first of them.
  shortValue: string;
  shortFile: string;
  shortInline: string;
  longFile: string[];
  longInline: string[];
}

const GIT_COMMIT: FlagSpec = {
  shortValue: "mFCct",
  shortFile: "F",
  shortInline: "m",
  longFile: ["--file"],
  longInline: ["--message"],
};
const GH: FlagSpec = {
  shortValue: "tBHalmprRTbF",
  shortFile: "F",
  shortInline: "b",
  longFile: ["--body-file"],
  longInline: ["--body"],
};

export interface PublicationAnalysis {
  publishing: boolean;
  // Body files named on the command line, resolved against cwd.
  bodyFiles: string[];
  // A message value on the command line contains Japanese, or the body is
  // read from stdin and the command text contains Japanese.
  unverifiedJapaneseBody: boolean;
}

function gitSubcommandIndex(words: readonly string[]): number {
  // Mirrors command-words.ts, which does not export its index.
  let i = 1;
  while (i < words.length) {
    const word = words[i] as string;
    if (word === "-C" || word === "-c") i += 2;
    else if (word.startsWith("-")) i += 1;
    else return i;
  }
  return -1;
}

function readFlags(
  words: readonly string[],
  spec: FlagSpec,
): { files: string[]; inline: string[] } {
  const files: string[] = [];
  const inline: string[] = [];
  const take = (flag: "file" | "inline", value: string) =>
    (flag === "file" ? files : inline).push(value);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (word === "--") break;
    if (word.startsWith("--")) {
      const eq = word.indexOf("=");
      const name = eq < 0 ? word : word.slice(0, eq);
      const kind = spec.longFile.includes(name)
        ? "file"
        : spec.longInline.includes(name)
          ? "inline"
          : null;
      if (!kind) continue;
      if (eq >= 0) take(kind, word.slice(eq + 1));
      else if (i + 1 < words.length) take(kind, words[++i] as string);
    } else if (word.startsWith("-") && word.length > 1) {
      for (let c = 1; c < word.length; c++) {
        const flag = word[c] as string;
        if (!spec.shortValue.includes(flag)) continue;
        const attached = word.slice(c + 1);
        const value = attached || (i + 1 < words.length ? words[++i] : "");
        if (flag === spec.shortFile) take("file", value as string);
        else if (flag === spec.shortInline) take("inline", value as string);
        break;
      }
    }
  }
  return { files, inline };
}

export function analyzePublication(
  command: string,
  cwd: string,
): PublicationAnalysis {
  const result: PublicationAnalysis = {
    publishing: false,
    bodyFiles: [],
    unverifiedJapaneseBody: false,
  };
  for (const simple of splitCommand(command)) {
    let start = 0;
    while (
      start < simple.length &&
      (ASSIGNMENT.test(simple[start] as string) ||
        WRAPPERS.has(simple[start] as string))
    )
      start++;
    const words = simple.slice(start);
    let spec: FlagSpec | null = null;
    let rest: string[] = [];
    if (words[0] === "git") {
      const sub = gitSubcommand(words);
      if (sub !== "commit" && sub !== "push") continue;
      result.publishing = true;
      if (sub === "push") continue;
      spec = GIT_COMMIT;
      rest = words.slice(gitSubcommandIndex(words) + 1);
    } else if (
      words[0] === "gh" &&
      (words[1] === "pr" || words[1] === "issue") &&
      ["create", "edit", "comment"].includes(words[2] ?? "")
    ) {
      result.publishing = true;
      spec = GH;
      rest = words.slice(3);
    }
    if (!spec) continue;
    const { files, inline } = readFlags(rest, spec);
    if (inline.some((value) => JAPANESE.test(value)))
      result.unverifiedJapaneseBody = true;
    for (const file of files) {
      if (file === "-") {
        if (JAPANESE.test(command)) result.unverifiedJapaneseBody = true;
      } else result.bodyFiles.push(resolve(cwd, file));
    }
  }
  return result;
}
