import type { EngineInterface, Register, Timer } from "claude-code";
import {
  NOTICE_LIMIT,
  PENDING_LIMIT,
  bashReason,
  buildOpenStdin,
  classifyAgentResult,
  durationArg,
  isAgentId,
  isBashCandidate,
  isTrackedAgent,
  parseOpenStdout,
  pushBounded,
  readCloseReason,
  reminderLine,
  type CloseReason,
  type Tracked,
} from "./track";

// A delegation must not wait on its own bookkeeping. Also passed to the child
// as timeoutMs so a stuck `delegation` is killed, not just abandoned.
const CALL_TIMEOUT_MS = 300;
const STATE_RETRIES = 3;

const PENDING = { plugin: "delegation-budget", key: "pending" } as const;
const NOTICES = { plugin: "delegation-budget", key: "notices" } as const;

// The engine follows `$` only into functions declared at the top level of
// this module, so every helper that uses it lives here and takes `$`.

type Exit = { exitCode: number; stdout: string };

/** Runs `delegation`, or null on a rejection or a timeout. */
async function runDelegation(
  $: EngineInterface,
  args: readonly string[],
  stdin?: string,
): Promise<Exit | null> {
  let timer: Timer | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = $.clock.after(CALL_TIMEOUT_MS, () => resolve(null));
  });
  try {
    const run = $.process
      .run(["delegation", ...args], { stdin, timeoutMs: CALL_TIMEOUT_MS })
      .then((r) => ({ exitCode: r.exitCode, stdout: r.stdout }));
    // A late rejection after the race is settled must not go unhandled.
    run.catch(() => undefined);
    return await Promise.race([run, timeout]);
  } catch {
    return null;
  } finally {
    timer?.cancel();
  }
}

async function nowOrNull($: EngineInterface): Promise<number | null> {
  try {
    return await $.clock.now();
  } catch {
    return null;
  }
}

async function openDelegation(
  $: EngineInterface,
  e: Parameters<typeof buildOpenStdin>[0],
): Promise<Tracked | null> {
  try {
    const sessionId = await $.session.id();
    const out = await runDelegation($, ["open"], buildOpenStdin(e, sessionId));
    // Exit 1 is the CLI saying "not a target"; no warning for it.
    if (out === null || out.exitCode !== 0) return null;
    return parseOpenStdout(out.stdout);
  } catch {
    return null;
  }
}

/** Fire-and-forget safe: runDelegation never rejects. */
async function closeDelegation(
  $: EngineInterface,
  selector: readonly string[],
  reason: CloseReason | undefined,
  durationMs: string | undefined,
): Promise<void> {
  await runDelegation($, [
    "close",
    ...selector,
    ...(reason === undefined ? [] : ["--reason", reason]),
    ...(durationMs === undefined ? [] : ["--duration-ms", durationMs]),
  ]);
}

async function bindDelegation(
  $: EngineInterface,
  tracked: Tracked,
  agentId: string,
): Promise<boolean> {
  const out = await runDelegation($, [
    "bind",
    tracked.id,
    "--agent-id",
    agentId,
  ]);
  return out !== null && out.exitCode === 0;
}

async function addPending(
  $: EngineInterface,
  tracked: Tracked,
  agentId: string,
  startedAt: number,
): Promise<void> {
  for (let attempt = 0; attempt < STATE_RETRIES; attempt++) {
    const held = await $.state.get(PENDING);
    const entry = { agentId, ...tracked, startedAt };
    const written = await $.state.set(
      PENDING,
      pushBounded(held.value ?? [], entry, PENDING_LIMIT),
      { ifVersion: held.version },
    );
    if (written.isSet) return;
  }
}

/** Takes the entry for `agentId` out of pending, or undefined if absent. */
async function takePending($: EngineInterface, agentId: string) {
  for (let attempt = 0; attempt < STATE_RETRIES; attempt++) {
    const held = await $.state.get(PENDING);
    const list = held.value ?? [];
    const found = list.find((p) => p.agentId === agentId);
    if (found === undefined) return undefined;
    const written = await $.state.set(
      PENDING,
      list.filter((p) => p.agentId !== agentId),
      { ifVersion: held.version },
    );
    if (written.isSet) return found;
  }
  return undefined;
}

async function addNotice($: EngineInterface, line: string): Promise<void> {
  for (let attempt = 0; attempt < STATE_RETRIES; attempt++) {
    const held = await $.state.get(NOTICES);
    const written = await $.state.set(
      NOTICES,
      pushBounded(held.value ?? [], line, NOTICE_LIMIT),
      { ifVersion: held.version },
    );
    if (written.isSet) return;
  }
}

/** Empties notices and returns what was in them; each line is delivered once. */
async function drainNotices($: EngineInterface): Promise<string[]> {
  for (let attempt = 0; attempt < STATE_RETRIES; attempt++) {
    const held = await $.state.get(NOTICES);
    const lines = held.value ?? [];
    if (lines.length === 0) return [];
    const written = await $.state.set(NOTICES, [], {
      ifVersion: held.version,
    });
    if (written.isSet) return [...lines];
  }
  return [];
}

async function finishBackground(
  $: EngineInterface,
  agentId: string,
  rawReason: unknown,
): Promise<void> {
  const entry = await takePending($, agentId);
  if (entry === undefined) return;
  const now = await nowOrNull($);
  // Not awaited: the close must not delay the turn's end.
  void closeDelegation(
    $,
    ["--agent-id", agentId],
    readCloseReason(rawReason),
    now === null ? undefined : durationArg(entry.startedAt, now),
  );
  await addNotice($, reminderLine(entry));
}

export const register: Register = (on) => {
  on("tool.call", { tool: ["Agent", "Bash"] }, async ($, e, next) => {
    const isAgent = e.tool === "Agent";
    const isCandidate = isAgent
      ? isTrackedAgent(e)
      : isBashCandidate((e as { command?: unknown }).command);
    if (!isCandidate) return next(e);

    // Started with the call so its latency overlaps the delegation's own.
    const opened = openDelegation($, e as never);
    const startedAt = await nowOrNull($);

    // Outside any try: a failure of the delegation itself must propagate.
    const result = await next(e);
    if (result.deny !== undefined) return result;

    try {
      const tracked = await opened;
      if (tracked === null) return result;

      if (
        !isAgent &&
        (e as { run_in_background?: unknown }).run_in_background === true
      ) {
        // Its end cannot be tied back to this call; the pending lapses.
        return result;
      }

      const launch = isAgent ? classifyAgentResult(result.result) : null;
      if (launch?.kind === "background") {
        if (
          startedAt !== null &&
          (await bindDelegation($, tracked, launch.agentId))
        ) {
          await addPending($, tracked, launch.agentId, startedAt);
        }
        return result;
      }
      if (launch?.kind === "unknown") return result;

      const endedAt = await nowOrNull($);
      await closeDelegation(
        $,
        [tracked.id],
        isAgent ? "answer" : bashReason(result.isError),
        startedAt === null || endedAt === null
          ? undefined
          : durationArg(startedAt, endedAt),
      );
      return {
        ...result,
        context: [...(result.context ?? []), reminderLine(tracked)],
      };
    } catch {
      // This mod's failure must not fail the delegation.
      return result;
    }
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId !== undefined && isAgentId(e.agentId)) {
      try {
        await finishBackground($, e.agentId, e.reason);
      } catch {
        // Bookkeeping only.
      }
    }
    return result;
  });

  on("prompt.submit", async ($, e, next) => {
    let lines: string[] = [];
    if (e.origin.kind === "task-notification") {
      try {
        lines = await drainNotices($);
      } catch {
        lines = [];
      }
    }
    if (lines.length === 0) return next(e);
    return next({ ...e, context: [...(e.context ?? []), ...lines] });
  });
};
