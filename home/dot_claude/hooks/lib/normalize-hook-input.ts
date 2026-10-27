/**
 * Adapt Cursor CLI / IDE hook stdin into the Claude Code shape that
 * cc-hooks-ts validates. Claude payloads pass through unchanged.
 *
 * Cursor third-party import maps settings event names, but still feeds
 * camelCase `hook_event_name` (e.g. preToolUse) and often omits `cwd`,
 * `session_id`, and `transcript_path`. Without this step, defineHook
 * scripts throw and run-guard fail-closes every tool call.
 *
 * CLI: bun normalize-hook-input.ts   (stdin JSON → stdout JSON)
 */

export const CURSOR_EVENT_TO_CLAUDE = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  stop: "Stop",
  subagentStop: "SubagentStop",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  preCompact: "PreCompact",
} as const;

type CursorEvent = keyof typeof CURSOR_EVENT_TO_CLAUDE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function looksLikeCursorPayload(input: Record<string, unknown>): boolean {
  const event = input.hook_event_name;
  if (typeof event === "string" && event in CURSOR_EVENT_TO_CLAUDE) return true;
  if (input.tool_name === "Shell") return true;
  return false;
}

function resolveCwd(
  input: Record<string, unknown>,
  fallbackCwd: string,
): string {
  const fromRoot = nonEmptyString(input.cwd);
  if (fromRoot) return fromRoot;

  const fromWorkingDirectory = nonEmptyString(input.working_directory);
  if (fromWorkingDirectory) return fromWorkingDirectory;

  if (isRecord(input.tool_input)) {
    const fromTool = nonEmptyString(input.tool_input.working_directory);
    if (fromTool) return fromTool;
  }

  return fallbackCwd;
}

/**
 * Returns a new object when adaptation is needed; otherwise the same
 * reference so callers can skip rewriting stdin for Claude payloads.
 */
export function normalizeHookInput(
  raw: unknown,
  fallbackCwd: string = process.env.PWD || process.cwd(),
): unknown {
  if (!isRecord(raw)) return raw;
  if (!looksLikeCursorPayload(raw)) return raw;

  const out: Record<string, unknown> = { ...raw };

  const event = out.hook_event_name;
  if (typeof event === "string" && event in CURSOR_EVENT_TO_CLAUDE) {
    out.hook_event_name = CURSOR_EVENT_TO_CLAUDE[event as CursorEvent];
  } else if (typeof out.hook_event_name !== "string") {
    out.hook_event_name = "PreToolUse";
  }

  out.cwd = resolveCwd(out, fallbackCwd);
  out.session_id =
    nonEmptyString(out.session_id) ??
    nonEmptyString(out.conversation_id) ??
    "cursor-unknown";
  out.transcript_path = nonEmptyString(out.transcript_path) ?? "/dev/null";

  if (out.tool_name === "Shell") out.tool_name = "Bash";

  if (
    (out.hook_event_name === "PreToolUse" ||
      out.hook_event_name === "PostToolUse" ||
      out.hook_event_name === "PostToolUseFailure") &&
    typeof out.tool_use_id !== "string"
  ) {
    out.tool_use_id = "cursor-unknown";
  }

  if (
    (out.hook_event_name === "PreToolUse" ||
      out.hook_event_name === "PostToolUse" ||
      out.hook_event_name === "PostToolUseFailure") &&
    out.tool_input === undefined
  ) {
    out.tool_input = {};
  }

  return out;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) {
    process.stdout.write(text);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stdout.write(text);
    return;
  }

  const normalized = normalizeHookInput(parsed);
  if (normalized === parsed) {
    process.stdout.write(text);
    return;
  }
  process.stdout.write(`${JSON.stringify(normalized)}\n`);
}

if (import.meta.main) {
  await main();
}
