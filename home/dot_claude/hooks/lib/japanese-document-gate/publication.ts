import { resolve } from "node:path";

export function publication(command: string): boolean {
  return /\bgit\s+(?:(?:-C|-c)\s+\S+\s+)*(?:commit|push)\b|\bgh\s+(?:pr|issue)\s+(?:create|edit|comment)\b/u.test(
    command,
  );
}

export function bodyFiles(command: string, cwd: string): string[] {
  const words = Array.from(
    command.matchAll(/"([^"\n]*)"|'([^'\n]*)'|([^\s]+)/gu),
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const result: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (["--body-file", "--file", "-F"].includes(word) && words[i + 1])
      result.push(resolve(cwd, words[++i] ?? ""));
    else if (/^(?:--body-file|--file)=/u.test(word))
      result.push(resolve(cwd, word.slice(word.indexOf("=") + 1)));
  }
  return result;
}
