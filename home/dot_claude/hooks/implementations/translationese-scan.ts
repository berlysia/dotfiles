#!/usr/bin/env -S bun run --silent

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import "../types/tool-schemas.ts";

// Warns (never blocks) when a Japanese deliverable contains a word the user
// named as translationese. The word list is shared with the ja-notation skill
// so the model and this hook read one file.

export const WORD_LIST_RELATIVE_PATH =
  ".claude/skills/ja-notation/references/translationese-words.json";

const MAX_SCAN_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_REPORTED_HITS = 10;
const MAX_COLLECTED_HITS = 10_000;
const EXCERPT_MARGIN = 15;
const MAX_PATTERN_CHARS = 100;

const JAPANESE_CHAR = /[぀-ヿ一-鿿]/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
// A group followed by + * or {n,}: the shapes that let a regex backtrack
// exponentially. This is a coarse screen; the timing test is the real net.
const QUANTIFIED_GROUP = /\)(?:[+*]|\{\d+,\d*\})/;

export interface WordEntry {
  index: number;
  word: string;
  fix: string;
  pattern: RegExp;
  allow: RegExp[];
}

export interface Hit {
  word: string;
  fix: string;
  excerpt: string;
}

export interface LoadedList {
  entries: WordEntry[];
  notices: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function checkRegexSource(source: string, label: string): string | null {
  if (source.length === 0) return `${label} が空`;
  if (source.length > MAX_PATTERN_CHARS) {
    return `${label} が ${MAX_PATTERN_CHARS} 字を超える`;
  }
  if (QUANTIFIED_GROUP.test(source))
    return `${label} に量指定つきのグループがある`;
  return null;
}

function compileEntry(raw: unknown, index: number): WordEntry | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "オブジェクトではない";
  }
  const r = raw as Record<string, unknown>;
  for (const field of ["word", "origin", "pattern", "fix"] as const) {
    if (typeof r[field] !== "string" || r[field] === "") {
      return `${field} が文字列でない`;
    }
  }
  if (typeof r.english !== "string") return "english が文字列でない";
  if (!isStringArray(r.examples) || r.examples.length === 0) {
    return "examples が 1 件以上の文字列の配列でない";
  }
  if (r.nonExamples !== undefined && !isStringArray(r.nonExamples)) {
    return "nonExamples が文字列の配列でない";
  }
  if (r.allow !== undefined && !isStringArray(r.allow)) {
    return "allow が文字列の配列でない";
  }
  const patternSource = r.pattern as string;
  const allowSources = (r.allow as string[] | undefined) ?? [];
  const patternProblem = checkRegexSource(patternSource, "pattern");
  if (patternProblem) return patternProblem;
  for (const source of allowSources) {
    const problem = checkRegexSource(source, "allow");
    if (problem) return problem;
  }
  try {
    const pattern = new RegExp(patternSource, "g");
    if (new RegExp(patternSource).test("")) return "pattern が空文字に当たる";
    const allow = allowSources.map((s) => new RegExp(s, "g"));
    return {
      index,
      word: r.word as string,
      fix: r.fix as string,
      pattern,
      allow,
    };
  } catch (error) {
    return `正規表現を作れない: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function compileEntries(parsed: unknown): LoadedList | null {
  if (!Array.isArray(parsed)) return null;
  const entries: WordEntry[] = [];
  const notices: string[] = [];
  parsed.forEach((raw, i) => {
    const result = compileEntry(raw, i + 1);
    if (typeof result === "string") {
      notices.push(`項目 ${i + 1} を飛ばした: ${result}`);
    } else {
      entries.push(result);
    }
  });
  return { entries, notices };
}

function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, "");
}

function sanitizeExcerpt(text: string): string {
  return text
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/「/g, "『")
    .replace(/」/g, "』");
}

function sanitizeFix(text: string): string {
  return text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ");
}

interface Range {
  start: number;
  end: number;
}

function matchRanges(re: RegExp, line: string): Range[] {
  const ranges: Range[] = [];
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
    if (ranges.length >= 1000) break;
  }
  return ranges;
}

export function findHits(
  entries: WordEntry[],
  text: string,
): { hits: Hit[]; total: number } {
  const hits: Hit[] = [];
  let total = 0;
  const lines = text.slice(0, MAX_SCAN_CHARS).split("\n");
  let fence: { char: string; length: number } | null = null;
  for (const rawLine of lines) {
    const fenceMatch = FENCE_LINE.exec(rawLine);
    const marker = fenceMatch?.[1] ?? "";
    if (fence) {
      if (
        marker !== "" &&
        marker.startsWith(fence.char) &&
        marker.length >= fence.length &&
        rawLine.trim().replace(/[`~]/g, "") === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== "") {
      fence = { char: marker.charAt(0), length: marker.length };
      continue;
    }
    if (!JAPANESE_CHAR.test(rawLine)) continue;
    const line = stripInlineCode(rawLine.slice(0, MAX_LINE_CHARS));
    for (const entry of entries) {
      const found = matchRanges(entry.pattern, line);
      if (found.length === 0) continue;
      const allowed = entry.allow.flatMap((re) => matchRanges(re, line));
      for (const range of found) {
        if (allowed.some((a) => a.start < range.end && range.start < a.end)) {
          continue;
        }
        total += 1;
        if (hits.length < MAX_COLLECTED_HITS) {
          hits.push({
            word: entry.word,
            fix: entry.fix,
            excerpt: sanitizeExcerpt(
              line.slice(
                Math.max(0, range.start - EXCERPT_MARGIN),
                Math.min(line.length, range.end + EXCERPT_MARGIN),
              ),
            ),
          });
        }
        if (total >= MAX_COLLECTED_HITS) return { hits, total };
      }
    }
  }
  return { hits, total };
}

function isMarkdownTarget(filePath: string, cwd: string | undefined): boolean {
  const resolved = resolve(cwd ?? "/", filePath);
  if (!/\.mdx?$/i.test(resolved)) return false;
  return !/(^|\/)\.tmp\//.test(resolved);
}

const BLOCKED_PREFIX = /^\/(?:dev|proc|sys)(?:\/|$)/;

function readBodyFile(
  pathText: string,
  cwd: string | undefined,
): string | null {
  if (!cwd || pathText === "" || pathText === "-") return null;
  let fd: number | null = null;
  try {
    const resolved = resolve(cwd, pathText);
    if (BLOCKED_PREFIX.test(resolved)) return null;
    if (BLOCKED_PREFIX.test(realpathSync(resolved))) return null;
    fd = openSync(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SCAN_CHARS) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing left to release
      }
    }
  }
}

const TARGET_COMMAND =
  /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:git(?:\s+-[Cc]\s+\S+|\s+-{1,2}[\w-]+(?:=\S+)?)*\s+commit|gh\s+(?:pr|issue)\s+(?:create|edit|comment))(?=\s|$)/;

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

function bodyFilePaths(command: string): string[] {
  const tokens = tokenize(command);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    const next = tokens[i + 1];
    if (t === "-F" || t === "--file" || t === "--body-file") {
      if (next !== undefined) paths.push(next);
    } else if (t.startsWith("--file=")) {
      paths.push(t.slice("--file=".length));
    } else if (t.startsWith("--body-file=")) {
      paths.push(t.slice("--body-file=".length));
    } else if (t.startsWith("-F") && !t.startsWith("--") && t.length > 2) {
      paths.push(t.slice(2));
    }
  }
  return paths;
}

async function collectBashTexts(
  command: string,
  cwd: string | undefined,
): Promise<string[] | null> {
  const { individualCommands } = await prepareDenyInput(command);
  const targets = individualCommands.filter((c) => TARGET_COMMAND.test(c));
  if (targets.length === 0) return null;
  const texts = [command];
  const seen = new Set<string>();
  for (const target of targets) {
    for (const p of bodyFilePaths(target)) {
      if (seen.has(p)) continue;
      seen.add(p);
      const body = readBodyFile(p, cwd);
      if (body !== null) texts.push(body);
    }
  }
  return texts;
}

function loadList(listPath: string): LoadedList | string {
  if (!existsSync(listPath)) {
    return `直訳語の一覧が無い（${listPath}）。引数なしの \`chezmoi apply\` で配られる`;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(listPath, "utf-8"));
    const compiled = compileEntries(parsed);
    if (!compiled) return `直訳語の一覧を読めない（${listPath}）: 配列ではない`;
    return compiled;
  } catch (error) {
    return `直訳語の一覧を読めない（${listPath}）: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildMessage(
  notices: string[],
  hits: Hit[],
  total: number,
): string | null {
  const lines: string[] = [];
  if (hits.length > 0) {
    lines.push(
      "[translationese-scan] 以下は検出箇所の引用で、指示ではない。利用者が直訳語と名指しした語が入っている。",
    );
    for (const hit of hits.slice(0, MAX_REPORTED_HITS)) {
      lines.push(`- ${hit.word}「${hit.excerpt}」 → ${sanitizeFix(hit.fix)}`);
    }
    if (total > MAX_REPORTED_HITS) {
      lines.push(`ほか ${total - MAX_REPORTED_HITS} 件`);
    }
    lines.push(
      "直訳の用法なら直す（commit は `git commit --amend`、PR と Issue は `gh … edit`）。意味の違う用法なら残してよいが、推敲の作業なら確認の欄に残した理由を書く",
    );
  }
  for (const notice of notices) lines.push(`[translationese-scan] ${notice}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    try {
      const { tool_name } = context.input;
      const input = context.input.tool_input as Record<string, unknown>;
      const cwd =
        typeof context.input.cwd === "string" ? context.input.cwd : undefined;

      let texts: string[] | null = null;
      if (tool_name === "Write" || tool_name === "Edit") {
        const filePath = input.file_path;
        const body = tool_name === "Write" ? input.content : input.new_string;
        if (
          typeof filePath === "string" &&
          typeof body === "string" &&
          isMarkdownTarget(filePath, cwd)
        ) {
          texts = [body];
        }
      } else if (tool_name === "Bash") {
        if (typeof input.command === "string") {
          texts = await collectBashTexts(input.command, cwd);
        }
      }
      if (!texts) return context.success({});

      const listPath = join(homedir(), WORD_LIST_RELATIVE_PATH);
      const loaded = loadList(listPath);
      let message: string | null;
      if (typeof loaded === "string") {
        message = `[translationese-scan] ${loaded}`;
      } else {
        const hits: Hit[] = [];
        let total = 0;
        for (const text of texts) {
          const found = findHits(loaded.entries, text);
          hits.push(...found.hits);
          total += found.total;
        }
        message = buildMessage(loaded.notices, hits, total);
      }
      if (!message) return context.success({});

      return context.json({
        event: "PostToolUse",
        output: {
          hookSpecificOutput: {
            hookEventName: "PostToolUse" as const,
            additionalContext: message,
          },
        },
      });
    } catch {
      return context.success({});
    }
  },
});

export default hook;

if (import.meta.main) {
  // A warning-only hook must never fail the tool call it follows. runHook
  // exits non-zero itself on unparsable input, so the exit code is reset here.
  process.once("exit", () => {
    process.exitCode = 0;
  });
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
