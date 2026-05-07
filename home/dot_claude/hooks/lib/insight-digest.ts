import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();

export const PROJECTS_DIR = join(HOME, ".claude", "projects");
export const LOGS_DIR = join(HOME, ".claude", "logs", "insights");
export const INSIGHTS_JSONL = join(LOGS_DIR, "insights.jsonl");
export const DIGEST_PATH = join(LOGS_DIR, "insight-digest.md");
export const STATE_PATH = join(LOGS_DIR, "state.json");
export const PAYLOAD_DUMP_PATH = join(
  LOGS_DIR,
  "insight-llm-payload.last.json",
);

export const STAMP_PATH = join(HOME, ".claude", ".last-distill-insights");
export const STAMP_LLM_PATH = join(
  HOME,
  ".claude",
  ".last-distill-insights-llm",
);
export const ACK_PATH = join(HOME, ".claude", ".last-insight-digest-acked");
export const DENY_LIST_PATH = join(HOME, ".claude", "insight-distill-deny.txt");
export const REDACT_LIST_PATH = join(
  HOME,
  ".claude",
  "insight-distill-redact.txt",
);

const STAR = String.fromCharCode(0x2605);
const HBAR = String.fromCharCode(0x2500);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
const IDEO_SP = String.fromCharCode(0x3000);

export const INSIGHT_DELIMITER_PATTERN = new RegExp(
  `${STAR} Insight ${HBAR}+\\s*([\\s\\S]+?)${HBAR}{5,}`,
  "g",
);

export const DEFAULT_REDACT_PATTERNS: RegExp[] = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[\w-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]*)?PRIVATE KEY-----/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /^[A-Z][A-Z0-9_]{2,}=\S+$/gm,
];

export interface DenyList {
  paths: string[];
  texts: RegExp[];
}

export interface DistillState {
  total: number;
  since_last_ack: number;
  last_run_at?: string;
  last_redact_hits?: number;
}

export interface InsightRecord {
  hash: string;
  session_id_hash: string;
  project: string;
  cwd: string;
  timestamp: string;
  text: string;
}

export function readAckMs(): number {
  try {
    const raw = readFileSync(ACK_PATH, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeAckMs(ms: number = Date.now()): void {
  ensureDir(LOGS_DIR);
  writeFileSync(ACK_PATH, String(Math.floor(ms)), { mode: 0o600 });
}

export function getUnreadDigestNotice(): string | null {
  try {
    if (!existsSync(DIGEST_PATH)) return null;
    const digestMtime = statSync(DIGEST_PATH).mtimeMs;
    if (digestMtime <= readAckMs()) return null;
    return `New Insight digest: ${DIGEST_PATH} (run /insight-digest ack to mark read)`;
  } catch {
    return null;
  }
}

export function sanitize(
  text: string,
  extraPatterns: RegExp[] = [],
): { text: string; hits: number } {
  let hits = 0;
  let result = text;
  const all = [...DEFAULT_REDACT_PATTERNS, ...extraPatterns];
  for (const pattern of all) {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    result = result.replace(re, () => {
      hits += 1;
      return "[REDACTED]";
    });
  }
  return { text: result, hits };
}

export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split(LS)
    .join("\n")
    .split(PS)
    .join("\n")
    .split(NBSP)
    .join(" ")
    .split(IDEO_SP)
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .toLowerCase();
}

export function hashInsight(normalized: string): string {
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function hashSessionId(sessionId: string): string {
  return createHash("sha1").update(sessionId).digest("hex").slice(0, 12);
}

export function extractInsights(assistantText: string): string[] {
  const out: string[] = [];
  const re = new RegExp(INSIGHT_DELIMITER_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  m = re.exec(assistantText);
  while (m !== null) {
    const captured = m[1];
    if (captured !== undefined) {
      const body = captured.trim();
      if (body.length > 0) out.push(body);
    }
    m = re.exec(assistantText);
  }
  return out;
}

export function loadDenyList(path: string = DENY_LIST_PATH): DenyList {
  const result: DenyList = { paths: [], texts: [] };
  if (!existsSync(path)) return result;
  const raw = readFileSync(path, "utf8");
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("path:")) {
      const value = line.slice("path:".length).trim();
      if (value.length > 0) result.paths.push(value);
    } else if (line.startsWith("text:")) {
      const value = line.slice("text:".length).trim();
      if (value.length > 0) {
        try {
          result.texts.push(new RegExp(value));
        } catch {
          // skip invalid regex silently
        }
      }
    }
  }
  return result;
}

export function loadRedactList(path: string = REDACT_LIST_PATH): RegExp[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: RegExp[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    try {
      out.push(new RegExp(line, "g"));
    } catch {
      // skip
    }
  }
  return out;
}

export function readState(path: string = STATE_PATH): DistillState {
  if (!existsSync(path)) {
    return { total: 0, since_last_ack: 0 };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const obj = JSON.parse(raw);
    return {
      total: Number(obj.total) || 0,
      since_last_ack: Number(obj.since_last_ack) || 0,
      last_run_at:
        typeof obj.last_run_at === "string" ? obj.last_run_at : undefined,
      last_redact_hits:
        typeof obj.last_redact_hits === "number"
          ? obj.last_redact_hits
          : undefined,
    };
  } catch {
    return { total: 0, since_last_ack: 0 };
  }
}

export function writeState(
  state: DistillState,
  path: string = STATE_PATH,
): void {
  writeFileSyncAtomic(path, JSON.stringify(state, null, 2), 0o600);
}

export function appendInsightRecord(
  record: InsightRecord,
  path: string = INSIGHTS_JSONL,
): void {
  ensureDir(LOGS_DIR);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function loadExistingHashes(path: string = INSIGHTS_JSONL): Set<string> {
  const seen = new Set<string>();
  if (!existsSync(path)) return seen;
  const raw = readFileSync(path, "utf8");
  for (const rawLine of raw.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    try {
      const obj = JSON.parse(rawLine);
      if (typeof obj.hash === "string") seen.add(obj.hash);
    } catch {
      // skip malformed
    }
  }
  return seen;
}

export function writeFileSyncAtomic(
  path: string,
  content: string,
  mode: number = 0o644,
): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function readStampMs(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function writeStampAt(path: string, ms: number): void {
  ensureDir(dirname(path));
  writeFileSync(path, String(Math.floor(ms)), { mode: 0o600 });
}
