import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { logEvent } from "./centralized-logging.ts";
import { getHomeDir } from "./path-utils.ts";
import { isSafeSessionId } from "./session-id.ts";
import { createMarker, readMarker } from "./session-marker.ts";
import {
  FRONTMATTER_READ_BYTES,
  MAX_BEFORE,
  MAX_PATTERN_LENGTH,
  loadedSkillRecordOfLine,
  matchesBash,
  parseBeforePattern,
  readFrontmatterList,
  scanTranscriptLines,
  type ScanOptions,
} from "./skill-requires.ts";

export const SKILL_GUIDE_SKILLS = [
  "commit-standards",
  "git-safety",
  "model-offloading",
] as const;
export const SKILL_GUIDE_SCAN_DEADLINE_MS = 800;
export const SKILL_GUIDE_MARKER_TTL_MS = 24 * 60 * 60 * 1000;
export const SKILL_GUIDE_LOG_MAX_BYTES = 1024 * 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SINGLE_WORD_ALLOWLIST = new Set(["git-worktree-create"]);
const GUIDE_KIND_SUFFIX = {
  gate: "_1",
  missing: "_m",
  after: "_a",
  ignored: "_i",
  read: "_r",
} as const;

export interface SkillGuidePattern {
  raw: string;
  words: string[];
}

export interface SkillGuideDeclaration {
  skill: (typeof SKILL_GUIDE_SKILLS)[number];
  before: SkillGuidePattern[];
}

export type GuideMarkerKind = keyof typeof GUIDE_KIND_SUFFIX;
export type GuideDecisionKind = "deny" | "ignored" | "missing" | "passed-read";

export interface SkillGuideDecisionRow {
  at: string;
  key: string;
  session: string;
  agent: "main" | "sub";
  words: string[];
  skill: string[];
  kind: GuideDecisionKind;
}

export interface SkillGuideDecisionInput {
  sessionId: string;
  agentId?: string;
  words: string[];
  skills: string[];
  kind: GuideDecisionKind;
}

export interface DecisionLogFileOps {
  statSync: typeof statSync;
  linkSync: typeof linkSync;
  unlinkSync: typeof unlinkSync;
}

export interface DecisionLogOptions {
  now?: () => Date;
  fileOps?: Partial<DecisionLogFileOps>;
}

export interface SkillReadScanResult {
  loaded: Set<string>;
  bytesRead: number;
  timedOut: boolean;
  complete: boolean;
  readable: boolean;
}

export type SkillReadStatus =
  | { status: "read" }
  | { status: "unread" }
  | { status: "undetermined"; kind: "timeout" | "no-transcript" };

export interface GuideMarkerKey {
  stateDir: string;
  sessionId: string;
  agentId?: string;
  target: string;
}

export type GuideGateSlot =
  | { status: "created"; attempt: 1 | 2; name: string }
  | { status: "exhausted" }
  | { status: "failed" };

export interface SkillGuideDeps {
  skillsRoot: string;
  stateDir: string;
  now?: () => Date;
  scan?: Partial<ScanOptions>;
}

export interface SkillGuideRequest {
  sessionId?: string;
  agentId?: string;
  transcriptPath?: string;
  commands: string[];
}

export interface SkillGuideGateResult {
  status: "not-applicable" | "allow" | "deny" | "undetermined";
  denied: { skill: string; words: string[] }[];
}

export type SkillGuideEvent =
  | "marker-failed"
  | "unsafe-session"
  | "timeout"
  | "no-transcript";

function emitError(message: string): void {
  try {
    logEvent("Error", undefined, `[skill-guide] ${message}`);
  } catch {
    // Logging must not change the hook's pass-through behavior.
  }
}

export function logSkillGuideEvent(event: SkillGuideEvent): void {
  emitError(event);
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

function parseGuidePattern(raw: string): SkillGuidePattern | null {
  if (raw.length > MAX_PATTERN_LENGTH) return null;
  const parsed = parseBeforePattern(raw);
  if (parsed?.kind === "bash") return { raw, words: parsed.words };

  const oneWord = /^Bash\(([^()]*)\)$/.exec(raw);
  if (!oneWord) return null;
  const words = (oneWord[1] ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1 || !SINGLE_WORD_ALLOWLIST.has(words[0] ?? "")) {
    return null;
  }
  return { raw, words };
}

/** Reads valid `read-before` declarations only from the three trusted skills. */
export function readSkillGuides(skillsRoot: string): SkillGuideDeclaration[] {
  let installed: Set<string>;
  try {
    installed = new Set(readdirSync(skillsRoot));
  } catch {
    return [];
  }

  const guides: SkillGuideDeclaration[] = [];
  for (const skill of SKILL_GUIDE_SKILLS) {
    if (!SKILL_NAME_PATTERN.test(skill) || !installed.has(skill)) continue;
    const text = readHead(
      join(skillsRoot, skill, "SKILL.md"),
      FRONTMATTER_READ_BYTES,
    );
    if (text === null) continue;
    const list = readFrontmatterList(text, "read-before");
    if (!list.found || "error" in list) continue;
    if (list.items.length === 0 || list.items.length > MAX_BEFORE) continue;
    const before: SkillGuidePattern[] = [];
    let valid = true;
    for (const raw of list.items) {
      const pattern = parseGuidePattern(raw);
      if (pattern === null) {
        valid = false;
        break;
      }
      before.push(pattern);
    }
    if (valid) guides.push({ skill, before });
  }
  return guides;
}

function canonicalPath(path: string): string | null {
  try {
    const absolute = resolve(path);
    try {
      return realpathSync(absolute);
    } catch {
      try {
        lstatSync(absolute);
        return null;
      } catch (error) {
        const code = errorCode(error);
        return code === "ENOENT" || code === "ENOTDIR" ? absolute : null;
      }
    }
  } catch {
    return null;
  }
}

function assistantReadPaths(line: Buffer): string[] {
  let record: unknown;
  try {
    record = JSON.parse(line.toString("utf8"));
  } catch {
    return [];
  }
  if (typeof record !== "object" || record === null) return [];
  const entry = record as { type?: unknown; message?: unknown };
  if (entry.type !== "assistant") return [];
  if (typeof entry.message !== "object" || entry.message === null) return [];
  const message = entry.message as { role?: unknown; content?: unknown };
  if (message.role !== "assistant" || !Array.isArray(message.content))
    return [];

  const paths: string[] = [];
  for (const item of message.content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as { type?: unknown; name?: unknown; input?: unknown };
    if (block.type !== "tool_use" || block.name !== "Read") continue;
    if (typeof block.input !== "object" || block.input === null) continue;
    const input = block.input as { file_path?: unknown };
    if (typeof input.file_path === "string") paths.push(input.file_path);
  }
  return paths;
}

/** Finds Skill loads and assistant Read calls whose resolved paths name each skill's distributed SKILL.md. */
export function scanSkillReads(
  transcriptPath: string | undefined,
  skillsRoot: string,
  skills: readonly string[],
  options: Partial<ScanOptions> = {},
): SkillReadScanResult {
  const loaded = new Set<string>();
  const targets = new Set(skills);
  const expectedDirs = new Map<string, string>();
  const expectedFiles = new Map<string, string>();
  for (const skill of targets) {
    const dir = canonicalPath(join(skillsRoot, skill));
    const file = canonicalPath(join(skillsRoot, skill, "SKILL.md"));
    if (dir !== null) expectedDirs.set(skill, dir);
    if (file !== null) expectedFiles.set(skill, file);
  }

  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    return {
      loaded,
      bytesRead: 0,
      timedOut: false,
      complete: false,
      readable: false,
    };
  }

  const scan = scanTranscriptLines(
    transcriptPath,
    (line) => {
      const loadedSkill = loadedSkillRecordOfLine(line);
      if (loadedSkill !== null && targets.has(loadedSkill.skill)) {
        const expected = expectedDirs.get(loadedSkill.skill);
        const actual = canonicalPath(loadedSkill.baseDirectory);
        if (expected !== undefined && actual === expected) {
          loaded.add(loadedSkill.skill);
        }
      }
      for (const filePath of assistantReadPaths(line)) {
        const actual = canonicalPath(filePath);
        if (actual === null) continue;
        for (const skill of targets) {
          if (actual === expectedFiles.get(skill)) loaded.add(skill);
        }
      }
    },
    {
      ...options,
      deadlineMs: options.deadlineMs ?? SKILL_GUIDE_SCAN_DEADLINE_MS,
      stopWhen: () =>
        targets.size > 0 && [...targets].every((skill) => loaded.has(skill)),
    },
  );
  return { loaded, ...scan };
}

export function skillReadStatus(
  result: SkillReadScanResult,
  skill: string,
): SkillReadStatus {
  if (result.loaded.has(skill)) return { status: "read" };
  if (!result.readable) {
    return { status: "undetermined", kind: "no-transcript" };
  }
  if (result.timedOut || !result.complete) {
    return { status: "undetermined", kind: "timeout" };
  }
  return { status: "unread" };
}

export function guideMarkerName(
  kind: GuideMarkerKind,
  sessionId: string,
  agentId: string | undefined,
  target: string,
  suffix: string = GUIDE_KIND_SUFFIX[kind],
): string {
  const digest = createHash("sha256")
    .update(`${kind}\0${sessionId}\0${agentId ?? ""}\0${target}`)
    .digest("hex")
    .slice(0, 32);
  return `${digest}${suffix}`;
}

function regularMarkerExists(dir: string, name: string): boolean {
  try {
    return lstatSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

/** Creates one private marker and sweeps markers older than a day. */
export function createGuideMarker(
  key: GuideMarkerKey & {
    kind: GuideMarkerKind;
    suffix?: string;
    content?: string;
    now?: Date;
  },
): boolean {
  if (!isSafeSessionId(key.sessionId)) {
    logSkillGuideEvent("unsafe-session");
    return false;
  }
  const name = guideMarkerName(
    key.kind,
    key.sessionId,
    key.agentId,
    key.target,
    key.suffix,
  );
  const created = createMarker({
    dir: key.stateDir,
    name,
    maxAgeMs: null,
    sweepAfterMs: SKILL_GUIDE_MARKER_TTL_MS,
    ...(key.content !== undefined ? { content: key.content } : {}),
    ...(key.now !== undefined ? { now: key.now } : {}),
  });
  if (!created && !regularMarkerExists(key.stateDir, name)) {
    logSkillGuideEvent("marker-failed");
  }
  return created;
}

/** Gets one of the two deny slots for this session, agent, and skill. */
export function acquireGuideGateSlot(
  key: GuideMarkerKey & { content: string; now?: Date },
): GuideGateSlot {
  if (!isSafeSessionId(key.sessionId)) {
    logSkillGuideEvent("unsafe-session");
    return { status: "failed" };
  }
  const firstName = guideMarkerName(
    "gate",
    key.sessionId,
    key.agentId,
    key.target,
    "_1",
  );
  if (
    createGuideMarker({
      ...key,
      kind: "gate",
      suffix: "_1",
      content: key.content,
    })
  ) {
    return { status: "created", attempt: 1, name: firstName };
  }
  if (!regularMarkerExists(key.stateDir, firstName)) {
    return { status: "failed" };
  }

  const secondName = guideMarkerName(
    "gate",
    key.sessionId,
    key.agentId,
    key.target,
    "_2",
  );
  if (
    createGuideMarker({
      ...key,
      kind: "gate",
      suffix: "_2",
      content: key.content,
    })
  ) {
    return { status: "created", attempt: 2, name: secondName };
  }
  if (!regularMarkerExists(key.stateDir, secondName)) {
    return { status: "failed" };
  }
  return { status: "exhausted" };
}

function hashSession(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

function decisionMarkerKind(kind: GuideDecisionKind): GuideMarkerKind {
  if (kind === "deny") return "gate";
  if (kind === "passed-read") return "read";
  return kind;
}

function decisionMarkerSuffix(kind: GuideDecisionKind): string {
  if (kind === "deny") return "_1";
  if (kind === "passed-read") return "_r";
  return GUIDE_KIND_SUFFIX[kind];
}

function decisionKeyHash(input: SkillGuideDecisionInput): string {
  const markerNames = input.skills
    .map((skill) =>
      guideMarkerName(
        decisionMarkerKind(input.kind),
        input.sessionId,
        input.agentId,
        skill,
        decisionMarkerSuffix(input.kind),
      ),
    )
    .sort();
  return createHash("sha256")
    .update(markerNames.join("\0"))
    .digest("hex")
    .slice(0, 32);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function sameInode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function rotateDecisionLog(
  logPath: string,
  at: Date,
  ops: DecisionLogFileOps,
): void {
  let current;
  try {
    current = ops.statSync(logPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (current.size <= SKILL_GUIDE_LOG_MAX_BYTES) return;

  const timestamp = at.toISOString().replace(/[:.]/g, "-");
  let archivePath = "";
  for (let sequence = 1; ; sequence += 1) {
    const candidate = join(
      dirname(logPath),
      `decisions.${timestamp}-${sequence}.jsonl`,
    );
    try {
      ops.linkSync(logPath, candidate);
      archivePath = candidate;
      break;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }

  let live;
  try {
    live = ops.statSync(logPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  const archived = ops.statSync(archivePath);
  if (!sameInode(live, archived)) return;
  ops.unlinkSync(logPath);
}

/** Appends one privacy-preserving row, rolling an oversized log before the append. */
export function appendGuideDecision(
  stateDir: string,
  input: SkillGuideDecisionInput,
  options: DecisionLogOptions = {},
): boolean {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const at = (options.now ?? (() => new Date()))();
    const row: SkillGuideDecisionRow = {
      at: at.toISOString(),
      key: decisionKeyHash(input),
      session: hashSession(input.sessionId),
      agent: input.agentId ? "sub" : "main",
      words: [...new Set(input.words)],
      skill: [...new Set(input.skills)],
      kind: input.kind,
    };
    const logPath = join(stateDir, "decisions.jsonl");
    const fileOps: DecisionLogFileOps = {
      statSync: options.fileOps?.statSync ?? statSync,
      linkSync: options.fileOps?.linkSync ?? linkSync,
      unlinkSync: options.fileOps?.unlinkSync ?? unlinkSync,
    };
    rotateDecisionLog(logPath, at, fileOps);
    appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return true;
  } catch {
    emitError("decision-log-failed");
    return false;
  }
}

function isDecisionRow(value: unknown): value is SkillGuideDecisionRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const words = row["words"];
  const skills = row["skill"];
  return (
    typeof row["at"] === "string" &&
    typeof row["key"] === "string" &&
    typeof row["session"] === "string" &&
    (row["agent"] === "main" || row["agent"] === "sub") &&
    Array.isArray(words) &&
    words.every((word: unknown) => typeof word === "string") &&
    Array.isArray(skills) &&
    skills.every((skill: unknown) => typeof skill === "string") &&
    (row["kind"] === "deny" ||
      row["kind"] === "ignored" ||
      row["kind"] === "missing" ||
      row["kind"] === "passed-read")
  );
}

/** Reads current and archived rows once per inode. */
export function readGuideDecisions(stateDir: string): SkillGuideDecisionRow[] {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter(
      (name) =>
        name === "decisions.jsonl" || /^decisions\..+-\d+\.jsonl$/.test(name),
    );
  } catch {
    return [];
  }
  const seenInodes = new Set<string>();
  const rows: SkillGuideDecisionRow[] = [];
  for (const name of names) {
    const path = join(stateDir, name);
    try {
      if (!lstatSync(path).isFile()) continue;
      const stat = statSync(path);
      const inode = `${stat.dev}:${stat.ino}`;
      if (seenInodes.has(inode)) continue;
      seenInodes.add(inode);
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        if (line === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (isDecisionRow(value)) rows.push(value);
      }
    } catch {
      // A missing, unreadable, or concurrently rotated file contributes no rows.
    }
  }
  return rows;
}

/** Writes a once-per-key missing or ignored decision guarded by its marker. */
export function recordGuideDecisionOnce(
  stateDir: string,
  input: SkillGuideDecisionInput & { kind: "missing" | "ignored" },
  now?: Date,
): boolean {
  const kind: GuideMarkerKind = input.kind;
  if (!isSafeSessionId(input.sessionId)) {
    logSkillGuideEvent("unsafe-session");
    return false;
  }
  const recorded: string[] = [];
  for (const skill of new Set(input.skills)) {
    const created = createGuideMarker({
      stateDir,
      sessionId: input.sessionId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      target: skill,
      kind,
      ...(now !== undefined ? { now } : {}),
    });
    if (created) recorded.push(skill);
  }
  if (recorded.length === 0) return false;
  return appendGuideDecision(
    stateDir,
    { ...input, skills: recorded },
    { now: () => now ?? new Date() },
  );
}

/** Records one read after a previous deny, using the first deny's words. */
export function recordPassedRead(
  stateDir: string,
  key: GuideMarkerKey,
  now?: Date,
): boolean {
  if (!isSafeSessionId(key.sessionId)) {
    logSkillGuideEvent("unsafe-session");
    return false;
  }
  const firstName = guideMarkerName(
    "gate",
    key.sessionId,
    key.agentId,
    key.target,
    "_1",
  );
  const firstWords = readMarker(stateDir, firstName);
  if (firstWords === null) return false;
  try {
    const nowMs = now?.getTime() ?? Date.now();
    if (
      nowMs - statSync(join(stateDir, firstName)).mtimeMs >
      SKILL_GUIDE_MARKER_TTL_MS
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const created = createGuideMarker({
    ...key,
    kind: "read",
    suffix: "_r",
    ...(now !== undefined ? { now } : {}),
  });
  if (!created) return false;
  return appendGuideDecision(
    stateDir,
    {
      sessionId: key.sessionId,
      ...(key.agentId !== undefined ? { agentId: key.agentId } : {}),
      words: firstWords.split(/\s+/).filter(Boolean),
      skills: [key.target],
      kind: "passed-read",
    },
    { now: () => now ?? new Date() },
  );
}

export interface SkillGuidePaths {
  skillsRoot: string;
  stateDir: string;
}

/** Resolves only absolute argv overrides; environment variables do not override these paths. */
export function resolveSkillGuidePaths(
  argv: readonly string[] = process.argv.slice(2),
  homeDir: string = getHomeDir(),
): SkillGuidePaths {
  const defaults: SkillGuidePaths = {
    skillsRoot: join(homeDir, ".claude", "skills"),
    stateDir: join(homeDir, ".claude", "state", "skill-guide"),
  };
  const resolved = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--skills-root") {
      resolved.skillsRoot =
        value !== undefined && !value.startsWith("--") && isAbsolute(value)
          ? value
          : defaults.skillsRoot;
      if (value !== undefined && !value.startsWith("--")) index += 1;
    } else if (option === "--state-dir") {
      resolved.stateDir =
        value !== undefined && !value.startsWith("--") && isAbsolute(value)
          ? value
          : defaults.stateDir;
      if (value !== undefined && !value.startsWith("--")) index += 1;
    }
  }
  return resolved;
}

function hasSkillFile(skillsRoot: string, skill: string): boolean {
  try {
    return lstatSync(join(skillsRoot, skill, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

function matchedGuides(
  guides: readonly SkillGuideDeclaration[],
  commands: readonly string[],
): { guide: SkillGuideDeclaration; pattern: SkillGuidePattern }[] {
  const matched: {
    guide: SkillGuideDeclaration;
    pattern: SkillGuidePattern;
  }[] = [];
  for (const guide of guides) {
    const pattern = guide.before.find((item) =>
      matchesBash(item.words, [...commands]),
    );
    if (pattern !== undefined) matched.push({ guide, pattern });
  }
  return matched;
}

/** Applies the T3 read-before gate policy for one set of parsed Bash commands. */
export function evaluateSkillGuide(
  request: SkillGuideRequest,
  deps: SkillGuideDeps,
): SkillGuideGateResult {
  const pass = (status: "allow" | "undetermined"): SkillGuideGateResult => ({
    status,
    denied: [],
  });
  try {
    if (
      typeof request.sessionId !== "string" ||
      !isSafeSessionId(request.sessionId)
    ) {
      logSkillGuideEvent("unsafe-session");
      return pass("undetermined");
    }
    const matched = matchedGuides(
      readSkillGuides(deps.skillsRoot),
      request.commands,
    );
    if (matched.length === 0) return { status: "not-applicable", denied: [] };

    const keys = matched.map((item) => ({
      skill: item.guide.skill,
      words: item.pattern.words,
    }));
    const scan = scanSkillReads(
      request.transcriptPath,
      deps.skillsRoot,
      keys.map((key) => key.skill),
      deps.scan,
    );
    if (!scan.readable) {
      logSkillGuideEvent("no-transcript");
      return pass("undetermined");
    }
    const allRead = keys.every((key) => scan.loaded.has(key.skill));
    if (!allRead && (scan.timedOut || !scan.complete)) {
      logSkillGuideEvent("timeout");
      return pass("undetermined");
    }

    const denied: { skill: string; words: string[] }[] = [];
    for (const item of keys) {
      if (scan.loaded.has(item.skill)) {
        recordPassedRead(
          deps.stateDir,
          {
            stateDir: deps.stateDir,
            sessionId: request.sessionId,
            ...(request.agentId !== undefined
              ? { agentId: request.agentId }
              : {}),
            target: item.skill,
          },
          deps.now?.(),
        );
        continue;
      }
      if (!hasSkillFile(deps.skillsRoot, item.skill)) {
        recordGuideDecisionOnce(
          deps.stateDir,
          {
            sessionId: request.sessionId,
            ...(request.agentId !== undefined
              ? { agentId: request.agentId }
              : {}),
            words: item.words,
            skills: [item.skill],
            kind: "missing",
          },
          deps.now?.(),
        );
        continue;
      }
      const slot = acquireGuideGateSlot({
        stateDir: deps.stateDir,
        sessionId: request.sessionId,
        ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
        target: item.skill,
        content: item.words.join(" "),
        ...(deps.now !== undefined ? { now: deps.now() } : {}),
      });
      if (slot.status === "created") {
        denied.push(item);
      } else if (slot.status === "exhausted") {
        recordGuideDecisionOnce(
          deps.stateDir,
          {
            sessionId: request.sessionId,
            ...(request.agentId !== undefined
              ? { agentId: request.agentId }
              : {}),
            words: item.words,
            skills: [item.skill],
            kind: "ignored",
          },
          deps.now?.(),
        );
      }
    }

    if (denied.length === 0) return pass("allow");
    appendGuideDecision(
      deps.stateDir,
      {
        sessionId: request.sessionId,
        ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
        words: denied.flatMap((item) => item.words),
        skills: denied.map((item) => item.skill),
        kind: "deny",
      },
      deps.now !== undefined ? { now: deps.now } : {},
    );
    return { status: "deny", denied };
  } catch {
    emitError("internal-error");
    return pass("undetermined");
  }
}
