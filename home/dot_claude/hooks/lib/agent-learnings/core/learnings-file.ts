import { isValidRepoKey } from "../../repo-key.ts";

export type LearningEntry = {
  id: string; // /^L-[0-9a-f]{12}$/
  title: string;
  body: string;
  seen: number;
  repos: string[]; // 各要素が isValidRepoKey
  updated: string; // /^\d{4}-\d{2}-\d{2}$/
  extra: Array<[string, string]>;
};
export type LearningsFile = {
  format: number;
  key: string;
  readOnly: boolean;
  entries: LearningEntry[];
};
export type Parsed =
  | { ok: true; value: LearningsFile }
  | { ok: false; reason: string };

export const COMMON_KEY = "common";

const HEADER = /^<!-- agent-learnings format: (\d+); key: (\S+) -->$/;
const ID_PATTERN = /^L-[0-9a-f]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXTRA_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;

type EntriesResult =
  | { ok: true; entries: LearningEntry[] }
  | { ok: false; reason: string };

function parseMeta(
  inner: string,
):
  | { ok: true; entry: Omit<LearningEntry, "title" | "body"> }
  | { ok: false; reason: string } {
  const fields = new Map<string, string>();
  const extra: Array<[string, string]> = [];
  for (const part of inner.split("; ")) {
    const at = part.indexOf(": ");
    if (at < 0) return { ok: false, reason: "meta field" };
    const name = part.slice(0, at);
    const value = part.slice(at + 2);
    if (!EXTRA_KEY.test(name)) return { ok: false, reason: "meta key" };
    if (
      name === "id" ||
      name === "seen" ||
      name === "repos" ||
      name === "updated"
    ) {
      if (fields.has(name)) return { ok: false, reason: "duplicate meta key" };
      fields.set(name, value);
    } else {
      extra.push([name, value]);
    }
  }
  const id = fields.get("id");
  const seen = fields.get("seen");
  const repos = fields.get("repos");
  const updated = fields.get("updated");
  if (id === undefined || !ID_PATTERN.test(id))
    return { ok: false, reason: "meta id" };
  if (seen === undefined || !/^\d+$/.test(seen))
    return { ok: false, reason: "meta seen" };
  if (updated === undefined || !DATE_PATTERN.test(updated))
    return { ok: false, reason: "meta updated" };
  if (repos === undefined) return { ok: false, reason: "meta repos" };
  const repoList = repos === "" ? [] : repos.split(",");
  if (!repoList.every(isValidRepoKey))
    return { ok: false, reason: "meta repos key" };
  return {
    ok: true,
    entry: { id, seen: Number(seen), repos: repoList, updated, extra },
  };
}

// lines[3] が空行であることは呼び出し側で確かめ済み。lines[4] 以降が項目の繰り返し
function parseEntries(lines: readonly string[]): EntriesResult {
  const entries: LearningEntry[] = [];
  let i = 4;
  while (i < lines.length) {
    const heading = /^## (.+)$/.exec(lines[i] ?? "");
    if (!heading) return { ok: false, reason: "heading" };
    const metaLine = /^<!-- (.*) -->$/.exec(lines[i + 1] ?? "");
    if (!metaLine) return { ok: false, reason: "meta line" };
    const meta = parseMeta(metaLine[1] ?? "");
    if (!meta.ok) return meta;
    const body = lines[i + 2];
    if (body === undefined || body === "" || body.startsWith("## "))
      return { ok: false, reason: "body" };
    entries.push({ ...meta.entry, title: heading[1] ?? "", body });
    const next = i + 3;
    if (next === lines.length) break;
    if (lines[next] !== "" || next + 1 >= lines.length)
      return { ok: false, reason: "separator" };
    i = next + 1;
  }
  return { ok: true, entries };
}

export function parseLearningsFile(text: string): Parsed {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header = HEADER.exec(lines[0] ?? "");
  if (!header) {
    return {
      ok: true,
      value: { format: 0, key: "", readOnly: true, entries: [] },
    };
  }
  const format = Number(header[1]);
  const key = header[2] ?? "";
  if (key !== COMMON_KEY && !isValidRepoKey(key))
    return { ok: false, reason: "header key" };

  let entries: LearningEntry[] = [];
  let problem: string | null = null;
  if (lines[1] !== "" || lines[2] !== `# Learnings: ${key}`) {
    problem = "title line";
  } else if (lines.length > 3) {
    if (lines[3] !== "") {
      problem = "blank line";
    } else {
      const parsed = parseEntries(lines);
      if (parsed.ok) entries = parsed.entries;
      else problem = parsed.reason;
    }
  }
  if (format !== 1)
    return { ok: true, value: { format, key, readOnly: true, entries } };
  if (problem !== null) return { ok: false, reason: problem };
  return { ok: true, value: { format, key, readOnly: false, entries } };
}

export function serializeLearningsFile(file: LearningsFile): string {
  const lines = [
    `<!-- agent-learnings format: 1; key: ${file.key} -->`,
    "",
    `# Learnings: ${file.key}`,
  ];
  for (const entry of file.entries) {
    const meta = [
      `id: ${entry.id}`,
      `seen: ${entry.seen}`,
      `repos: ${entry.repos.join(",")}`,
      `updated: ${entry.updated}`,
      ...entry.extra.map(([k, v]) => `${k}: ${v}`),
    ].join("; ");
    lines.push("", `## ${entry.title}`, `<!-- ${meta} -->`, entry.body);
  }
  return `${lines.join("\n")}\n`;
}
