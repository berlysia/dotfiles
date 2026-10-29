import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { withHome } from "./lib/delegation-offload-home.mjs";
import * as offloadModule from "../home/dot_local/share/delegation/offload.ts";
import {
  EDIT_DENY,
  READ_DENY,
  buildChildEnv,
  buildLogLine,
  buildOpencodeArgv,
  buildVerifiedRecord,
  collectAuthInputs,
  collectOffloadInputs,
  hashPlanFile,
  loadBrief,
  offloadDirPath,
  offloadRecordPath,
  parseOffloadArgs,
  parseVerifiedRecord,
  sameFileIdentity,
  verifyAuthProviders,
  verifyOffload,
} from "../home/dot_local/share/delegation/offload.ts";

const OFFLOAD_SRC = join(
  import.meta.dirname,
  "../home/dot_local/share/delegation/offload.ts",
);
const FIXTURE_KEY = "fixture-fixture-fixture";

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

// ---- arguments --------------------------------------------------------------

const GLM = "zai-coding-plan/glm-5.3";
const SARASHINA_MODEL = "sarashina/sarashina3.2-mini-thinking";
const FREE_GLM = "opencode/glm-5.3-flash-free";

function argvOf(over = {}) {
  const base = {
    "--exposure": "external-ok",
    "--model": GLM,
    "--brief-file": "/tmp/brief.md",
    "--dir": "/tmp/work",
    ...over,
  };
  const out = [];
  for (const [k, v] of Object.entries(base)) {
    if (v !== null) out.push(k, v);
  }
  return out;
}
const parseArgs = (argv, env = {}) =>
  parseOffloadArgs(argv, { cwd: "/tmp/cwd", env });

test("parseOffloadArgs: exposure", () => {
  assert.equal(parseArgs(argvOf()).ok, true);
  for (const v of [null, "closed", "public"]) {
    assert.equal(parseArgs(argvOf({ "--exposure": v })).ok, false, String(v));
  }
});

test("parseOffloadArgs: only sendsOut models, exactly once", () => {
  for (const m of [GLM, SARASHINA_MODEL, FREE_GLM]) {
    assert.equal(parseArgs(argvOf({ "--model": m })).ok, true, m);
  }
  const closed = parseArgs(
    argvOf({ "--exposure": "closed", "--model": SARASHINA_MODEL }),
  );
  assert.equal(closed.ok, false);
  assert.equal(closed.model, SARASHINA_MODEL);
  for (const m of ["sonnet", "gpt-6.1-terra", "x"]) {
    assert.equal(parseArgs(argvOf({ "--model": m })).ok, false, m);
  }
  assert.equal(
    parseArgs([...argvOf({ "--model": "a" }), "--model", "a"]).ok,
    false,
  );
  assert.equal(parseArgs([...argvOf(), "--model", GLM]).ok, false);
  assert.equal(parseArgs(argvOf({ "--model": null })).model, null);
});

test("parseOffloadArgs: absolute paths and the dir length", () => {
  assert.equal(parseArgs(argvOf({ "--brief-file": "b.md" })).ok, false);
  assert.equal(parseArgs(argvOf({ "--dir": "work" })).ok, false);
  assert.equal(parseArgs(argvOf({ "--dir": null })).args.dir, "/tmp/cwd");
  assert.equal(parseArgs(argvOf({ "--dir": `/${"a".repeat(1023)}` })).ok, true);
  assert.equal(
    parseArgs(argvOf({ "--dir": `/${"a".repeat(1024)}` })).ok,
    false,
  );
  assert.equal(parseArgs(argvOf({ "--plan": "p.md" })).ok, false);
  assert.equal(parseArgs(argvOf({ "--plan": "/p.md" })).args.plan, "/p.md");
  assert.equal(parseArgs([...argvOf(), "--write"]).args.write, true);
  assert.equal(parseArgs([...argvOf(), "--bogus"]).ok, false);
});

test("parseOffloadArgs: proxy variables", () => {
  for (const env of [
    { https_proxy: "http://u:p@h:1" },
    { http_proxy: "socks5://h:1" },
    { HTTPS_PROXY: "http://u:p@h:1" },
    { HTTP_PROXY: "socks5://h:1" },
  ]) {
    assert.equal(parseArgs(argvOf(), env).ok, false, JSON.stringify(env));
  }
  assert.equal(parseArgs(argvOf(), { https_proxy: "http://h:3128" }).ok, true);
  const childEnv = buildChildEnv({
    https_proxy: "http://h:3128",
    PATH: "/bin",
  });
  assert.equal(childEnv.https_proxy, "http://h:3128");
});

// ---- brief and plan ------------------------------------------------------------

function loadText(text) {
  return withHome(({ root }) => {
    const p = join(root, "brief.md");
    writeFileSync(p, text, { mode: 0o600 });
    return loadBrief(p);
  });
}
const loadBytes = (bytes) =>
  withHome(({ root }) => {
    const p = join(root, "brief.md");
    writeFileSync(p, bytes, { mode: 0o600 });
    return loadBrief(p);
  });

test("loadBrief: size, NUL and leading dash", () => {
  assert.equal(loadBytes(Buffer.alloc(0)).ok, false);
  assert.equal(loadBytes(Buffer.alloc(100 * 1024, 0x61)).ok, true);
  assert.equal(loadBytes(Buffer.alloc(100 * 1024 + 1, 0x61)).ok, false);
  assert.equal(loadBytes(Buffer.from("ab\0cd")).ok, false);
  assert.equal(loadText("--attach=x\nrest").ok, false);
  assert.equal(loadText("fine\n--attach=x").ok, true);
});

test("loadBrief: secret shapes are refused without echoing them", () => {
  const cases = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ["x ghp_", "a".repeat(36)].join(""),
    ["see sk-ant-", "b".repeat(30)].join(""),
    ["AKIA", "A".repeat(16)].join(""),
  ];
  for (const text of cases) {
    const r = loadText(text);
    assert.equal(r.ok, false, text);
    assert.equal(r.reason.includes("ghp_"), false);
    assert.equal(r.reason.includes("a".repeat(10)), false);
    assert.equal(r.reason.includes("BEGIN"), false);
    assert.equal(r.excerpt, undefined);
  }
  const both = loadText(`${["ghp_", "a".repeat(36)].join("")} and @/etc/hosts`);
  assert.equal(both.ok, false);
  assert.match(both.reason, /秘密/);
  assert.equal(both.excerpt, undefined);
});

test("loadBrief: attachment-looking @ is refused with an excerpt", () => {
  const refused = [
    "見て @/etc/hosts",
    "@~/.ssh/id_ed25519",
    "(@/etc/passwd)",
    ":@/etc/hosts",
    '"@/x"',
    "[@~/.ssh/id_ed25519]",
    "@../../.ssh/id_rsa",
    "@.env",
    "@src/a.ts",
    "`@types/node`",
    "x@/etc/hosts",
    ".@/x",
    "-@~/x",
    "_@../x",
    "見て@/etc/hosts",
    "見て@src/a.ts",
  ];
  for (const text of refused) {
    const input = text.startsWith("-") ? `ok ${text}` : text;
    const r = loadText(input);
    assert.equal(r.ok, false, text);
    assert.match(r.reason, /添付に見える @/);
    assert.ok(r.excerpt?.includes("@"), text);
  }
  const controls = loadText("a\u001b[31m\n@/x");
  assert.equal(controls.ok, false);
  assert.equal(controls.excerpt.includes("\u001b"), false);
  assert.equal(controls.excerpt.includes("\n"), false);
  assert.match(controls.excerpt, /\\u001b/);
  const c1 = loadText("a\u009b@/x");
  assert.doesNotMatch(c1.excerpt, /\u009b/);
  assert.match(c1.excerpt, /\\u009b/);
});

test("loadBrief: ordinary text passes", () => {
  for (const text of [
    ["sk-", "c".repeat(30)].join(""),
    "password=x is only a word",
    "a@b.example",
    "user.name@host.example",
    "メールは @ で区切る",
  ]) {
    assert.equal(loadText(text).ok, true, text);
  }
});

test("loadBrief and hashPlanFile: only regular files read from one fd", () => {
  withHome(({ root }) => {
    const real = join(root, "real.md");
    writeFileSync(real, "hello", { mode: 0o600 });
    const link = join(root, "link.md");
    symlinkSync(real, link);
    assert.equal(loadBrief(link).ok, false);
    assert.equal(hashPlanFile(link).ok, false);
    const fifo = join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    assert.equal(hashPlanFile(fifo).ok, false);
    assert.equal(loadBrief(fifo).ok, false);
    assert.equal(hashPlanFile("/dev/zero").ok, false);
    const plan = hashPlanFile(real);
    assert.equal(plan.ok, true);
    assert.match(plan.sha256, /^[0-9a-f]{64}$/);
    const big = join(root, "big.md");
    writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(hashPlanFile(big).ok, false);
  });
});

// ---- record and verification ------------------------------------------------

const HEX = (c) => c.repeat(64);
function goodRecord(over = {}) {
  return {
    v: 1,
    verifiedAt: "2026-10-29T00:00:00.000Z",
    realpath: "/opt/opencode/bin/opencode",
    executableSha256: HEX("a"),
    targets: [{ path: "/opt/opencode/real", sha256: HEX("b") }],
    version: "2.2.0",
    configSha256: HEX("c"),
    authProviders: [],
    models: [GLM],
    ...over,
  };
}
const parseRec = (o) => parseVerifiedRecord(Buffer.from(JSON.stringify(o)));

function inputsFor(record, over = {}) {
  return {
    realpath: record.realpath,
    executableSha256: record.executableSha256,
    targetSha256: Object.fromEntries(
      record.targets.map((t) => [t.path, t.sha256]),
    ),
    configSha256: record.configSha256,
    foundConfigPaths: [],
    record: parseRec(record),
    ...inputs(),
    ...over,
  };
}

test("parseVerifiedRecord: malformed records are broken, v mismatch is its own state", () => {
  assert.equal(parseRec(goodRecord()).kind, "ok");
  assert.equal(parseRec({ ...goodRecord(), note: "extra" }).kind, "ok");
  assert.deepEqual(parseRec(goodRecord({ v: 2 })), { kind: "version", v: 2 });
  const without = (key) => {
    const r = goodRecord();
    delete r[key];
    return r;
  };
  const bad = [
    without("models"),
    goodRecord({ models: [] }),
    goodRecord({ executableSha256: 12 }),
    goodRecord({ executableSha256: "a".repeat(63) }),
    goodRecord({ executableSha256: HEX("A") }),
    goodRecord({ realpath: "relative/opencode" }),
    goodRecord({ targets: [{ path: "/x" }] }),
    goodRecord({ targets: [{ path: "x", sha256: HEX("b") }] }),
    goodRecord({ verifiedAt: "x" }),
    goodRecord({ version: "" }),
    goodRecord({ version: "  " }),
    goodRecord({ authProviders: ["b", "a"] }),
    goodRecord({ authProviders: ["a", "a"] }),
    goodRecord({ authProviders: "a" }),
    goodRecord({ v: "1" }),
    [1, 2],
  ];
  for (const r of bad) {
    assert.equal(parseRec(r).kind, "broken", JSON.stringify(r));
  }
  assert.equal(parseVerifiedRecord(Buffer.from("{not json")).kind, "broken");
});

test("verifyOffload: each mismatch is refused, a full match passes", () => {
  const rec0 = goodRecord();
  const ok = verifyOffload(inputsFor(rec0));
  assert.deepEqual(ok, { ok: true, models: [GLM] });

  const missing = verifyOffload(
    inputsFor(rec0, { record: { kind: "missing" } }),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.check, "verify");
  assert.match(missing.recovery.join("\n"), /opencode-containment\.mjs/);

  const v2 = verifyOffload(
    inputsFor(rec0, { record: { kind: "version", v: 2 } }),
  );
  assert.match(v2.reason, /形式の版が違う記録（v=2）/);

  for (const state of [
    { realpath: "/elsewhere/opencode" },
    { executableSha256: HEX("d") },
    { targetSha256: { "/opt/opencode/real": HEX("d") } },
    { targetSha256: {} },
    { configSha256: HEX("d") },
    { configSha256: null },
  ]) {
    const r = verifyOffload(inputsFor(rec0, state));
    assert.equal(r.ok, false, JSON.stringify(state));
    assert.equal(r.check, "verify");
  }
  for (const found of [
    ["/h/.config/opencode/plugin"],
    ["/h/.config/opencode/opencode.json"],
    ["/h/.opencode/plugin"],
  ]) {
    assert.equal(
      verifyOffload(inputsFor(rec0, { foundConfigPaths: found })).ok,
      false,
      found[0],
    );
  }
});

test("verifyOffload: a missing opencode is resolve, whatever the record says", () => {
  for (const record of [
    { kind: "missing" },
    { kind: "broken", reason: "x" },
    parseRec(goodRecord()),
  ]) {
    const r = verifyOffload(
      inputsFor(goodRecord(), { realpath: null, record }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.check, "resolve");
  }
});

test("verifyOffload: the credential comparison is part of it", () => {
  const r = verifyOffload(
    inputsFor(goodRecord(), { authDb: { kind: "ok", ids: ["anthropic"] } }),
  );
  assert.equal(r.ok, false);
  assert.match(r.recovery.join("\n"), /auth logout anthropic/);
});

test("buildVerifiedRecord output passes verifyOffload and parses back", () => {
  const rec0 = goodRecord();
  const base = inputsFor(rec0, {
    authFile: { kind: "ok", providers: ["zai-coding-plan"] },
    authDb: { kind: "ok", ids: ["sarashina", "zai-coding-plan"] },
  });
  const built = buildVerifiedRecord({
    inputs: base,
    version: " 2.2.0\n",
    models: [GLM],
    targets: rec0.targets,
    now: new Date("2026-10-29T00:00:00Z"),
  });
  assert.deepEqual(built.authProviders, ["sarashina", "zai-coding-plan"]);
  assert.equal(built.version, "2.2.0");
  const reparsed = parseRec(built);
  assert.equal(reparsed.kind, "ok");
  assert.deepEqual(verifyOffload({ ...base, record: reparsed }), {
    ok: true,
    models: [GLM],
  });
  assert.throws(() =>
    buildVerifiedRecord({
      inputs: { ...base, realpath: null },
      version: "1",
      models: [GLM],
      targets: [],
      now: new Date(),
    }),
  );
});

test("collectOffloadInputs and verifyOffload against a fake opencode", () => {
  withHome(({ root }) => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    const exe = join(bin, "opencode");
    writeFileSync(exe, "#!/bin/sh\necho 2.2.0\n", { mode: 0o755 });
    const cfgDir = join(root, ".config", "opencode");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "opencode.jsonc"), "{}\n");
    const env = { HOME: root, PATH: bin };
    const first = collectOffloadInputs(env);
    assert.equal(first.realpath, exe);
    assert.equal(first.record.kind, "missing");
    assert.equal(verifyOffload(first).ok, false);

    const record = buildVerifiedRecord({
      inputs: first,
      version: "2.2.0",
      models: [GLM],
      targets: [],
      now: new Date(),
    });
    mkdirSync(offloadDirPath(env), { recursive: true, mode: 0o700 });
    writeFileSync(offloadRecordPath(env), JSON.stringify(record));
    assert.deepEqual(verifyOffload(collectOffloadInputs(env)), {
      ok: true,
      models: [GLM],
    });

    // Files opencode itself writes next to the config do not count.
    writeFileSync(join(cfgDir, "service.json"), "{}");
    mkdirSync(join(cfgDir, "node_modules", "x"), { recursive: true });
    assert.equal(verifyOffload(collectOffloadInputs(env)).ok, true);

    mkdirSync(join(cfgDir, "plugin"));
    assert.equal(verifyOffload(collectOffloadInputs(env)).ok, false);
    rmSync(join(cfgDir, "plugin"), { recursive: true });
    writeFileSync(join(cfgDir, "opencode.jsonc"), "{ }\n");
    assert.equal(verifyOffload(collectOffloadInputs(env)).ok, false);
  });
});

test("deny lists: matching and the jsonc mirror stays in sync later", () => {
  assert.ok(READ_DENY.includes("**/.env"));
  assert.ok(EDIT_DENY.includes("package.json"));
  for (const p of READ_DENY) assert.ok(EDIT_DENY.includes(p), p);
});

// ---- ~/.opencode allowlist and package.json dependency checks ---------------------

/** A fake opencode install; returns the env and the ~/.opencode path. */
function withLegacyDir(fn) {
  return withHome(({ root }) => {
    const bin = join(root, "pathbin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 2.2.0\n", {
      mode: 0o755,
    });
    const legacy = join(root, ".opencode");
    mkdirSync(join(legacy, "bin"), { recursive: true });
    writeFileSync(join(legacy, "bin", "opencode"), "x");
    mkdirSync(join(legacy, "node_modules"));
    writeFileSync(
      join(legacy, "package.json"),
      JSON.stringify({ dependencies: { "@opencode-ai/plugin": "2.2.0" } }),
    );
    writeFileSync(join(legacy, ".gitignore"), "node_modules\n");
    const env = { HOME: root, PATH: bin };
    const found = () => collectOffloadInputs(env).foundConfigPaths;
    return fn({ root, legacy, env, found });
  });
}

test("~/.opencode: only what opencode keeps there passes", () => {
  withLegacyDir(({ legacy, found }) => {
    assert.deepEqual(found(), []);
    writeFileSync(join(legacy, "package-lock.json"), "{}");
    writeFileSync(join(legacy, "bun.lock"), "");
    assert.deepEqual(found(), []);
  });
});

test("~/.opencode: a symlinked bin is fine, a symlinked node_modules is not", () => {
  withLegacyDir(({ root, legacy, found }) => {
    rmSync(join(legacy, "bin"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(legacy, "bin"));
    assert.deepEqual(found(), []);
    rmSync(join(legacy, "node_modules"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), join(legacy, "node_modules"));
    const r = found();
    assert.equal(r.length, 1);
    assert.match(r[0], /node_modules/);
  });
});

test("~/.opencode: config files, config dirs and unknown names are refused with their path", () => {
  for (const name of [
    "opencode.jsonc",
    "opencode.json",
    "config.json",
    "config.jsonc",
    "plugin",
    "agent",
    "unknown-dir",
  ]) {
    withLegacyDir(({ legacy, found }) => {
      const p = join(legacy, name);
      if (name.includes(".")) writeFileSync(p, "{}");
      else mkdirSync(p);
      const r = found();
      assert.equal(r.length, 1, name);
      assert.ok(r[0].includes(p), name);
    });
  }
});

test("~/.opencode is not a plain directory: refused", () => {
  withLegacyDir(({ root, legacy, found }) => {
    rmSync(legacy, { recursive: true });
    writeFileSync(legacy, "");
    assert.equal(found().length, 1);
    rmSync(legacy);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), legacy);
    assert.equal(found().length, 1);
  });
});

test("opencode.jsonc: allowed under ~/.config/opencode (by hash), refused under ~/.opencode", () => {
  withLegacyDir(({ root, legacy, found }) => {
    const cfg = join(root, ".config", "opencode");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "opencode.jsonc"), "{}\n");
    assert.deepEqual(found(), []);
    writeFileSync(join(legacy, "opencode.jsonc"), "{}\n");
    const r = found();
    assert.equal(r.length, 1);
    assert.ok(r[0].includes(join(legacy, "opencode.jsonc")));
  });
});

test("package.json: dependency names are limited to @opencode-ai/plugin, in all four fields", () => {
  for (const dir of ["legacy", "config"]) {
    withLegacyDir(({ root, legacy, found }) => {
      const base =
        dir === "legacy" ? legacy : join(root, ".config", "opencode");
      mkdirSync(base, { recursive: true });
      const pkg = join(base, "package.json");
      const put = (v) => writeFileSync(pkg, JSON.stringify(v));
      put({ dependencies: { "@opencode-ai/plugin": "latest" } });
      assert.deepEqual(found(), [], dir);
      put({
        dependencies: { "@opencode-ai/plugin": "1.0.0", "left-pad": "1" },
      });
      assert.ok(
        found().some((x) => x.includes("left-pad")),
        dir,
      );
      for (const f of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        put({ [f]: { "left-pad": "1.0.0" } });
        const r = found();
        assert.equal(r.length, 1, `${dir} ${f}`);
        assert.ok(r[0].includes("left-pad"), `${dir} ${f}`);
      }
    });
  }
});

test("package.json: forbidden fields, bad shapes, symlink, broken JSON, absence", () => {
  withLegacyDir(({ root, legacy, found }) => {
    const pkg = join(legacy, "package.json");
    for (const f of [
      "scripts",
      "overrides",
      "resolutions",
      "workspaces",
      "patchedDependencies",
      "trustedDependencies",
    ]) {
      writeFileSync(pkg, JSON.stringify({ [f]: {} }));
      const r = found();
      assert.equal(r.length, 1, f);
      assert.ok(r[0].includes(f), f);
    }
    writeFileSync(pkg, JSON.stringify({ dependencies: [] }));
    assert.equal(found().length, 1);
    writeFileSync(pkg, JSON.stringify({ dependencies: "x" }));
    assert.equal(found().length, 1);
    writeFileSync(pkg, "[]");
    assert.equal(found().length, 1);
    writeFileSync(pkg, "{ broken");
    assert.equal(found().length, 1);
    rmSync(pkg);
    assert.deepEqual(found(), []);
    writeFileSync(join(root, "real.json"), "{}");
    symlinkSync(join(root, "real.json"), pkg);
    assert.equal(found().length, 1);
  });
});

test("package.json: the @opencode-ai/plugin spec is an allowlist of shapes", () => {
  withLegacyDir(({ legacy, found }) => {
    const pkg = join(legacy, "package.json");
    const spec = (v) =>
      writeFileSync(
        pkg,
        JSON.stringify({ dependencies: { "@opencode-ai/plugin": v } }),
      );
    for (const ok of [
      "1.2.3",
      "^1.2.3",
      "~1.2",
      "1",
      "2.2.0-beta.1",
      "latest",
      ">=1.2.0 <2.0.0",
    ]) {
      spec(ok);
      assert.deepEqual(found(), [], ok);
    }
    for (const bad of [
      "file:/tmp/x",
      "link:../x",
      "github:a/b",
      "git+https://x/y.git",
      "https://x/y.tgz",
      "npm:left-pad@1",
      "workspace:*",
      "a/b",
      "",
      "*",
      ">=1.2.0 junk",
    ]) {
      spec(bad);
      assert.equal(found().length, 1, bad);
    }
    spec(1);
    assert.equal(found().length, 1);
  });
});

// ---- writing and deleting the record ------------------------------------------------

const { writeVerifiedRecord, deleteVerifiedRecord } = offloadModule;

test("writeVerifiedRecord: reads back, unknown fields stay, mode 0600, no temp file", () => {
  withHome(({ root }) => {
    const env = { HOME: root };
    const record = goodRecord({ auxProviders: ["opencode"] });
    writeVerifiedRecord(env, record);
    const state = parseVerifiedRecord(readFileSync(offloadRecordPath(env)));
    assert.equal(state.kind, "ok");
    assert.deepEqual(state.record.models, [GLM]);
    assert.deepEqual(readdirSync(offloadDirPath(env)), ["verified.json"]);
    assert.equal(statSync(offloadRecordPath(env)).mode & 0o777, 0o600);
    // an unknown field does not stop verifyOffload
    const base = inputsFor(record);
    assert.deepEqual(verifyOffload({ ...base, record: state }), {
      ok: true,
      models: [GLM],
    });
    // overwriting replaces it
    writeVerifiedRecord(env, goodRecord({ version: "9.9.9" }));
    assert.equal(
      parseVerifiedRecord(readFileSync(offloadRecordPath(env))).record.version,
      "9.9.9",
    );
  });
});

test("writeVerifiedRecord: creates the missing data dirs from the top", () => {
  withHome(({ root }) => {
    rmSync(join(root, ".local"), { recursive: true });
    const env = { HOME: root };
    writeVerifiedRecord(env, goodRecord());
    assert.equal(
      parseVerifiedRecord(readFileSync(offloadRecordPath(env))).kind,
      "ok",
    );
  });
});

test("writeVerifiedRecord: a broken record throws and leaves nothing", () => {
  withHome(({ root }) => {
    const env = { HOME: root };
    assert.throws(() => writeVerifiedRecord(env, goodRecord({ models: [] })));
    assert.throws(() => writeVerifiedRecord(env, "nope"));
    assert.throws(() => statSync(offloadDirPath(env)));
  });
});

test("writeVerifiedRecord: an unsafe record dir or data dir throws, no record", () => {
  withHome(({ root }) => {
    const env = { HOME: root };
    const dataDir = join(root, ".local", "share", "delegation-ledger");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), offloadDirPath(env));
    assert.throws(() => writeVerifiedRecord(env, goodRecord()));
    assert.deepEqual(readdirSync(join(root, "elsewhere")), []);
    rmSync(offloadDirPath(env));
    rmSync(dataDir, { recursive: true });
    symlinkSync(join(root, "elsewhere"), dataDir);
    assert.throws(() => writeVerifiedRecord(env, goodRecord()));
    assert.deepEqual(readdirSync(join(root, "elsewhere")), []);
  });
});

test(
  "writeVerifiedRecord: failing before the rename leaves no temp file",
  {
    skip: process.getuid?.() === 0,
  },
  () => {
    withHome(({ root }) => {
      const env = { HOME: root };
      writeVerifiedRecord(env, goodRecord());
      const dir = offloadDirPath(env);
      // A directory where the record goes makes the rename fail after the temp file is written.
      rmSync(offloadRecordPath(env));
      mkdirSync(offloadRecordPath(env));
      assert.throws(() => writeVerifiedRecord(env, goodRecord()));
      assert.deepEqual(readdirSync(dir), ["verified.json"]);
      // ensureOwnedDir repairs a read-only record dir, so that is not a failure path.
      rmSync(offloadRecordPath(env), { recursive: true });
      chmodSync(dir, 0o500);
      writeVerifiedRecord(env, goodRecord());
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.deepEqual(readdirSync(dir), ["verified.json"]);
    });
  },
);

test(
  "deleteVerifiedRecord: removes it, absent is fine, other failures throw",
  {
    skip: process.getuid?.() === 0,
  },
  () => {
    withHome(({ root }) => {
      const env = { HOME: root };
      deleteVerifiedRecord(env);
      writeVerifiedRecord(env, goodRecord());
      deleteVerifiedRecord(env);
      assert.deepEqual(readdirSync(offloadDirPath(env)), []);
      writeVerifiedRecord(env, goodRecord());
      chmodSync(offloadDirPath(env), 0o500);
      try {
        assert.throws(() => deleteVerifiedRecord(env));
      } finally {
        chmodSync(offloadDirPath(env), 0o700);
      }
    });
  },
);

// ---- child env, argv and log ---------------------------------------------------

test("buildOpencodeArgv: agent by --write, brief is one last element", () => {
  const brief = "line\n--attach=x\n$(id) `id`";
  const read = buildOpencodeArgv({ model: GLM, write: false, brief });
  assert.deepEqual(read, [
    "run",
    "--standalone",
    "--agent",
    "worktree-read",
    "-m",
    GLM,
    "--auto",
    brief,
  ]);
  const edit = buildOpencodeArgv({ model: GLM, write: true, brief });
  assert.equal(edit[3], "worktree-edit");
  assert.equal(edit.at(-1), brief);
});

test("buildOpencodeArgv: observe adds five words before the brief and nothing else", () => {
  const brief = "b";
  const plain = buildOpencodeArgv({ model: GLM, write: false, brief });
  assert.deepEqual(
    buildOpencodeArgv({ model: GLM, write: false, brief, observe: false }),
    plain,
  );
  const observed = buildOpencodeArgv({
    model: GLM,
    write: false,
    brief,
    observe: true,
  });
  const extra = ["--format", "json", "--print-logs", "--log-level", "DEBUG"];
  assert.deepEqual(observed, [...plain.slice(0, -1), ...extra, brief]);
  assert.equal(observed.at(-1), brief);
});

test("buildChildEnv: allowlist only", () => {
  const parent = {
    PATH: "/bin",
    HOME: "/h",
    LANG: "C",
    LC_ALL: "C",
    TERM: "xterm",
    TMPDIR: "/t",
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_PERMISSION: "{}",
    XDG_CONFIG_HOME: "/x",
    XDG_DATA_HOME: "/x",
    NODE_OPTIONS: "--x",
    GIT_DIR: "/g",
    ANTHROPIC_API_KEY: FIXTURE_KEY,
    ZAI_API_KEY: FIXTURE_KEY,
    SARASHINA_API_KEY: FIXTURE_KEY,
  };
  const out = buildChildEnv(parent);
  for (const k of [
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_PERMISSION",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "NODE_OPTIONS",
    "GIT_DIR",
    "ANTHROPIC_API_KEY",
    "ZAI_API_KEY",
    "SARASHINA_API_KEY",
  ]) {
    assert.equal(k in out, false, k);
  }
  assert.equal(out.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(out.HOME, "/h");
  assert.equal(out.PATH, "/bin");
  assert.equal(out.LC_ALL, "C");
});

test("buildLogLine: shape, no brief text, bounded size", () => {
  const brief = "secret brief body";
  const line = buildLogLine({
    at: "2026-10-29T00:00:00.000Z",
    result: "spawned",
    model: GLM,
    agent: "worktree-read",
    dir: "/tmp/w",
    briefSha256: HEX("e"),
    planSha256: null,
  });
  assert.ok(line.endsWith("\n"));
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed), [
    "v",
    "at",
    "result",
    "model",
    "agent",
    "dir",
    "briefSha256",
    "planSha256",
  ]);
  assert.equal(parsed.briefSha256, HEX("e"));
  assert.equal(line.includes(brief), false);
  const unknown = JSON.parse(
    buildLogLine({
      at: "t",
      result: "args",
      model: null,
      agent: null,
      dir: null,
      briefSha256: null,
      planSha256: null,
    }),
  );
  assert.equal(unknown.model, null);
  assert.equal(unknown.briefSha256, null);
  const wide = buildLogLine({
    at: "t",
    result: "dir",
    model: GLM,
    agent: "worktree-read",
    dir: `/${"\u0001".repeat(1023)}`,
    briefSha256: HEX("e"),
    planSha256: HEX("f"),
  });
  assert.ok(Buffer.byteLength(wide) <= 4096);
  const atLine = buildLogLine({
    at: "t",
    result: "brief",
    model: GLM,
    agent: null,
    dir: "/w",
    briefSha256: HEX("e"),
    planSha256: null,
  });
  assert.equal(atLine.includes("@"), false);
});

// ---- opencode.jsonc ---------------------------------------------------------------

const JSONC_PATH = join(
  import.meta.dirname,
  "../home/dot_config/opencode/opencode.jsonc",
);

/** Parse JSONC: drop // and block comments outside strings, then trailing commas. */
function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const readJsonc = () => parseJsonc(readFileSync(JSONC_PATH, "utf8"));
const denyKeys = (rules) =>
  Object.entries(rules)
    .filter(([, v]) => v === "deny")
    .map(([k]) => k);

test("opencode.jsonc: global settings and the sarashina provider", () => {
  const cfg = readJsonc();
  assert.equal(cfg.share, "disabled");
  assert.equal(cfg.autoupdate, false);
  for (const key of [
    "mcp",
    "plugin",
    "enabled_providers",
    "small_model",
    "model",
  ]) {
    assert.equal(key in cfg, false, key);
  }
  const settings = cfg.providers.sarashina.settings;
  assert.equal("apiKey" in settings, false);
  assert.equal(typeof settings.baseURL, "string");
  const p = cfg.providers.sarashina;
  assert.equal(p.name, "Sarashina API");
  assert.equal(p.package, "@opencode/ai/providers/openai-compatible");
  assert.deepEqual(p.compatibility, {
    maxTokensField: "max_completion_tokens",
    streamUsage: false,
  });
  assert.deepEqual(Object.keys(p.models), ["sarashina3.2-mini-thinking"]);
  assert.equal(
    readFileSync(JSONC_PATH, "utf8").includes("SARASHINA_API_KEY"),
    false,
  );
});

test("opencode.jsonc: the two offload agents are allowlists", () => {
  const { agent } = readJsonc();
  assert.deepEqual(Object.keys(agent).sort(), [
    "worktree-edit",
    "worktree-read",
  ]);
  for (const [name, def] of Object.entries(agent)) {
    const perm = def.permission;
    assert.equal(Object.keys(perm)[0], "*", name);
    assert.equal(perm["*"], "deny", name);
    for (const tool of ["read", "glob", "list"]) {
      assert.notEqual(perm[tool], "deny", `${name} ${tool}`);
      assert.ok(perm[tool], `${name} ${tool}`);
    }
    for (const tool of [
      "grep",
      "bash",
      "webfetch",
      "websearch",
      "codesearch",
      "task",
      "skill",
      "opencode_*",
      "external_directory",
    ]) {
      assert.equal(perm[tool], "deny", `${name} ${tool}`);
    }
    assert.equal(Object.keys(perm.read)[0], "*");
    assert.equal(perm.read["*"], "allow");
    assert.deepEqual(denyKeys(perm.read), [...READ_DENY], name);
  }
  const read = agent["worktree-read"].permission;
  for (const tool of ["edit", "write"]) {
    assert.ok(read[tool] === undefined || read[tool] === "deny", tool);
  }
  const edit = agent["worktree-edit"].permission;
  for (const tool of ["edit", "write"]) {
    assert.equal(edit[tool]["*"], "allow", tool);
    assert.deepEqual(denyKeys(edit[tool]), [...EDIT_DENY], tool);
    for (const p of denyKeys(edit.read)) {
      assert.ok(denyKeys(edit[tool]).includes(p), `${tool} lacks ${p}`);
    }
  }
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
