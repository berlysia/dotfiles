import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  OPENCODE_CREDENTIAL_PROVIDERS,
  readOpencodeCredentialKey,
} from "../home/dot_local/share/ai-usage/opencode-credential.ts";
import { resolveApiKey } from "../home/dot_local/share/ai-usage/providers/opencode.ts";
import { allowedAuthProviders } from "../home/dot_local/share/delegation/destinations.ts";
import { collectAuthInputs } from "../home/dot_local/share/delegation/offload.ts";

const UNREADABLE = "opencode credential store unreadable";
// Low-entropy on purpose so the secret scanner does not flag the fixture.
const KEY = "fixture".repeat(3);
const OPTS = { timeoutMs: 1000, verbose: false, details: false };
const SAVED_ENV = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "ZAI_API_KEY",
  "ZAI_CODING_API_KEY",
  "SARASHINA_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
];

let home;
let dataDir;
let dbPath;
let envBefore;

function makeDb(rows, columns) {
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE credential (${columns ?? "integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER"})`,
  );
  if (rows.length === 0) {
    db.close();
    return;
  }
  const insert = db.prepare(
    "INSERT INTO credential (integration_id, value, active, time_updated) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) {
    insert.run(
      r.id,
      typeof r.value === "string" ? r.value : JSON.stringify(r.value),
      r.active ?? 1,
      r.t ?? 1,
    );
  }
  db.close();
}

beforeEach(() => {
  envBefore = {};
  for (const k of SAVED_ENV) envBefore[k] = process.env[k];
  for (const k of SAVED_ENV) delete process.env[k];
  home = realpathSync(mkdtempSync(join(tmpdir(), "ai-usage-cred-")));
  dataDir = join(home, ".local", "share", "opencode");
  mkdirSync(dataDir, { recursive: true });
  dbPath = join(dataDir, "opencode.db");
  process.env.HOME = home;
});

afterEach(() => {
  for (const k of SAVED_ENV) {
    if (envBefore[k] === undefined) delete process.env[k];
    else process.env[k] = envBefore[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("readOpencodeCredentialKey", () => {
  it("returns the key of the newest active row", () => {
    makeDb([
      { id: "zai-coding-plan", value: { key: "old" + KEY }, t: 1 },
      { id: "zai-coding-plan", value: { key: "new" + KEY }, t: 5 },
      { id: "zai-coding-plan", value: { key: "off" + KEY }, active: 0, t: 9 },
      { id: "sarashina", value: { key: "other" + KEY }, t: 9 },
    ]);
    assert.equal(
      readOpencodeCredentialKey(dbPath, "zai-coding-plan"),
      "new" + KEY,
    );
  });

  it("is undefined without a matching active row or without a database", () => {
    assert.equal(readOpencodeCredentialKey(dbPath, "sarashina"), undefined);
    makeDb([{ id: "sarashina", value: { key: KEY }, active: 0 }]);
    assert.equal(readOpencodeCredentialKey(dbPath, "sarashina"), undefined);
    assert.equal(readOpencodeCredentialKey(dbPath, "opencode"), undefined);
  });

  it("is undefined when value is not a usable key", () => {
    for (const value of ["not json", { key: "" }, { key: 7 }, { nokey: KEY }]) {
      rmSync(dbPath, { force: true });
      makeDb([{ id: "sarashina", value }]);
      assert.equal(
        readOpencodeCredentialKey(dbPath, "sarashina"),
        undefined,
        JSON.stringify(value),
      );
    }
  });

  it("throws a fixed message without cause when the table or a column is missing", () => {
    const check = () => {
      try {
        readOpencodeCredentialKey(dbPath, "sarashina");
      } catch (error) {
        return error;
      }
      assert.fail("expected a throw");
    };
    const empty = new DatabaseSync(dbPath);
    empty.exec("CREATE TABLE other (x TEXT)");
    empty.close();
    for (const error of [check()]) {
      assert.equal(error.message, UNREADABLE);
      assert.equal(error.cause, undefined);
    }
    rmSync(dbPath, { force: true });
    makeDb([], "value TEXT, active INTEGER, time_updated INTEGER");
    const error = check();
    assert.equal(error.message, UNREADABLE);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(dbPath), false);
  });

  it("throws the fixed message when another connection holds an exclusive lock", () => {
    makeDb([{ id: "sarashina", value: { key: KEY } }]);
    const writer = new DatabaseSync(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const started = Date.now();
      let caught;
      try {
        readOpencodeCredentialKey(dbPath, "sarashina");
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, "expected a throw");
      assert.equal(caught.message, UNREADABLE);
      assert.equal(caught.cause, undefined);
      assert.ok(Date.now() - started < 1500);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("a missing file and an unreadable store are different outcomes", () => {
    assert.equal(readOpencodeCredentialKey(dbPath, "sarashina"), undefined);
    writeFileSync(dbPath, "this is not a database, only text".repeat(40));
    assert.throws(
      () => readOpencodeCredentialKey(dbPath, "sarashina"),
      (e) => e.message === UNREADABLE,
    );
  });

  it("the SQL is fixed and binds integration_id", () => {
    const source = readFileSync(
      new URL(
        "../home/dot_local/share/ai-usage/opencode-credential.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.ok(
      source.includes(
        "SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_updated DESC LIMIT 1",
      ),
    );
    assert.equal(/\$\{[^}]*(integration|provider)/i.test(source), false);
    assert.equal(/"\s*\+\s*integration/i.test(source), false);
  });
});

describe("resolveApiKey (Z.ai) lookup order", () => {
  const writeAuth = (path, key) =>
    writeFileSync(path, JSON.stringify({ "zai-coding-plan": { key } }));

  it("env ZAI_CODING_API_KEY beats the database", () => {
    makeDb([{ id: "zai-coding-plan", value: { key: "db" + KEY } }]);
    process.env.ZAI_CODING_API_KEY = "env" + KEY;
    process.env.ZAI_API_KEY = "envb" + KEY;
    const got = resolveApiKey(OPTS);
    assert.equal(got.key, "env" + KEY);
    assert.equal(got.source, "ZAI_CODING_API_KEY");
  });

  it("ZAI_API_KEY is used when ZAI_CODING_API_KEY is absent", () => {
    process.env.ZAI_API_KEY = "envb" + KEY;
    const got = resolveApiKey(OPTS);
    assert.equal(got.key, "envb" + KEY);
    assert.equal(got.source, "ZAI_API_KEY");
  });

  it("the database beats auth.json", () => {
    makeDb([{ id: "zai-coding-plan", value: { key: "db" + KEY } }]);
    writeAuth(join(dataDir, "auth.json"), "file" + KEY);
    const got = resolveApiKey(OPTS);
    assert.equal(got.key, "db" + KEY);
    assert.equal(got.source, `${dbPath}#credential`);
  });

  it("auth.json is used when env and the database have no key", () => {
    writeAuth(join(dataDir, "auth.json"), "file" + KEY);
    let got = resolveApiKey(OPTS);
    assert.equal(got.key, "file" + KEY);
    assert.equal(got.source, `${join(dataDir, "auth.json")}#zai-coding-plan`);
    // A store that throws counts as "no key in the database".
    const broken = new DatabaseSync(dbPath);
    broken.exec("CREATE TABLE other (x TEXT)");
    broken.close();
    got = resolveApiKey(OPTS);
    assert.equal(got.key, "file" + KEY);
  });

  it("--auth-file is used before the database", () => {
    makeDb([{ id: "zai-coding-plan", value: { key: "db" + KEY } }]);
    const custom = join(home, "custom-auth.json");
    writeAuth(custom, "custom" + KEY);
    const got = resolveApiKey({ ...OPTS, authFile: custom });
    assert.equal(got.key, "custom" + KEY);
  });

  it("nothing anywhere: the same message as before", () => {
    assert.throws(() => resolveApiKey(OPTS), /^Error: No Z\.ai credentials\./);
  });
});

describe("boundaries between ai-usage and delegation", () => {
  it("no delegation source imports the credential reader or a provider (pace.ts may import ai-usage/summary.ts)", () => {
    const dir = new URL("../home/dot_local/share/delegation/", import.meta.url);
    const forms = [
      /\bfrom\s*["'][^"']*ai-usage\/(?:opencode-credential|providers\/)[^"']*["']/,
      /\bexport\s[^;]*\bfrom\s*["'][^"']*ai-usage\/(?:opencode-credential|providers\/)[^"']*["']/,
      /\bimport\s*\(\s*["'][^"']*ai-usage\/(?:opencode-credential|providers\/)[^"']*["']\s*\)/,
      /\brequire\s*\(\s*["'][^"']*ai-usage\/(?:opencode-credential|providers\/)[^"']*["']\s*\)/,
    ];
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0);
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), "utf8");
      for (const re of forms) assert.equal(re.test(text), false, f);
    }
  });

  it("every provider whose key ai-usage reads is in the delegation check", () => {
    const rows = [
      ...OPENCODE_CREDENTIAL_PROVIDERS.map((id) => ({
        id,
        value: { key: KEY },
      })),
      { id: "zai-coding-plan", value: { key: KEY }, active: 0 },
      { id: "opencode", value: { key: KEY }, active: 0 },
    ];
    makeDb(rows);
    chmodAll();
    const got = collectAuthInputs(process.env);
    assert.equal(got.authDb.kind, "ok");
    for (const id of OPENCODE_CREDENTIAL_PROVIDERS) {
      assert.ok(got.authDb.ids.includes(id), id);
    }
    assert.ok(got.authDb.ids.includes("opencode"));
    const allowed = allowedAuthProviders();
    for (const id of OPENCODE_CREDENTIAL_PROVIDERS) {
      assert.ok(allowed.includes(id), id);
    }
    assert.equal(readOpencodeCredentialKey(dbPath, "opencode"), undefined);
  });
});

function chmodAll() {
  for (const name of readdirSync(dataDir))
    chmodSync(join(dataDir, name), 0o600);
}
