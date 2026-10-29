#!/usr/bin/env -S bun run --silent

import { defineHook } from "cc-hooks-ts";
import {
  parserGiveUpMark,
  parserGiveUpReasonSince,
} from "../lib/bash-parser.ts";
import {
  getCommandFromToolInput,
  splitCommandWords,
  unwrapCommand,
} from "../lib/command-parsing.ts";
import {
  createDenyResponse,
  shortenForReason,
} from "../lib/context-helpers.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import "../types/tool-schemas.ts";

/**
 * Denies starting opencode from Bash. Sending work to an external model goes
 * through `delegation offload`, which checks the exposure and the brief
 * first; a direct `opencode run` skips those checks. The rule catches the
 * careless direct launch only: a command word built from a variable, a
 * symlinked alias, a script that runs it, and launches from a terminal or
 * Codex are not covered (spec K9).
 */

/** Takes one string and returns the commands to judge, or why it could not. */
export type ExtractCommands = (
  text: string,
) => Promise<{ commands: string[] } | { gaveUp: string }>;

export type OpencodeVerdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

/** Nesting of `bash -c` / `eval` strings that is still read; the top string is depth 0. */
const MAX_DEPTH = 3;

const OPENCODE_NAMES = new Set(["opencode", "opencode-ai"]);

/** Read-only forms that never reach a model. Matched as whole argument lists. */
const ALLOWED_ARGS: readonly (readonly string[])[] = [
  ["--version"],
  ["models"],
  ["debug", "config"],
  ["debug", "agents"],
  ["debug", "paths"],
];

const RULE_REASON =
  "Bash から opencode を起動できません。外部へ送る委譲は `delegation offload` を使ってください（model-offloading.md の OpenCode の節）。読み取りだけなら `opencode --version`・`opencode models`・`opencode debug config|agents|paths` は通ります。";

const GIVE_UP_HINT =
  "heredoc の本文に opencode が入るなら、メッセージをファイルに書いて `-F` で渡してください。";

// The mark is taken before the parser runs, as home-destruction-guard does: a
// give-up raised by the next call would otherwise go unseen.
//
// individualCommands also holds the whole text. Split into words, the body
// of a heredoc that the masker keeps (anything but cat / tee) turns into
// commands of its own, so `git commit -F - <<'EOF'` with `opencode run` in
// the message would be denied. For a text with a heredoc the parts the parser
// extracted (`git commit -F`) stand in for the whole. Other texts keep the
// whole: the parts drop quoting and arguments of `bash -lc '...'`.
const defaultExtract: ExtractCommands = async (text) => {
  const mark = parserGiveUpMark();
  const { maskedText, individualCommands } = await prepareDenyInput(text);
  const gaveUp = parserGiveUpReasonSince(mark);
  if (gaveUp !== null) return { gaveUp };
  if (!maskedText.includes("<<")) return { commands: individualCommands };
  const parts = individualCommands.filter(
    (c) => c.trim() !== maskedText.trim(),
  );
  return { commands: parts.length > 0 ? parts : individualCommands };
};

function isAllowedArgs(args: readonly string[]): boolean {
  return ALLOWED_ARGS.some(
    (allowed) =>
      allowed.length === args.length &&
      allowed.every((word, idx) => word === args[idx]),
  );
}

/**
 * The splitter cuts at `&`, so `2>&1` and `&>` would end a command early and
 * hand the rest (`opencode debug paths 2>&1 run x`) to a command of its own.
 * Rewrite them to plain redirections first; this text is only judged.
 */
function normalizeRedirections(text: string): string {
  return text
    .replace(/(^|\s)\d*[<>]&(\d+|-)(?=\s|$)/g, "$1")
    .replace(/(^|\s)&>(>?)/g, "$1>$2");
}

const REDIRECTION = /^\d*(>>?|<|>\|)(.*)$/;

/** Drops `> file`, `2>/dev/null` and the like; bash keeps the other words as arguments. */
function dropRedirections(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = REDIRECTION.exec(args[i] as string);
    if (match === null) {
      kept.push(args[i] as string);
    } else if (match[2] === "") {
      i++; // the target is the next word
    }
  }
  return kept;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

type Finding =
  | { kind: "rule" }
  | { kind: "depth" }
  | { kind: "gaveUp"; why: string };

async function findViolation(
  text: string,
  depth: number,
  extract: ExtractCommands,
): Promise<Finding | null> {
  if (depth > MAX_DEPTH) return { kind: "depth" };
  const extracted = await extract(text);
  if ("gaveUp" in extracted) return { kind: "gaveUp", why: extracted.gaveUp };
  for (const command of extracted.commands) {
    // individualCommands can hold a whole `a && b`; split it so one command
    // word is judged at a time.
    for (const words of splitCommandWords(normalizeRedirections(command))) {
      const { words: run, indirect } = unwrapCommand(words);
      if (indirect !== null) {
        const inner = await findViolation(indirect, depth + 1, extract);
        if (inner) return inner;
        continue;
      }
      const head = run[0];
      if (!head) continue;
      // `opencode-ai@latest` names a version of the package; compare the name.
      const name = basename(head.value).split("@")[0] ?? "";
      if (!OPENCODE_NAMES.has(name)) continue;
      if (!isAllowedArgs(dropRedirections(run.slice(1).map((t) => t.value)))) {
        return { kind: "rule" };
      }
    }
  }
  return null;
}

export async function judgeOpencodeCommand(
  command: string,
  deps: { extract?: ExtractCommands } = {},
): Promise<OpencodeVerdict> {
  // Most Bash calls never mention opencode: they skip the parser, so they
  // neither cost parse time nor fail on a parser give-up. A text that does
  // not contain the word cannot name the command, so the verdict is the same.
  if (!command.includes("opencode")) return { decision: "allow" };
  const finding = await findViolation(
    command,
    0,
    deps.extract ?? defaultExtract,
  );
  const shown = `\nCommand: ${shortenForReason(command)}`;
  if (finding === null) return { decision: "allow" };
  if (finding.kind === "rule") {
    return { decision: "deny", reason: RULE_REASON + shown };
  }
  if (finding.kind === "depth") {
    return {
      decision: "deny",
      reason: `${RULE_REASON}\nシェルの入れ子が深く、中身を判定できませんでした。${shown}`,
    };
  }
  return {
    decision: "deny",
    reason: `${RULE_REASON}\nコマンドを解析できませんでした（${finding.why}）。${GIVE_UP_HINT}${shown}`,
  };
}

interface GateContext {
  input: { tool_name: string; tool_input: unknown };
  success(output: object): unknown;
  json(response: ReturnType<typeof createDenyResponse>): unknown;
}

export async function runOpencodeGate<C extends GateContext>(
  context: C,
  judge: typeof judgeOpencodeCommand = judgeOpencodeCommand,
): Promise<ReturnType<C["success"]> | ReturnType<C["json"]>> {
  const { tool_name, tool_input } = context.input;
  if (tool_name !== "Bash") {
    return context.success({}) as ReturnType<C["success"]>;
  }
  try {
    const command = getCommandFromToolInput("Bash", tool_input) || "";
    const verdict = await judge(command);
    if (verdict.decision === "deny") {
      return context.json(createDenyResponse(verdict.reason)) as ReturnType<
        C["json"]
      >;
    }
    return context.success({}) as ReturnType<C["success"]>;
  } catch (error) {
    // Reached only for a command that mentions opencode (the short circuit
    // runs first), so failing closed stops nothing else.
    return context.json(
      createDenyResponse(
        `opencode の直接起動の判定でエラーが出ました: ${error}`,
      ),
    ) as ReturnType<C["json"]>;
  }
}

const hook = defineHook({
  trigger: { PreToolUse: true },
  run: (context) => runOpencodeGate(context),
});

export default hook;

if (import.meta.main) {
  const { runHook } = await import("cc-hooks-ts");
  await runHook(hook);
}
