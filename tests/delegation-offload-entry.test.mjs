// Process-level tests for `delegation offload`. They live apart from
// delegation-offload.test.mjs (pure functions) so the two files run in
// parallel and each stays under the per-file time cap. Every test builds its
// own world under a temp HOME and runs a fake opencode; no real opencode and
// no network are used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  import.meta.dirname,
  "../home/dot_local/share/delegation/main.ts",
);
const GLM = "zai-coding-plan/glm-5.3";
const SAR = "sarashina/sarashina3.2-mini-thinking";
const FREE = "opencode/glm-5.3-flash-free";
const SYSTEM_PATH = "/usr/bin:/bin";
const sha = (s) => createHash("sha256").update(s).digest("hex");

function fakeScript(w, o = {}) {
  const out = w.out;
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
${o.versionHook ?? ""}
  printf '%s\\n' "${o.versionOut ?? "2.2.0"}"
  exit ${o.versionExit ?? 0}
fi
printf '%s\\0' "$@" > "${out}/argv"
pwd > "${out}/cwd"
env > "${out}/env"
cat "${w.logPath}" > "${out}/logseen" 2>/dev/null
${o.runHook ?? ""}
exit ${o.exit ?? 0}
`;
}

/** A temp HOME with a repo, a brief, a config, a fake opencode and a record. */
function world(o = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "offload-entry-")));
  const w = {
    root,
    bin: join(root, "bin"),
    repo: join(root, "work"),
    out: join(root, "out"),
    brief: join(root, "brief.md"),
    authDir: join(root, ".local", "share", "opencode"),
    cfgDir: join(root, ".config", "opencode"),
    ledgerDir: join(root, ".local", "share", "delegation-ledger"),
  };
  w.offloadDir = join(w.ledgerDir, "offload");
  w.recordPath = join(w.offloadDir, "verified.json");
  w.logPath = join(w.offloadDir, "offload.log");
  w.exe = join(w.bin, "opencode");
  for (const d of [w.bin, w.repo, w.out, w.cfgDir])
    mkdirSync(d, { recursive: true });
  mkdirSync(w.authDir, { recursive: true, mode: 0o700 });
  chmodSync(w.authDir, 0o700);
  mkdirSync(w.offloadDir, { recursive: true, mode: 0o700 });
  chmodSync(w.ledgerDir, 0o700);
  chmodSync(w.offloadDir, 0o700);
  spawnSync("git", ["init", "-q"], { cwd: w.repo });
  writeFileSync(join(w.repo, ".gitignore"), "out/\n");
  writeFileSync(w.brief, "Reply with OK.\n");
  writeFileSync(join(w.cfgDir, "opencode.jsonc"), "{}\n");
  w.writeExe = (opts) => {
    const text = fakeScript(w, opts);
    writeFileSync(w.exe, text, { mode: 0o755 });
    chmodSync(w.exe, 0o755);
    return text;
  };
  const text = w.writeExe(o.script ?? {});
  w.record = {
    v: 1,
    verifiedAt: new Date().toISOString(),
    realpath: w.exe,
    executableSha256: sha(text),
    targets: [],
    version: "2.2.0",
    configSha256: sha("{}\n"),
    authProviders: [],
    models: [GLM, SAR, FREE],
    ...(o.record ?? {}),
  };
  w.writeRecord = (r = w.record) =>
    writeFileSync(w.recordPath, typeof r === "string" ? r : JSON.stringify(r));
  if (o.record !== null) w.writeRecord();
  w.cleanup = () => rmSync(root, { recursive: true, force: true });
  return w;
}

const baseArgs = (w, extra = []) => [
  "offload",
  "--exposure",
  "external-ok",
  "--model",
  GLM,
  "--brief-file",
  w.brief,
  "--dir",
  w.repo,
  ...extra,
];
const envOf = (w, extra = {}) => ({
  HOME: w.root,
  PATH: `${w.bin}:${SYSTEM_PATH}`,
  ...extra,
});

function start(w, args = baseArgs(w), env = envOf(w)) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env,
    cwd: w.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((resolve) =>
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    ),
  );
  return { child, done };
}
const run = (w, args, env) => start(w, args, env).done;

const logLines = (w) =>
  existsSync(w.logPath)
    ? readFileSync(w.logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const argvSeen = (w) =>
  readFileSync(join(w.out, "argv"), "utf8").split("\0").slice(0, -1);
const launched = (w) => existsSync(join(w.out, "argv"));
const everything = (r) => `${r.stdout}\n${r.stderr}`;

function waitFor(path, ms = 5000) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() > until) return reject(new Error(`timeout: ${path}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(...pids) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    if (pids.every((p) => !alive(p))) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function snapshot(dir, skip) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (p === skip) continue;
      if (e.isDirectory()) {
        out[p] = "dir";
        walk(p);
      } else out[p] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

function writeDb(w, ids, mode = 0o600) {
  const path = join(w.authDir, "opencode.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE credential (integration_id TEXT, active INTEGER, value TEXT)",
  );
  for (const id of ids) {
    db.prepare("INSERT INTO credential VALUES (?, 1, ?)").run(
      id,
      "fixture-fixture",
    );
  }
  db.close();
  chmodSync(path, mode);
  return path;
}

async function withWorld(opts, fn) {
  const w = world(opts);
  try {
    await fn(w);
  } finally {
    w.cleanup();
  }
}

describe("delegation offload (process)", { concurrency: true }, () => {
  it("passes: starts the fake with the fixed argv, cwd, env and logs before starting", () =>
    withWorld({ script: { exit: 7 } }, async (w) => {
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 7, everything(r));
      assert.deepEqual(argvSeen(w), [
        "run",
        "--standalone",
        "--agent",
        "worktree-read",
        "-m",
        GLM,
        "--auto",
        "Reply with OK.\n",
      ]);
      assert.equal(readFileSync(join(w.out, "cwd"), "utf8").trim(), w.repo);
      const env = readFileSync(join(w.out, "env"), "utf8");
      assert.match(env, /^OPENCODE_DISABLE_CLAUDE_CODE=1$/m);
      assert.equal(/XDG_|ANTHROPIC|NODE_OPTIONS/.test(env), false);
      const lines = logLines(w);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].result, "spawned");
      assert.equal(lines[0].briefSha256, sha("Reply with OK.\n"));
      assert.equal(lines[0].agent, "worktree-read");
      assert.equal(
        readFileSync(join(w.out, "logseen"), "utf8").includes('"spawned"'),
        true,
      );
      assert.equal(statSync(w.logPath).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(w.logPath, "utf8").includes("Reply with OK"),
        false,
      );
    }));

  it("--write selects worktree-edit and reports changed paths", () =>
    withWorld(
      {
        script: {
          runHook: `mkdir -p "${"$PWD"}/src" "${"$PWD"}/out" "${"$PWD"}/newdir"; echo a > src/a.ts; echo b > out/x; echo c > newdir/y`,
        },
      },
      async (w) => {
        const r = await run(w, baseArgs(w, ["--write"]));
        assert.equal(r.code, 0, everything(r));
        assert.equal(argvSeen(w)[3], "worktree-edit");
        for (const p of ["src/a.ts", "out/", "newdir/y"]) {
          assert.ok(r.stderr.includes(p), `${p}\n${r.stderr}`);
        }
        assert.ok(r.stderr.includes("全差分を読む"));
      },
    ));

  it("--write with no change still prints the read-the-diff line; without --write it does not", () =>
    withWorld({}, async (w) => {
      const a = await run(w, baseArgs(w, ["--write"]));
      assert.ok(a.stderr.includes("全差分を読む"));
      const b = await run(w, baseArgs(w));
      assert.equal(b.stderr.includes("全差分を読む"), false);
    }));

  it("refusals and launches interleave: five calls give five log lines and the ledger is untouched", () =>
    withWorld({}, async (w) => {
      mkdirSync(join(w.ledgerDir, "pending"), { recursive: true });
      writeFileSync(join(w.ledgerDir, "ledger.jsonl"), '{"x":1}\n');
      const before = snapshot(w.ledgerDir, w.offloadDir);
      const results = [];
      results.push(
        await run(w, [
          "offload",
          "--exposure",
          "closed",
          "--model",
          SAR,
          "--brief-file",
          w.brief,
        ]),
      );
      writeFileSync(join(w.root, "bad.md"), "-starts with dash\n");
      results.push(
        await run(
          w,
          baseArgs(w).map((a) => (a === w.brief ? join(w.root, "bad.md") : a)),
        ),
      );
      results.push(await run(w, baseArgs(w)));
      writeFileSync(w.recordPath, "{");
      results.push(await run(w, baseArgs(w)));
      w.writeRecord();
      results.push(await run(w, baseArgs(w)));
      assert.deepEqual(
        results.map((r) => r.code),
        [1, 1, 0, 1, 0],
      );
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["args", "brief", "spawned", "verify", "spawned"],
      );
      assert.deepEqual(snapshot(w.ledgerDir, w.offloadDir), before);
    }));

  it("a parseArgs duplicate adds no log line", () =>
    withWorld({}, async (w) => {
      const r = await run(w, [...baseArgs(w), "--dir", w.repo]);
      assert.equal(r.code, 1);
      assert.equal(logLines(w).length, 0);
    }));

  it("no record: verify line, recovery, nothing started", () =>
    withWorld({ record: null }, async (w) => {
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /recovery: .*opencode-containment\.mjs/);
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["verify"],
      );
      assert.equal(launched(w), false);
    }));

  it("a model missing from the record is refused with that model in recovery", () =>
    withWorld({ record: { models: [GLM] } }, async (w) => {
      const r = await run(
        w,
        baseArgs(w).map((a) => (a === GLM ? SAR : a)),
      );
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes(`--model ${SAR}`), r.stderr);
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["verify"],
      );
      assert.equal(launched(w), false);
    }));

  it("no opencode on PATH: resolve", () =>
    withWorld({}, async (w) => {
      const r = await run(w, baseArgs(w), envOf(w, { PATH: SYSTEM_PATH }));
      assert.equal(r.code, 1);
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["resolve"],
      );
    }));

  it("auth directory writable by the group is refused, 0755 passes", () =>
    withWorld({}, async (w) => {
      chmodSync(w.authDir, 0o775);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /recovery: chmod go-w /);
      assert.equal(launched(w), false);
      chmodSync(w.authDir, 0o755);
      const ok = await run(w, baseArgs(w));
      assert.equal(ok.code, 0, everything(ok));
      assert.equal(launched(w), true);
    }));

  it("stored credentials: matching set passes, empty record fails, foreign id names itself", () =>
    withWorld({ record: { authProviders: ["sarashina"] } }, async (w) => {
      writeDb(w, ["sarashina"]);
      const ok = await run(w, baseArgs(w));
      assert.equal(ok.code, 0, everything(ok));
      w.writeRecord({ ...w.record, authProviders: [] });
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /recovery: .*opencode-containment/);
      rmSync(join(w.authDir, "opencode.db"));
      writeDb(w, ["mcp-github"]);
      const foreign = await run(w, baseArgs(w));
      assert.equal(foreign.code, 1);
      assert.ok(foreign.stderr.includes("mcp-github"));
    }));

  it("loose database mode and symlinked auth.json are refused; the record stays", () =>
    withWorld({}, async (w) => {
      const db = writeDb(w, [], 0o644);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes(`recovery: chmod 600 ${db}`), r.stderr);
      assert.ok(existsSync(w.recordPath));
      chmodSync(db, 0o600);
      writeFileSync(join(w.root, "real-auth.json"), "{}", { mode: 0o600 });
      symlinkSync(join(w.root, "real-auth.json"), join(w.authDir, "auth.json"));
      assert.equal((await run(w, baseArgs(w))).code, 1);
      assert.equal(launched(w), false);
    }));

  it("loose auth.json mode: chmod and key-reissue lines", () =>
    withWorld({}, async (w) => {
      writeFileSync(join(w.authDir, "auth.json"), "{}", { mode: 0o644 });
      chmodSync(join(w.authDir, "auth.json"), 0o644);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /recovery: chmod 600 .*auth\.json/);
      assert.ok(existsSync(w.recordPath));
    }));

  it("a broken auth.json and hostile credential names never leak", () =>
    withWorld({}, async (w) => {
      writeFileSync(
        join(w.authDir, "auth.json"),
        '{"fixture-fixture-fixture":',
        { mode: 0o600 },
      );
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      const seen =
        everything(r) +
        (existsSync(w.logPath) ? readFileSync(w.logPath, "utf8") : "");
      assert.equal(seen.includes("fixture-fixture-fixture"), false);
      rmSync(join(w.authDir, "auth.json"));
      writeDb(w, ["a\u001b[31m\nb;$(x)"]);
      const h = await run(w, baseArgs(w));
      assert.equal(h.code, 1);
      assert.equal(/\u001b|\$\(/.test(h.stderr), false);
      assert.ok(h.stderr.includes("(表示できない名前)"));
    }));

  it("version mismatch removes the record; other version failures keep it", () =>
    withWorld({ script: { versionOut: "9.9.9" } }, async (w) => {
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["version"],
      );
      assert.equal(existsSync(w.recordPath), false);
      assert.equal(launched(w), false);
    }));

  it("a record rewritten during the version check is not removed", () =>
    withWorld({}, async (w) => {
      const text = w.writeExe({
        versionOut: "9.9.9",
        versionHook: `echo '{"other":1}' > "${w.recordPath}"`,
      });
      w.writeRecord({ ...w.record, executableSha256: sha(text) });
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.equal(readFileSync(w.recordPath, "utf8").trim(), '{"other":1}');
    }));

  it("version command failing or printing nothing keeps the record", () =>
    withWorld({}, async (w) => {
      for (const script of [{ versionExit: 3 }, { versionOut: "" }]) {
        const text = w.writeExe(script);
        w.writeRecord({ ...w.record, executableSha256: sha(text) });
        const r = await run(w, baseArgs(w));
        assert.equal(r.code, 1);
        assert.ok(existsSync(w.recordPath));
        assert.equal(launched(w), false);
      }
    }));

  it("record problems keep the record: broken JSON and v=2", () =>
    withWorld({}, async (w) => {
      for (const text of ["{", JSON.stringify({ ...w.record, v: 2 })]) {
        w.writeRecord(text);
        const r = await run(w, baseArgs(w));
        assert.equal(r.code, 1);
        assert.equal(readFileSync(w.recordPath, "utf8"), text);
      }
    }));

  it("auth store as a symlink to another directory is refused", () =>
    withWorld({}, async (w) => {
      const other = join(w.root, "other-auth");
      mkdirSync(other, { mode: 0o700 });
      rmSync(w.authDir, { recursive: true });
      symlinkSync(other, w.authDir);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.equal(launched(w), false);
    }));

  it("files opencode writes next to its config do not break the next launches", () =>
    withWorld(
      {
        script: {
          runHook: `echo '{}' > "${"$HOME"}/.config/opencode/service.json"; mkdir -p "${"$HOME"}/.config/opencode/node_modules/x"; echo y > "${"$HOME"}/.config/opencode/node_modules/x/f"`,
        },
      },
      async (w) => {
        assert.equal((await run(w, baseArgs(w))).code, 0);
        assert.equal((await run(w, baseArgs(w))).code, 0);
        assert.equal((await run(w, baseArgs(w))).code, 0);
      },
    ));

  it("a record directory that is a symlink is refused; an unwritable log refuses the launch", () =>
    withWorld({}, async (w) => {
      rmSync(w.logPath, { force: true });
      mkdirSync(w.logPath);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.equal(launched(w), false);
      rmSync(w.logPath, { recursive: true });
      const real = join(w.root, "real-offload");
      rmSync(w.offloadDir, { recursive: true });
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, w.offloadDir);
      const s = await run(w, baseArgs(w));
      assert.equal(s.code, 1);
      assert.equal(launched(w), false);
    }));

  it("a launcher that stops being executable after verification: one spawned line, reason on stderr", () =>
    withWorld({}, async (w) => {
      const text = w.writeExe({ versionHook: `  chmod 644 "$0"` });
      w.writeRecord({ ...w.record, executableSha256: sha(text) });
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 1);
      assert.deepEqual(
        logLines(w).map((l) => l.result),
        ["spawned"],
      );
      assert.ok(r.stderr.length > 0);
    }));

  it("the argv keeps a hostile multi-line brief as one element", () =>
    withWorld({}, async (w) => {
      const body = "line\n--attach=x\n$(id) `id`\n";
      writeFileSync(w.brief, body);
      const r = await run(w, baseArgs(w));
      assert.equal(r.code, 0, everything(r));
      const argv = argvSeen(w);
      assert.equal(argv.length, 8);
      assert.equal(argv[7], body);
    }));

  it("SIGTERM and SIGHUP reach the child's group; a brief is kept", () =>
    withWorld({}, async (w) => {
      for (const [sig, code] of [
        ["SIGTERM", 143],
        ["SIGHUP", 129],
      ]) {
        w.writeExe({});
        const text = w.writeExe({
          runHook: `echo $$ > "${w.out}/pid"; sleep 300 & echo $! > "${w.out}/spid"; wait`,
        });
        w.writeRecord({ ...w.record, executableSha256: sha(text) });
        rmSync(join(w.out, "pid"), { force: true });
        const { child, done } = start(w);
        await waitFor(join(w.out, "spid"));
        child.kill(sig);
        const r = await done;
        assert.equal(r.code, code, r.stderr);
        const pids = [
          readFileSync(join(w.out, "pid"), "utf8"),
          readFileSync(join(w.out, "spid"), "utf8"),
        ].map((s) => Number(s.trim()));
        assert.ok(await gone(...pids));
        rmSync(join(w.out, "spid"), { force: true });
      }
      assert.ok(existsSync(w.brief));
    }));

  it("a child that ignores SIGTERM is killed after the grace period", () =>
    withWorld({}, async (w) => {
      const text = w.writeExe({
        runHook: `trap '' TERM; echo $$ > "${w.out}/pid"; sleep 300 & echo $! > "${w.out}/spid"; wait`,
      });
      w.writeRecord({ ...w.record, executableSha256: sha(text) });
      const { child, done } = start(
        w,
        baseArgs(w),
        envOf(w, { DELEGATION_OFFLOAD_KILL_GRACE_MS: "200" }),
      );
      await waitFor(join(w.out, "spid"));
      child.kill("SIGTERM");
      const r = await done;
      assert.equal(r.code, 143, r.stderr);
      const pids = ["pid", "spid"].map((n) =>
        Number(readFileSync(join(w.out, n), "utf8").trim()),
      );
      assert.ok(await gone(...pids));
    }));

  it("a time limit gives 124 and leaves no group; a signal death gives 128+n", () =>
    withWorld({}, async (w) => {
      const text = w.writeExe({
        runHook: `sleep 300 & echo $! > "${w.out}/spid"; wait`,
      });
      w.writeRecord({ ...w.record, executableSha256: sha(text) });
      const r = await run(
        w,
        baseArgs(w),
        envOf(w, {
          DELEGATION_OFFLOAD_TIMEOUT_MS: "200",
          DELEGATION_OFFLOAD_KILL_GRACE_MS: "200",
        }),
      );
      assert.equal(r.code, 124, r.stderr);
      assert.ok(
        await gone(Number(readFileSync(join(w.out, "spid"), "utf8").trim())),
      );
      const text2 = w.writeExe({ runHook: "kill -SEGV $$" });
      w.writeRecord({ ...w.record, executableSha256: sha(text2) });
      assert.equal((await run(w, baseArgs(w))).code, 139);
    }));

  it("the timeout variables can only shorten the limits", () =>
    withWorld({ script: { exit: 0 } }, async (w) => {
      const r = await run(
        w,
        baseArgs(w),
        envOf(w, {
          DELEGATION_OFFLOAD_TIMEOUT_MS: "99999999999",
          DELEGATION_OFFLOAD_KILL_GRACE_MS: "x",
        }),
      );
      assert.equal(r.code, 0, everything(r));
    }));
});
