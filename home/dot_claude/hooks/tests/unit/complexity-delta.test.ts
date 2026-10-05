import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createHook } from "../../implementations/complexity-delta.ts";
import type { ComplexityLogEntry } from "../../types/logging-types.ts";
import {
  createStopContextFor,
  createUserPromptSubmitContext,
  invokeRun,
} from "./test-helpers.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `complexity-delta-${label}-`));
  tempDirs.push(dir);
  return dir;
}

// Generous for every case that expects cccc to answer, so a loaded machine does
// not turn a normal run into a timeout. The timeout cases pass 200 instead.
const PATIENT_TIMEOUT_MS = 10_000;

function makeRepo(): string {
  const repo = makeTempDir("repo");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

type Fn = { name: string; kind: string; line: number; cognitive: number };
const fn = (name: string, cognitive: number, line = 1): Fn => ({
  name,
  kind: "function",
  line,
  cognitive,
});
const report = (functions: Fn[]) =>
  JSON.stringify({ files: [{ path: "./a.ts", functions }], summary: {} });

let sessionCounter = 0;

/** One repository, one fake cccc, one state directory. */
function setup(options: { binInsideRepo?: boolean; timeoutMs?: number } = {}) {
  const repo = makeRepo();
  const stateDir = join(makeTempDir("state"), "complexity-delta");
  const binDir = options.binInsideRepo ? join(repo, "bin") : makeTempDir("bin");
  mkdirSync(binDir, { recursive: true });
  const outputFile = join(makeTempDir("out"), "cccc.json");
  const callsFile = join(dirname(outputFile), "calls");
  const sessionId = `cd-${process.pid}-${++sessionCounter}`;
  // pathEnv is only where cccc is looked up; git is found through the real PATH.
  const hook = createHook(() => ({
    stateDir,
    pathEnv: binDir,
    ccccTimeoutMs: options.timeoutMs ?? PATIENT_TIMEOUT_MS,
  }));

  // Each call appends its arguments as one line, so the file doubles as a counter.
  const script = (body: string) => {
    writeFileSync(
      join(binDir, "cccc"),
      `#!/bin/sh\necho "$*" >> "${callsFile}"\n${body}\n`,
      { mode: 0o755 },
    );
  };
  const respond = (raw: string) => {
    writeFileSync(outputFile, raw);
    script(`exec cat "${outputFile}"`);
  };
  const callLines = () =>
    existsSync(callsFile) ? readFileSync(callsFile, "utf-8").trim().split("\n") : [];
  const calls = () => callLines().length;

  const prompt = async (cwd = repo) => {
    const ctx = createUserPromptSubmitContext("go");
    Object.assign(ctx.input, { cwd, session_id: sessionId });
    await invokeRun(hook, ctx);
    return ctx;
  };
  const stop = async (cwd = repo) => {
    const ctx = createStopContextFor(hook, { cwd, session_id: sessionId });
    await invokeRun(hook, ctx);
    return ctx;
  };
  const statePath = join(stateDir, `${sessionId}.json`);
  const state = () => JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  const logs = (): ComplexityLogEntry[] => {
    const logDir = process.env.CLAUDE_LOGS_DIR;
    assert.ok(logDir, "run with --import tests/preload-test-env.mjs");
    const logFile = join(logDir, "complexity.jsonl");
    if (!existsSync(logFile)) return [];
    return readFileSync(logFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ComplexityLogEntry)
      .filter((entry) => entry.session_id === sessionId);
  };

  return {
    repo,
    stateDir,
    statePath,
    binDir,
    respond,
    script,
    calls,
    callLines,
    prompt,
    stop,
    state,
    logs,
  };
}

const message = (ctx: { jsonCalls: unknown[] }): string | undefined =>
  (ctx.jsonCalls[0] as { systemMessage?: string } | undefined)?.systemMessage;

describe("complexity-delta: notice", () => {
  it("shows a function that got worse between the prompt and the stop", async () => {
    const t = setup();
    t.respond(report([fn("f", 24, 3)]));
    const promptCtx = await t.prompt();
    assert.equal(promptCtx.jsonCalls.length, 0);
    assert.equal(promptCtx.successCalls.length, 1);

    t.respond(report([fn("f", 44, 5)]));
    const stopCtx = await t.stop();
    assert.equal(
      message(stopCtx),
      [
        "[complexity-delta] Cognitive complexity rose this turn (>= 25, new or +5):",
        "  a.ts:5 f 24 → 44",
      ].join("\n"),
    );
    assert.deepEqual(Object.keys(stopCtx.jsonCalls[0] as object), ["systemMessage"]);

    const notices = t.logs().filter((entry) => entry.kind === "notice");
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0]?.findings, [
      { path: "a.ts", line: 5, name: "f", before: 24, after: 44 },
    ]);
  });

  it("stays silent on a second stop with the same findings and logs once", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    const second = await t.stop();
    assert.equal(second.jsonCalls.length, 0);
    assert.equal(t.logs().filter((entry) => entry.kind === "notice").length, 1);
  });

  it("shows again when the findings change within the turn", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    t.respond(report([fn("f", 50)]));
    assert.match(message(await t.stop()) ?? "", /f 24 → 50/);
  });

  it("clears the shown digest when the findings disappear, and on the next prompt", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond(report([fn("f", 44)]));
    await t.stop();
    assert.match(String(t.state().shown), /^[0-9a-f]{64}$/);
    t.respond(report([fn("f", 24)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.state().shown, null);

    t.respond(report([fn("f", 44)]));
    await t.stop();
    await t.prompt();
    assert.equal(t.state().shown, null);
    t.respond(report([fn("f", 60)]));
    assert.match(message(await t.stop()) ?? "", /f 44 → 60/);
  });

  it("logs only the findings that got a line in the UI", async () => {
    const t = setup();
    t.respond(report([]));
    await t.prompt();
    t.respond(report(Array.from({ length: 13 }, (_, i) => fn(`f${i}`, 30, i + 1))));
    const text = message(await t.stop()) ?? "";
    assert.equal(text.split("\n").at(-1), "  ... and 3 more");
    const [notice] = t.logs().filter((entry) => entry.kind === "notice");
    assert.equal(notice?.findings?.length, 10);
  });

  it("reads more than 1 MiB of cccc output", async () => {
    const t = setup();
    const many = Array.from({ length: 30000 }, (_, i) => fn(`f${i}`, 1, i + 1));
    assert.ok(report(many).length > 1024 * 1024);
    t.respond(report(many));
    await t.prompt();
    t.respond(report([...many, fn("big", 40, 99999)]));
    assert.match(message(await t.stop()) ?? "", /a\.ts:99999 big new 40/);
  });
});

describe("complexity-delta: when it does nothing", () => {
  it("ignores a stop without a baseline", async () => {
    const t = setup();
    t.respond(report([fn("f", 44)]));
    const ctx = await t.stop();
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(existsSync(t.statePath), false);
    assert.equal(t.calls(), 0);
  });

  it("ignores a directory outside git without creating state", async () => {
    const t = setup();
    const outside = makeTempDir("outside");
    await t.prompt(outside);
    await t.stop(outside);
    assert.equal(existsSync(t.stateDir), false);
    assert.equal(t.calls(), 0);
  });

  it("ignores a session id that is not a safe file name", async () => {
    const t = setup();
    t.respond(report([fn("f", 44)]));
    const hook = createHook(() => ({
      stateDir: t.stateDir,
      pathEnv: t.binDir,
      ccccTimeoutMs: PATIENT_TIMEOUT_MS,
    }));
    const ctx = createUserPromptSubmitContext("go");
    Object.assign(ctx.input, { cwd: t.repo, session_id: "../escape" });
    await invokeRun(hook, ctx);
    assert.equal(existsSync(t.stateDir), false);
  });

  it("does not compare when the stop happens in another repository", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    const before = readFileSync(t.statePath, "utf-8");
    t.respond(report([fn("f", 44)]));
    const ctx = await t.stop(makeRepo());
    assert.equal(ctx.jsonCalls.length, 0);
    assert.equal(readFileSync(t.statePath, "utf-8"), before);
  });

  it("starts from a fresh state when the prompt happens in another repository", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    const firstRoot = t.state().root;
    await t.prompt(makeRepo());
    assert.equal(typeof t.state().root, "string");
    assert.notEqual(t.state().root, firstRoot);
    t.respond(report([fn("f", 44)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
  });

  it("treats a corrupt or wrong-version state file as no state and logs it", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    writeFileSync(t.statePath, JSON.stringify({ version: 2 }));
    t.respond(report([fn("f", 44)]));
    assert.equal((await t.stop()).jsonCalls.length, 0);
    writeFileSync(t.statePath, "{not json");
    await t.prompt();
    assert.equal(t.state().version, 1);
    assert.equal(t.logs().filter((entry) => entry.reason === "state").length, 2);
  });

  it("writes the state file as 0600 inside a 0700 directory", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(statSync(t.statePath).mode & 0o777, 0o600);
    assert.equal(statSync(t.stateDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(t.stateDir).filter((name) => name.endsWith(".tmp")), []);
  });
});

describe("complexity-delta: choosing the binary", () => {
  it("logs a skip with a recovery step when no cccc is on PATH", async () => {
    const t = setup();
    assert.equal((await t.prompt()).jsonCalls.length, 0);
    assert.equal(t.state().baseline, null);
    assert.equal((await t.stop()).jsonCalls.length, 0);
    const skips = t.logs().filter((entry) => entry.reason === "cccc-not-found");
    assert.equal(skips.length, 1);
    assert.match(skips[0]?.recovery ?? "", /mise install/);
  });

  it("does not run a cccc that lives inside the repository", async () => {
    const t = setup({ binInsideRepo: true });
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(t.calls(), 0);
    assert.equal(t.logs().some((entry) => entry.reason === "cccc-not-found"), true);
  });

  it("does not run a cccc that resolves to a file named mise", async () => {
    const t = setup();
    const real = join(makeTempDir("mise"), "mise");
    writeFileSync(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(real, join(t.binDir, "cccc"));
    await t.prompt();
    assert.equal(t.logs().some((entry) => entry.reason === "cccc-not-found"), true);
  });

  it("logs a failed measurement and drops the baseline when cccc exits non-zero", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.script("exit 2");
    await t.prompt();
    assert.equal(t.state().baseline, null);
    const failed = t.logs().filter((entry) => entry.reason === "failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0]?.binary ?? "", /cccc$/);
  });
});

describe("complexity-delta: giving up", () => {
  it("turns itself off after two consecutive timeouts and says so once", async () => {
    const t = setup({ timeoutMs: 200 });
    t.script("exec sleep 30");
    const first = await t.prompt();
    assert.equal(first.jsonCalls.length, 0);
    assert.equal(t.state().timeouts, 1);
    assert.equal(t.state().baseline, null);

    const second = await t.prompt();
    assert.match(message(second) ?? "", /^\[complexity-delta\] cccc exceeded 200ms twice/);
    assert.equal((message(second) ?? "").includes(t.statePath), true);
    assert.equal(t.state().disabled, "timeout");
    const disabled = t.logs().filter((entry) => entry.kind === "disabled");
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0]?.recovery, t.statePath);

    const callsBefore = t.calls();
    const third = await t.prompt();
    assert.equal(third.jsonCalls.length, 0);
    assert.equal(t.calls(), callsBefore);
  });

  it("counts a stop timeout and resets the count on a success", async () => {
    const t = setup({ timeoutMs: 200 });
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.script("exec sleep 30");
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.state().timeouts, 1);
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(t.state().timeouts, 0);
    assert.equal(t.state().disabled, undefined);
  });

  it("turns itself off at once when the output has an unexpected shape", async () => {
    const t = setup();
    t.respond(JSON.stringify({ files: "changed" }));
    const ctx = await t.prompt();
    assert.match(message(ctx) ?? "", /did not match the expected shape/);
    assert.equal((message(ctx) ?? "").includes(join(t.binDir, "cccc")), true);
    assert.equal(t.state().disabled, "schema");
    assert.equal(t.logs().some((entry) => entry.reason === "schema"), true);

    // Once off, a stop neither measures nor speaks.
    t.respond(report([fn("f", 44)]));
    const callsWhileOff = t.calls();
    assert.equal((await t.stop()).jsonCalls.length, 0);
    assert.equal(t.calls(), callsWhileOff);

    // Another repository starts from a fresh state.
    t.respond(report([fn("f", 24)]));
    await t.prompt(makeRepo());
    assert.equal(t.state().disabled, undefined);
    assert.equal(t.state().timeouts, 0);
  });

  it("turns itself off when a stop sees an unexpected shape, keeping the baseline", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    t.respond("[]");
    assert.match(message(await t.stop()) ?? "", /did not match the expected shape/);
    assert.equal(t.state().disabled, "schema");
    assert.notEqual(t.state().baseline, null);
    const disabled = t.logs().filter((entry) => entry.kind === "disabled");
    assert.equal(disabled.length, 1);
    assert.equal(disabled[0]?.recovery, t.statePath);
  });
});

describe("complexity-delta: housekeeping", () => {
  it("passes --no-config and the .git exclusion to cccc", async () => {
    const t = setup();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.deepEqual(t.callLines(), ["--no-config --exclude .git/** ."]);
  });

  it("removes state files older than seven days on a prompt, unless it is off", async () => {
    const t = setup();
    mkdirSync(t.stateDir, { recursive: true });
    const stale = join(t.stateDir, "stale.json");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const plantStale = () => {
      writeFileSync(stale, "{}");
      utimesSync(stale, eightDaysAgo, eightDaysAgo);
    };

    plantStale();
    t.respond(report([fn("f", 24)]));
    await t.prompt();
    assert.equal(existsSync(stale), false);

    t.respond("[]");
    await t.prompt();
    assert.equal(t.state().disabled, "schema");
    plantStale();
    await t.prompt();
    assert.equal(existsSync(stale), true);
  });
});
