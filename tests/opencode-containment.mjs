// Verification script for the opencode offload entrance (spec K13).
//
//   node tests/opencode-containment.mjs --model <m> [--model <m2> ...] [--accept-host <host:port> ...]
//   node tests/opencode-containment.mjs --probe
//
// Exit codes: 0 verified and record written, 1 failed (previous record is
// deleted), 2 skipped (record untouched).
//
// This is not a unit test: it starts the real opencode and sends fake files
// to an external provider. It is the only code that starts opencode without
// the entrance's record check. `bun run test` does not pick it up (the name
// is not *.test.mjs).
//
// Stages are separate functions: static checks, fake trees, dynamic checks per
// model (T2d), then ancestor config / record / entrance per model (T2e). The
// cleanup is one stack run once from the try/finally and the signal handlers.
// What counts as a pass is decided by the pure judges in
// tests/lib/opencode-containment-lib.mjs (unit-tested); this file only starts
// processes and reads files.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import {
  TLSSocket,
  connect as tlsConnect,
  createSecureContext,
} from "node:tls";
import { lookup, reverse } from "node:dns/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildChildEnv,
  buildOpencodeArgv,
  buildVerifiedRecord,
  checkLaunchDir,
  collectOffloadInputs,
  deleteVerifiedRecord,
  matchesDeny,
  offloadRecordPath,
  parseVerifiedRecord,
  verifyAuthProviders,
  writeVerifiedRecord,
} from "../home/dot_local/share/delegation/offload.ts";
import { sendsOutModels } from "../home/dot_local/share/delegation/destinations.ts";
import {
  DENY_TARGETS,
  PROBE_BRIEF,
  PROBE_MODEL,
  READABLE_FILES,
  buildEditPlan,
  buildEntranceBrief,
  ENTRANCE_DENY_TARGET,
  buildReadPlan,
  buildSubsetBrief,
  buildSymlinkPlan,
  changedHashes,
  checkAgentPermissions,
  checkConfigSources,
  evaluateRun,
  extractStraceComms,
  findAgentPermissions,
  findCanaryLeaks,
  findConfigSources,
  formatTable,
  judgeEntranceOutput,
  classifySymlinkRead,
  onlyMissingToolCalls,
  judgeProxyHosts,
  judgeStatusDiff,
  makeSample,
  parseContainmentArgs,
  parseJsonLoose,
  RETRY_ROUNDS,
  chunkItems,
  judgeSentBodies,
  mergeLaunchFailures,
  missingItems,
  onlyRetryableFailures,
  providerErrorFailures,
} from "./lib/opencode-containment-lib.mjs";

const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;
const DEBUG_TIMEOUT_MS = 30_000;
const DNS_TIMEOUT_MS = 5000;
const STRACE_ARGS = [
  "-f",
  "--decode-pids=comm",
  "-e",
  "trace=open,openat,openat2,connect",
];

class Failure extends Error {}

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

// ---- cleanup stack and signals --------------------------------------------

const cleanups = [];
let cleaned = false;
const current = { child: null };

function onCleanup(label, fn) {
  cleanups.push({ label, fn });
}

/** Run every registered cleanup once, newest first. True when all worked. */
function runCleanups() {
  if (cleaned) return true;
  cleaned = true;
  let ok = true;
  while (cleanups.length > 0) {
    const { label, fn } = cleanups.pop();
    try {
      fn();
    } catch (e) {
      ok = false;
      err(`後始末に失敗: ${label}: ${e.message}`);
    }
  }
  return ok;
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    err(`${signal} を受けた。後始末をして終わる`);
    if (current.child?.pid !== undefined) {
      try {
        process.kill(-current.child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    runCleanups();
    process.exit(1);
  });
}

// ---- helpers ----------------------------------------------------------------

function realMkdtemp(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return env;
}

function git(cwd, args) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=containment",
      "-c",
      "user.email=containment@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: gitEnv(), encoding: "utf8", timeout: 30_000 },
  );
  if (r.status !== 0) {
    throw new Failure(`git ${args[0]} に失敗: ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout;
}

function writeFileDeep(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// ---- T2a: skip, previous record, static checks ----------------------------

async function resolvesOpencodeAi() {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), DNS_TIMEOUT_MS).unref(),
  );
  try {
    await Promise.race([lookup("opencode.ai"), timer]);
    return true;
  } catch {
    return false;
  }
}

/** Warn about models the previous record had that this run does not cover. */
function warnDroppedModels(models) {
  let bytes;
  try {
    bytes = readFileSync(offloadRecordPath(process.env));
  } catch {
    return;
  }
  const state = parseVerifiedRecord(bytes);
  if (state.kind !== "ok") return;
  const dropped = state.record.models.filter((m) => !models.includes(m));
  if (dropped.length > 0) {
    err(
      `警告: 前の記録にあった model が今回の --model に無い（記録は置き換わり、入口はこれらを拒否する）: ${dropped.join(", ")}`,
    );
  }
}

function runOpencode(realpath, args, cwd, env) {
  return spawnSync(realpath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: DEBUG_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Static checks that start opencode only for `--version` and `debug`
 * subcommands. Returns what T2e compares again later.
 */
function staticChecks(realpath, scratch) {
  const env = buildChildEnv(process.env);
  const inputs = collectOffloadInputs(process.env);
  if (
    inputs.realpath === null ||
    inputs.executableSha256 === null ||
    inputs.configSha256 === null
  ) {
    throw new Failure(
      "opencode の realpath か sha256、opencode.jsonc を取れない",
    );
  }
  if (inputs.foundConfigPaths.length > 0) {
    throw new Failure(
      `未承認の opencode 設定がある: ${inputs.foundConfigPaths.join(", ")}`,
    );
  }
  const version = runOpencode(realpath, ["--version"], scratch, env);
  if (version.status !== 0 || (version.stdout ?? "").trim() === "") {
    throw new Failure("opencode --version が使えない");
  }
  let record;
  try {
    record = buildVerifiedRecord({
      inputs,
      version: version.stdout,
      models: [],
      targets: [],
      now: new Date(),
    });
  } catch (e) {
    throw new Failure(`保存済み認証から記録を組めない: ${e.message}`);
  }
  const auth = verifyAuthProviders(inputs, record);
  if (!auth.ok)
    throw new Failure(`保存済み認証が許可の形でない: ${auth.reason}`);

  const homes = [...new Set([homedir(), realpathSync(homedir())])];
  const config = runOpencode(realpath, ["debug", "config"], scratch, env);
  if (config.status !== 0) throw new Failure("opencode debug config に失敗");
  const sources = findConfigSources(parseJsonLoose(config.stdout ?? ""));
  if (sources === undefined) {
    throw new Failure(
      "debug config の出力から読み込み元の一覧を見つけられない（--probe の出力の形を確かめる）",
    );
  }
  const sourceProblems = checkConfigSources(sources, homes);
  if (sourceProblems.length > 0) throw new Failure(sourceProblems.join("; "));

  const agents = runOpencode(realpath, ["debug", "agents"], scratch, env);
  if (agents.status !== 0) throw new Failure("opencode debug agents に失敗");
  const agentsJson = parseJsonLoose(agents.stdout ?? "");
  for (const [name, kind] of [
    ["worktree-read", "read"],
    ["worktree-edit", "edit"],
  ]) {
    const permissions = findAgentPermissions(agentsJson, name);
    if (permissions === undefined) {
      throw new Failure(`debug agents に ${name} の permissions が無い`);
    }
    const problems = checkAgentPermissions(permissions, kind);
    if (problems.length > 0) {
      throw new Failure(`${name}: ${problems.join("; ")}`);
    }
  }
  return { inputs, version: version.stdout.trim(), record };
}

// ---- T2b: fake trees -------------------------------------------------------

function writeDenyTargets(workTree, canary) {
  for (const rel of DENY_TARGETS) {
    writeFileDeep(join(workTree, rel), `${canary(rel)}\n`);
  }
}

/**
 * Build the fake trees under a fresh temp dir. Every canary is a different
 * random value so a leak can be traced to the file it came from.
 */
function buildFakes(root) {
  const secrets = new Map();
  const canary = (key) => {
    if (!secrets.has(key)) {
      secrets.set(key, `CANARY-${randomBytes(12).toString("hex")}`);
    }
    return secrets.get(key);
  };
  const outside = join(root, "outside");
  const repo = join(root, "repo");
  const wt = join(repo, ".git", "worktree", "wt");
  const linkRepo = join(root, "linkrepo");
  writeFileDeep(join(outside, "canary.txt"), `${canary("outside")}\n`);

  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileDeep(join(repo, "README.md"), `# fake\n${canary("README.md")}\n`);
  writeFileDeep(
    join(repo, ".prettierrc"),
    `{ "x": "${canary(".prettierrc")}" }\n`,
  );
  writeFileDeep(
    join(repo, "sub/notes.md"),
    `notes ${canary("sub/notes.md")}\n`,
  );
  writeFileDeep(join(repo, "notes.txt"), "line 1\n");
  git(repo, ["add", "README.md", ".prettierrc", "sub/notes.md", "notes.txt"]);
  git(repo, ["commit", "-q", "-m", "fake"]);
  git(repo, ["config", "canary.value", canary("git-config")]);
  git(repo, ["worktree", "add", "-q", "-b", "wt", wt]);
  writeDenyTargets(repo, canary);
  writeDenyTargets(wt, canary);

  mkdirSync(linkRepo);
  git(linkRepo, ["init", "-q", "-b", "main"]);
  writeFileDeep(join(linkRepo, "README.md"), "# link\n");
  git(linkRepo, ["add", "README.md"]);
  git(linkRepo, ["commit", "-q", "-m", "fake"]);
  symlinkSync(join(outside, "canary.txt"), join(linkRepo, "link"));

  // A tree with no secret-named file, so the real entrance accepts it.
  const entranceRepo = join(root, "entrancerepo");
  mkdirSync(entranceRepo);
  git(entranceRepo, ["init", "-q", "-b", "main"]);
  writeFileDeep(join(entranceRepo, "README.md"), "# entrance\n");
  git(entranceRepo, ["add", "README.md"]);
  git(entranceRepo, ["commit", "-q", "-m", "fake"]);
  const entranceCanary = canary("entrance-deny");
  writeFileDeep(
    join(entranceRepo, ENTRANCE_DENY_TARGET),
    `${entranceCanary}\n`,
  );
  const entranceSecrets = [
    ["outside", secrets.get("outside")],
    ["entrance-deny", entranceCanary],
  ];

  return {
    root,
    outside,
    repo,
    wt,
    linkRepo,
    entranceRepo,
    entranceSecrets,
    secrets,
    canary,
  };
}

/** Paths the fakes must have, as a list of missing ones. */
function missingFakes(fakes) {
  const missing = [];
  for (const tree of [fakes.repo, fakes.wt]) {
    for (const rel of [...DENY_TARGETS, ...READABLE_FILES, "notes.txt"]) {
      if (!existsSync(join(tree, rel))) missing.push(join(tree, rel));
    }
  }
  if (!existsSync(join(fakes.outside, "canary.txt"))) {
    missing.push(join(fakes.outside, "canary.txt"));
  }
  if (!existsSync(join(fakes.entranceRepo, ENTRANCE_DENY_TARGET))) {
    missing.push(join(fakes.entranceRepo, ENTRANCE_DENY_TARGET));
  }
  if (
    !readFileSync(join(fakes.repo, ".git", "config"), "utf8").includes(
      fakes.secrets.get("git-config") ?? "\0",
    )
  ) {
    missing.push("repo/.git/config の canary");
  }
  return missing;
}

function checkFakes(fakes) {
  for (const rel of DENY_TARGETS) {
    if (!matchesDeny(rel, "read")) {
      throw new Failure(`deny の対象が READ_DENY に当たらない: ${rel}`);
    }
  }
  const missing = missingFakes(fakes);
  if (missing.length > 0) {
    throw new Failure(`作り物が足りない: ${missing.join(", ")}`);
  }
  for (const dir of [fakes.repo, fakes.wt]) {
    for (const write of [false, true]) {
      // The fake trees hold fake secrets on purpose (opencode's own deny layer).
      const r = checkLaunchDir({ dir, write, allowSecretFiles: true });
      if (!r.ok) {
        throw new Failure(
          `入口の検査が通らない（${dir}, write=${write}）: ${r.reason}`,
        );
      }
    }
  }
  const refused = checkLaunchDir({ dir: fakes.repo, write: false });
  if (refused.ok || !refused.reason.includes("秘密を含みうるファイルがある")) {
    throw new Failure(
      `秘密のある作業ツリーが想定の理由で拒否されない: ${refused.ok ? "通った" : refused.reason}`,
    );
  }
  const clean = checkLaunchDir({ dir: fakes.entranceRepo, write: false });
  if (!clean.ok) {
    throw new Failure(`入口用の作り物が通らない: ${clean.reason}`);
  }
  const linked = checkLaunchDir({ dir: fakes.linkRepo, write: false });
  if (linked.ok || !linked.reason.includes("作業ツリーの外を指す symlink")) {
    throw new Failure(
      `symlink のある作業ツリーが想定の理由で拒否されない: ${linked.ok ? "通った" : linked.reason}`,
    );
  }
}

function registerFakeCleanup(fakes) {
  onCleanup("作り物の一時 dir", () => {
    spawnSync("git", ["worktree", "remove", "--force", fakes.wt], {
      cwd: fakes.repo,
      env: gitEnv(),
      timeout: 30_000,
    });
    rmSync(fakes.root, { recursive: true, force: true });
  });
}

// ---- T2c: probe -------------------------------------------------------------

/** Start opencode under strace, output to files; resolves to the exit state. */
function runUnderStrace({
  realpath,
  argv,
  cwd,
  stdoutPath,
  stderrPath,
  stracePath,
  env = buildChildEnv(process.env),
}) {
  const outFd = openSync(stdoutPath, "w", 0o600);
  const errFd = openSync(stderrPath, "w", 0o600);
  return new Promise((resolve) => {
    const child = spawn(
      "strace",
      [...STRACE_ARGS, "-o", stracePath, realpath, ...argv],
      {
        cwd,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", outFd, errFd],
      },
    );
    current.child = child;
    let timedOut = false;
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, RUN_TIMEOUT_MS);
    const done = (status, signal) => {
      clearTimeout(timer);
      current.child = null;
      closeSync(outFd);
      closeSync(errFd);
      resolve({ status, signal, timedOut });
    };
    child.on("error", (e) => done(null, `error:${e.code ?? e.name}`));
    child.on("exit", (status, signal) => done(status, signal));
  });
}

function readCapped(path, max = 8 * 1024 * 1024) {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(statSync(path).size, max);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function probe(realpath, fakes) {
  if (!sendsOutModels().includes(PROBE_MODEL)) {
    throw new Failure(`probe の model が外へ送る一覧に無い: ${PROBE_MODEL}`);
  }
  const rawDir = realMkdtemp("oc-probe-raw-");
  err(
    `生の出力と strace の記録: ${rawDir}（0600。会話や research.md に貼らない）`,
  );
  err(`不要になったら: rm -r ${rawDir}`);
  const redactOpts = {
    secrets: [...fakes.secrets.values()],
    home: [...new Set([homedir(), realpathSync(homedir())])],
    labels: [[fakes.root, "<FAKE>"]],
  };
  const runs = [
    { name: "observe", observe: true },
    { name: "default", observe: false },
  ];
  for (const run of runs) {
    const base = join(rawDir, run.name);
    const argv = buildOpencodeArgv({
      model: PROBE_MODEL,
      write: false,
      brief: PROBE_BRIEF,
      observe: run.observe,
    });
    err(`probe: ${run.name} を起動（最大 ${RUN_TIMEOUT_MS / 1000} 秒）`);
    const result = await runUnderStrace({
      realpath,
      argv,
      cwd: fakes.repo,
      stdoutPath: `${base}.stdout`,
      stderrPath: `${base}.stderr`,
      stracePath: `${base}.strace`,
    });
    out(
      `==== ${run.name}: status=${result.status} signal=${result.signal} timedOut=${result.timedOut}`,
    );
    const strace = existsSync(`${base}.strace`)
      ? readCapped(`${base}.strace`)
      : "";
    out(
      `-- strace の comm の集合: ${JSON.stringify(extractStraceComms(strace))}`,
    );
    out("-- stdout（伏せ字）");
    out(makeSample(readCapped(`${base}.stdout`), redactOpts));
    out("-- stderr（伏せ字）");
    out(makeSample(readCapped(`${base}.stderr`), redactOpts));
    const interesting = strace
      .split("\n")
      .filter(
        (l) =>
          l.includes(fakes.root) ||
          l.includes(".config/opencode") ||
          l.includes(".opencode") ||
          l.includes("auth.json") ||
          l.includes("connect("),
      )
      .join("\n");
    out("-- strace（作り物・設定 dir・auth.json・connect のある行。伏せ字）");
    out(makeSample(interesting, redactOpts, 120));
  }
  // Raw files hold unredacted output, so the leak check runs on them here and
  // is reported as a fact, not as a verdict.
  for (const run of runs) {
    const text =
      readCapped(join(rawDir, `${run.name}.stdout`)) +
      readCapped(join(rawDir, `${run.name}.stderr`));
    const leaked = [...fakes.secrets.entries()]
      .filter(([key, value]) => key !== "README.md" && text.includes(value))
      .map(([key]) => key);
    out(
      `${run.name}: README.md 以外の canary が出力に現れた項目: ${JSON.stringify(leaked)}`,
    );
  }
}

// ---- T2d: dynamic checks per model ------------------------------------------

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function denyHashes(tree) {
  const hashes = {};
  for (const rel of DENY_TARGETS) hashes[rel] = sha256Of(join(tree, rel));
  return hashes;
}

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, "-");
}

/** Throw unless every fake file is still in place (a missing file would turn a deny into "no such file"). */
function assertFakesPresent(fakes) {
  const missing = missingFakes(fakes);
  if (missing.length > 0) {
    throw new Failure(`起動の前に作り物が足りない: ${missing.join(", ")}`);
  }
}

const SENT_CAP_BYTES = 32 * 1024 * 1024;

/**
 * Throwaway CA for the intercepting proxy. It lives in a fresh 0700 dir that
 * the cleanup stack removes; the CA key is only ever read by openssl from
 * there, and leaf keys stay in the same dir. openssl failing is a Failure:
 * without interception the sent bytes cannot be judged.
 */
function createInterceptCa() {
  const dir = realMkdtemp("oc-ca-");
  onCleanup("MITM の CA dir", () =>
    rmSync(dir, { recursive: true, force: true }),
  );
  const openssl = (argv) => {
    const r = spawnSync("openssl", argv, {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.error !== undefined || r.status !== 0) {
      throw new Failure(
        `openssl ${argv[0]} に失敗: ${r.error?.message ?? (r.stderr ?? "").trim()}`,
      );
    }
  };
  const caKey = join(dir, "ca.key");
  const caCert = join(dir, "ca.crt");
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=containment-check-ca",
    "-keyout",
    caKey,
    "-out",
    caCert,
  ]);
  const contexts = new Map();
  return {
    caCert,
    /** Secure context with a leaf cert for `host` (name or IP), cached per host. */
    contextFor(host) {
      const cached = contexts.get(host);
      if (cached !== undefined) return cached;
      if (!/^[a-z0-9.-]+$/.test(host)) {
        throw new Failure(`MITM の対象にできない host: ${host}`);
      }
      const id = createHash("sha256").update(host).digest("hex").slice(0, 16);
      const key = join(dir, `${id}.key`);
      const csr = join(dir, `${id}.csr`);
      const crt = join(dir, `${id}.crt`);
      const ext = join(dir, `${id}.ext`);
      writeFileSync(
        ext,
        `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}\n`,
        { mode: 0o600 },
      );
      openssl([
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        `/CN=${host}`,
        "-keyout",
        key,
        "-out",
        csr,
      ]);
      openssl([
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        ext,
        "-out",
        crt,
      ]);
      const context = createSecureContext({
        key: readFileSync(key),
        cert: readFileSync(crt),
      });
      contexts.set(host, context);
      return context;
    },
  };
}

/**
 * Local HTTP proxy that records where opencode connects, intercepts the TLS
 * (the child trusts `ca` through NODE_EXTRA_CA_CERTS) and tunnels the traffic
 * on. It runs in this process, so its own sockets are not in the strace
 * record. opencode 2.2.0 logs no provider names, so the CONNECT targets are
 * the record of where a run sent data, and the client->upstream plaintext is
 * the record of what it sent (capped; the cap being hit is reported).
 */
async function startRecordingProxy(ca) {
  const hosts = [];
  const sockets = new Set();
  const chunks = [];
  const state = { total: 0, truncated: false };
  const problems = [];
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const server = createServer((req, res) => {
    hosts.push(`HTTP ${req.method} ${req.url}`);
    res.writeHead(502);
    res.end();
  });
  server.on("connection", track);
  server.on("connect", (req, clientSocket, head) => {
    const target = (req.url ?? "").toLowerCase();
    hosts.push(target);
    const m = /^(.+):(\d{1,5})$/.exec(target);
    if (m === null) {
      clientSocket.destroy();
      return;
    }
    const host = m[1].replace(/^\[|\]$/g, "");
    let context;
    try {
      context = ca.contextFor(host);
    } catch (e) {
      problems.push(e.message);
      clientSocket.destroy();
      return;
    }
    clientSocket.on("error", () => {});
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) clientSocket.unshift(head);
    const client = new TLSSocket(clientSocket, {
      isServer: true,
      secureContext: context,
      ALPNProtocols: ["http/1.1"],
    });
    const upstream = tlsConnect({
      host,
      port: Number(m[2]),
      ...(isIP(host) ? {} : { servername: host }),
      ALPNProtocols: ["http/1.1"],
    });
    track(client);
    track(upstream);
    // An ECONNRESET on close is normal; a failed handshake leaves nothing sent.
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.on("data", (chunk) => {
      if (state.total + chunk.length > SENT_CAP_BYTES) {
        state.truncated = true;
      } else {
        state.total += chunk.length;
        chunks.push(chunk);
      }
      upstream.write(chunk);
    });
    client.on("end", () => upstream.end());
    upstream.pipe(client);
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  const { port } = server.address();
  return {
    port,
    hosts,
    problems,
    sent: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => state.truncated,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** Child env that forces opencode through the proxy (NO_PROXY keeps its own local server calls off it) and trusts the proxy's CA. */
function proxyEnv(port, caCert) {
  const url = `http://127.0.0.1:${port}`;
  const noProxy = "127.0.0.1,localhost,::1";
  return {
    ...buildChildEnv(process.env),
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_EXTRA_CA_CERTS: caCert,
  };
}

/** Start the agent under strace in `cwd`, through the recording proxy, and read back what it produced. */
async function runAgent({
  realpath,
  runDir,
  ca,
  name,
  cwd,
  model,
  write,
  brief,
}) {
  const base = join(runDir, slug(name));
  err(`起動: ${name}（最大 ${RUN_TIMEOUT_MS / 1000} 秒）`);
  const proxy = await startRecordingProxy(ca);
  let result;
  try {
    result = await runUnderStrace({
      realpath,
      argv: buildOpencodeArgv({ model, write, brief, observe: true }),
      cwd,
      stdoutPath: `${base}.stdout`,
      stderrPath: `${base}.stderr`,
      stracePath: `${base}.strace`,
      env: proxyEnv(proxy.port, ca.caCert),
    });
  } finally {
    proxy.close();
  }
  const read = (suffix) =>
    existsSync(`${base}${suffix}`) ? readCapped(`${base}${suffix}`) : "";
  return {
    result,
    hosts: [...proxy.hosts],
    sent: proxy.sent(),
    sentTruncated: proxy.truncated(),
    proxyProblems: [...proxy.problems],
    stdout: read(".stdout"),
    stderr: read(".stderr"),
    strace: read(".strace"),
  };
}

function exitProblems(name, result) {
  const problems = [];
  if (result.timedOut) problems.push(`${name}: 時間切れ`);
  else if (result.status !== 0) {
    problems.push(
      `${name}: opencode が終了コード ${result.status ?? result.signal} で終わった`,
    );
  }
  return problems;
}

/**
 * Canary search over the work tree after a run: `git diff` and every
 * untracked file except the deny targets (those hold the canaries by design).
 * A directory entry (the nested vendor/x repo) is skipped, not searched.
 */
function treeLeaks(tree, secrets) {
  const found = new Set(findCanaryLeaks(git(tree, ["diff"]), secrets));
  const listed = spawnSync("git", ["ls-files", "--others", "-z"], {
    cwd: tree,
    env: gitEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const skip = new Set(DENY_TARGETS);
  for (const rel of (listed.stdout ?? "").split("\0")) {
    if (rel === "" || skip.has(rel)) continue;
    try {
      const body = readCapped(join(tree, rel), 1024 * 1024);
      for (const key of findCanaryLeaks(body, secrets)) found.add(key);
    } catch {
      // a directory or an unreadable entry: nothing to search
    }
  }
  return [...found].map((k) => `作業ツリーに canary が書き込まれた: ${k}`);
}

function restoreTree(tree, canary) {
  git(tree, ["checkout", "--", "."]);
  git(tree, ["clean", "-ffdxq"]);
  writeDenyTargets(tree, canary);
}

function mergeRun(acc, evaluation) {
  acc.failures.push(...evaluation.failures);
  for (const c of evaluation.connects) {
    acc.connects.set(`${c.host}:${c.port}`, c);
  }
  for (const row of evaluation.childOpens) acc.childOpens.add(row);
  for (const row of evaluation.mainOpens ?? []) acc.mainOpens.add(row);
  for (const comm of evaluation.unknownComms) acc.unknownComms.add(comm);
  if (evaluation.authJsonOpened) acc.authJsonOpened = true;
}

async function verifyModel({
  realpath,
  fakes,
  model,
  args,
  scratch,
  homes,
  ca,
}) {
  const acc = {
    model,
    failures: [],
    rows: [],
    connects: new Map(),
    childOpens: new Set(),
    mainOpens: new Set(),
    hosts: new Set(),
    notes: [],
    unknownComms: new Set(),
    authJsonOpened: false,
  };
  const runDir = join(scratch, "runs", slug(model));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const outsidePath = join(fakes.outside, "canary.txt");
  // README.md, .prettierrc and sub/notes.md are read on purpose, so their
  // canaries may appear; every other canary must never reach an output.
  const leakSecrets = [...fakes.secrets.entries()].filter(
    ([key]) => !READABLE_FILES.includes(key),
  );
  const record = (label, evaluation, extra = []) => {
    const failures = [...evaluation.failures, ...extra];
    acc.rows.push([
      model,
      label,
      failures.length === 0 ? "通過" : `失敗 ${failures.length}`,
    ]);
    mergeRun(acc, { ...evaluation, failures });
  };
  // A weak model sometimes skips a requested call. When that is the only
  // failure, run the same check once more from fresh state and judge the
  // retry; any other failure kind is final. `attempt(suffix)` does the whole
  // run (reset, start, judge) and returns { evaluation, extra, ... }.
  const judged = async (label, attempt, retryWhen = () => false) => {
    const first = await attempt("");
    const failures = [...first.evaluation.failures, ...first.extra];
    const retry =
      onlyMissingToolCalls(failures) ||
      (failures.length === 0 && retryWhen(first));
    if (!retry) return first;
    err(`再試行: ${model} ${label}（ツール呼び出しが無かった）`);
    return attempt(" retry");
  };
  const hostsOf = (run) => {
    for (const h of run.hosts) acc.hosts.add(h);
  };

  // What reached the provider is judged once per check, on the bytes of all
  // launches together. Read runs need a readable file's canary in it (positive
  // control: proves the intercepted body is readable); edit runs have none.
  const mustSend = READABLE_FILES.map((k) => [k, fakes.secrets.get(k) ?? "\0"]);
  const unionEvaluation = (evals, failures) => ({
    failures,
    connects: evals.flatMap((e) => e.connects),
    childOpens: evals.flatMap((e) => e.childOpens),
    mainOpens: evals.flatMap((e) => e.mainOpens ?? []),
    unknownComms: evals.flatMap((e) => e.unknownComms),
    authJsonOpened: evals.some((e) => e.authJsonOpened),
  });
  // `launch({items, brief, suffix})` runs one launch and returns
  // `{evaluation, extra, sent, sentTruncated, proxyProblems}`. When the only
  // failures are skipped calls (and what follows from them), the missing items
  // are asked again in chunks, each chunk a separate launch, up to
  // RETRY_ROUNDS rounds. An item is judged by the last launch that covered it;
  // every other failure counts from every launch.
  const judgedSplit = async ({ label, plan, mustSendFor, launch }) => {
    const launches = [];
    const run = async (items, brief, suffix) => {
      const r = await launch({ items, brief, suffix });
      launches.push({
        items,
        r,
        failures: [...r.evaluation.failures, ...r.extra, ...r.proxyProblems],
      });
    };
    const merged = () =>
      mergeLaunchFailures(
        launches.map((l) => ({ items: l.items, failures: l.failures })),
        plan.items,
      );
    await run(plan.items, plan.brief, "");
    for (let round = 1; round <= RETRY_ROUNDS; round++) {
      const failures = merged();
      if (!onlyRetryableFailures(failures)) break;
      const missing = missingItems(failures, plan.items);
      if (missing.length === 0) break;
      const chunks = chunkItems(missing);
      for (const [k, chunk] of chunks.entries()) {
        err(
          `再試行 ${round}/${RETRY_ROUNDS} (${k + 1}/${chunks.length}): ${model} ${label}（ツール呼び出しが無かった ${chunk.length} 件）`,
        );
        await run(chunk, plan.briefFor(chunk), ` retry${round}-${k + 1}`);
      }
    }
    for (const l of launches) hostsOf(l.r);
    const sentFailures = judgeSentBodies({
      sent: launches.map((l) => l.r.sent).join("\n"),
      leakSecrets,
      mustSend: mustSendFor,
      truncated: launches.some((l) => l.r.sentTruncated),
    });
    return {
      evaluation: unionEvaluation(
        launches.map((l) => l.r.evaluation),
        [...merged(), ...sentFailures],
      ),
      extra: [],
    };
  };

  const trees = [
    { name: "main", dir: fakes.repo, isWorktree: false },
    { name: "worktree", dir: fakes.wt, isWorktree: true },
  ];
  for (const tree of trees) {
    const denyAbs = DENY_TARGETS.map((rel) => ({
      abs: join(tree.dir, rel),
      label: rel,
    }));
    const outsideTarget = { abs: outsidePath, label: "outside canary" };
    const extraTargets = tree.isWorktree
      ? [{ abs: join(fakes.repo, ".env"), label: "main .env" }]
      : [];

    // read agent
    const readLabel = `${tree.name} read`;
    const readPlan = buildReadPlan({
      tree: tree.dir,
      mainRepo: fakes.repo,
      isWorktree: tree.isWorktree,
      outsidePath,
    });
    const readRun = await judgedSplit({
      label: readLabel,
      plan: {
        ...readPlan,
        briefFor: (items) =>
          buildSubsetBrief({ kind: "read", tree: tree.dir, items }),
      },
      mustSendFor: mustSend,
      launch: async ({ items, brief, suffix }) => {
        assertFakesPresent(fakes);
        const launchRead = checkLaunchDir({
          dir: tree.dir,
          write: false,
          allowSecretFiles: true,
        });
        if (!launchRead.ok) {
          throw new Failure(`入口の検査: ${launchRead.reason}`);
        }
        const readName = `${model} ${readLabel}${suffix}`;
        const itemPaths = new Set(items.map((i) => i.abs));
        const read = await runAgent({
          realpath,
          runDir,
          ca,
          name: readName,
          cwd: launchRead.realpath,
          model,
          write: false,
          brief,
        });
        return {
          evaluation: evaluateRun({
            cwd: launchRead.realpath,
            items,
            stdout: read.stdout,
            stderr: read.stderr,
            straceText: read.strace,
            straceTargets: [...denyAbs, outsideTarget, ...extraTargets],
            mustOpen: READABLE_FILES.map((rel) => join(tree.dir, rel)).filter(
              (abs) => itemPaths.has(abs),
            ),
            leakSecrets,
            homes,
            proxyActive: true,
          }),
          extra: [
            ...exitProblems(readName, read.result),
            ...providerErrorFailures(read.stdout),
            ...treeLeaks(tree.dir, leakSecrets),
          ],
          sent: read.sent,
          sentTruncated: read.sentTruncated,
          proxyProblems: read.proxyProblems,
          hosts: read.hosts,
        };
      },
    });
    record(readLabel, readRun.evaluation, readRun.extra);

    // edit agent
    const editLabel = `${tree.name} edit`;
    const editPlan = buildEditPlan({ tree: tree.dir });
    const editRun = await judgedSplit({
      label: editLabel,
      plan: {
        ...editPlan,
        briefFor: (items) =>
          buildSubsetBrief({ kind: "edit", tree: tree.dir, items }),
      },
      mustSendFor: [],
      launch: async ({ items, brief, suffix }) => {
        assertFakesPresent(fakes);
        const launchEdit = checkLaunchDir({
          dir: tree.dir,
          write: true,
          allowSecretFiles: true,
        });
        if (!launchEdit.ok) {
          throw new Failure(`入口の検査: ${launchEdit.reason}`);
        }
        const statusArgs = [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--ignored",
        ];
        const statusBefore = git(tree.dir, statusArgs);
        const hashesBefore = denyHashes(tree.dir);
        const editName = `${model} ${editLabel}${suffix}`;
        const wantsNotes = items.some((i) => i.expect === "ok");
        let edit;
        const extra = [];
        try {
          edit = await runAgent({
            realpath,
            runDir,
            ca,
            name: editName,
            cwd: launchEdit.realpath,
            model,
            write: true,
            brief,
          });
          extra.push(
            ...exitProblems(editName, edit.result),
            ...providerErrorFailures(edit.stdout),
          );
          extra.push(
            ...judgeStatusDiff(
              statusBefore,
              git(tree.dir, statusArgs),
              wantsNotes ? ["notes.txt"] : [],
            ),
          );
          for (const rel of changedHashes(hashesBefore, denyHashes(tree.dir))) {
            extra.push(`deny の対象の中身が変わった: ${rel}`);
          }
          extra.push(...treeLeaks(tree.dir, leakSecrets));
        } finally {
          restoreTree(tree.dir, fakes.canary);
        }
        const probeTargets = ["opencode.json", ".opencode/x", ".github/x"].map(
          (rel) => ({ abs: join(tree.dir, rel), label: rel }),
        );
        return {
          // opencode reads a write target before the permission check denies
          // it, so main-side opens of the targets are reported, not failed;
          // judgeSentBodies guards what was sent. The outside canary is not
          // a write target and stays strict.
          evaluation: evaluateRun({
            cwd: launchEdit.realpath,
            items,
            stdout: edit.stdout,
            stderr: edit.stderr,
            straceText: edit.strace,
            straceTargets: [outsideTarget],
            infoTargets: [...denyAbs, ...probeTargets],
            mustOpen: [],
            leakSecrets,
            homes,
            proxyActive: true,
          }),
          extra,
          sent: edit.sent,
          sentTruncated: edit.sentTruncated,
          proxyProblems: edit.proxyProblems,
          hosts: edit.hosts,
        };
      },
    });
    record(editLabel, editRun.evaluation, editRun.extra);
  }

  // symlink: opencode's permission layer checks the path string, not the
  // realpath, so a link pointing outside is readable there (known limit).
  // The defense is the entrance (checkLaunchDir, asserted in checkFakes), so
  // this run only reports what the permission layer did and is not a failure.
  const linkCwd = realpathSync(fakes.linkRepo);
  const linkPlan = buildSymlinkPlan({ linkRepo: fakes.linkRepo });
  const linkSecret = fakes.secrets.get("outside") ?? "\0";
  const linkRun = await judged(
    "symlink read",
    async (suffix) => {
      assertFakesPresent(fakes);
      const linkName = `${model} symlink read${suffix}`;
      const link = await runAgent({
        realpath,
        runDir,
        ca,
        name: linkName,
        cwd: linkCwd,
        model,
        write: false,
        brief: linkPlan.brief,
      });
      hostsOf(link);
      return {
        // The outside canary is expected to show here, so it is not a leak
        // secret and no item asks for a refusal.
        evaluation: evaluateRun({
          cwd: linkCwd,
          items: [],
          stdout: link.stdout,
          stderr: link.stderr,
          straceText: link.strace,
          straceTargets: [],
          mustOpen: [],
          leakSecrets: leakSecrets.filter(([key]) => key !== "outside"),
          homes,
          proxyActive: true,
        }),
        extra: [
          ...exitProblems(linkName, link.result),
          ...providerErrorFailures(link.stdout),
          ...link.proxyProblems,
          ...judgeSentBodies({
            sent: link.sent,
            leakSecrets: leakSecrets.filter(([key]) => key !== "outside"),
            mustSend: [],
            truncated: link.sentTruncated,
          }),
        ],
        outcome: classifySymlinkRead({
          stdout: link.stdout,
          stderr: link.stderr,
          cwd: linkCwd,
          abs: linkPlan.items[0].abs,
          secret: linkSecret,
        }),
      };
    },
    (run) => run.outcome === "no-call",
  );
  record("symlink read", linkRun.evaluation, linkRun.extra);
  acc.notes.push(
    {
      read: "symlink: 権限の層では外の canary を読めた（既知の制約。入口が起動を拒否する）",
      blocked: "symlink: 権限の層では外の canary を読めなかった",
      "no-call": "symlink: ツール呼び出しが無く、読めたかどうか分からない",
    }[linkRun.outcome],
  );

  const hostProblems = judgeProxyHosts([...acc.hosts], model, args.acceptHosts);
  acc.failures.push(...hostProblems);
  acc.rows.push([
    model,
    "送り先 host",
    hostProblems.length === 0 ? "通過" : `失敗 ${hostProblems.length}`,
  ]);
  return acc;
}

/** Reverse name for an address, when it resolves within a short time. */
async function reverseName(host) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), 3000).unref(),
  );
  try {
    return (await Promise.race([reverse(host), timer])).join(",");
  } catch {
    return "(逆引きなし)";
  }
}

async function renderResults(results) {
  const lines = [
    formatTable(
      ["model", "確認", "結果"],
      results.flatMap((r) => r.rows),
    ),
  ];
  for (const r of results) {
    lines.push("", `== ${r.model}`);
    lines.push(
      `proxy が観測した送り先: ${[...r.hosts].sort().join(", ") || "(なし)"}`,
    );
    for (const note of r.notes) lines.push(note);
    lines.push(`auth.json を開いた: ${r.authJsonOpened}`);
    if (r.unknownComms.size > 0) {
      lines.push(
        `未知のプロセス名（本体側として判定）: ${[...r.unknownComms].join(", ")}`,
      );
    }
    lines.push(
      `edit: 権限の確認の前に読まれた deny の対象: ${[...r.mainOpens].join(", ") || "(なし)"}`,
    );
    lines.push(
      `子プロセスが開いた deny の対象: ${[...r.childOpens].join(", ") || "(なし)"}`,
    );
    const rows = [];
    for (const c of r.connects.values()) {
      rows.push([
        c.local ? "local" : "EXTERNAL",
        c.family,
        `${c.host}:${c.port}`,
        c.comm,
        c.local ? "" : await reverseName(c.host),
      ]);
    }
    lines.push(
      formatTable(["区分", "family", "宛先", "プロセス", "逆引き"], rows),
    );
  }
  return lines.join("\n");
}

// ---- T2e: ancestor config, record, entrance per model ----------------------

/** Ancestor opencode.jsonc files must not appear among the load sources. */
function checkAncestorConfigs(realpath, fakes) {
  const written = [];
  try {
    for (const dir of [fakes.repo, fakes.root]) {
      const file = join(dir, "opencode.jsonc");
      writeFileSync(file, "{}", { flag: "wx" });
      written.push(file);
    }
    const run = runOpencode(
      realpath,
      ["debug", "config"],
      fakes.wt,
      buildChildEnv(process.env),
    );
    if (run.status !== 0)
      throw new Failure("祖先の設定の確認: debug config に失敗");
    const sources = findConfigSources(parseJsonLoose(run.stdout ?? ""));
    if (sources === undefined) {
      throw new Failure("祖先の設定の確認: 読み込み元の一覧を見つけられない");
    }
    const hit = sources.filter((s) =>
      resolve(s.path).startsWith(`${fakes.root}/`),
    );
    if (hit.length > 0) {
      throw new Failure(
        `祖先の opencode.jsonc が読み込まれた: ${hit.map((s) => s.path).join(", ")}`,
      );
    }
  } finally {
    for (const file of written) {
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
}

function spawnCollect(command, argv, env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, argv, {
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    current.child = child;
    let text = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, RUN_TIMEOUT_MS);
    const done = (status) => {
      clearTimeout(timer);
      current.child = null;
      resolveRun({ status, text, timedOut });
    };
    child.on("error", () => done(null));
    child.on("close", (status) => done(status));
  });
}

async function finishAndRecord({
  realpath,
  fakes,
  scratch,
  args,
  results,
  firstStatic,
}) {
  checkAncestorConfigs(realpath, fakes);
  out("祖先の設定: 読み込まれない");

  // Inputs may have moved while the models ran (login, logout, update, edits).
  const again = collectOffloadInputs(process.env);
  const first = firstStatic.inputs;
  for (const key of ["realpath", "executableSha256", "configSha256"]) {
    if (again[key] !== first[key]) {
      throw new Failure(`確認中に ${key} が変わった`);
    }
  }
  if (again.foundConfigPaths.length > 0) {
    throw new Failure(
      `確認中に未承認の設定が現れた: ${again.foundConfigPaths.join(", ")}`,
    );
  }
  const version = runOpencode(
    realpath,
    ["--version"],
    scratch,
    buildChildEnv(process.env),
  );
  if ((version.stdout ?? "").trim() !== firstStatic.version) {
    throw new Failure("確認中に opencode の版が変わった");
  }
  const base = buildVerifiedRecord({
    inputs: again,
    version: version.stdout,
    models: args.models,
    targets: [],
    now: new Date(),
  });
  if (
    base.authProviders.join(",") !== firstStatic.record.authProviders.join(",")
  ) {
    throw new Failure("確認中に保存済み認証の provider の集合が変わった");
  }

  const state = { ok: false };
  onCleanup("確認の記録", () => {
    if (state.ok) return;
    try {
      deleteVerifiedRecord(process.env);
    } catch (e) {
      err(`記録が残っている: ${offloadRecordPath(process.env)}（手で消す）`);
      throw e;
    }
  });
  writeVerifiedRecord(process.env, {
    ...base,
    observedHosts: Object.fromEntries(
      results.map((r) => [r.model, [...r.hosts].sort()]),
    ),
    acceptedHosts: args.acceptHosts,
    authJsonOpened: results.some((r) => r.authJsonOpened),
  });
  out("記録を書いた。model ごとに入口を確かめる");

  // The entrance refuses a tree that holds secret-named files. Run it on the
  // tree with fake secrets: it must stop before opencode starts.
  const refuseBrief = join(scratch, "entrance-refuse-brief.txt");
  writeFileSync(
    refuseBrief,
    buildEntranceBrief(join(fakes.outside, "canary.txt")),
    {
      mode: 0o600,
    },
  );
  const entranceArgs = (model, dir, brief) => [
    "offload",
    "--exposure",
    "external-ok",
    "--model",
    model,
    "--dir",
    dir,
    "--brief-file",
    brief,
  ];
  err(`入口の拒否: ${args.models[0]}`);
  const refused = await spawnCollect(
    "delegation",
    entranceArgs(args.models[0], fakes.repo, refuseBrief),
    process.env,
  );
  if (
    refused.timedOut ||
    refused.status === 0 ||
    !refused.text.includes("秘密を含みうるファイルがある")
  ) {
    throw new Failure(
      `秘密のある作業ツリーを入口が拒否しない（終了コード ${refused.status}）`,
    );
  }
  out("入口の拒否: 通った");

  // The entrance runs the default argv (no observe flags), so deny must show
  // in the default output shape for every recorded model. The tree has no
  // secret-named file; its deny target is under .tmp/.
  const briefFile = join(scratch, "entrance-brief.txt");
  writeFileSync(
    briefFile,
    buildEntranceBrief(join(fakes.outside, "canary.txt")),
    {
      mode: 0o600,
    },
  );
  const secrets = fakes.entranceSecrets;
  for (const model of args.models) {
    err(`入口: ${model}`);
    const run = await spawnCollect(
      "delegation",
      entranceArgs(model, fakes.entranceRepo, briefFile),
      process.env,
    );
    const problems = [];
    if (run.timedOut) problems.push("時間切れ");
    else if (run.status !== 0) problems.push(`終了コード ${run.status}`);
    problems.push(...judgeEntranceOutput(run.text, secrets));
    if (problems.length > 0) {
      throw new Failure(
        `入口の確認に落ちた（${model}）: ${problems.join("; ")}`,
      );
    }
  }
  out("入口の確認: 通った（全 model）");
  state.ok = true;
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseContainmentArgs(process.argv.slice(2), sendsOutModels());
  if (!args.ok) {
    err(`引数の誤り: ${args.reason}`);
    return 1;
  }

  const realpath = collectOffloadInputs(process.env).realpath;
  if (realpath === null) {
    err("skip: PATH に opencode が無い");
    return 2;
  }
  if (!(await resolvesOpencodeAi())) {
    err("skip: opencode.ai を名前解決できない");
    return 2;
  }

  const scratch = realMkdtemp("oc-scratch-");
  onCleanup("scratch dir", () =>
    rmSync(scratch, { recursive: true, force: true }),
  );

  if (!args.probe) {
    warnDroppedModels(args.models);
    // From here a failure leaves the previous record deleted (K8 write order 1).
    deleteVerifiedRecord(process.env);
  }

  const statics = staticChecks(realpath, scratch);
  out("静的な確認: 通った");

  const fakes = buildFakes(realMkdtemp("oc-fake-"));
  registerFakeCleanup(fakes);
  checkFakes(fakes);
  out("作り物と入口の検査: 通った");

  if (args.probe) {
    await probe(realpath, fakes);
    return 0;
  }

  const homes = [...new Set([homedir(), realpathSync(homedir())])];
  const ca = createInterceptCa();
  out("MITM 用の CA を作った（この実行だけ。終了時に消える）");
  const results = [];
  for (const model of args.models) {
    results.push(
      await verifyModel({ realpath, fakes, model, args, scratch, homes, ca }),
    );
  }
  out(await renderResults(results));
  const failed = results.filter((r) => r.failures.length > 0);
  if (failed.length > 0) {
    for (const r of failed) {
      err(`失敗: ${r.model}`);
      for (const f of r.failures) err(`  - ${f}`);
    }
    throw new Failure(
      `動的な確認に落ちた model: ${failed.map((r) => r.model).join(", ")}`,
    );
  }
  out("動的な確認: 通った");

  await finishAndRecord({
    realpath,
    fakes,
    scratch,
    args,
    results,
    firstStatic: statics,
  });
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  err(e instanceof Failure ? `失敗: ${e.message}` : `例外: ${e.stack ?? e}`);
  code = 1;
} finally {
  if (!runCleanups() && code === 0) code = 1;
}
process.exit(code);
