// Pure functions only: the engine follows `$` into top-level functions of
// register.ts, so nothing here touches the engine.

export const CODEX_AGENT = "codex:codex-rescue";
export const PENDING_LIMIT = 50;
export const NOTICE_LIMIT = 5;

const OPEN_STDOUT_MAX_BYTES = 200;
const COMMAND_MAX_BYTES = 8192;
const BASH_HEADS = new Set(["opencode", "codex", "bun"]);
const HARNESSES = new Set([
  "claude-code-agent",
  "codex-cli",
  "opencode",
  "cursor",
  "other",
]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "unknown"]);
const REASONS = new Set(["answer", "aborted", "refusal", "error"]);
const AGENT_DEF_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^d-[0-9a-f]{12}$/;
const MASKED_MODEL_RE = /^m-[0-9a-f]{6}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
// Same shape the CLI accepts for --agent-id.
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type Tracked = {
  id: string;
  harness: string;
  model: string;
  effort: string;
};

export type CloseReason = "answer" | "aborted" | "refusal" | "error";

function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The longest prefix of `text` that fits in `maxBytes` of UTF-8. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out;
}

export function isTrackedAgent(input: {
  model?: unknown;
  subagent_type?: unknown;
}): boolean {
  if (input.model === "sonnet" || input.subagent_type === CODEX_AGENT) {
    return true;
  }
  // No model: the CLI reads the agent definition and decides. Any other model
  // (haiku reviewers behind Codex included) stays out so they are not counted
  // twice with the Bash they run. Not shared with the CLI: separate deploys.
  return (
    input.model === undefined &&
    typeof input.subagent_type === "string" &&
    AGENT_DEF_RE.test(input.subagent_type)
  );
}

/**
 * Broader than the CLI's own rule on purpose: the CLI makes the final call
 * (open exits 1 for a non-target), this only avoids spawning it for `ls`.
 */
export function isBashCandidate(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.split(/&&|\|\||[;|\n]/).some((segment) => {
    const head = segment.trim().split(/\s+/)[0];
    return head !== undefined && BASH_HEADS.has(head);
  });
}

type OpenSource = {
  tool: string;
  tool_use_id: string;
  subagent_type?: unknown;
  model?: unknown;
  effort?: unknown;
  command?: unknown;
};

/** prompt and description are never forwarded; command is cut to 8 KB. */
export function buildOpenStdin(e: OpenSource, sessionId: string): string {
  return JSON.stringify({
    v: 1,
    tool: e.tool,
    tool_use_id: e.tool_use_id,
    sessionId,
    subagent_type: e.subagent_type,
    model: e.model,
    effort: e.effort,
    command:
      e.tool === "Bash" && typeof e.command === "string"
        ? truncateUtf8(e.command, COMMAND_MAX_BYTES)
        : undefined,
  });
}

/**
 * The four words `delegation open` prints, each validated, or null when the
 * output is not that line. A word that fails its check becomes `?`; a broken
 * id drops the whole thing. Nothing but validated words reaches the context.
 */
export function parseOpenStdout(stdout: string): Tracked | null {
  if (utf8Length(stdout) > OPEN_STDOUT_MAX_BYTES) return null;
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (/[\r\n]/.test(line)) return null;
  const words = line.split(/[ \t]+/);
  if (words.length !== 4) return null;
  const [id, harness, model, effort] = words as [
    string,
    string,
    string,
    string,
  ];
  if (!ID_RE.test(id)) return null;
  return {
    id,
    harness: HARNESSES.has(harness) ? harness : "?",
    model: model.startsWith("m-")
      ? MASKED_MODEL_RE.test(model)
        ? model
        : "?"
      : MODEL_RE.test(model)
        ? model
        : "?",
    effort: EFFORTS.has(effort) ? effort : "?",
  };
}

export function reminderLine(t: Tracked): string {
  return `[delegation] ${t.id} (${t.harness}/${t.model}/${t.effort}) 完了。採否を delegation record で記録`;
}

export type AgentLaunch =
  | { kind: "background"; agentId: string }
  | { kind: "foreground" }
  | { kind: "unknown" };

/**
 * Probe result: a background launch answers `status: "async_launched"` with
 * no content; a foreground one carries `agentId` as well, so agentId alone
 * proves nothing.
 */
export function classifyAgentResult(result: unknown): AgentLaunch {
  if (typeof result !== "object" || result === null) return { kind: "unknown" };
  const r = result as Record<string, unknown>;
  if (r.status === "async_launched" || r.isAsync === true) {
    return typeof r.agentId === "string" && AGENT_ID_RE.test(r.agentId)
      ? { kind: "background", agentId: r.agentId }
      : { kind: "unknown" };
  }
  return r.content !== undefined ? { kind: "foreground" } : { kind: "unknown" };
}

/** The tool result has no numeric exit code; only `isError` is readable. */
export function bashReason(isError: unknown): CloseReason {
  return isError === true ? "error" : "answer";
}

export function readCloseReason(reason: unknown): CloseReason | undefined {
  return typeof reason === "string" && REASONS.has(reason)
    ? (reason as CloseReason)
    : undefined;
}

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_RE.test(value);
}

/** Appends and drops the oldest entries beyond `limit`. */
export function pushBounded<T>(
  list: readonly T[],
  item: T,
  limit: number,
): T[] {
  const next = [...list, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function durationArg(startedAt: number, now: number): string {
  const diff = Math.round(now - startedAt);
  return String(Number.isFinite(diff) && diff > 0 ? diff : 0);
}
