/**
 * delegation: ledger of delegated work (who ran it, how it turned out) plus a
 * pre-delegation route. Entry point only dispatches and parses arguments; the
 * file formats live in schema.ts / store.ts.
 */
import { readSync } from "node:fs";
import { captureAgent, captureBash, type Captured } from "./capture.ts";
import {
  DEFAULT_SINCE_DAYS,
  PENDING_LIMIT,
  STDIN_MAX_BYTES,
} from "./constants.ts";
import {
  buildDelegationRow,
  countOrNull,
  displayModel,
  durationOrNull,
  EFFORTS,
  END_REASONS,
  FOUND_BYS,
  HARNESSES,
  isAgentId,
  isDelegationId,
  isOneOf,
  isToolUseId,
  KINDS,
  SIZES,
  VERDICTS,
  type DelegationRow,
  type DelegationInput,
  type LapseRow,
  type Pending,
} from "./schema.ts";
import {
  StoreError,
  appendLedger,
  createPending,
  foldLedger,
  ledgerIds,
  lapsePending,
  listPending,
  newDelegationId,
  openStore,
  readLedger,
  readPending,
  removePendingFile,
  reviewDue,
  reviewPromptLine,
  updatePending,
  withPendingLock,
  lapseStalePendings,
  type Store,
} from "./store.ts";
import {
  forecastDir,
  readForecast,
  type ForecastRead,
} from "./forecast-file.ts";
import {
  applyLookahead,
  fetchUsage,
  loadWindowMins,
  paceProvider,
  surplusPoints,
} from "./pace.ts";
import { buildRoute } from "./route.ts";
import { buildReview } from "./review.ts";

const VALUE_FLAGS = new Set([
  "agent-id",
  "reason",
  "duration-ms",
  "kind",
  "size",
  "verdict",
  "shape-errors",
  "reworks",
  "triage-excluded",
  "note",
  "harness",
  "model",
  "effort",
  "later-defect",
  "session",
  "since",
]);
const BOOLEAN_FLAGS = new Set(["manual", "rework"]);

type Args = { positionals: string[]; flags: Map<string, string | true> };

/** Unknown flags are skipped without consuming a value. */
function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) flags.set(name, a.slice(eq + 1));
      else if (i + 1 < argv.length) flags.set(name, argv[++i] ?? "");
    }
  }
  return { positionals, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function nowFromEnv(env: Record<string, string | undefined>): Date {
  // DELEGATION_NOW exists so tests can pin the clock.
  const pinned = env.DELEGATION_NOW;
  if (pinned !== undefined) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function readStdinLimited(limit: number): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(4096);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EOF") break;
      if (code === "EAGAIN") continue;
      throw e;
    }
    if (n === 0) break;
    total += n;
    if (total > limit) return null;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function cmdOpen(now: Date): number {
  const text = readStdinLimited(STDIN_MAX_BYTES);
  if (text === null) return 1;
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return 1;
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return 1;
  }
  if (input.v !== 1) return 1;
  const toolUseId = input.tool_use_id;
  const sessionId = input.sessionId;
  if (!isToolUseId(toolUseId) || !isToolUseId(sessionId)) return 1;

  let captured: Captured | null;
  if (input.tool === "Agent") {
    const subagentType = optionalString(input.subagent_type);
    const model = optionalString(input.model);
    const effort = optionalString(input.effort);
    captured = captureAgent({
      ...(subagentType !== undefined ? { subagentType } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    });
  } else if (input.tool === "Bash" && typeof input.command === "string") {
    captured = captureBash(input.command);
  } else {
    return 1;
  }
  if (captured === null) return 1;

  const store = openStore();
  const pendings = listPending(store);
  const existing = pendings.find((p) => p.toolUseId === toolUseId);
  if (existing !== undefined) {
    printOpen(existing);
    return 0;
  }
  if (pendings.length >= PENDING_LIMIT) {
    const oldest = [...pendings].sort(
      (a, b) =>
        Date.parse(a.openedAt) - Date.parse(b.openedAt) ||
        a.id.localeCompare(b.id),
    )[0];
    if (oldest !== undefined) {
      try {
        lapsePending(store, oldest.id, now);
      } catch (e) {
        if (!(e instanceof StoreError && e.code === "busy")) throw e;
      }
    }
  }
  const taken = ledgerIds(readLedger(store).rows);
  for (;;) {
    const id = newDelegationId(store, taken);
    const pending: Pending = {
      v: 1,
      id,
      openedAt: now.toISOString(),
      sessionId,
      toolUseId,
      harness: captured.harness,
      invocation: captured.invocation,
      model: captured.model,
      effort: captured.effort,
      agentId: null,
      closedAt: null,
      endReason: null,
      durationMs: null,
    };
    if (createPending(store, pending)) {
      printOpen(pending);
      return 0;
    }
  }
}

function printOpen(p: Pending): void {
  process.stdout.write(
    `${p.id} ${p.harness} ${displayModel(p.model)} ${p.effort}\n`,
  );
}

function cmdBind(args: Args): number {
  const id = args.positionals[0];
  const agentId = flagString(args, "agent-id");
  if (!isDelegationId(id) || !isAgentId(agentId)) return 1;
  const store = openStore();
  const result = updatePending(store, id, (p) =>
    p.agentId !== null ? null : { ...p, agentId },
  );
  return result === null ? 1 : 0;
}

function parseDurationFlag(v: string | undefined): number | null {
  return v !== undefined && /^\d+$/.test(v) ? durationOrNull(Number(v)) : null;
}

function cmdClose(args: Args, now: Date): number {
  const ref = args.positionals[0];
  const agentFlag = flagString(args, "agent-id");
  const store = openStore();
  let target: string;
  if (ref !== undefined) {
    if (!isDelegationId(ref)) return 1;
    target = ref;
  } else if (agentFlag !== undefined) {
    if (!isAgentId(agentFlag)) return 1;
    const matches = listPending(store).filter((p) => p.agentId === agentFlag);
    if (matches.length === 0) return 0;
    if (matches.length > 1) return 1;
    target = matches[0]?.id ?? "";
  } else {
    return 1;
  }
  const reasonFlag = flagString(args, "reason");
  const endReason = isOneOf(END_REASONS, reasonFlag) ? reasonFlag : null;
  const durationMs = parseDurationFlag(flagString(args, "duration-ms"));
  updatePending(store, target, (p) =>
    p.closedAt !== null
      ? null
      : { ...p, closedAt: now.toISOString(), endReason, durationMs },
  );
  return 0;
}

function countFlag(args: Args, name: string): number | undefined | "bad" {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = /^\d+$/.test(v) ? countOrNull(Number(v)) : null;
  return n === null ? "bad" : n;
}

type Judgement = Pick<
  DelegationInput,
  | "kind"
  | "size"
  | "verdict"
  | "shapeErrors"
  | "reworks"
  | "triageExcluded"
  | "note"
>;

function readJudgement(args: Args): Judgement | null {
  const kind = flagString(args, "kind");
  const size = flagString(args, "size");
  const verdict = flagString(args, "verdict");
  if (
    !isOneOf(KINDS, kind) ||
    !isOneOf(SIZES, size) ||
    !isOneOf(VERDICTS, verdict)
  ) {
    return null;
  }
  const out: Judgement = { kind, size, verdict };
  for (const [flag, key] of [
    ["shape-errors", "shapeErrors"],
    ["reworks", "reworks"],
    ["triage-excluded", "triageExcluded"],
  ] as const) {
    const n = countFlag(args, flag);
    if (n === "bad") return null;
    if (n !== undefined) out[key] = n;
  }
  const note = flagString(args, "note");
  if (note !== undefined) out.note = note;
  return out;
}

function printReviewPrompt(store: Store, now: Date): void {
  const line = reviewPromptLine(reviewDue(readLedger(store).rows, now));
  if (line !== null) process.stdout.write(`${line}\n`);
}

function strictHarness(h: string) {
  return isOneOf(HARNESSES, h) ? h : "other";
}
function strictEffort(e: string) {
  return isOneOf(EFFORTS, e) ? e : "unknown";
}
function strictEndReason(r: string | null) {
  return isOneOf(END_REASONS, r) ? r : null;
}

function rowFromPending(p: Pending, j: Judgement): DelegationRow {
  return buildDelegationRow({
    id: p.id,
    at: p.openedAt,
    harness: p.harness,
    invocation: p.invocation,
    model: p.model,
    effort: p.effort,
    sessionId: p.sessionId,
    manual: false,
    durationMs: p.durationMs,
    endReason: p.endReason,
    ...j,
  });
}

function rowFromLapse(l: LapseRow, j: Judgement): DelegationRow {
  return buildDelegationRow({
    id: l.id,
    at: l.openedAt ?? l.at,
    harness: strictHarness(l.harness),
    invocation: l.invocation,
    model: l.model,
    effort: strictEffort(l.effort),
    sessionId: l.sessionId,
    manual: false,
    durationMs: l.durationMs,
    endReason: strictEndReason(l.endReason),
    ...j,
  });
}

function cmdRecordManual(args: Args, now: Date): number {
  const j = readJudgement(args);
  const harness = flagString(args, "harness");
  const effort = flagString(args, "effort") ?? "unknown";
  if (j === null || !isOneOf(HARNESSES, harness) || !isOneOf(EFFORTS, effort)) {
    return 1;
  }
  const store = openStore();
  const id = newDelegationId(store, ledgerIds(readLedger(store).rows));
  appendLedger(
    store,
    buildDelegationRow({
      id,
      at: now.toISOString(),
      harness,
      invocation: ["manual"],
      model: flagString(args, "model") ?? "unknown",
      effort,
      sessionId: null,
      manual: true,
      durationMs: null,
      endReason: null,
      ...j,
    }),
  );
  process.stdout.write(`recorded ${id}\n`);
  printReviewPrompt(store, now);
  return 0;
}

function cmdRecord(args: Args, now: Date): number {
  if (args.flags.has("manual")) return cmdRecordManual(args, now);
  const id = args.positionals[0];
  if (!isDelegationId(id)) return 1;
  const j = readJudgement(args);
  if (j === null) return 1;
  const store = openStore();
  const folded = foldLedger(readLedger(store).rows);

  const recorded = folded.delegations.find((d) => d.id === id);
  if (recorded !== undefined) {
    // A crash after the append can leave the pending behind; clear it.
    withPendingLock(store, id, () => removePendingFile(store, id));
    process.stdout.write(`already-recorded ${id} ${recorded.verdict}\n`);
    return 0;
  }
  const wrote = withPendingLock(store, id, () => {
    const p = readPending(store, id);
    if (p === null) return false;
    appendLedger(store, rowFromPending(p, j));
    removePendingFile(store, id);
    return true;
  });
  if (!wrote) {
    const lapse = folded.lapses.find((l) => l.id === id);
    if (lapse === undefined) return 1;
    appendLedger(store, rowFromLapse(lapse, j));
  }
  process.stdout.write(`recorded ${id}\n`);
  printReviewPrompt(store, now);
  return 0;
}

function cmdAmend(args: Args, now: Date): number {
  const id = args.positionals[0];
  if (!isDelegationId(id)) return 1;
  const defect = flagString(args, "later-defect");
  const rework = args.flags.has("rework");
  if ((defect === undefined) === !rework) return 1;
  if (defect !== undefined && !isOneOf(FOUND_BYS, defect)) return 1;
  const store = openStore();
  const folded = foldLedger(readLedger(store).rows);
  if (!folded.delegations.some((d) => d.id === id)) return 1;
  appendLedger(
    store,
    defect !== undefined
      ? {
          v: 1,
          type: "amend",
          id,
          at: now.toISOString(),
          laterDefect: { foundBy: defect as "main" },
        }
      : { v: 1, type: "amend", id, at: now.toISOString(), reworks: 1 },
  );
  process.stdout.write(`amended ${id}\n`);
  return 0;
}

function cmdLapse(args: Args, now: Date): number {
  const id = args.positionals[0];
  if (!isDelegationId(id)) return 1;
  return lapsePending(openStore(), id, now) ? 0 : 1;
}

async function cmdRoute(args: Args, now: Date): Promise<number> {
  const kind = flagString(args, "kind");
  const size = flagString(args, "size");
  const session = flagString(args, "session");
  if (!isOneOf(KINDS, kind) || !isOneOf(SIZES, size)) return 1;
  if (session !== undefined && !isToolUseId(session)) return 1;
  const store = openStore();
  lapseStalePendings(store, now);
  const ledger = readLedger(store);
  const pendings = listPending(store);
  const usage = fetchUsage(process.env);
  const mins = await loadWindowMins();
  const claudeWeek = usage.claude?.weekly ?? null;
  const resetsAtMs =
    claudeWeek?.resetsAt == null ? Number.NaN : Date.parse(claudeWeek.resetsAt);
  // readForecast does not throw; the guard keeps an unexpected failure from
  // reaching the top-level catch, which would print the message.
  let forecast: ForecastRead;
  try {
    forecast = readForecast(
      forecastDir(process.env),
      now,
      Number.isFinite(resetsAtMs) ? resetsAtMs : null,
    );
  } catch {
    forecast = { ok: false, reason: "no-dir" };
  }
  const claudePace = paceProvider(usage.claude, now, mins);
  const applied = applyLookahead(claudePace, claudeWeek, forecast, now, mins);
  const paces = {
    claude: applied.pace,
    codex: paceProvider(usage.codex, now, mins),
    opencode: paceProvider(usage.opencode, now, mins),
  };
  const lines = buildRoute({
    kind,
    size,
    now,
    folded: foldLedger(ledger.rows),
    paces,
    claudeAheadBy: applied.aheadBy,
    lookahead: applied.lookahead,
    surplus: {
      codex: surplusPoints(usage.codex?.weekly ?? null, now, mins),
      opencode: surplusPoints(usage.opencode?.weekly ?? null, now, mins),
    },
    pendingTotal: pendings.length,
    pendingSession:
      session === undefined
        ? null
        : pendings.filter((p) => p.sessionId === session).length,
    skipped: ledger.skipped,
    ledgerLarge: ledger.large,
    due: reviewDue(ledger.rows, now),
    windowMinsMissing: mins === null,
    usageMissing:
      usage.claude === null && usage.codex === null && usage.opencode === null,
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function cmdReview(args: Args, now: Date): number {
  const sinceFlag = flagString(args, "since");
  let sinceDays = DEFAULT_SINCE_DAYS;
  if (sinceFlag !== undefined) {
    if (!/^\d{1,4}$/.test(sinceFlag) || Number(sinceFlag) === 0) return 1;
    sinceDays = Number(sinceFlag);
  }
  const store = openStore();
  lapseStalePendings(store, now);
  const ledger = readLedger(store);
  const lines = buildReview({
    now,
    sinceDays,
    folded: foldLedger(ledger.rows),
    skipped: ledger.skipped,
    ledgerLarge: ledger.large,
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  appendLedger(store, { v: 1, type: "review", at: now.toISOString() });
  return 0;
}

const USAGE = `Usage: delegation <command> [args]

Commands:
  route --kind <k> --size <S|M|L> [--session <id>]   where to delegate
  open                         stdin JSON (v:1) -> "<id> <harness> <model> <effort>"
  bind <id> --agent-id <a>
  close (<id> | --agent-id <a>) --reason <r> --duration-ms <n>
  record <id> --kind --size --verdict [--shape-errors N] [--reworks N]
         [--triage-excluded N] [--note T]
  record --manual --harness <h> [--model m] [--effort e] --kind --size --verdict
  amend <id> (--later-defect <foundBy> | --rework)
  lapse <id>
  review [--since <days>]

kind: research impl mechanical review triage draft
size: S M L   verdict: adopted patched redone discarded
`;

async function dispatch(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const now = nowFromEnv(process.env);
  switch (cmd) {
    case "route":
      return cmdRoute(args, now);
    case "review":
      return cmdReview(args, now);
    case "open":
      return cmdOpen(now);
    case "bind":
      return cmdBind(args);
    case "close":
      return cmdClose(args, now);
    case "record":
      return cmdRecord(args, now);
    case "amend":
      return cmdAmend(args, now);
    case "lapse":
      return cmdLapse(args, now);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return cmd === undefined ? 2 : 0;
    default:
      process.stderr.write(`delegation: unknown command: ${cmd}\n`);
      return 2;
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await dispatch(process.argv.slice(2));
  } catch (e) {
    if (e instanceof StoreError) {
      process.stderr.write(
        e.code === "busy" ? "busy\n" : `delegation: ${e.message}\n`,
      );
    } else {
      process.stderr.write(`delegation: ${(e as Error).message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
