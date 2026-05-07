#!/usr/bin/env -S bun run --silent

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  appendInsightRecord,
  buildLlmPayload,
  DIGEST_PATH,
  ensureDir,
  evaluateStageBGate,
  extractInsights,
  formatProposalsAsMarkdown,
  hashInsight,
  hashSessionId,
  INSIGHTS_JSONL,
  loadDenyList,
  loadExistingHashes,
  loadRedactList,
  LOGS_DIR,
  normalize,
  parseProposalYaml,
  PAYLOAD_DUMP_PATH,
  PROJECTS_DIR,
  readAckMs,
  readState,
  readStampMs,
  replaceDigestDistillationSection,
  sanitize,
  selectStageBInputs,
  shouldUpdateStamp,
  STAGE_B_SAFETY_MARGIN_MS,
  STAGE_B_SYSTEM_PROMPT,
  STAMP_LLM_PATH,
  STAMP_PATH,
  writeFileSyncAtomic,
  writePayloadDump,
  writeStampAt,
  writeState,
  type DenyList,
  type DistillState,
  type InsightRecord,
  type LlmPayload,
  type StageBOutcome,
  type StageBQueryFn,
} from "../hooks/lib/insight-digest.ts";

function resolveClaudeExecutable(): string | undefined {
  try {
    return execSync("which claude", { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const STAGE_B_DEFAULT_MODEL = "haiku";
const STAGE_B_DISALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TaskCreate",
  "TaskUpdate",
];

interface ClusterRow {
  count: number;
  distinct_sessions: number;
  last_seen: string;
  hash: string;
  preview: string;
  redacted: boolean;
}

function parseArgs(argv: string[]): { force: boolean; llm: boolean } {
  const force = argv.includes("--force");
  const llm = argv.includes("--llm");
  return { force, llm };
}

function listJsonlFiles(deny: DenyList, since: number): string[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, entry.name);
    if (matchesAnyGlob(dir, deny.paths)) continue;
    walkJsonl(dir, deny, since, out);
  }
  return out;
}

function walkJsonl(
  dir: string,
  deny: DenyList,
  since: number,
  out: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (matchesAnyGlob(path, deny.paths)) continue;
    if (entry.isDirectory()) {
      walkJsonl(path, deny, since, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    try {
      if (statSync(path).mtimeMs < since) continue;
    } catch {
      continue;
    }
    out.push(path);
  }
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  for (const g of globs) {
    if (matchesGlob(path, g)) return true;
  }
  return false;
}

function matchesGlob(path: string, glob: string): boolean {
  const re = globToRegExp(glob);
  return re.test(path);
}

function globToRegExp(glob: string): RegExp {
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        src += ".*";
        i++;
      } else {
        src += "[^/]*";
      }
    } else if (ch === "?") {
      src += ".";
    } else if (ch && /[.+^${}()|[\]\\]/.test(ch)) {
      src += `\\${ch}`;
    } else if (ch !== undefined) {
      src += ch;
    }
  }
  return new RegExp(`^${src}$`);
}

interface AssistantText {
  sessionId: string;
  cwd: string;
  project: string;
  timestamp: string;
  text: string;
}

function* readAssistantBlocks(
  jsonlPath: string,
): Generator<AssistantText, void, undefined> {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message as { content?: unknown } | undefined;
    if (!message) continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const buf: string[] = [];
    for (const part of parts) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text"
      ) {
        const txt = (part as { text?: unknown }).text;
        if (typeof txt === "string") buf.push(txt);
      }
    }
    if (buf.length === 0) continue;
    yield {
      sessionId: typeof obj.sessionId === "string" ? obj.sessionId : "",
      cwd: typeof obj.cwd === "string" ? obj.cwd : "",
      project: basename(jsonlPath).replace(/\.jsonl$/, ""),
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
      text: buf.join("\n"),
    };
  }
}

function deriveProjectFromPath(jsonlPath: string): string {
  const dir = jsonlPath.split("/").slice(-2, -1)[0] ?? "unknown";
  return dir;
}

async function main(): Promise<void> {
  const { force, llm } = parseArgs(process.argv.slice(2));
  ensureDir(LOGS_DIR);

  const tStart = Date.now();
  const since = force ? 0 : readStampMs(STAMP_PATH);
  const deny = loadDenyList();
  const extraRedact = loadRedactList();
  const existingHashes = loadExistingHashes();

  const previousState = readState();
  const previousAck = readAckMs();

  let scanned = 0;
  let matched = 0;
  let appended = 0;
  let totalRedactHits = 0;

  const seenInRun = new Set<string>();

  const files = listJsonlFiles(deny, since);
  for (const file of files) {
    scanned++;
    for (const block of readAssistantBlocks(file)) {
      const insights = extractInsights(block.text);
      if (insights.length === 0) continue;
      for (const raw of insights) {
        if (skipByDenyText(raw, deny)) continue;
        const sanitizeResult = sanitize(raw, extraRedact);
        totalRedactHits += sanitizeResult.hits;
        const cleaned = sanitizeResult.text;
        const norm = normalize(cleaned);
        const hash = hashInsight(norm);
        if (existingHashes.has(hash) || seenInRun.has(hash)) continue;
        seenInRun.add(hash);
        matched++;
        const project = block.cwd ? block.cwd : deriveProjectFromPath(file);
        const record: InsightRecord = {
          hash,
          session_id_hash: hashSessionId(block.sessionId || file),
          project,
          cwd: block.cwd,
          timestamp: block.timestamp,
          text: cleaned,
        };
        appendInsightRecord(record);
        appended++;
      }
    }
  }

  const state: DistillState = {
    total: previousState.total + appended,
    since_last_ack:
      readAckMs() > previousAck
        ? appended
        : previousState.since_last_ack + appended,
    last_run_at: new Date(tStart).toISOString(),
    last_redact_hits: totalRedactHits,
  };
  writeState(state);

  const clusters = buildHeuristicClusters();
  writeDigest(clusters, state, totalRedactHits);

  const safeStamp = tStart - 60_000;
  writeStampAt(STAMP_PATH, safeStamp);

  console.error(
    `[distill-insights] scanned=${scanned} matched=${matched} appended=${appended} redact_hits=${totalRedactHits} digest=${DIGEST_PATH}`,
  );

  if (llm) {
    await runStageB({ force, state, tStart });
  }
}

export interface StageBPaths {
  jsonl: string;
  stamp: string;
  digest: string;
  payloadDump: string;
}

interface RunStageBOpts {
  force: boolean;
  state: DistillState;
  tStart: number;
  queryFn?: StageBQueryFn;
  model?: string;
  paths?: Partial<StageBPaths>;
  redactPatterns?: RegExp[];
  maxInputChars?: number;
}

function resolvePaths(paths?: Partial<StageBPaths>): StageBPaths {
  return {
    jsonl: paths?.jsonl ?? INSIGHTS_JSONL,
    stamp: paths?.stamp ?? STAMP_LLM_PATH,
    digest: paths?.digest ?? DIGEST_PATH,
    payloadDump: paths?.payloadDump ?? PAYLOAD_DUMP_PATH,
  };
}

export async function runStageB(opts: RunStageBOpts): Promise<StageBOutcome> {
  const { force, state, tStart } = opts;
  const queryFn = opts.queryFn ?? (query as unknown as StageBQueryFn);
  const model = opts.model ?? STAGE_B_DEFAULT_MODEL;
  const paths = resolvePaths(opts.paths);
  const redactPatterns = opts.redactPatterns ?? loadRedactList();

  const gate = force
    ? ({ ok: true } as const)
    : evaluateStageBGate(state, paths.stamp);
  if (!gate.ok) {
    const outcome: StageBOutcome = { kind: "skipped", reason: gate.reason };
    applyStageBOutcome(outcome, tStart, paths);
    return outcome;
  }

  const set = selectStageBInputs({
    force,
    sinceLastAck: state.since_last_ack,
    redactPatterns,
    ...(opts.maxInputChars !== undefined
      ? { maxInputChars: opts.maxInputChars }
      : {}),
    jsonlPath: paths.jsonl,
  });
  const payload = buildLlmPayload(set, { model });
  writePayloadDump(payload, paths.payloadDump);

  if (set.inputs.length === 0) {
    const outcome: StageBOutcome = {
      kind: "ok",
      proposals: [],
      truncated: set.truncated,
      inputsCount: 0,
      rawProposalCount: 0,
    };
    applyStageBOutcome(outcome, tStart, paths);
    return outcome;
  }

  const result = await runLlmDistillation({ payload, queryFn });
  if (!result.ok) {
    const outcome: StageBOutcome = {
      kind: "llm_error",
      detail: result.reason,
    };
    applyStageBOutcome(outcome, tStart, paths);
    return outcome;
  }

  const parsed = parseProposalYaml(result.raw);
  if (!parsed.ok) {
    const outcome: StageBOutcome = {
      kind: "parse_error",
      reason: parsed.reason,
    };
    applyStageBOutcome(outcome, tStart, paths);
    return outcome;
  }

  const outcome: StageBOutcome = {
    kind: "ok",
    proposals: parsed.proposals,
    truncated: set.truncated,
    inputsCount: set.inputs.length,
    rawProposalCount: parsed.rawCount,
  };
  applyStageBOutcome(outcome, tStart, paths);
  return outcome;
}

function applyStageBOutcome(
  outcome: StageBOutcome,
  tStart: number,
  paths: StageBPaths,
): void {
  let digestText = "";
  try {
    digestText = readFileSync(paths.digest, "utf8");
  } catch {
    digestText = "";
  }
  const newBody = formatProposalsAsMarkdown(outcome);
  const updated = replaceDigestDistillationSection(digestText, newBody);
  writeFileSyncAtomic(paths.digest, updated, 0o600);
  if (shouldUpdateStamp(outcome)) {
    writeStampAt(paths.stamp, tStart - STAGE_B_SAFETY_MARGIN_MS);
  }
  console.error(`[distill-insights] stage_b outcome=${outcome.kind}`);
}

export async function runLlmDistillation(opts: {
  payload: LlmPayload;
  queryFn: StageBQueryFn;
}): Promise<{ ok: true; raw: string } | { ok: false; reason: string }> {
  const { payload, queryFn } = opts;
  try {
    const claudePath = resolveClaudeExecutable();
    const conversation = queryFn({
      prompt: payload.user_prompt,
      options: {
        model: payload.model,
        maxTurns: 10,
        systemPrompt: STAGE_B_SYSTEM_PROMPT,
        allowedTools: [],
        disallowedTools: STAGE_B_DISALLOWED_TOOLS,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        ...(claudePath !== undefined
          ? { pathToClaudeCodeExecutable: claudePath }
          : {}),
      },
    });
    let raw = "";
    for await (const message of conversation) {
      if (
        message.type === "result" &&
        message.subtype === "success" &&
        typeof message.result === "string" &&
        !message.is_error
      ) {
        raw = message.result;
      }
    }
    if (raw.length === 0) {
      return { ok: false, reason: "empty_response" };
    }
    return { ok: true, raw };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: detail };
  }
}

function makePreview(text: string): string {
  const candidates = text
    .split("\n")
    .map((line) => line.replace(/^[\s`*\-_>#]+/, "").trim())
    .filter((line) => line.length >= 8);
  const head = candidates[0] ?? text.replace(/\s+/g, " ").trim();
  return head.slice(0, 140);
}

function skipByDenyText(raw: string, deny: DenyList): boolean {
  for (const re of deny.texts) {
    if (re.test(raw)) return true;
  }
  return false;
}

function buildHeuristicClusters(): ClusterRow[] {
  if (!existsSync(INSIGHTS_JSONL)) return [];
  const grouped = new Map<
    string,
    {
      count: number;
      sessions: Set<string>;
      lastSeen: string;
      preview: string;
      redacted: boolean;
    }
  >();
  const raw = readFileSync(INSIGHTS_JSONL, "utf8");
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let obj: InsightRecord;
    try {
      obj = JSON.parse(line) as InsightRecord;
    } catch {
      continue;
    }
    const existing = grouped.get(obj.hash);
    const preview = makePreview(obj.text);
    const redacted = obj.text.includes("[REDACTED]");
    if (existing) {
      existing.count += 1;
      existing.sessions.add(obj.session_id_hash);
      if (obj.timestamp > existing.lastSeen) existing.lastSeen = obj.timestamp;
      existing.redacted = existing.redacted || redacted;
    } else {
      grouped.set(obj.hash, {
        count: 1,
        sessions: new Set<string>([obj.session_id_hash]),
        lastSeen: obj.timestamp,
        preview,
        redacted,
      });
    }
  }
  const rows: ClusterRow[] = [];
  for (const [hash, info] of grouped.entries()) {
    rows.push({
      hash,
      count: info.count,
      distinct_sessions: info.sessions.size,
      last_seen: info.lastSeen,
      preview: info.preview,
      redacted: info.redacted,
    });
  }
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.last_seen.localeCompare(a.last_seen);
  });
  return rows;
}

function writeDigest(
  clusters: ClusterRow[],
  state: DistillState,
  redactHits: number,
): void {
  const generated = new Date().toISOString();
  const lines: string[] = [];
  lines.push("# Insight Digest");
  lines.push("");
  lines.push(`- Generated: ${generated}`);
  lines.push(`- Total cumulative insights: ${state.total}`);
  lines.push(`- Since last ack: ${state.since_last_ack}`);
  lines.push(`- Last sanitizer hits in this run: ${redactHits}`);
  lines.push("");
  lines.push("## Top Recurring Topics (heuristic)");
  lines.push("");
  if (clusters.length === 0) {
    lines.push("_No insight blocks found yet._");
  } else {
    lines.push("| count | sessions | last_seen | preview |");
    lines.push("|-------|----------|-----------|---------|");
    const top = clusters.slice(0, 30);
    for (const row of top) {
      const preview = row.redacted ? `[redacted] ${row.preview}` : row.preview;
      const safePreview = preview.replace(/\|/g, "\\|").replace(/\n/g, " ");
      lines.push(
        `| ${row.count} | ${row.distinct_sessions} | ${row.last_seen.slice(0, 10)} | ${safePreview} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Distillation (LLM)");
  lines.push("");
  lines.push(
    "<!-- llm: not yet enabled. Stage B will populate this section. -->",
  );
  lines.push("");
  writeFileSyncAtomic(DIGEST_PATH, lines.join("\n"), 0o600);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`[distill-insights] fatal: ${error}`);
    process.exit(1);
  });
}
