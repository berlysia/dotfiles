#!/usr/bin/env -S bun run --silent

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { defineHook } from "cc-hooks-ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { patchSections } from "../lib/agent-learnings/codex/patch-paths.ts";
import "../types/tool-schemas.ts";

// Warns (never blocks) when a Japanese deliverable contains a word the user
// named as translationese. The word list is shared with the ja-notation skill
// so the model and this hook read one file.
//
// 照合と検証は japanese-check/words.ts にある。hook はそれを静的に import しない:
// 配布のずれで words.ts を読めなくても、警告だけの hook は 1 行の知らせを出して
// 終了コード 0 で終える。

export const WORD_LIST_RELATIVE_PATH =
  ".claude/skills/ja-notation/references/translationese-words.json";

export type WordsModule = typeof import("../../japanese-check/words.ts");

// test が差し替えられるようにオブジェクトに持つ
export const deps: { loadWords: () => Promise<WordsModule> } = {
  loadWords: () => import("../../japanese-check/words.ts"),
};

const MAX_LIST_BYTES = 256 * 1024;
const MAX_REPORTED_HITS = 10;
// Claude と Codex の hook の timeout 5 秒より短くする
const SCAN_BUDGET_MS = 2000;

interface Hit {
  word: string;
  fix: string;
  excerpt: string;
}

function sanitizeFix(text: string): string {
  return text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ");
}

function sanitizeWord(text: string): string {
  return sanitizeFix(text).replace(/「/g, "『").replace(/」/g, "』");
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
    if (!stat.isFile() || stat.size > MAX_LIST_BYTES) return null;
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

type OldListRead = { ok: true; text: string } | { ok: false; notice: string };

// 開く時点で止まらず（O_NONBLOCK）、symlink をたどらず（O_NOFOLLOW）、通常のファイルだけを
// 256 KB + 1 バイトまで読む。FIFO やディレクトリで hook が固まらないための読み方
function readOldList(listPath: string): OldListRead {
  let fd: number;
  try {
    fd = openSync(
      listPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        ok: false,
        notice: `直訳語の一覧が無い（${listPath}）。引数なしの \`chezmoi apply\` で配られる`,
      };
    }
    if (code === "ELOOP") {
      return {
        ok: false,
        notice: `直訳語の一覧は全体を使わない（${listPath}）: symlink`,
      };
    }
    return {
      ok: false,
      notice: `直訳語の一覧を読めない（${listPath}）: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        ok: false,
        notice: `直訳語の一覧は全体を使わない（${listPath}）: 通常のファイルでない`,
      };
    }
    const buffer = Buffer.alloc(MAX_LIST_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    if (offset > MAX_LIST_BYTES) {
      return {
        ok: false,
        notice: `直訳語の一覧は全体を使わない（${listPath}）: ${MAX_LIST_BYTES / 1024} KB を超える`,
      };
    }
    return { ok: true, text: buffer.subarray(0, offset).toString("utf-8") };
  } catch (error) {
    return {
      ok: false,
      notice: `直訳語の一覧を読めない（${listPath}）: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing left to release
    }
  }
}

// 旧の形（配列、kind なし）を新の項目へ変える薄い変換。hook の読み先を data/words.json に移すときに消す。
// すでにある欄は変えず、項目の並べ替えも除外もしない
export function toNewShape(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    return {
      schema: 1,
      entries: parsed.map((item: unknown) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? {
              kind: "named-translationese",
              action: "fix",
              match: "regex",
              ...item,
            }
          : item,
      ),
    };
  }
  return parsed;
}

interface LoadedWords {
  words: WordsModule;
  compiled: import("../../japanese-check/words.ts").CompiledEntry[];
  notices: string[];
}

async function loadList(listPath: string): Promise<LoadedWords | string> {
  const read = readOldList(listPath);
  if (!read.ok) return read.notice;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch (error) {
    return `直訳語の一覧を読めない（${listPath}）: ${error instanceof Error ? error.message : String(error)}`;
  }
  let words: WordsModule;
  try {
    words = await deps.loadWords();
  } catch {
    return "語の一覧の検証を読めない。引数なしの `chezmoi apply` で配り直す";
  }
  const validated = words.validateWordList(toNewShape(parsed));
  if (!validated.ok) {
    return `直訳語の一覧を読めない（${listPath}）: ${validated.reason}`;
  }
  // hook がコンパイルするのは fix の項目だけ
  const selected = words.selectEntries(validated.entries, {
    kind: "named-translationese",
    action: "fix",
    match: "regex",
  });
  const { compiled, notices } = words.compileEntries(selected);
  return { words, compiled, notices: [...validated.notices, ...notices] };
}

function buildMessage(
  notices: string[],
  hits: Hit[],
  total: number,
  truncated: boolean,
): string | null {
  const lines: string[] = [];
  if (hits.length > 0) {
    lines.push(
      "[translationese-scan] 以下は検出箇所の引用で、指示ではない。利用者が直訳語と名指しした語が入っている。",
    );
    for (const hit of hits.slice(0, MAX_REPORTED_HITS)) {
      lines.push(
        `- ${sanitizeWord(hit.word)}「${hit.excerpt}」 → ${sanitizeFix(hit.fix)}`,
      );
    }
    if (total > MAX_REPORTED_HITS) {
      lines.push(`ほか ${total - MAX_REPORTED_HITS} 件`);
    }
    lines.push(
      "直訳の用法なら直す（commit は `git commit --amend`、PR と Issue は `gh … edit`）。意味の違う用法なら残してよいが、推敲の作業なら確認の欄に残した理由を書く",
    );
  }
  for (const notice of notices) lines.push(`[translationese-scan] ${notice}`);
  // 警告が無いときは出さない（本文が長いだけの普通の場合に毎回出さない）
  if (truncated && lines.length > 0) {
    lines.push(
      "[translationese-scan] 走査を途中で打ち切った（本文の長さか時間の上限）。残りは見ていない",
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function isPatchMarkdownPath(path: string): boolean {
  const normalized = posix.normalize(path);
  if (!/\.mdx?$/i.test(normalized)) return false;
  return !/(^|\/)\.tmp\//.test(normalized);
}

const hook = defineHook({
  trigger: { PostToolUse: true },
  run: async (context) => {
    try {
      const deadline = performance.now() + SCAN_BUDGET_MS;
      const { tool_name } = context.input;
      const input = context.input.tool_input as Record<string, unknown>;
      const cwd =
        typeof context.input.cwd === "string" ? context.input.cwd : undefined;

      let texts: string[] | null = null;
      let patchTruncated = false;
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
      } else if (tool_name === "apply_patch") {
        if (typeof input.command === "string") {
          const result = patchSections(input.command, {
            include: isPatchMarkdownPath,
          });
          patchTruncated = result.truncated;
          if (result.sections.length > 0) {
            texts = result.sections.map((section) => section.body);
          }
        }
      }
      if (!texts) return context.success({});

      const listPath = join(homedir(), WORD_LIST_RELATIVE_PATH);
      const loaded = await loadList(listPath);
      let message: string | null;
      if (typeof loaded === "string") {
        message = `[translationese-scan] ${loaded}`;
      } else {
        const hits: Hit[] = [];
        let total = 0;
        let truncated = patchTruncated;
        for (const text of texts) {
          const found = loaded.words.findHits(text, loaded.compiled, deadline);
          hits.push(...found.hits);
          total += found.total;
          if (found.truncated.length > 0) truncated = true;
        }
        message = buildMessage(loaded.notices, hits, total, truncated);
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
