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

export const DIGEST_PREVIEW_MAX_LINES = 14;

export function getUnreadDigestPreview(
  maxLines: number = DIGEST_PREVIEW_MAX_LINES,
): string | null {
  try {
    if (!existsSync(DIGEST_PATH)) return null;
    const digestMtime = statSync(DIGEST_PATH).mtimeMs;
    if (digestMtime <= readAckMs()) return null;
    const raw = readFileSync(DIGEST_PATH, "utf8");
    const preview = raw
      .split("\n")
      .slice(0, maxLines)
      .join("\n")
      .replace(/\n+$/, "");
    return `New Insight digest (${DIGEST_PATH}):\n${preview}\n\n_Run /insight-digest for full view, /insight-digest ack to mark read._`;
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

// =============================================================================
// Stage B (LLM Distillation) — types and pure helpers
// =============================================================================

export const MAX_INPUT_CHARS = 200_000;
export const LLM_GATE_DAYS = 7;
export const LLM_GATE_COUNT = 10;
export const YAML_BODY_CAP = 256_000;
export const STAGE_B_SAFETY_MARGIN_MS = 60_000;

export const PROPOSAL_TYPES = [
  "skill",
  "claude_md",
  "rule",
  "discard",
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export interface LlmEvidence {
  session_id_hash: string;
  excerpt: string;
}

export interface LlmProposal {
  cluster_id: number;
  theme: string;
  proposal_type: ProposalType;
  target_path: string | null;
  suggested_title: string;
  suggested_body: string;
  rationale: string;
  evidence: LlmEvidence[];
}

export interface LlmInputItem {
  cluster_id: number;
  hash: string;
  session_id_hash: string;
  project: string;
  timestamp: string;
  text: string;
}

export interface LlmPayload {
  generated_at: string;
  model: string;
  truncated: boolean;
  total_candidates: number;
  inputs_count: number;
  truncated_hashes: string[];
  extra_redact_hits: number;
  system_prompt: string;
  user_prompt: string;
  inputs: LlmInputItem[];
}

export interface StageBInputSet {
  inputs: LlmInputItem[];
  truncated: boolean;
  truncatedHashes: string[];
  extraHits: number;
  totalCandidates: number;
}

export type StageBGateResult =
  | { ok: true }
  | { ok: false; reason: "gate_count" | "gate_age" | "gate_both" };

export type StageBOutcome =
  | { kind: "skipped"; reason: "gate_count" | "gate_age" | "gate_both" }
  | { kind: "llm_error"; detail: string }
  | {
      kind: "parse_error";
      reason: "no_fence" | "yaml_error" | "schema_error" | "size_cap";
    }
  | {
      kind: "ok";
      proposals: LlmProposal[];
      truncated: boolean;
      inputsCount: number;
      rawProposalCount: number;
    };

export interface StageBQueryMessage {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
}

export type StageBQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<StageBQueryMessage>;

export const STAGE_B_SYSTEM_PROMPT = `You are an insight curator. The user is a single developer running Claude Code.
Each input below is a self-contained insight from past sessions. Group similar insights
into clusters (theme), then for each cluster decide whether it should become:
- "skill"      : repeatable how-to that Claude can execute on user request
- "claude_md"  : project-/global-level project context
- "rule"       : cross-cutting development rule (~/.claude/rules/*.md)
- "discard"    : one-off observation with no reuse value

Output a JSON array wrapped in ~~~ fences (NOT triple backticks). The fenced block
MUST be the only content. Keep all text in the language(s) of the inputs. Do not
invent insights not present in the inputs. Each evidence excerpt MUST be copied
verbatim (you may shorten with "..." but never paraphrase). Escape newlines in
strings with \\n.

Schema (strict, every field required, JSON):
[
  {
    "cluster_id": 1,
    "theme": "string",
    "proposal_type": "skill" | "claude_md" | "rule" | "discard",
    "target_path": "string or null",
    "suggested_title": "string",
    "suggested_body": "string with \\n for newlines",
    "rationale": "string",
    "evidence": [
      { "session_id_hash": "string", "excerpt": "string" }
    ]
  }
]

Discard clusters with fewer than 2 evidence items unless they clearly demand a skill or rule.`;

export function buildUserPrompt(inputs: LlmInputItem[]): string {
  const lines: string[] = [];
  lines.push(
    `Cluster the following ${inputs.length} insights and return YAML proposals as instructed.`,
  );
  lines.push(
    "For each evidence entry, set session_id_hash to the [#xxx] tag prefixing the insight body.",
  );
  lines.push("");
  for (const item of inputs) {
    lines.push(`[#${item.session_id_hash}] ${item.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function evaluateStageBGate(
  state: DistillState,
  stampPath: string,
  now: number = Date.now(),
  thresholdDays: number = LLM_GATE_DAYS,
  thresholdCount: number = LLM_GATE_COUNT,
): StageBGateResult {
  const countOk = state.since_last_ack >= thresholdCount;
  const stampMs = readStampMs(stampPath);
  const ageOk = stampMs === 0 || now - stampMs >= thresholdDays * 86_400_000;
  if (countOk && ageOk) return { ok: true };
  if (!countOk && !ageOk) return { ok: false, reason: "gate_both" };
  return { ok: false, reason: countOk ? "gate_age" : "gate_count" };
}

export function selectStageBInputs(opts: {
  force: boolean;
  sinceLastAck: number;
  redactPatterns?: RegExp[];
  maxInputChars?: number;
  jsonlPath?: string;
}): StageBInputSet {
  const {
    force,
    sinceLastAck,
    redactPatterns = [],
    maxInputChars = MAX_INPUT_CHARS,
    jsonlPath = INSIGHTS_JSONL,
  } = opts;
  if (!existsSync(jsonlPath)) {
    return {
      inputs: [],
      truncated: false,
      truncatedHashes: [],
      extraHits: 0,
      totalCandidates: 0,
    };
  }
  const raw = readFileSync(jsonlPath, "utf8");
  const records: InsightRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as InsightRecord);
    } catch {
      // skip malformed
    }
  }
  const slice = force
    ? records.slice()
    : records.slice(Math.max(0, records.length - sinceLastAck));
  slice.sort((a, b) => {
    const ta = parseTimestamp(a.timestamp);
    const tb = parseTimestamp(b.timestamp);
    return tb - ta;
  });
  let extraHits = 0;
  let cumulative = 0;
  const inputs: LlmInputItem[] = [];
  const truncatedHashes: string[] = [];
  for (const record of slice) {
    const sanitized = sanitize(record.text, redactPatterns);
    extraHits += sanitized.hits;
    if (cumulative + sanitized.text.length > maxInputChars) {
      truncatedHashes.push(record.hash);
      continue;
    }
    cumulative += sanitized.text.length;
    inputs.push({
      cluster_id: inputs.length + 1,
      hash: record.hash,
      session_id_hash: record.session_id_hash,
      project: record.project,
      timestamp: record.timestamp,
      text: sanitized.text,
    });
  }
  return {
    inputs,
    truncated: truncatedHashes.length > 0,
    truncatedHashes,
    extraHits,
    totalCandidates: slice.length,
  };
}

function parseTimestamp(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? -Infinity : n;
}

export function buildLlmPayload(
  set: StageBInputSet,
  opts: { model: string },
): LlmPayload {
  return {
    generated_at: new Date().toISOString(),
    model: opts.model,
    truncated: set.truncated,
    total_candidates: set.totalCandidates,
    inputs_count: set.inputs.length,
    truncated_hashes: set.truncatedHashes,
    extra_redact_hits: set.extraHits,
    system_prompt: STAGE_B_SYSTEM_PROMPT,
    user_prompt: buildUserPrompt(set.inputs),
    inputs: set.inputs,
  };
}

export function writePayloadDump(
  payload: LlmPayload,
  path: string = PAYLOAD_DUMP_PATH,
): void {
  writeFileSyncAtomic(path, JSON.stringify(payload, null, 2), 0o600);
}

const FENCE_PATTERN = /~~~(?:json|yaml)?\s*\n([\s\S]*?)\n?~~~/;

export type ProposalParseResult =
  | { ok: true; proposals: LlmProposal[]; rawCount: number }
  | {
      ok: false;
      reason: "no_fence" | "yaml_error" | "schema_error" | "size_cap";
    };

export function parseProposalYaml(raw: string): ProposalParseResult {
  if (raw.length > YAML_BODY_CAP) {
    return { ok: false, reason: "size_cap" };
  }
  const match = FENCE_PATTERN.exec(raw);
  const body = match && match[1] !== undefined ? match[1] : raw;
  if (body.length > YAML_BODY_CAP) {
    return { ok: false, reason: "size_cap" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "yaml_error" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "schema_error" };
  }
  const rawCount = parsed.length;
  const proposals: LlmProposal[] = [];
  for (const item of parsed) {
    const validated = validateProposal(item);
    if (validated !== null) proposals.push(validated);
  }
  return { ok: true, proposals, rawCount };
}

function validateProposal(item: unknown): LlmProposal | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const cluster_id = obj.cluster_id;
  const theme = obj.theme;
  const proposal_type = obj.proposal_type;
  if (typeof cluster_id !== "number" || !Number.isFinite(cluster_id)) {
    return null;
  }
  if (typeof theme !== "string" || theme.length === 0) return null;
  if (
    typeof proposal_type !== "string" ||
    !PROPOSAL_TYPES.includes(proposal_type as ProposalType)
  ) {
    return null;
  }
  const target_path =
    typeof obj.target_path === "string" ? obj.target_path : null;
  const suggested_title =
    typeof obj.suggested_title === "string" ? obj.suggested_title : "";
  const suggested_body =
    typeof obj.suggested_body === "string" ? obj.suggested_body : "";
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence.flatMap((ev) => {
        if (!ev || typeof ev !== "object") return [];
        const eobj = ev as Record<string, unknown>;
        const sid =
          typeof eobj.session_id_hash === "string" ? eobj.session_id_hash : "";
        const excerpt = typeof eobj.excerpt === "string" ? eobj.excerpt : "";
        if (sid.length === 0 && excerpt.length === 0) return [];
        return [{ session_id_hash: sid, excerpt }];
      })
    : [];
  return {
    cluster_id,
    theme,
    proposal_type: proposal_type as ProposalType,
    target_path,
    suggested_title,
    suggested_body,
    rationale,
    evidence,
  };
}

export function shouldUpdateStamp(outcome: StageBOutcome): boolean {
  return outcome.kind === "ok";
}

export function formatTrailingComment(
  outcome: StageBOutcome,
  now: Date = new Date(),
): string {
  const at = now.toISOString();
  switch (outcome.kind) {
    case "skipped":
      return `<!-- llm: skipped reason=${outcome.reason} at=${at} -->`;
    case "llm_error":
      return `<!-- llm: skipped reason=llm_error detail=${escapeComment(outcome.detail)} at=${at} -->`;
    case "parse_error":
      return `<!-- llm: skipped reason=parse_error detail=${outcome.reason} at=${at} -->`;
    case "ok":
      return `<!-- llm: ok proposals=${outcome.proposals.length} raw=${outcome.rawProposalCount} truncated=${outcome.truncated} inputs=${outcome.inputsCount} at=${at} -->`;
  }
}

function escapeComment(value: string): string {
  return value.replace(/-->/g, "--&gt;").replace(/\s+/g, " ").slice(0, 120);
}

export function formatProposalsAsMarkdown(outcome: StageBOutcome): string {
  const lines: string[] = [];
  lines.push("## Distillation (LLM)");
  lines.push("");
  if (outcome.kind === "ok" && outcome.proposals.length > 0) {
    lines.push("| cluster | type | title | rationale |");
    lines.push("|---------|------|-------|-----------|");
    for (const p of outcome.proposals) {
      const title = singleLine(p.suggested_title) || "(untitled)";
      const rationale = singleLine(p.rationale);
      lines.push(
        `| ${p.cluster_id} | ${p.proposal_type} | ${title} | ${rationale} |`,
      );
    }
    lines.push("");
    for (const p of outcome.proposals) {
      lines.push(`### Cluster ${p.cluster_id}: ${singleLine(p.theme)}`);
      lines.push("");
      lines.push(`- **proposal_type**: ${p.proposal_type}`);
      lines.push(
        `- **target_path**: ${p.target_path ? `\`${p.target_path}\`` : "_(none)_"}`,
      );
      if (p.suggested_title.length > 0) {
        lines.push(`- **suggested_title**: ${singleLine(p.suggested_title)}`);
      }
      if (p.suggested_body.length > 0) {
        lines.push("- **suggested_body**:");
        lines.push("");
        lines.push("  ```");
        for (const ln of p.suggested_body.split("\n")) {
          lines.push(`  ${ln}`);
        }
        lines.push("  ```");
      }
      if (p.rationale.length > 0) {
        lines.push(`- **rationale**: ${singleLine(p.rationale)}`);
      }
      if (p.evidence.length > 0) {
        lines.push("- **evidence**:");
        for (const ev of p.evidence) {
          lines.push(
            `  - \`[#${ev.session_id_hash}]\` ${singleLine(ev.excerpt)}`,
          );
        }
      }
      lines.push("");
    }
  } else if (outcome.kind === "ok") {
    lines.push(
      "_LLM responded but produced no actionable proposals on this run._",
    );
    lines.push("");
  } else {
    lines.push(
      "_LLM distillation skipped on this run. Stage A heuristics above remain valid._",
    );
    lines.push("");
  }
  lines.push(formatTrailingComment(outcome));
  lines.push("");
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

const DISTILLATION_HEADER = "## Distillation (LLM)";

export function replaceDigestDistillationSection(
  digestText: string,
  newBody: string,
): string {
  const idx = digestText.indexOf(DISTILLATION_HEADER);
  if (idx < 0) {
    return `${digestText.replace(/\s*$/, "")}\n\n${newBody.replace(/\s*$/, "")}\n`;
  }
  const before = digestText.slice(0, idx).replace(/\s*$/, "");
  const afterIdx = findNextHeaderAfter(digestText, idx);
  const after = afterIdx < 0 ? "" : digestText.slice(afterIdx);
  const trailing = after.length > 0 ? `\n\n${after.replace(/^\s+/, "")}` : "\n";
  return `${before}\n\n${newBody.replace(/\s*$/, "")}\n${trailing}`;
}

function findNextHeaderAfter(text: string, start: number): number {
  const re = /^#{1,2} /gm;
  re.lastIndex = start + DISTILLATION_HEADER.length;
  const match = re.exec(text);
  return match ? match.index : -1;
}
