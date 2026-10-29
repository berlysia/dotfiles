// Verification script for the opencode offload entrance (spec K13).
//
//   node tests/opencode-containment.mjs --model <m> [--model <m2> ...] [--accept-aux <provider> ...]
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
// Stages are separate functions so the dynamic checks (plan-3 T2d/T2e) can be
// added between `buildFakes` and the cleanup without touching the rest.
// The cleanup is one stack run once from the try/finally and the signal
// handlers.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  writeFileSync,
} from "node:fs";
import { lookup } from "node:dns/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
} from "../home/dot_local/share/delegation/offload.ts";
import { sendsOutModels } from "../home/dot_local/share/delegation/destinations.ts";
import {
  DENY_TARGETS,
  PROBE_BRIEF,
  PROBE_MODEL,
  READABLE_FILES,
  checkAgentPermissions,
  checkConfigSources,
  extractStraceComms,
  findAgentPermissions,
  findConfigSources,
  makeSample,
  parseContainmentArgs,
  parseJsonLoose,
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

  return { root, outside, repo, wt, linkRepo, secrets, canary };
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
      const r = checkLaunchDir({ dir, write });
      if (!r.ok) {
        throw new Failure(
          `入口の検査が通らない（${dir}, write=${write}）: ${r.reason}`,
        );
      }
    }
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
}) {
  const outFd = openSync(stdoutPath, "w", 0o600);
  const errFd = openSync(stderrPath, "w", 0o600);
  return new Promise((resolve) => {
    const child = spawn(
      "strace",
      [...STRACE_ARGS, "-o", stracePath, realpath, ...argv],
      {
        cwd,
        env: buildChildEnv(process.env),
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

  staticChecks(realpath, scratch);
  out("静的な確認: 通った");

  const fakes = buildFakes(realMkdtemp("oc-fake-"));
  registerFakeCleanup(fakes);
  checkFakes(fakes);
  out("作り物と入口の検査: 通った");

  if (args.probe) {
    await probe(realpath, fakes);
    return 0;
  }

  // plan-3 T2d (dynamic checks) and T2e (record, entrance per model) go here.
  err(
    "動的な確認（T2d）と記録の書き込み（T2e）は未実装。記録は書かない。前の記録は消してある",
  );
  return 1;
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
