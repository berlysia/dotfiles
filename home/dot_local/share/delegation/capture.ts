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
const SUBAGENT_RE = /^[a-z0-9:_-]{1,40}$/;

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
