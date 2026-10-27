import type { EngineInterface, Register } from "claude-code";
import type { Timer } from "claude-code";
import { type RateLimitSample, type RateLimitWindow } from "./forecast";
import { buildLineInput } from "./line";
import { externalFilePath, lineFilePath } from "./line-file";
import { buildExternalFile, externalFetchDue } from "./external";
import type { ForecastFile } from "./status-input";
import {
  collectWindows,
  decode,
  encode,
  isRecordDue,
  mergeAll,
  nextWakeAt,
  pruneOwn,
  selectKeysToDelete,
} from "./samples";

const KEY_PREFIX = "samples:v1:";
// Other sessions' samples are re-read at most this often: reading 12 keys took
// 75-157 ms in the field test, too slow to pay on every recorded measure.
const REREAD_INTERVAL_MS = 600_000;

type UsageState = {
  /** Every session's samples; the own key is the memory copy, which wins. */
  byKey: Map<string, RateLimitSample[]>;
  /** Survives a session id change, so the same reading is not recorded twice. */
  lastRecorded: Partial<Record<RateLimitWindow, RateLimitSample>>;
  timer: Timer | null;
  externalTick: Timer | null;
  externalInitial: Timer | null;
  externalInFlight: boolean;
  externalLogged: Set<ExternalFailure>;
  loggedReject: boolean;
  loggedWriteReject: boolean;
  loaded: boolean;
  lastRereadAt: number | null;
};

function createState(): UsageState {
  return {
    byKey: new Map(),
    lastRecorded: {},
    timer: null,
    externalTick: null,
    externalInitial: null,
    externalInFlight: false,
    externalLogged: new Set(),
    loggedReject: false,
    loggedWriteReject: false,
    loaded: false,
    lastRereadAt: null,
  };
}

// The engine follows `$` only into functions declared at the top level of the
// module (a closure inside `register` makes the module fail to load), so every
// helper below takes `$` and the state as arguments.

type ExternalFailure = "run-rejected" | "bad-output" | "write-rejected";

function logExternal(
  $: EngineInterface,
  state: UsageState,
  kind: ExternalFailure,
): void {
  if (state.externalLogged.has(kind)) return;
  state.externalLogged.add(kind);
  $.ui.log(`usage-line: external ${kind}`, { to: "debug" });
}

/**
 * Runs ai-usage at most once per 5 minutes across sessions and writes the
 * shared file. `attemptAt` is written before the run, so a failing fetch is not
 * retried by every session on every tick. Started from timers only: work begun
 * inside a handler may stop when that dispatch is abandoned.
 */
async function fetchExternal(
  $: EngineInterface,
  state: UsageState,
): Promise<void> {
  if (state.externalInFlight) return;
  state.externalInFlight = true;
  try {
    const path = externalFilePath({
      XDG_RUNTIME_DIR: await $.env.get("XDG_RUNTIME_DIR"),
      TMPDIR: await $.env.get("TMPDIR"),
    });
    if (path === null) return;
    const now = await $.clock.now();
    if (!externalFetchDue(await $.store.get("external:v1"), now)) return;
    try {
      await $.store.set("external:v1", { attemptAt: now });
    } catch {
      logExternal($, state, "write-rejected");
      return;
    }
    let stdout: string;
    try {
      const result = await $.process.run(
        [
          "ai-usage",
          "codex",
          "opencode",
          "cursor",
          "--summary",
          "--timeout",
          "8",
        ],
        { timeoutMs: 60_000 },
      );
      stdout = result.stdout;
    } catch {
      logExternal($, state, "run-rejected");
      return;
    }
    const file = buildExternalFile(stdout, await $.clock.now());
    if (file === null) {
      logExternal($, state, "bad-output");
      return;
    }
    try {
      await $.fs.write(path, JSON.stringify(file));
    } catch {
      logExternal($, state, "write-rejected");
    }
  } finally {
    state.externalInFlight = false;
  }
}

function armExternal($: EngineInterface, state: UsageState): void {
  state.externalTick?.cancel();
  state.externalInitial?.cancel();
  state.externalTick = $.clock.every(60_000, () => {
    void fetchExternal($, state).catch(() => undefined);
  });
  state.externalInitial = $.clock.after(0, () => {
    void fetchExternal($, state).catch(() => undefined);
  });
}

/**
 * Hands the forecasts to statusline.ts, which draws the line. Only windows
 * that have a latest sample are written; the file is written every time (its
 * `at` moves) so the reader can tell the mod is alive.
 */
async function writeForecastFile(
  $: EngineInterface,
  state: UsageState,
  input: ReturnType<typeof buildLineInput>,
  now: number,
): Promise<void> {
  const path = lineFilePath(
    {
      XDG_RUNTIME_DIR: await $.env.get("XDG_RUNTIME_DIR"),
      TMPDIR: await $.env.get("TMPDIR"),
    },
    await $.session.id(),
  );
  if (path === null) return;
  const windows: ForecastFile["windows"] = {};
  for (const window of ["five_hour", "seven_day"] as const) {
    const { latest, forecast } = input.windows[window];
    if (latest === null) continue;
    windows[window] = { resetsAt: latest.resetsAt, forecast };
  }
  const file: ForecastFile = { v: 1, at: now, windows };
  try {
    await $.fs.write(path, JSON.stringify(file));
  } catch (error) {
    if (!state.loggedWriteReject) {
      state.loggedWriteReject = true;
      $.ui.log(
        `usage-line: could not write forecast file: ${error instanceof Error ? error.message : String(error)}`,
        { to: "debug" },
      );
    }
  }
}

/**
 * Re-reads the store: deletes expired keys and rebuilds `byKey`. The own key
 * keeps its memory copy whenever it has one, because the store may be behind
 * (a rejected `set`) or this call may have raced a `session.measure` that
 * recorded while the reads were in flight.
 */
async function loadAll(
  $: EngineInterface,
  state: UsageState,
  now: number,
): Promise<void> {
  const ownKey = `${KEY_PREFIX}${await $.session.id()}`;
  const keys = (await $.store.keys()).filter((k) => k.startsWith(KEY_PREFIX));
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, unknown]> => [
      key,
      await $.store.get(key),
    ]),
  );
  const doomed = new Set(
    selectKeysToDelete(entries, now).filter((key) => key !== ownKey),
  );
  await Promise.all([...doomed].map((key) => $.store.delete(key)));

  // From here to the assignment nothing is awaited: `state.byKey` is read at
  // the moment it is replaced, so a concurrent measure's samples are not lost.
  const rebuilt = new Map<string, RateLimitSample[]>();
  const ownInMemory = state.byKey.get(ownKey);
  if (ownInMemory !== undefined) rebuilt.set(ownKey, ownInMemory);
  for (const [key, value] of entries) {
    if (doomed.has(key) || rebuilt.has(key)) continue;
    rebuilt.set(key, decode(value, now));
  }
  state.byKey = rebuilt;
  state.lastRereadAt = now;
}

function scheduleWake(
  $: EngineInterface,
  state: UsageState,
  waitMs: number,
): Timer {
  return $.clock.after(waitMs, () => {
    void rebuildLine($, state).catch(() => undefined);
  });
}

async function rebuildLine(
  $: EngineInterface,
  state: UsageState,
): Promise<void> {
  const now = await $.clock.now();
  const merged = mergeAll(state.byKey);
  await writeForecastFile($, state, buildLineInput(merged, null, now), now);
  state.timer?.cancel();
  state.timer = null;
  const wakeAt = nextWakeAt(merged, now);
  if (wakeAt !== null) state.timer = scheduleWake($, state, wakeAt - now);
}

async function recordMeasure(
  $: EngineInterface,
  state: UsageState,
  e: { rateLimits: unknown },
): Promise<void> {
  const now = await $.clock.now();
  let didLoad = false;
  if (!state.loaded) {
    // A hot reload, or a measure that arrived before session.start finished.
    await loadAll($, state, now);
    state.loaded = true;
    didLoad = true;
  }

  const due = collectWindows(e.rateLimits).filter((observed) =>
    isRecordDue(state.lastRecorded[observed.window], observed, now),
  );
  if (due.length > 0) {
    const added: RateLimitSample[] = due.map((observed) => ({
      ...observed,
      sampledAt: now,
    }));
    const ownKey = `${KEY_PREFIX}${await $.session.id()}`;
    const own = pruneOwn([...(state.byKey.get(ownKey) ?? []), ...added], now);
    state.byKey.set(ownKey, own);
    try {
      await $.store.set(ownKey, encode(own));
      for (const sample of added) state.lastRecorded[sample.window] = sample;
      const isRereadDue =
        state.lastRereadAt === null ||
        now - state.lastRereadAt >= REREAD_INTERVAL_MS;
      if (!didLoad && isRereadDue) await loadAll($, state, now);
    } catch (error) {
      // Drop what was added so the next measure records it again.
      state.byKey.set(
        ownKey,
        (state.byKey.get(ownKey) ?? []).filter((s) => !added.includes(s)),
      );
      if (!state.loggedReject) {
        state.loggedReject = true;
        $.ui.log(
          `usage-line: could not save samples: ${error instanceof Error ? error.message : String(error)}`,
          { to: "debug" },
        );
      }
    }
  }
  await rebuildLine($, state);
}

export const register: Register = (on) => {
  // Made here, synchronously: a measure can arrive before session.start ends.
  const state = createState();

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    armExternal($, state);
    try {
      await loadAll($, state, await $.clock.now());
      state.loaded = true;
      await rebuildLine($, state);
    } catch {
      // The forecast file is a convenience; the session goes on without it.
    }
    return result;
  });

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    try {
      await recordMeasure($, state, e);
    } catch {
      // As above.
    }
    return result;
  });
};
