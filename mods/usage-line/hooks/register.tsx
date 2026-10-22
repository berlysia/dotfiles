import type { EngineInterface, Register } from "claude-code";
import type { Timer } from "claude-code";
import { type RateLimitSample, type RateLimitWindow } from "./forecast";
import { formatLine } from "./format";
import { buildLineInput } from "./line";
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

// `plugin` and `key` must be literals for `$.state`, so the ref lives here.
const lineRef = { plugin: "usage-line", key: "line" } as const;

type UsageState = {
  /** Every session's samples; the own key is the memory copy, which wins. */
  byKey: Map<string, RateLimitSample[]>;
  /** Survives a session id change, so the same reading is not recorded twice. */
  lastRecorded: Partial<Record<RateLimitWindow, RateLimitSample>>;
  contextPercent: number | null;
  timer: Timer | null;
  loggedReject: boolean;
  loaded: boolean;
  lastRereadAt: number | null;
};

function createState(): UsageState {
  return {
    byKey: new Map(),
    lastRecorded: {},
    contextPercent: null,
    timer: null,
    loggedReject: false,
    loaded: false,
    lastRereadAt: null,
  };
}

// The engine follows `$` only into functions declared at the top level of the
// module (a closure inside `register` makes the module fail to load), so every
// helper below takes `$` and the state as arguments.

async function publishLine(
  $: EngineInterface,
  line: string | undefined,
): Promise<void> {
  // null, not undefined: a PluginState value stays JSON.
  await $.state.set(lineRef, line ?? null);
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
  const line = formatLine(
    buildLineInput(merged, state.contextPercent, now),
    now,
  );
  await publishLine($, line);
  state.timer?.cancel();
  state.timer = null;
  const wakeAt = nextWakeAt(merged, now);
  if (wakeAt !== null) state.timer = scheduleWake($, state, wakeAt - now);
}

async function recordMeasure(
  $: EngineInterface,
  state: UsageState,
  e: { context: { percent?: number | null }; rateLimits: unknown },
): Promise<void> {
  const now = await $.clock.now();
  let didLoad = false;
  if (!state.loaded) {
    // A hot reload, or a measure that arrived before session.start finished.
    await loadAll($, state, now);
    state.loaded = true;
    didLoad = true;
  }
  state.contextPercent = e.context.percent ?? null;

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
    try {
      await loadAll($, state, await $.clock.now());
      state.loaded = true;
      await rebuildLine($, state);
    } catch {
      // The line is a convenience; the session goes on without it.
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

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    try {
      const { value: line } = await $.state.get(lineRef);
      if (typeof line !== "string" || line === "") return await next(e);
      const tail = e.props.tail;
      return await next({
        ...e,
        props: {
          ...e.props,
          tail: tail === undefined || tail === "" ? line : `${tail}  ${line}`,
        },
      });
    } catch {
      return next(e);
    }
  });
};
