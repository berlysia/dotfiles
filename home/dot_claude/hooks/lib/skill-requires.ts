// lib/skill-requires.ts
//
// Parts of the skill-requires gate (ADR-0046): reading a skill's declaration
// from its SKILL.md frontmatter, matching an operation against the declared
// patterns, and finding which skills a session has loaded.
//
// Why not a YAML library or lib/pattern-matcher.ts: the declaration is read on
// every Bash/Write call, so the reader stays line-based (no anchors or aliases
// to expand) and the matcher knows only the two pattern shapes the gate needs.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

// --- names and limits (K2) -------------------------------------------------

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_REQUIRES = 10;
export const MAX_BEFORE = 5;
export const MAX_PATTERN_LENGTH = 80;
export const FRONTMATTER_READ_BYTES = 8 * 1024;

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    SKILL_NAME_PATTERN.test(name) &&
    !name.includes("..")
  );
}

// --- declaration -------------------------------------------------------------

export type BeforePattern =
  | { kind: "bash"; words: string[] }
  | { kind: "write"; extension: string };

export interface SkillDeclaration {
  /** The skill that carries the declaration (its directory name). */
  skill: string;
  requires: string[];
  before: BeforePattern[];
  /** The patterns as written, for display in tests and logs. */
  rawBefore: string[];
}

export type ParseResult =
  | { ok: true; declaration: SkillDeclaration }
  | { ok: false; reason: string };

const REQUIRES_KEY = "requires-skills";
const BEFORE_KEY = "requires-skills-before";

export function parseBeforePattern(raw: string): BeforePattern | null {
  if (raw.length > MAX_PATTERN_LENGTH) return null;
  const bash = /^Bash\(([^()]*)\)$/.exec(raw);
  if (bash) {
    const words = (bash[1] ?? "").trim().split(/\s+/).filter(Boolean);
    // One word (`git`) would match unrelated operations of that command.
    if (words.length < 2) return null;
    return { kind: "bash", words };
  }
  const write = /^Write\(\*\*\/\*\.([A-Za-z0-9]+)\)$/.exec(raw);
  if (write)
    return { kind: "write", extension: (write[1] ?? "").toLowerCase() };
  return null;
}

function unquote(item: string): string {
  const trimmed = item.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The frontmatter lines (between the opening and closing `---`), or null. */
function frontmatterLines(text: string): string[] | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") return lines.slice(1, i);
  }
  return null;
}

type ListRead =
  | { found: false }
  | { found: true; items: string[] }
  | { found: true; error: string };

export type FrontmatterListRead = ListRead;

/** One key's list, in `[a, b]` or `- a` form. Anything else is an error. */
function readList(lines: string[], key: string): ListRead {
  const prefix = `${key}:`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index === -1) return { found: false };
  const rest = (lines[index] ?? "").slice(prefix.length).trim();
  if (rest !== "") {
    if (!(rest.startsWith("[") && rest.endsWith("]"))) {
      return { found: true, error: `${key} is not a list` };
    }
    const inner = rest.slice(1, -1).trim();
    const items = inner === "" ? [] : inner.split(",").map(unquote);
    return { found: true, items };
  }
  const items: string[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      items.push(unquote(item[1] ?? ""));
      continue;
    }
    if (line.trim() === "") continue;
    break;
  }
  return { found: true, items };
}

/** Reads one list key from closed frontmatter using the gate's line-based YAML subset. */
export function readFrontmatterList(
  text: string,
  key: string,
): FrontmatterListRead {
  const lines = frontmatterLines(text);
  if (lines === null) return { found: false };
  return readList(lines, key);
}

/**
 * Reads the two keys out of a SKILL.md text. Returns "no declaration" with the
 * reason when the keys are absent, only one is present, or any value breaks
 * the limits; the hook drops the reason, the repository check reports it.
 */
export function parseSkillDeclaration(
  skill: string,
  text: string,
): ParseResult {
  if (!isValidSkillName(skill))
    return { ok: false, reason: "invalid skill name" };
  const lines = frontmatterLines(text);
  if (lines === null) return { ok: false, reason: "no closed frontmatter" };
  const requires = readList(lines, REQUIRES_KEY);
  const before = readList(lines, BEFORE_KEY);
  if (!requires.found && !before.found) {
    return { ok: false, reason: "no declaration" };
  }
  if (!requires.found || !before.found) {
    return {
      ok: false,
      reason: `only one of ${REQUIRES_KEY} and ${BEFORE_KEY} is present`,
    };
  }
  if ("error" in requires) return { ok: false, reason: requires.error };
  if ("error" in before) return { ok: false, reason: before.error };
  if (requires.items.length === 0 || before.items.length === 0) {
    return { ok: false, reason: "empty list" };
  }
  if (requires.items.length > MAX_REQUIRES) {
    return { ok: false, reason: `more than ${MAX_REQUIRES} ${REQUIRES_KEY}` };
  }
  if (before.items.length > MAX_BEFORE) {
    return { ok: false, reason: `more than ${MAX_BEFORE} ${BEFORE_KEY}` };
  }
  for (const name of requires.items) {
    if (!isValidSkillName(name)) {
      return {
        ok: false,
        reason: `invalid skill name in ${REQUIRES_KEY}: ${JSON.stringify(name)}`,
      };
    }
  }
  const patterns: BeforePattern[] = [];
  for (const raw of before.items) {
    const pattern = parseBeforePattern(raw);
    if (pattern === null) {
      return {
        ok: false,
        reason: `unreadable pattern in ${BEFORE_KEY}: ${JSON.stringify(raw)}`,
      };
    }
    patterns.push(pattern);
  }
  return {
    ok: true,
    declaration: {
      skill,
      requires: [...requires.items],
      before: patterns,
      rawBefore: [...before.items],
    },
  };
}

export interface ReadDeclarationsResult {
  declarations: SkillDeclaration[];
  /** Skills that have a SKILL.md but no usable declaration, with the reason. */
  skipped: { skill: string; reason: string }[];
}

/**
 * K3: reads each skill directory's SKILL.md under skillsDir. A SKILL.md that is itself a symlink or
 * not a regular file is not read; only its first 8 KB is.
 */
export function readDeclarations(skillsDir: string): ReadDeclarationsResult {
  const result: ReadDeclarationsResult = { declarations: [], skipped: [] };
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!isValidSkillName(name)) continue;
    const text = readHead(
      join(skillsDir, name, "SKILL.md"),
      FRONTMATTER_READ_BYTES,
    );
    if (text === null) continue;
    const parsed = parseSkillDeclaration(name, text);
    if (parsed.ok) result.declarations.push(parsed.declaration);
    else result.skipped.push({ skill: name, reason: parsed.reason });
  }
  return result;
}

function readHead(path: string, maxBytes: number): string | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const buffer = Buffer.alloc(maxBytes);
    let offset = 0;
    while (offset < maxBytes) {
      const n = readSync(fd, buffer, offset, maxBytes - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// --- matching (K4) -----------------------------------------------------------

function normalizeCommand(command: string): string {
  return command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S* )+/, "");
}

/** `commands` are the individual commands of one Bash call, heredoc bodies already emptied. */
export function matchesBash(words: string[], commands: string[]): boolean {
  const head = words.join(" ");
  return commands.some((command) => {
    const normalized = normalizeCommand(command);
    return (
      normalized === head ||
      (normalized.startsWith(head) && normalized[head.length] === " ")
    );
  });
}

export function matchesWrite(extension: string, filePath: string): boolean {
  return filePath.toLowerCase().endsWith(`.${extension}`);
}

export type Operation =
  | { tool: "Bash"; commands: string[] }
  | { tool: "Write"; filePath: string };

export function matchesDeclaration(
  declaration: SkillDeclaration,
  operation: Operation,
): boolean {
  return declaration.before.some((pattern) => {
    if (pattern.kind === "bash") {
      return (
        operation.tool === "Bash" &&
        matchesBash(pattern.words, operation.commands)
      );
    }
    return (
      operation.tool === "Write" &&
      matchesWrite(pattern.extension, operation.filePath)
    );
  });
}

// --- transcript (K5) ---------------------------------------------------------

export const LOAD_MARKER = "Base directory for this skill: ";
export const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DEADLINE_MS = 1500;

export interface ScanOptions {
  chunkBytes?: number;
  maxScanBytes?: number;
  maxLineBytes?: number;
  deadlineMs?: number;
  /** Stop as soon as all of these have been found. */
  needed?: ReadonlySet<string>;
  now?: () => number;
}

export interface ScanResult {
  loaded: Set<string>;
  bytesRead: number;
  /** The deadline ended the scan before it finished and before `needed` was found. */
  timedOut: boolean;
}

export interface TranscriptLineScanResult {
  bytesRead: number;
  timedOut: boolean;
  /** False when the scan did not reach the start of the file. */
  complete: boolean;
  readable: boolean;
}

export interface TranscriptLineScanOptions extends ScanOptions {
  /** Stop after the current chunk when this returns true. */
  stopWhen?: () => boolean;
}

export interface LoadedSkillRecord {
  skill: string;
  baseDirectory: string;
}

export function loadedSkillRecordOfLine(
  line: Buffer,
): LoadedSkillRecord | null {
  if (line.indexOf(LOAD_MARKER) === -1) return null;
  let record: unknown;
  try {
    record = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const entry = record as {
    type?: unknown;
    isMeta?: unknown;
    message?: unknown;
  };
  if (entry.type !== "user" || entry.isMeta !== true) return null;
  const message = entry.message as { content?: unknown } | null | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  if (!first.text.startsWith(LOAD_MARKER)) return null;
  const baseDirectory =
    first.text
      .slice(LOAD_MARKER.length)
      .split("\n", 1)[0]
      ?.trim()
      .replace(/\/+$/, "") ?? "";
  const name = baseDirectory.split("/").pop() ?? "";
  return isValidSkillName(name) ? { skill: name, baseDirectory } : null;
}

/** The skill a transcript line records as loaded, or null. Only the isMeta user record counts. */
export function loadedSkillOfLine(line: Buffer): string | null {
  return loadedSkillRecordOfLine(line)?.skill ?? null;
}

/**
 * Reads the transcript backwards in chunks and collects the skills it records
 * as loaded. A line split by a chunk boundary is joined as bytes with its
 * neighbour before decoding. Returns an empty result for anything that is not
 * an absolute path to a regular file.
 */
export function scanLoadedSkills(
  path: string,
  options: ScanOptions = {},
): ScanResult {
  const needed = options.needed;
  const result: ScanResult = {
    loaded: new Set(),
    bytesRead: 0,
    timedOut: false,
  };
  const satisfied = () =>
    needed !== undefined &&
    needed.size > 0 &&
    [...needed].every((name) => result.loaded.has(name));
  const scan = scanTranscriptLines(
    path,
    (line) => {
      const name = loadedSkillOfLine(line);
      if (name !== null) result.loaded.add(name);
    },
    { ...options, stopWhen: satisfied },
  );
  result.bytesRead = scan.bytesRead;
  result.timedOut = scan.timedOut;
  return result;
}

/** Scans complete JSONL lines backwards with the same limits as scanLoadedSkills. */
export function scanTranscriptLines(
  path: string,
  onLine: (line: Buffer) => void,
  options: TranscriptLineScanOptions = {},
): TranscriptLineScanResult {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = options.now ?? (() => performance.now());
  const result: TranscriptLineScanResult = {
    bytesRead: 0,
    timedOut: false,
    complete: false,
    readable: false,
  };
  if (typeof path !== "string" || !isAbsolute(path)) return result;

  const startedAt = now();
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return result;
    result.readable = true;
    const rangeStart = Math.max(0, stat.size - maxScanBytes);
    let position = stat.size;
    let carry: Buffer = Buffer.alloc(0);
    let discarding = false;

    while (position > rangeStart) {
      const chunkStart = Math.max(rangeStart, position - chunkBytes);
      let chunk: Buffer = Buffer.alloc(position - chunkStart);
      let filled = 0;
      while (filled < chunk.length) {
        const n = readSync(
          fd,
          chunk,
          filled,
          chunk.length - filled,
          chunkStart + filled,
        );
        if (n === 0) break;
        filled += n;
      }
      chunk = chunk.subarray(0, filled);
      result.bytesRead += filled;
      position = chunkStart;

      if (discarding) {
        // The tail of an over-long line is in this chunk after its last newline.
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          if (options.stopWhen?.()) break;
          if (position > rangeStart && now() - startedAt >= deadlineMs) {
            result.timedOut = true;
            break;
          }
          continue;
        }
        chunk = chunk.subarray(0, lastNewline + 1);
        discarding = false;
      }

      const combined: Buffer = Buffer.concat([chunk, carry]);
      let segmentEnd = combined.length;
      // Walk complete lines from the back; the first segment is the partial one.
      let index = combined.lastIndexOf(0x0a, segmentEnd - 1);
      while (index !== -1) {
        onLine(combined.subarray(index + 1, segmentEnd));
        segmentEnd = index;
        index =
          segmentEnd === 0 ? -1 : combined.lastIndexOf(0x0a, segmentEnd - 1);
      }
      // combined[0..segmentEnd) has no newline: a whole line only at the file start.
      if (position === 0) {
        onLine(combined.subarray(0, segmentEnd));
        carry = Buffer.alloc(0);
      } else if (segmentEnd > maxLineBytes) {
        carry = Buffer.alloc(0);
        discarding = true;
      } else {
        carry = Buffer.from(combined.subarray(0, segmentEnd));
      }

      if (position === 0) result.complete = true;
      if (options.stopWhen?.()) break;
      if (position > rangeStart && now() - startedAt >= deadlineMs) {
        result.timedOut = true;
        break;
      }
    }
    if (position === 0) result.complete = true;
  } catch {
    result.readable = false;
    result.complete = false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return result;
}

// --- apm.yml names (K10) -----------------------------------------------------

/** Skill names apm installs: the `skills:` lists, and `…/skills/<name>#…` paths. */
export function extractApmSkillNames(text: string): Set<string> {
  const names = new Set<string>();
  const lines = text.split(/\r?\n/);
  let listIndent: number | null = null;
  for (const line of lines) {
    const pathForm = /^\s*-\s+\S*\/skills\/([A-Za-z0-9._-]+)(?:#\S*)?\s*$/.exec(
      line,
    );
    if (pathForm) names.add(pathForm[1] ?? "");
    const indent = line.length - line.trimStart().length;
    if (/^\s*skills:\s*$/.test(line)) {
      listIndent = indent;
      continue;
    }
    if (listIndent !== null) {
      const item = /^(\s*)-\s+([A-Za-z0-9._-]+)\s*$/.exec(line);
      if (item && (item[1] ?? "").length > listIndent) {
        names.add(item[2] ?? "");
        continue;
      }
      if (line.trim() !== "" && !line.trim().startsWith("#")) listIndent = null;
    }
  }
  names.delete("");
  return names;
}
