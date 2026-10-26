#!/usr/bin/env -S bun run --silent

/**
 * Sends a Bash/Write call back once, per session and declaring skill, when
 * the skill says (frontmatter `requires-skills` / `requires-skills-before`)
 * that other skills must be loaded before this operation and the session has
 * not loaded them. The deny only stops; it approves nothing. See
 * docs/decisions/0046-*.md.
 *
 * Registered without run-guard.sh and without `|| exit 2`, like
 * ask-preflight.ts: every failure passes the call through, and passing means
 * printing nothing (an explicit `allow` would override the permission rules).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { logDecision, logEvent } from "../lib/centralized-logging.ts";
import { prepareDenyInput } from "../lib/deny-input.ts";
import { getHomeDir } from "../lib/path-utils.ts";
import { readStdinLimited } from "../lib/read-stdin-limited.ts";
import { isSafeSessionId } from "../lib/session-id.ts";
import { createMarker, readMarker } from "../lib/session-marker.ts";
import {
  matchesDeclaration,
  type Operation,
  readDeclarations,
  type ScanOptions,
  scanLoadedSkills,
  type SkillDeclaration,
} from "../lib/skill-requires.ts";

const MAX_STDIN_BYTES = 1024 * 1024;
const WATCHDOG_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_TAG = "[skill-requires-gate]";

export interface SkillRequiresGateDeps {
  stateDir: string;
  skillsDir: string;
  now: () => Date;
  /** Chunk size, deadline and the like; tests shrink them. */
  scan?: Partial<ScanOptions>;
}

export type DecisionKind = "deny" | "passed" | "timeout";

function defaultDeps(): SkillRequiresGateDeps {
  return {
    stateDir:
      process.env["SKILL_REQUIRES_GATE_STATE_DIR"] ||
      join(getHomeDir(), ".claude", "state", "skill-requires-gate"),
    skillsDir: join(getHomeDir(), ".claude", "skills"),
    now: () => new Date(),
  };
}

function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // side channels must not change the decision
  }
}

/** The marker name: session id + `_` + the first 16 hex digits of the skill name's SHA-256. */
function markerBase(sessionId: string, skill: string): string {
  const digest = createHash("sha256").update(skill).digest("hex").slice(0, 16);
  return `${sessionId}_${digest}`;
}

function appendDecision(
  deps: SkillRequiresGateDeps,
  row: {
    sessionId: string;
    skill: string;
    kind: DecisionKind;
    missing: string[];
  },
): void {
  quietly(() => {
    mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: deps.now().toISOString(), ...row });
    appendFileSync(join(deps.stateDir, "decisions.log"), `${line}\n`, {
      mode: 0o600,
    });
  });
}

function buildReason(
  denied: { declaration: SkillDeclaration; missing: string[] }[],
): string {
  const parts = denied.map(
    ({ declaration, missing }) =>
      `スキル「${declaration.skill}」は、この操作の前に次のスキルを読み込むよう指示している。まだ読み込まれていない: ${missing.join(", ")}`,
  );
  return [
    ...parts,
    "Skill ツールで読み込んでから、同じ操作をやり直す。",
    "指示の条件に該当しない場合（例: 英語で書く）や、読み込めない場合は、省く理由を応答に 1 行書いてから同じ操作をやり直せば通る。",
    "このセッションで同じ宣言の 2 回目は止めない。",
  ].join("\n");
}

async function operationOf(
  root: Record<string, unknown>,
): Promise<Operation | null> {
  const toolInput = root["tool_input"];
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  if (root["tool_name"] === "Bash") {
    const command = input["command"];
    if (typeof command !== "string") return null;
    const { individualCommands } = await prepareDenyInput(command);
    return { tool: "Bash", commands: individualCommands };
  }
  if (root["tool_name"] === "Write") {
    const filePath = input["file_path"];
    return typeof filePath === "string" ? { tool: "Write", filePath } : null;
  }
  return null;
}

async function judge(
  root: Record<string, unknown>,
  deps: SkillRequiresGateDeps,
): Promise<object | null> {
  if (root["agent_id"]) return null;
  const sessionId = root["session_id"];
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) return null;
  const transcriptPath = root["transcript_path"];
  if (typeof transcriptPath !== "string") return null;

  const { declarations } = readDeclarations(deps.skillsDir);
  if (declarations.length === 0) return null;
  const operation = await operationOf(root);
  if (operation === null) return null;
  const matched = declarations.filter((d) => matchesDeclaration(d, operation));
  if (matched.length === 0) return null;

  const needed = new Set<string>();
  for (const d of matched) {
    needed.add(d.skill);
    for (const name of d.requires) needed.add(name);
  }
  const scan = scanLoadedSkills(transcriptPath, {
    ...deps.scan,
    needed,
  });
  const now = deps.now();
  const active = matched.filter((d) => scan.loaded.has(d.skill));

  if (scan.timedOut) {
    for (const d of active) {
      const base = markerBase(sessionId, d.skill);
      const first = createMarker({
        dir: deps.stateDir,
        name: `${base}_timeout`,
        maxAgeMs: null,
        sweepAfterMs: DAY_MS,
        now,
      });
      if (first) {
        appendDecision(deps, {
          sessionId,
          skill: d.skill,
          kind: "timeout",
          missing: [],
        });
      }
    }
    return null;
  }

  const denied: { declaration: SkillDeclaration; missing: string[] }[] = [];
  const alreadyDenied: { declaration: SkillDeclaration; missing: string[] }[] =
    [];
  for (const d of active) {
    const missing = d.requires.filter((name) => !scan.loaded.has(name));
    const base = markerBase(sessionId, d.skill);
    if (missing.length > 0) {
      const created = createMarker({
        dir: deps.stateDir,
        name: base,
        maxAgeMs: DAY_MS,
        sweepAfterMs: DAY_MS,
        now,
      });
      if (created) {
        denied.push({ declaration: d, missing });
        continue;
      }
    }
    if (readMarker(deps.stateDir, base) !== null) {
      alreadyDenied.push({ declaration: d, missing });
    }
  }

  if (denied.length > 0) {
    for (const { declaration, missing } of denied) {
      appendDecision(deps, {
        sessionId,
        skill: declaration.skill,
        kind: "deny",
        missing,
      });
    }
    quietly(() =>
      logDecision("Bash|Write", "deny", `${LOG_TAG} deny`, sessionId),
    );
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: buildReason(denied),
      },
    };
  }

  for (const { declaration, missing } of alreadyDenied) {
    const passed = createMarker({
      dir: deps.stateDir,
      name: `${markerBase(sessionId, declaration.skill)}_passed`,
      maxAgeMs: null,
      sweepAfterMs: DAY_MS,
      now,
    });
    if (passed) {
      appendDecision(deps, {
        sessionId,
        skill: declaration.skill,
        kind: "passed",
        missing,
      });
    }
  }
  return null;
}

/** The JSON to print on stdout, or null to print nothing. Never throws. */
export async function run(
  input: unknown,
  deps: SkillRequiresGateDeps,
): Promise<object | null> {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return null;
    }
    const root = input as Record<string, unknown>;
    if (root["hook_event_name"] !== "PreToolUse") return null;
    if (root["tool_name"] !== "Bash" && root["tool_name"] !== "Write") {
      return null;
    }
    return await judge(root, deps);
  } catch {
    quietly(() => logEvent("Error", undefined, `${LOG_TAG} internal error`));
    return null;
  }
}

if (import.meta.main) {
  // Synchronous reads cannot be interrupted by this race; the last net is the
  // `timeout` in settings. The timer is unref'd so a finished run exits at once.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), WATCHDOG_MS);
    timer.unref();
  });
  try {
    const work = (async () => {
      const raw = await readStdinLimited(MAX_STDIN_BYTES, WATCHDOG_MS);
      if (raw === null) return null;
      return run(JSON.parse(raw), defaultDeps());
    })();
    const output = await Promise.race([work, watchdog]);
    if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // print nothing and let the call through
  }
  clearTimeout(timer);
  process.exitCode = 0;
}
