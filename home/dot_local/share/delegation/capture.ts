import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  CLAUDE_MODELS,
  EFFORTS,
  isOneOf,
  normalizeModel,
  type Effort,
  type Harness,
} from "./schema.ts";

export type Captured = {
  harness: Harness;
  invocation: string[];
  model: string;
  effort: Effort;
};

const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"];
// SUBAGENT_RE only labels the invocation, so it allows `:` and `_`. AGENT_DEF_RE
// builds a file name, so it must not: a plugin agent like `plugin:x` has no
// file under the agents dir, and `_`/`.`/`/` would widen what can be opened.
const SUBAGENT_RE = /^[a-z0-9:_-]{1,40}$/;
const AGENT_DEF_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * Models an agent definition may pin. Narrower than CLAUDE_MODELS: `inherit`
 * says nothing about which model ran, so it is not recorded.
 */
export const AGENT_DEF_MODELS = ["sonnet", "opus", "haiku", "fable"] as const;
const AGENT_DEF_MAX_BYTES = 64 * 1024;

/** Shell-ish word splitting; quoting is honoured, nothing is expanded. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of segment) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) tokens.push(cur);
  return tokens;
}

type Flags = {
  model?: string;
  variant?: string;
  reasoningEffort?: string;
  sandbox?: string;
  auto: boolean;
};

function readFlags(tokens: readonly string[]): Flags {
  const flags: Flags = { auto: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? "";
    const next = tokens[i + 1];
    if ((t === "-m" || t === "--model") && next !== undefined) {
      flags.model = next;
      i++;
    } else if (t.startsWith("--model=")) {
      flags.model = t.slice("--model=".length);
    } else if (t === "--variant" && next !== undefined) {
      flags.variant = next;
      i++;
    } else if (t === "-s" || t === "--sandbox") {
      if (next !== undefined) {
        flags.sandbox = next;
        i++;
      }
    } else if ((t === "-c" || t === "--config") && next !== undefined) {
      const m = /^model_reasoning_effort=(.*)$/.exec(next);
      if (m !== null) flags.reasoningEffort = m[1] ?? "";
      i++;
    } else if (t === "--auto") {
      flags.auto = true;
    }
  }
  return flags;
}

function effortOf(v: string | undefined): Effort {
  return isOneOf(EFFORTS, v) ? v : "unknown";
}

function captureSegment(tokens: readonly string[]): Captured | null {
  const [first, second] = tokens;
  if (first === "opencode" && second === "run") {
    const f = readFlags(tokens.slice(2));
    return {
      harness: "opencode",
      invocation: f.auto
        ? ["opencode run", "opencode:--auto"]
        : ["opencode run"],
      model: normalizeModel("opencode", f.model),
      effort: effortOf(f.variant),
    };
  }
  const isCodexExec = first === "codex" && second === "exec";
  const isReviewer =
    first === "bun" &&
    second !== undefined &&
    second.endsWith("reviewer-codex-run.ts");
  if (isCodexExec || isReviewer) {
    const f = readFlags(tokens.slice(2));
    const invocation = [isCodexExec ? "codex exec" : "reviewer-codex-run"];
    if (f.sandbox !== undefined && SANDBOXES.includes(f.sandbox)) {
      invocation.push(`sandbox:${f.sandbox}`);
    }
    return {
      harness: "codex-cli",
      invocation,
      model: normalizeModel("codex-cli", f.model),
      effort: effortOf(f.reasoningEffort),
    };
  }
  return null;
}

/** First segment (split on && ; | newline) that starts a delegation wins. */
export function captureBash(command: string): Captured | null {
  for (const segment of command.split(/&&|[;|\n]/)) {
    const hit = captureSegment(tokenize(segment));
    if (hit !== null) return hit;
  }
  return null;
}

export function captureAgent(input: {
  subagentType?: string;
  model?: string;
  effort?: string;
}): Captured {
  if (input.subagentType === "codex:codex-rescue") {
    return {
      harness: "codex-cli",
      invocation: ["via:codex-rescue"],
      model: "unknown",
      effort: "unknown",
    };
  }
  const invocation =
    input.subagentType !== undefined && SUBAGENT_RE.test(input.subagentType)
      ? [`subagent:${input.subagentType}`]
      : [];
  return {
    harness: "claude-code-agent",
    invocation,
    model: isOneOf(CLAUDE_MODELS, input.model) ? input.model : "unknown",
    effort: effortOf(input.effort),
  };
}

/**
 * Where agent definitions live. A malformed DELEGATION_AGENTS_DIR yields null
 * rather than falling back to HOME, so a typo cannot silently read elsewhere.
 */
export function agentsDirFrom(
  env: Record<string, string | undefined>,
): string | null {
  const override = env.DELEGATION_AGENTS_DIR;
  if (override !== undefined) {
    if (
      isAbsolute(override) &&
      override !== "/" &&
      !override.endsWith("/") &&
      normalize(override) === override
    ) {
      return override;
    }
    return null;
  }
  const home = env.HOME;
  if (home === undefined || home === "" || !isAbsolute(home)) return null;
  return join(home, ".claude", "agents");
}

function stripQuotes(v: string): string {
  const q = v[0];
  if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Reads `model:` from the frontmatter. Two `model:` lines are refused: YAML
 * parsers disagree on duplicate keys, and recording the other one than the
 * harness uses would be worse than recording nothing.
 */
export function parseAgentModel(text: string): string | null {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = body
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[0] !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  const hits: string[] = [];
  for (const line of lines.slice(1, end)) {
    if (!line.startsWith("model:")) continue;
    const rest = line.slice("model:".length);
    // `model:sonnet` is one YAML scalar, not a key.
    if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") continue;
    hits.push(rest);
  }
  if (hits.length !== 1) return null;
  const value = stripQuotes(
    (hits[0] as string).replace(/^[ \t]+|[ \t]+$/g, ""),
  );
  return isOneOf(AGENT_DEF_MODELS, value) ? value : null;
}

function readCapped(fd: number): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(8192);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > AGENT_DEF_MAX_BYTES) return null;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Never throws: any failure to read or parse the definition is null. */
export function readAgentModel(
  dir: string,
  subagentType: unknown,
): string | null {
  if (typeof subagentType !== "string" || !AGENT_DEF_RE.test(subagentType)) {
    return null;
  }
  const path = join(dir, `${subagentType}.md`);
  if (dirname(path) !== dir) return null;
  let fd: number | null = null;
  try {
    const l = lstatSync(path);
    if (!l.isFile() || l.size > AGENT_DEF_MAX_BYTES) return null;
    fd = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const f = fstatSync(fd);
    if (!f.isFile() || f.size > AGENT_DEF_MAX_BYTES) return null;
    const text = readCapped(fd);
    return text === null ? null : parseAgentModel(text);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to recover
      }
    }
  }
}

/** Same shape as captureAgent, with the model taken from the definition. */
export function captureAgentFromDefinition(
  subagentType: string,
  model: string,
  effort?: string,
): Captured {
  return {
    harness: "claude-code-agent",
    invocation: [`subagent:${subagentType}`],
    model,
    effort: effortOf(effort),
  };
}
