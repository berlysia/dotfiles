import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectAuthInputs,
  sameFileIdentity,
  verifyAuthProviders,
} from "../home/dot_local/share/delegation/offload.ts";

const OFFLOAD_SRC = join(
  import.meta.dirname,
  "../home/dot_local/share/delegation/offload.ts",
);
const FIXTURE_KEY = "fixture-fixture-fixture";
const ISOLATED = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "SARASHINA_API_KEY",
];

/** Run fn with HOME at a fresh temp dir and the credential env vars removed. */
function withHome(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "delegation-offload-")));
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (ISOLATED.includes(k) || k.startsWith("OPENCODE_")) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.HOME = root;
  const dir = join(root, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    return fn({ root, dir });
  } finally {
    for (const k of Object.keys(process.env)) {
      if (ISOLATED.includes(k) || k.startsWith("OPENCODE_")) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

function makeDb(path, rows, { wal = false, columns } = {}) {
  const db = new DatabaseSync(path);
  if (wal) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
  }
  if (rows !== null) {
    db.exec(
      `CREATE TABLE credential (${columns ?? "integration_id TEXT, active INTEGER, value TEXT"})`,
    );
    for (const [id, active] of rows) {
      db.prepare(
        "INSERT INTO credential (integration_id, active, value) VALUES (?, ?, ?)",
      ).run(id, active, FIXTURE_KEY);
    }
  }
  chmodSync(path, 0o600);
  return db;
}

// ---- pure comparison ------------------------------------------------------

const F = (path, mode = 0o600, extra = {}) => ({
  path,
  symlink: false,
  ownedBySelf: true,
  mode,
  ...extra,
});
const AUTH = "/h/.local/share/opencode/auth.json";
const DB = "/h/.local/share/opencode/opencode.db";

function inputs(over = {}) {
  return {
    authFile: { kind: "missing" },
    authDb: { kind: "missing" },
    authFiles: [],
    authDir: { mode: 0o700, ownedBySelf: true, symlink: false },
    ...over,
  };
}
const okFile = (providers) => ({ kind: "ok", providers });
const okDb = (ids) => ({ kind: "ok", ids });
const rec = (authProviders) => ({ authProviders });
const joined = (r) => [r.reason, ...r.recovery].join("\n");

test("sameFileIdentity: dev and ino must both match", () => {
  assert.equal(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
  assert.equal(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
  assert.equal(sameFileIdentity({ dev: 1, ino: 2 }, { dev: 2, ino: 2 }), false);
});

test("verifyAuthProviders: auth.json names against the record", () => {
  const ok = (names, recorded) =>
    verifyAuthProviders(
      inputs({ authFile: okFile(names), authFiles: [F(AUTH)] }),
      rec(recorded),
    );
  assert.equal(ok(["zai-coding-plan"], ["zai-coding-plan"]).ok, true);
  assert.equal(
    ok(["sarashina", "zai-coding-plan"], ["sarashina", "zai-coding-plan"]).ok,
    true,
  );
  const added = ok(["sarashina", "zai-coding-plan"], ["zai-coding-plan"]);
  assert.equal(added.ok, false);
  assert.match(joined(added), /opencode-containment\.mjs/);
  const outside = ok(["zai-coding-plan", "anthropic"], ["zai-coding-plan"]);
  assert.equal(outside.ok, false);
  assert.match(joined(outside), /opencode-containment\.mjs/);
  const forged = ok(["anthropic"], ["anthropic"]);
  assert.equal(forged.ok, false);
  assert.match(joined(forged), /recovery: opencode auth logout anthropic/);
});

test("verifyAuthProviders: file modes, symlinks and owners", () => {
  const withFile = (f, extra = {}) =>
    verifyAuthProviders(
      inputs({ authFile: okFile([]), authFiles: [f], ...extra }),
      rec([]),
    );
  for (const mode of [0o644, 0o640, 0o606]) {
    const r = withFile(F(AUTH, mode));
    assert.equal(r.ok, false, mode.toString(8));
    assert.match(joined(r), new RegExp(`chmod 600 ${AUTH}`));
    assert.match(joined(r), /発行し直す/);
  }
  for (const mode of [0o600, 0o400]) {
    assert.equal(withFile(F(AUTH, mode)).ok, true, mode.toString(8));
  }
  const db = verifyAuthProviders(
    inputs({ authFiles: [F(AUTH), F(DB, 0o644)] }),
    rec([]),
  );
  assert.equal(db.ok, false);
  assert.match(joined(db), new RegExp(`chmod 600 ${DB}`));
  for (const [suffix, mode] of [
    ["-wal", 0o644],
    ["-shm", 0o666],
    ["-journal", 0o644],
  ]) {
    const r = verifyAuthProviders(
      inputs({ authFiles: [F(DB), F(DB + suffix, mode)] }),
      rec([]),
    );
    assert.equal(r.ok, false, suffix);
    assert.match(joined(r), new RegExp(`chmod 600 ${DB + suffix}`));
  }
  assert.equal(
    verifyAuthProviders(inputs({ authFiles: [F(AUTH), F(DB)] }), rec([])).ok,
    true,
  );
  assert.equal(withFile(F(AUTH, 0o600, { symlink: true })).ok, false);
  assert.equal(withFile(F(DB, 0o600, { symlink: true })).ok, false);
  assert.equal(withFile(F(AUTH, 0o600, { ownedBySelf: false })).ok, false);
  assert.equal(withFile(F(DB, 0o600, { ownedBySelf: false })).ok, false);
});

test("verifyAuthProviders: the credential directory", () => {
  const dirCase = (authDir, over = {}) =>
    verifyAuthProviders(inputs({ authDir, ...over }), rec([]));
  const d = (mode, extra = {}) => ({
    mode,
    ownedBySelf: true,
    symlink: false,
    ...extra,
  });
  for (const mode of [0o775, 0o757]) {
    const r = dirCase(d(mode));
    assert.equal(r.ok, false, mode.toString(8));
    assert.match(joined(r), /chmod go-w /);
  }
  for (const mode of [0o755, 0o700]) assert.equal(dirCase(d(mode)).ok, true);
  assert.equal(dirCase(d(null, { symlink: true })).ok, false);
  assert.equal(dirCase(d(0o777)).ok, false);
  assert.equal(dirCase(d(0o700, { ownedBySelf: false })).ok, false);
  assert.equal(
    dirCase({ mode: null, ownedBySelf: null, symlink: false }).ok,
    true,
  );
  // No credential files at all.
  assert.equal(
    verifyAuthProviders(inputs(), rec(["zai-coding-plan"])).ok,
    false,
  );
  assert.equal(
    verifyAuthProviders(inputs({ authFile: { kind: "unreadable" } }), rec([]))
      .ok,
    false,
  );
});

test("verifyAuthProviders: the table names are unioned with auth.json", () => {
  const both = ["sarashina", "zai-coding-plan"];
  assert.equal(
    verifyAuthProviders(
      inputs({
        authFile: okFile(["zai-coding-plan"]),
        authDb: okDb(["sarashina"]),
      }),
      rec(both),
    ).ok,
    true,
  );
  assert.equal(
    verifyAuthProviders(
      inputs({ authDb: okDb(["sarashina", "zai-coding-plan"]) }),
      rec(both),
    ).ok,
    true,
  );
  const added = verifyAuthProviders(
    inputs({ authDb: okDb(["sarashina"]) }),
    rec([]),
  );
  assert.equal(added.ok, false);
  assert.match(joined(added), /opencode-containment\.mjs/);
  const outside = verifyAuthProviders(
    inputs({ authDb: okDb(["anthropic"]) }),
    rec([]),
  );
  assert.equal(outside.ok, false);
  assert.match(joined(outside), /opencode auth logout anthropic/);
  const notProvider = verifyAuthProviders(
    inputs({ authDb: okDb(["mcp-github"]) }),
    rec([]),
  );
  assert.equal(notProvider.ok, false);
  assert.match(joined(notProvider), /mcp-github/);
  assert.equal(
    verifyAuthProviders(inputs({ authDb: { kind: "missing" } }), rec([])).ok,
    true,
  );
  const unopenable = verifyAuthProviders(
    inputs({ authDb: { kind: "unopenable" } }),
    rec([]),
  );
  const noTable = verifyAuthProviders(
    inputs({ authDb: { kind: "no-table" } }),
    rec([]),
  );
  assert.equal(unopenable.ok, false);
  assert.equal(noTable.ok, false);
  assert.match(unopenable.reason, /開けない/);
  assert.match(noTable.reason, /テーブルが無い/);
  assert.notEqual(unopenable.reason, noTable.reason);
  assert.equal(
    verifyAuthProviders(inputs({ authDb: okDb([]) }), rec([])).ok,
    true,
  );
});

test("verifyAuthProviders: names shown in recovery lines are sanitized", () => {
  const hostile = verifyAuthProviders(
    inputs({ authDb: okDb(["bad\u001b[31m\nname;$(id)"]) }),
    rec([]),
  );
  assert.equal(hostile.ok, false);
  const text = joined(hostile);
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    assert.ok(code === 10 || code >= 32, `control char ${code}`);
  }
  assert.doesNotMatch(text, /;|\$\(/);
  assert.match(text, /\(表示できない名前\)/);
  assert.doesNotMatch(text, /auth logout/);
  const fromFile = verifyAuthProviders(
    inputs({ authFile: okFile(["a$(id)"]) }),
    rec([]),
  );
  assert.match(joined(fromFile), /\(表示できない名前\)/);
  assert.doesNotMatch(joined(fromFile), /\$\(/);
  const plain = verifyAuthProviders(
    inputs({ authDb: okDb(["mcp-github"]) }),
    rec([]),
  );
  assert.match(joined(plain), /auth logout mcp-github/);
  const long = verifyAuthProviders(
    inputs({ authDb: okDb(["a".repeat(65)]) }),
    rec([]),
  );
  assert.match(joined(long), /\(表示できない名前\)/);
  assert.doesNotMatch(joined(long), /a{65}/);
});

// ---- collection -----------------------------------------------------------

test("collectAuthInputs: rows of the credential table, any active flag", () => {
  withHome(({ dir }) => {
    makeDb(
      join(dir, "opencode.db"),
      [
        ["sarashina", 1],
        ["zai-coding-plan", 0],
      ],
      {},
    ).close();
    const got = collectAuthInputs(process.env);
    assert.deepEqual(got.authDb, {
      kind: "ok",
      ids: ["sarashina", "zai-coding-plan"],
    });
    assert.equal(got.authFile.kind, "missing");
    assert.equal(JSON.stringify(got).includes(FIXTURE_KEY), false);
  });
});

test("collectAuthInputs: db states", () => {
  withHome(({ dir }) => {
    const db = join(dir, "opencode.db");
    assert.equal(collectAuthInputs(process.env).authDb.kind, "missing");
    makeDb(db, []).close();
    assert.deepEqual(collectAuthInputs(process.env).authDb, {
      kind: "ok",
      ids: [],
    });
    rmSync(db);
    makeDb(db, null).close();
    assert.equal(collectAuthInputs(process.env).authDb.kind, "no-table");
    rmSync(db);
    writeFileSync(db, "this is not a sqlite database at all, just bytes", {
      mode: 0o600,
    });
    assert.equal(collectAuthInputs(process.env).authDb.kind, "unopenable");
    rmSync(db);
    makeDb(db, [], { columns: "other TEXT" }).close();
    assert.equal(collectAuthInputs(process.env).authDb.kind, "unopenable");
  });
});

test("collectAuthInputs: sees rows still in the write-ahead log", () => {
  withHome(({ dir }) => {
    const writer = makeDb(join(dir, "opencode.db"), [["sarashina", 1]], {
      wal: true,
    });
    try {
      const got = collectAuthInputs(process.env);
      assert.deepEqual(got.authDb, { kind: "ok", ids: ["sarashina"] });
    } finally {
      writer.close();
    }
  });
});

test("collectAuthInputs: a locked database gives up quickly without throwing", () => {
  withHome(({ dir }) => {
    const writer = makeDb(join(dir, "opencode.db"), [["sarashina", 1]]);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const t0 = Date.now();
      const got = collectAuthInputs(process.env);
      assert.equal(got.authDb.kind, "unopenable");
      assert.ok(Date.now() - t0 < 1000);
    } finally {
      writer.close();
    }
  });
});

test("collectAuthInputs: modes and symlinks are reported", () => {
  withHome(({ dir, root }) => {
    const db = join(dir, "opencode.db");
    makeDb(db, []).close();
    chmodSync(db, 0o644);
    const loose = collectAuthInputs(process.env).authFiles.find(
      (f) => f.path === db,
    );
    assert.equal(loose.mode, 0o644);
    assert.equal(loose.symlink, false);
    assert.equal(loose.ownedBySelf, true);
    rmSync(db);
    const target = join(root, "real.db");
    makeDb(target, []).close();
    symlinkSync(target, db);
    const got = collectAuthInputs(process.env);
    assert.equal(got.authFiles.find((f) => f.path === db).symlink, true);
    assert.equal(got.authDb.kind, "unopenable");
  });
});

test("collectAuthInputs: auth.json keys only, secrets stay out", () => {
  withHome(({ dir }) => {
    const auth = join(dir, "auth.json");
    writeFileSync(
      auth,
      JSON.stringify({ "zai-coding-plan": { key: FIXTURE_KEY } }),
      {
        mode: 0o600,
      },
    );
    const got = collectAuthInputs(process.env);
    assert.deepEqual(got.authFile, {
      kind: "ok",
      providers: ["zai-coding-plan"],
    });
    assert.equal(JSON.stringify(got).includes(FIXTURE_KEY), false);
    writeFileSync(auth, `{"${FIXTURE_KEY}":`, { mode: 0o600 });
    let out = "";
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = (s) => ((out += String(s)), true);
    process.stderr.write = (s) => ((out += String(s)), true);
    let broken;
    try {
      broken = collectAuthInputs(process.env);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    assert.deepEqual(broken.authFile, { kind: "unreadable" });
    assert.equal(JSON.stringify(broken).includes(FIXTURE_KEY), false);
    assert.equal(out.includes(FIXTURE_KEY), false);
    const verdict = verifyAuthProviders(broken, rec([]));
    assert.equal(verdict.reason, "auth.json unreadable");
    assert.equal(joined(verdict).includes(FIXTURE_KEY), false);
  });
});

test("collectAuthInputs: directory states", () => {
  withHome(({ dir, root }) => {
    assert.deepEqual(collectAuthInputs(process.env).authDir, {
      mode: 0o700,
      ownedBySelf: true,
      symlink: false,
    });
    chmodSync(dir, 0o775);
    assert.equal(collectAuthInputs(process.env).authDir.mode, 0o775);
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true });
    assert.deepEqual(collectAuthInputs(process.env).authDir, {
      mode: null,
      ownedBySelf: null,
      symlink: false,
    });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), dir);
    assert.equal(collectAuthInputs(process.env).authDir.symlink, true);
  });
});

test("collectAuthInputs ignores XDG and credential env vars", () => {
  const before = { ...process.env };
  withHome(({ dir, root }) => {
    process.env.XDG_DATA_HOME = join(root, "other");
    process.env.ZAI_API_KEY = FIXTURE_KEY;
    process.env.SARASHINA_API_KEY = FIXTURE_KEY;
    makeDb(join(dir, "opencode.db"), [["sarashina", 1]]).close();
    const got = collectAuthInputs(process.env);
    assert.deepEqual(got.authDb, { kind: "ok", ids: ["sarashina"] });
  });
  assert.deepEqual({ ...process.env }, before);
});

// ---- source checks --------------------------------------------------------

test("offload.ts source: imports, no hard-coded providers, SQL shape", () => {
  const src = readFileSync(OFFLOAD_SRC, "utf8");
  const targets = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  for (const t of targets) {
    assert.ok(
      t.startsWith("node:") ||
        ["./constants.ts", "./destinations.ts", "./store.ts"].includes(t),
      t,
    );
  }
  assert.equal(src.includes('"sarashina"'), false);
  assert.equal(src.includes('"zai-coding-plan"'), false);
  assert.ok(src.includes("SELECT DISTINCT integration_id FROM credential"));
  assert.equal(/SELECT\s+value/i.test(src), false);
  assert.equal(/,\s*value\b/.test(src), false);
  assert.equal(/immutable/i.test(src), false);
});
