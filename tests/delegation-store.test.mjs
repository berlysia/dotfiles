import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  StoreError,
  appendLedger,
  createPending,
  foldLedger,
  listPending,
  newDelegationId,
  openStore,
  readLedger,
  readPending,
  resolveDataDir,
  updatePending,
  withPendingLock,
} from "../home/dot_local/share/delegation/store.ts";

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-store-")));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { HOME: home };
  return { root, home, env, done: () => rmSync(root, { recursive: true }) };
}

const pendingOf = (id, extra = {}) => ({
  v: 1,
  id,
  openedAt: "2026-10-29T00:00:00.000Z",
  sessionId: "s1",
  toolUseId: `tu-${id}`,
  harness: "claude-code-agent",
  invocation: [],
  model: "sonnet",
  effort: "high",
  agentId: null,
  closedAt: null,
  endReason: null,
  durationMs: null,
  ...extra,
});
const delegationOf = (id, extra = {}) => ({
  v: 1,
  type: "delegation",
  id,
  at: "2026-10-29T00:00:00.000Z",
  harness: "claude-code-agent",
  invocation: [],
  model: "sonnet",
  effort: "high",
  kind: "impl",
  size: "M",
  sessionId: "s1",
  manual: false,
  durationMs: null,
  endReason: null,
  verdict: "adopted",
  ...extra,
});
const A = "d-aaaaaaaaaaaa";
const B = "d-bbbbbbbbbbbb";
const fast = { retryDelayMs: 0 };

test("relative XDG_DATA_HOME is ignored", () => {
  const sb = sandbox();
  try {
    assert.equal(
      resolveDataDir({ HOME: sb.home, XDG_DATA_HOME: "relative/path" }),
      join(sb.home, ".local/share/delegation-ledger"),
    );
    assert.equal(
      resolveDataDir({ HOME: sb.home, XDG_DATA_HOME: join(sb.root, "xdg") }),
      join(sb.root, "xdg/delegation-ledger"),
    );
  } finally {
    sb.done();
  }
});

test("data dir that is a symlink is refused", () => {
  const sb = sandbox();
  try {
    const target = join(sb.root, "elsewhere");
    mkdirSync(target);
    mkdirSync(join(sb.home, ".local/share"), { recursive: true });
    symlinkSync(target, join(sb.home, ".local/share/delegation-ledger"));
    assert.throws(
      () => openStore(sb.env),
      (e) => e instanceof StoreError && e.code === "symlink",
    );
  } finally {
    sb.done();
  }
});

for (const mask of [0o022, 0o077]) {
  test(`modes are 0700 dir / 0600 files under umask ${mask.toString(8)}`, () => {
    const sb = sandbox();
    const old = process.umask(mask);
    try {
      const store = openStore(sb.env, fast);
      createPending(store, pendingOf(A));
      appendLedger(store, delegationOf(A));
      assert.equal(statSync(store.dir).mode & 0o777, 0o700);
      assert.equal(statSync(store.pendingDir).mode & 0o777, 0o700);
      assert.equal(statSync(store.ledgerPath).mode & 0o777, 0o600);
      assert.equal(
        statSync(join(store.pendingDir, `${A}.json`)).mode & 0o777,
        0o600,
      );
    } finally {
      process.umask(old);
      sb.done();
    }
  });
}

test("ledger or pending file that is a symlink is refused", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    const decoy = join(sb.root, "decoy");
    writeFileSync(decoy, "");
    symlinkSync(decoy, store.ledgerPath);
    assert.throws(() => readLedger(store), /symlink/);
    assert.throws(() => appendLedger(store, delegationOf(A)), /symlink/);
    writeFileSync(decoy, JSON.stringify(pendingOf(B)));
    symlinkSync(decoy, join(store.pendingDir, `${B}.json`));
    assert.throws(() => readPending(store, B), /symlink/);
  } finally {
    sb.done();
  }
});

test("createPending is exclusive", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    assert.equal(createPending(store, pendingOf(A)), true);
    assert.equal(createPending(store, pendingOf(A)), false);
  } finally {
    sb.done();
  }
});

test("ids avoid pending and ledger collisions", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    const id = newDelegationId(store, new Set());
    assert.match(id, /^d-[0-9a-f]{12}$/);
  } finally {
    sb.done();
  }
});

test("fold: first delegation row wins", () => {
  const folded = foldLedger([
    delegationOf(A, { verdict: "adopted" }),
    delegationOf(A, { verdict: "discarded" }),
  ]);
  assert.equal(folded.delegations.length, 1);
  assert.equal(folded.delegations[0].verdict, "adopted");
});

test("fold: lapse rows collapse per id and lose to a delegation row", () => {
  const lapse = (id) => ({
    v: 1,
    type: "lapse",
    id,
    at: "2026-10-29T00:00:00.000Z",
    openedAt: null,
    harness: "codex-cli",
    invocation: [],
    model: "unknown",
    effort: "unknown",
    sessionId: null,
    durationMs: null,
    endReason: null,
  });
  assert.equal(foldLedger([lapse(A), lapse(A)]).lapses.length, 1);
  assert.equal(foldLedger([lapse(A), delegationOf(A)]).lapses.length, 0);
  assert.equal(foldLedger([delegationOf(A), lapse(A)]).lapses.length, 0);
});

test("fold: amend reworks add up and cap at 999; orphan amends are counted", () => {
  const amend = (id) => ({ v: 1, type: "amend", id, at: "x", reworks: 1 });
  const folded = foldLedger([
    delegationOf(A, { reworks: 998 }),
    amend(A),
    amend(A),
    amend(A),
    amend(B),
    {
      v: 1,
      type: "amend",
      id: A,
      at: "x",
      laterDefect: { foundBy: "reviewer" },
    },
  ]);
  assert.equal(folded.delegations[0].reworks, 999);
  assert.deepEqual(folded.delegations[0].laterDefects, ["reviewer"]);
  assert.equal(folded.ignoredAmends, 1);
});

test("readLedger counts skipped rows by kind and reports size", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    appendLedger(store, delegationOf(A));
    appendFileSync(store.ledgerPath, '{"v":2,"type":"delegation"}\n');
    appendFileSync(store.ledgerPath, '{"v":1,"type":"zzz"}\n');
    appendFileSync(store.ledgerPath, "{broken\n");
    const r = readLedger(store);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.skipped, { version: 1, type: 1, broken: 1 });
    assert.equal(r.large, false);
  } finally {
    sb.done();
  }
});

test("bind and close in either order keep both updates (10 rounds)", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    for (let i = 0; i < 10; i++) {
      const id = `d-${String(i).padStart(12, "0")}`;
      createPending(store, pendingOf(id));
      const bind = () =>
        updatePending(store, id, (p) => ({ ...p, agentId: "ag1" }));
      const close = () =>
        updatePending(store, id, (p) => ({
          ...p,
          closedAt: "2026-10-29T01:00:00.000Z",
        }));
      if (i % 2 === 0) {
        bind();
        close();
      } else {
        close();
        bind();
      }
      const p = readPending(store, id);
      assert.equal(p.agentId, "ag1");
      assert.equal(p.closedAt, "2026-10-29T01:00:00.000Z");
    }
  } finally {
    sb.done();
  }
});

test("update while the lock is held gives up as busy and changes nothing", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    createPending(store, pendingOf(A));
    withPendingLock(store, A, () => {
      assert.throws(
        () => updatePending(store, A, (p) => ({ ...p, agentId: "x" })),
        (e) => e instanceof StoreError && e.code === "busy",
      );
    });
    assert.equal(readPending(store, A).agentId, null);
    // lock is released afterwards
    updatePending(store, A, (p) => ({ ...p, agentId: "x" }));
    assert.equal(readPending(store, A).agentId, "x");
  } finally {
    sb.done();
  }
});

test("a lock older than 10 s is taken over", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    createPending(store, pendingOf(A));
    const lock = join(store.pendingDir, `${A}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    updatePending(store, A, (p) => ({ ...p, agentId: "y" }));
    assert.equal(readPending(store, A).agentId, "y");
    assert.equal(existsSync(lock), false);
  } finally {
    sb.done();
  }
});

test("listPending ignores locks and temp files", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    createPending(store, pendingOf(A));
    mkdirSync(join(store.pendingDir, `${B}.lock`));
    writeFileSync(join(store.pendingDir, `${B}.json.tmp-zz`), "{}");
    assert.deepEqual(
      listPending(store).map((p) => p.id),
      [A],
    );
    assert.deepEqual(readdirSync(store.pendingDir).length, 3);
  } finally {
    sb.done();
  }
});

test("ledger over 5 MB is flagged", () => {
  const sb = sandbox();
  try {
    const store = openStore(sb.env, fast);
    writeFileSync(store.ledgerPath, "x".repeat(5 * 1024 * 1024 + 1) + "\n", {
      mode: 0o600,
    });
    assert.equal(readLedger(store).large, true);
    assert.ok(readFileSync(store.ledgerPath).length > 0);
  } finally {
    sb.done();
  }
});
